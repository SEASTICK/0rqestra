-- 0rqestra Teams, phase 3: one work brief per team run, published by the run's owner.
--
-- * work_briefs (from phase 1) gets the run's id, the author's display name, the Git branch, the
--   expected repository-relative paths, a short outcome, a sequence number and a finish time.
-- * Briefs are written only through public.publish_run_brief. It takes the author from the
--   session, checks project membership and every field, and is safe to retry: (project, author,
--   run) is unique, an update applies only with a higher sequence number, and a finished brief
--   (completed, stopped, failed) never changes again, so a late update cannot reopen it.
-- * Members of the project's team read briefs; nobody writes them directly.
-- * Every change sends a small "brief_changed" broadcast (ids only, no content) on the private
--   topic teams:<project>:briefs, which only project members may listen to. Clients then read the
--   briefs again through the API, so a missed broadcast is recovered by the next read.
-- * Finished briefs keep their outcome and finish time for the phase 4 catch-up.

alter table public.work_briefs
  add column run_id text,
  add column author_name text,
  add column branch text,
  add column paths text[] not null default '{}',
  add column outcome text,
  add column seq integer not null default 0,
  add column finished_at timestamptz;

-- Phase 1 created the table empty; map any earlier rows to the new status set before it applies.
update public.work_briefs set run_id = id::text where run_id is null;
update public.work_briefs set status = case status when 'open' then 'in_progress' when 'draft' then 'in_progress' else 'completed' end
  where status not in ('in_progress', 'blocked', 'completed', 'stopped', 'failed');
alter table public.work_briefs drop constraint if exists work_briefs_status_check;
alter table public.work_briefs
  alter column run_id set not null,
  alter column status set default 'in_progress',
  add constraint work_briefs_status_check check (status in ('in_progress', 'blocked', 'completed', 'stopped', 'failed')),
  add constraint work_briefs_run_id_check check (run_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  add constraint work_briefs_author_name_check check (author_name is null or char_length(author_name) <= 80),
  add constraint work_briefs_branch_check check (branch is null or char_length(branch) <= 250),
  add constraint work_briefs_paths_check check (cardinality(paths) <= 50),
  add constraint work_briefs_outcome_check check (outcome is null or char_length(outcome) <= 500),
  add constraint work_briefs_one_per_run unique (project_id, author_id, run_id);
create index work_briefs_active_idx on public.work_briefs (project_id, status);

-- Only the function below writes briefs.
drop policy if exists "Project members write their own briefs" on public.work_briefs;
drop policy if exists "Authors edit their briefs" on public.work_briefs;
drop policy if exists "Authors delete their briefs" on public.work_briefs;
revoke insert, update, delete on public.work_briefs from authenticated;

-- A repository-relative path: plain segments, no "..", no leading slash, no drive letter or
-- backslash, so an absolute local path can never be stored.
create function private.is_repo_path(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null
    and p ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*/?$'
    and char_length(p) <= 300
    and p !~ '(^|/)\.\.?(/|$)';
$$;
revoke all on function private.is_repo_path(text) from public, anon;
grant execute on function private.is_repo_path(text) to authenticated;

create function public.publish_run_brief(
  p_project_id uuid,
  p_run_id text,
  p_seq integer,
  p_status text,
  p_title text,
  p_branch text default null,
  p_paths text[] default '{}',
  p_outcome text default null
)
returns table (brief_id uuid, status text, seq integer, applied boolean, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  v_branch text := nullif(btrim(coalesce(p_branch, '')), '');
  v_outcome text := nullif(btrim(regexp_replace(coalesce(p_outcome, ''), '\s+', ' ', 'g')), '');
  v_paths text[] := coalesce(p_paths, '{}');
  v_terminal boolean := p_status in ('completed', 'stopped', 'failed');
  v_row public.work_briefs%rowtype;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  if not private.is_project_member(p_project_id) then
    raise exception 'not_project_member' using errcode = '42501';
  end if;
  if p_run_id is null or p_run_id !~ '^[A-Za-z0-9_-]{1,100}$' then
    raise exception 'invalid_run_id' using errcode = '22023';
  end if;
  if p_seq is null or p_seq < 1 or p_seq > 1000000 then
    raise exception 'invalid_seq' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('in_progress', 'blocked', 'completed', 'stopped', 'failed') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  if v_branch is not null and (char_length(v_branch) > 250 or v_branch ~ '[[:cntrl:]]') then
    raise exception 'invalid_branch' using errcode = '22023';
  end if;
  if cardinality(v_paths) > 50 or exists (select 1 from unnest(v_paths) as p where not private.is_repo_path(p)) then
    raise exception 'invalid_paths' using errcode = '22023';
  end if;
  if v_outcome is not null and char_length(v_outcome) > 500 then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  select split_part(m.email, '@', 1) into v_name
  from public.shared_projects p join public.team_members m on m.team_id = p.team_id and m.user_id = v_uid
  where p.id = p_project_id;

  insert into public.work_briefs as b (project_id, author_id, run_id, author_name, title, body, status, branch, paths, outcome, seq, finished_at, updated_at)
  values (p_project_id, v_uid, p_run_id, left(v_name, 80), v_title, '', p_status, v_branch, v_paths, v_outcome, p_seq,
          case when v_terminal then now() end, now())
  on conflict (project_id, author_id, run_id) do update set
    title = excluded.title,
    status = excluded.status,
    branch = excluded.branch,
    paths = excluded.paths,
    outcome = excluded.outcome,
    seq = excluded.seq,
    finished_at = excluded.finished_at,
    author_name = excluded.author_name
  where b.seq < excluded.seq and b.status not in ('completed', 'stopped', 'failed')
  returning * into v_row;

  if found then
    return query select v_row.id, v_row.status, v_row.seq, true, v_row.updated_at;
  else
    -- A repeat or a late update: nothing changed. Report what is stored.
    return query select b.id, b.status, b.seq, false, b.updated_at from public.work_briefs b
      where b.project_id = p_project_id and b.author_id = v_uid and b.run_id = p_run_id;
  end if;
end;
$$;
revoke all on function public.publish_run_brief(uuid, text, integer, text, text, text, text[], text) from public, anon;
grant execute on function public.publish_run_brief(uuid, text, integer, text, text, text, text[], text) to authenticated;

-- Tell project members that a brief changed (ids only).
create function private.announce_brief_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('brief_id', new.id, 'status', new.status, 'seq', new.seq),
    'brief_changed',
    'teams:' || new.project_id::text || ':briefs',
    true
  );
  return null;
end;
$$;
revoke all on function private.announce_brief_change() from public, anon, authenticated;
create trigger work_briefs_announce after insert or update on public.work_briefs
  for each row execute function private.announce_brief_change();

create function private.briefs_topic_allowed(p_topic text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_match text[];
begin
  v_match := regexp_match(coalesce(p_topic, ''), '^teams:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):briefs$');
  if v_match is null or auth.uid() is null then
    return false;
  end if;
  return private.is_project_member(v_match[1]::uuid);
end;
$$;
revoke all on function private.briefs_topic_allowed(text) from public, anon;
grant execute on function private.briefs_topic_allowed(text) to authenticated;

-- Members listen; there is deliberately no insert policy for this topic, so no client can send a
-- fake "brief_changed".
create policy "Teams members listen to brief changes" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'broadcast' and private.briefs_topic_allowed((select realtime.topic())));
