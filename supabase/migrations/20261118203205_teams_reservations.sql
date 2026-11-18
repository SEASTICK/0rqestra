-- 0rqestra Teams, phase 5: path reservations with leases.
--
-- Before a coordinated team run starts, its owner's app reserves the run's repository-relative
-- files and folders. task_reservations (from phase 1) gets the run id, the paths, a lease token and
-- the holder's display name. All writes go through the functions below:
-- * acquire_reservation: one transaction per project (the shared project row is locked), so of
--   two overlapping requests exactly one is granted. Expired leases are cleared first. A path
--   overlaps another if they are equal or one is a folder of the other, compared without case;
--   src/auth/ overlaps src/auth/session.ts, but not src/auth-old/. Branches do not matter. A retry
--   with the same run id returns the same reservation.
-- * renew_reservation, expand_reservation, release_reservation: only with the lease token, by the
--   user who holds it, while it has not expired (server time). An old session therefore cannot
--   renew or release a reservation that has since been replaced. A denied expansion leaves the
--   reservation as it was.
-- * Members of the project's team read reservations; nobody writes them directly.
-- * Every change is announced on the project's private briefs topic ("reservation_changed").

alter table public.task_reservations
  add column run_id text,
  add column paths text[] not null default '{}',
  add column lease_token uuid,
  add column reserved_by_name text,
  add column renewed_at timestamptz;

drop index if exists public.task_reservations_one_active_idx;
alter table public.task_reservations drop constraint if exists task_reservations_status_check;
update public.task_reservations set run_id = id::text where run_id is null;
alter table public.task_reservations
  alter column run_id set not null,
  add constraint task_reservations_status_check check (status in ('active', 'released', 'expired')),
  add constraint task_reservations_run_id_check check (run_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  add constraint task_reservations_paths_check check (cardinality(paths) <= 200);
create unique index task_reservations_one_active_run_idx on public.task_reservations (project_id, reserved_by, run_id) where status = 'active';
create index task_reservations_active_idx on public.task_reservations (project_id, status, expires_at);

drop policy if exists "Project members reserve for themselves" on public.task_reservations;
drop policy if exists "Holders update their reservations" on public.task_reservations;
drop policy if exists "Holders delete their reservations" on public.task_reservations;
revoke insert, update, delete on public.task_reservations from authenticated;

-- Folder-aware, case-insensitive overlap. A trailing slash only marks a folder.
create function private.reservation_path(p text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(p, '/+$', ''));
$$;

create function private.paths_overlap(a text, b text) returns boolean
language sql immutable set search_path = '' as $$
  select x = y
      or left(x, char_length(y) + 1) = y || '/'
      or left(y, char_length(x) + 1) = x || '/'
  from (select private.reservation_path(a) as x, private.reservation_path(b) as y) as t;
$$;

-- Active, unexpired reservations in a project that overlap the given paths, with the overlapping
-- pairs. p_exclude leaves out one reservation (the caller's own, when expanding).
create function private.reservation_conflicts(p_project_id uuid, p_paths text[], p_exclude uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c), '[]'::jsonb) from (
    select r.id as reservation_id, r.reserved_by as user_id, coalesce(r.reserved_by_name, 'A teammate') as name,
           r.summary as task, r.run_id, r.branch,
           (select jsonb_agg(distinct jsonb_build_object('yours', mine, 'theirs', theirs))
              from unnest(p_paths) as mine, unnest(r.paths) as theirs
              where private.paths_overlap(mine, theirs)) as overlaps
    from public.task_reservations r
    where r.project_id = p_project_id and r.status = 'active' and r.expires_at > now()
      and (p_exclude is null or r.id <> p_exclude)
      and exists (select 1 from unnest(p_paths) as mine, unnest(r.paths) as theirs where private.paths_overlap(mine, theirs))
  ) as c;
$$;

create function private.check_reservation_paths(p_paths text[]) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_paths is null or cardinality(p_paths) < 1 or cardinality(p_paths) > 200
     or exists (select 1 from unnest(p_paths) as p where not private.is_repo_path(p)) then
    raise exception 'invalid_paths' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.reservation_path(text), private.paths_overlap(text, text),
  private.reservation_conflicts(uuid, text[], uuid), private.check_reservation_paths(text[]) from public, anon, authenticated;

create function public.acquire_reservation(p_project_id uuid, p_run_id text, p_summary text, p_branch text, p_paths text[], p_ttl_seconds integer default 120)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_row public.task_reservations%rowtype;
  v_conflicts jsonb;
  v_name text;
begin
  if v_uid is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if not private.is_project_member(p_project_id) then raise exception 'not_project_member' using errcode = '42501'; end if;
  if p_run_id is null or p_run_id !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'invalid_run_id' using errcode = '22023'; end if;
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 900 then raise exception 'invalid_ttl' using errcode = '22023'; end if;
  perform private.check_reservation_paths(p_paths);

  -- One acquisition at a time per project.
  perform 1 from public.shared_projects where id = p_project_id for update;
  update public.task_reservations set status = 'expired'
    where project_id = p_project_id and status = 'active' and expires_at <= now();

  -- A retry of the same start returns the reservation it already has.
  select * into v_row from public.task_reservations
    where project_id = p_project_id and reserved_by = v_uid and run_id = p_run_id and status = 'active';
  if found then
    update public.task_reservations set expires_at = now() + make_interval(secs => p_ttl_seconds), renewed_at = now()
      where id = v_row.id returning * into v_row;
    return jsonb_build_object('status', 'granted', 'reservation_id', v_row.id, 'lease_token', v_row.lease_token,
      'paths', to_jsonb(v_row.paths), 'expires_at', v_row.expires_at, 'server_now', now(), 'retry', true);
  end if;

  v_conflicts := private.reservation_conflicts(p_project_id, p_paths, null);
  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('status', 'conflict', 'conflicts', v_conflicts, 'server_now', now());
  end if;

  select split_part(m.email, '@', 1) into v_name
    from public.shared_projects p join public.team_members m on m.team_id = p.team_id and m.user_id = v_uid where p.id = p_project_id;
  insert into public.task_reservations (project_id, reserved_by, reserved_by_name, task_key, run_id, summary, branch, paths, status, lease_token, expires_at, renewed_at)
  values (p_project_id, v_uid, left(v_name, 80), p_run_id, p_run_id, left(btrim(regexp_replace(coalesce(p_summary, ''), '\s+', ' ', 'g')), 2000),
          nullif(left(btrim(coalesce(p_branch, '')), 250), ''), p_paths, 'active', gen_random_uuid(),
          now() + make_interval(secs => p_ttl_seconds), now())
  returning * into v_row;
  return jsonb_build_object('status', 'granted', 'reservation_id', v_row.id, 'lease_token', v_row.lease_token,
    'paths', to_jsonb(v_row.paths), 'expires_at', v_row.expires_at, 'server_now', now(), 'retry', false);
end;
$$;

-- The lease must belong to the caller, match the token, be active and unexpired (server time).
create function private.held_lease(p_reservation_id uuid, p_lease_token uuid) returns public.task_reservations
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.task_reservations%rowtype;
begin
  select * into v_row from public.task_reservations where id = p_reservation_id for update;
  if not found or v_row.reserved_by <> auth.uid() or v_row.lease_token is distinct from p_lease_token
     or v_row.status <> 'active' or v_row.expires_at <= now() then
    return null;
  end if;
  return v_row;
end;
$$;
revoke all on function private.held_lease(uuid, uuid) from public, anon, authenticated;

create function public.renew_reservation(p_reservation_id uuid, p_lease_token uuid, p_ttl_seconds integer default 120)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.task_reservations%rowtype;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 900 then raise exception 'invalid_ttl' using errcode = '22023'; end if;
  v_row := private.held_lease(p_reservation_id, p_lease_token);
  if v_row.id is null then
    return jsonb_build_object('status', 'lost', 'server_now', now());
  end if;
  update public.task_reservations set expires_at = now() + make_interval(secs => p_ttl_seconds), renewed_at = now()
    where id = v_row.id returning * into v_row;
  return jsonb_build_object('status', 'renewed', 'expires_at', v_row.expires_at, 'server_now', now());
end;
$$;

create function public.expand_reservation(p_reservation_id uuid, p_lease_token uuid, p_paths text[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.task_reservations%rowtype;
  v_project uuid;
  v_new text[];
  v_conflicts jsonb;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  perform private.check_reservation_paths(p_paths);
  select project_id into v_project from public.task_reservations where id = p_reservation_id;
  if v_project is null then return jsonb_build_object('status', 'lost', 'server_now', now()); end if;
  perform 1 from public.shared_projects where id = v_project for update;
  v_row := private.held_lease(p_reservation_id, p_lease_token);
  if v_row.id is null then
    return jsonb_build_object('status', 'lost', 'server_now', now());
  end if;
  -- Only paths not already covered by the reservation.
  select coalesce(array_agg(p), '{}') into v_new from unnest(p_paths) as p
    where not exists (select 1 from unnest(v_row.paths) as have
                      where private.reservation_path(p) = private.reservation_path(have)
                         or left(private.reservation_path(p), char_length(private.reservation_path(have)) + 1) = private.reservation_path(have) || '/');
  if cardinality(v_new) = 0 then
    return jsonb_build_object('status', 'expanded', 'paths', to_jsonb(v_row.paths), 'expires_at', v_row.expires_at, 'server_now', now());
  end if;
  update public.task_reservations set status = 'expired'
    where project_id = v_project and status = 'active' and expires_at <= now();
  v_conflicts := private.reservation_conflicts(v_project, v_new, v_row.id);
  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('status', 'conflict', 'conflicts', v_conflicts, 'server_now', now());
  end if;
  if cardinality(v_row.paths) + cardinality(v_new) > 200 then raise exception 'invalid_paths' using errcode = '22023'; end if;
  update public.task_reservations set paths = paths || v_new where id = v_row.id returning * into v_row;
  return jsonb_build_object('status', 'expanded', 'paths', to_jsonb(v_row.paths), 'expires_at', v_row.expires_at, 'server_now', now());
end;
$$;

create function public.release_reservation(p_reservation_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.task_reservations%rowtype;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  select * into v_row from public.task_reservations where id = p_reservation_id for update;
  if not found or v_row.reserved_by <> auth.uid() or v_row.lease_token is distinct from p_lease_token then
    return jsonb_build_object('status', 'not_owner');
  end if;
  if v_row.status = 'active' then
    update public.task_reservations set status = 'released', released_at = now() where id = v_row.id;
  end if;
  return jsonb_build_object('status', 'released');
end;
$$;

revoke all on function public.acquire_reservation(uuid, text, text, text, text[], integer), public.renew_reservation(uuid, uuid, integer),
  public.expand_reservation(uuid, uuid, text[]), public.release_reservation(uuid, uuid) from public, anon;
grant execute on function public.acquire_reservation(uuid, text, text, text, text[], integer), public.renew_reservation(uuid, uuid, integer),
  public.expand_reservation(uuid, uuid, text[]), public.release_reservation(uuid, uuid) to authenticated;

-- The lease token is a secret of its holder: members may read reservations but not the token.
revoke select on public.task_reservations from authenticated;
grant select (id, project_id, reserved_by, reserved_by_name, task_key, run_id, summary, branch, paths, status, created_at, expires_at, released_at, renewed_at)
  on public.task_reservations to authenticated;

create function private.announce_reservation_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('reservation_id', new.id, 'status', new.status),
    'reservation_changed',
    'teams:' || new.project_id::text || ':briefs',
    true
  );
  return null;
end;
$$;
revoke all on function private.announce_reservation_change() from public, anon, authenticated;
create trigger task_reservations_announce after insert or update on public.task_reservations
  for each row execute function private.announce_reservation_change();
