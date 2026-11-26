-- 0rqestra: a shared Project Checklist. Teammates agree on what needs doing, claim items and see
-- progress. Items belong to the shared project (its id), so everyone sees the same checklist whatever
-- folder or branch they use on their own computer.
--
-- Rules (the acting user is always auth.uid(); timestamps come from the database):
-- * Only members of the project's team read items (row-level security) and only through the
--   functions below can anyone change them. A pending invitation gives no access.
-- * An assignee is nobody or a member of the same project's team.
-- * claim_checklist_item gives an unassigned item to the caller in one conditional update: when two
--   people claim at once, one gets it and the other is told who did.
-- * A blocked item says what is needed. Status stays under human control: a linked run only shows
--   what happened; nothing marks an item done on its own.
-- * Every change is announced as "checklist_changed" on the project's existing private topic
--   teams:<project>:briefs (members only, *_teams_run_briefs.sql); the apps then read the checklist.

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  notes text not null default '' check (char_length(notes) <= 4000),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done')),
  assignee_id uuid references auth.users (id) on delete set null,
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) between 1 and 1000),
  archived boolean not null default false,
  run_id text check (run_id is null or run_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (status <> 'blocked' or blocked_reason is not null)
);
create index checklist_items_project_idx on public.checklist_items (project_id, archived, updated_at desc);
create index checklist_items_assignee_idx on public.checklist_items (assignee_id);
create index checklist_items_created_by_idx on public.checklist_items (created_by);
create index checklist_items_updated_by_idx on public.checklist_items (updated_by);
alter table public.checklist_items enable row level security;
revoke all on public.checklist_items from anon, authenticated;
grant select on public.checklist_items to authenticated;
create policy "Project members read the checklist" on public.checklist_items
  for select to authenticated using (private.is_project_member(project_id));

-- Nobody, or a member of the project's team.
create function private.checklist_assignee_ok(p_project uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is null or exists (
    select 1 from public.shared_projects p join public.team_members m on m.team_id = p.team_id
    where p.id = p_project and m.user_id = p_user
  );
$$;

-- The item, locked, if the caller is a member of its project; otherwise not found.
create function private.checklist_item_for_update(p_item uuid) returns public.checklist_items
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.checklist_items%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  select * into v_row from public.checklist_items c where c.id = p_item for update;
  if not found or not private.is_project_member(v_row.project_id) then
    raise exception 'checklist_item_not_found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create function public.add_checklist_item(p_project_id uuid, p_title text, p_notes text default '', p_assignee uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_notes text := coalesce(p_notes, '');
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  if not private.is_project_member(p_project_id) then
    raise exception 'not_project_member' using errcode = '42501';
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 or char_length(v_notes) > 4000 then
    raise exception 'invalid_checklist_item' using errcode = '22023';
  end if;
  if not private.checklist_assignee_ok(p_project_id, p_assignee) then
    raise exception 'invalid_assignee' using errcode = '22023';
  end if;
  if (select count(*) from public.checklist_items c where c.project_id = p_project_id and not c.archived) >= 500 then
    raise exception 'too_many_checklist_items' using errcode = '54000';
  end if;
  insert into public.checklist_items (project_id, title, notes, assignee_id, created_by, updated_by)
    values (p_project_id, v_title, v_notes, p_assignee, v_uid, v_uid) returning id into v_id;
  return v_id;
end;
$$;

-- Title, notes and assignee.
create function public.update_checklist_item(p_item_id uuid, p_title text, p_notes text, p_assignee uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.checklist_items%rowtype := private.checklist_item_for_update(p_item_id);
  v_title text := btrim(coalesce(p_title, ''));
  v_notes text := coalesce(p_notes, '');
begin
  if char_length(v_title) < 1 or char_length(v_title) > 200 or char_length(v_notes) > 4000 then
    raise exception 'invalid_checklist_item' using errcode = '22023';
  end if;
  if not private.checklist_assignee_ok(v_row.project_id, p_assignee) then
    raise exception 'invalid_assignee' using errcode = '22023';
  end if;
  update public.checklist_items c set title = v_title, notes = v_notes, assignee_id = p_assignee,
    updated_by = auth.uid(), updated_at = now(), version = c.version + 1
    where c.id = v_row.id returning c.version into v_row.version;
  return v_row.version;
end;
$$;

-- To do, In progress, Blocked (with what is needed) or Done; reopening is going back to To do.
create function public.set_checklist_status(p_item_id uuid, p_status text, p_blocked_reason text default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.checklist_items%rowtype := private.checklist_item_for_update(p_item_id);
  v_reason text := nullif(btrim(coalesce(p_blocked_reason, '')), '');
begin
  if p_status is null or p_status not in ('todo', 'in_progress', 'blocked', 'done') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_status = 'blocked' and (v_reason is null or char_length(v_reason) > 1000) then
    raise exception 'blocked_reason_required' using errcode = '22023';
  end if;
  update public.checklist_items c set status = p_status, blocked_reason = case when p_status = 'blocked' then v_reason else null end,
    updated_by = auth.uid(), updated_at = now(), version = c.version + 1
    where c.id = v_row.id returning c.version into v_row.version;
  return v_row.version;
end;
$$;

-- Gives an unassigned item to the caller. outcome: 'claimed', 'yours' (already yours) or 'taken'
-- (someone else has it: assignee_id says who).
create function public.claim_checklist_item(p_item_id uuid)
returns table (outcome text, assignee_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  select c.project_id into v_project from public.checklist_items c where c.id = p_item_id;
  if v_project is null or not private.is_project_member(v_project) then
    raise exception 'checklist_item_not_found' using errcode = 'P0002';
  end if;
  update public.checklist_items c set assignee_id = v_uid, updated_by = v_uid, updated_at = now(), version = c.version + 1
    where c.id = p_item_id and c.assignee_id is null and not c.archived;
  if found then
    return query select 'claimed'::text, v_uid;
    return;
  end if;
  select c.assignee_id into v_owner from public.checklist_items c where c.id = p_item_id;
  return query select case when v_owner = v_uid then 'yours' when v_owner is null then 'archived' else 'taken' end, v_owner;
end;
$$;

create function public.archive_checklist_item(p_item_id uuid, p_archived boolean default true)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.checklist_items%rowtype := private.checklist_item_for_update(p_item_id);
begin
  update public.checklist_items c set archived = coalesce(p_archived, true),
    updated_by = auth.uid(), updated_at = now(), version = c.version + 1
    where c.id = v_row.id returning c.version into v_row.version;
  return v_row.version;
end;
$$;

-- Links a team run (its run id, as in the work briefs) to the item, or unlinks it (null).
create function public.link_checklist_run(p_item_id uuid, p_run_id text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.checklist_items%rowtype := private.checklist_item_for_update(p_item_id);
  v_run text := nullif(btrim(coalesce(p_run_id, '')), '');
begin
  if v_run is not null and v_run !~ '^[A-Za-z0-9_-]{1,100}$' then
    raise exception 'invalid_run' using errcode = '22023';
  end if;
  update public.checklist_items c set run_id = v_run,
    updated_by = auth.uid(), updated_at = now(), version = c.version + 1
    where c.id = v_row.id returning c.version into v_row.version;
  return v_row.version;
end;
$$;

create function private.announce_checklist_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('item_id', coalesce(new.id, old.id)),
    'checklist_changed',
    'teams:' || coalesce(new.project_id, old.project_id)::text || ':briefs',
    true
  );
  return null;
end;
$$;
create trigger checklist_items_announce after insert or update or delete on public.checklist_items
  for each row execute function private.announce_checklist_change();

revoke all on function private.checklist_assignee_ok(uuid, uuid), private.checklist_item_for_update(uuid), private.announce_checklist_change()
  from public, anon, authenticated;
revoke all on function public.add_checklist_item(uuid, text, text, uuid), public.update_checklist_item(uuid, text, text, uuid),
  public.set_checklist_status(uuid, text, text), public.claim_checklist_item(uuid), public.archive_checklist_item(uuid, boolean),
  public.link_checklist_run(uuid, text) from public, anon;
grant execute on function public.add_checklist_item(uuid, text, text, uuid), public.update_checklist_item(uuid, text, text, uuid),
  public.set_checklist_status(uuid, text, text), public.claim_checklist_item(uuid), public.archive_checklist_item(uuid, boolean),
  public.link_checklist_run(uuid, text) to authenticated;
