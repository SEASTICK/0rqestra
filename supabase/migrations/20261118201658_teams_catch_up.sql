-- 0rqestra Teams, phase 4: catch-up and per-user read tracking.
--
-- * brief_reads records, per user, the newest revision (seq) of each brief they have been shown.
--   A user reads and writes only their own rows, and only for briefs of projects they belong to.
-- * public.team_catch_up(project) returns teammates' briefs the caller has not seen at their current
--   revision: active ones (started or changed) and runs finished in the last 14 days. The caller's
--   own briefs are never included.
-- * public.mark_briefs_seen(project, items) records what the app has shown. A revision can only
--   move forward, and never past the brief's real revision. The app calls it only after the
--   catch-up is in the chat, so anything not yet shown stays eligible.

create table public.brief_reads (
  user_id uuid not null references auth.users (id) on delete cascade,
  brief_id uuid not null references public.work_briefs (id) on delete cascade,
  seen_seq integer not null check (seen_seq >= 1),
  seen_at timestamptz not null default now(),
  primary key (user_id, brief_id)
);
create index brief_reads_brief_id_idx on public.brief_reads (brief_id);

alter table public.brief_reads enable row level security;
revoke all on public.brief_reads from anon, authenticated;
grant select on public.brief_reads to authenticated;
create policy "Users read their own brief reads" on public.brief_reads
  for select to authenticated using (user_id = (select auth.uid()));

create function public.team_catch_up(p_project_id uuid)
returns table (
  brief_id uuid, run_id text, author_id uuid, author_name text, title text, status text, branch text,
  paths text[], outcome text, seq integer, seen_seq integer, updated_at timestamptz, finished_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  if not private.is_project_member(p_project_id) then
    raise exception 'not_project_member' using errcode = '42501';
  end if;
  return query
    select b.id, b.run_id, b.author_id, b.author_name, b.title, b.status, b.branch, b.paths, b.outcome, b.seq,
           r.seen_seq, b.updated_at, b.finished_at
    from public.work_briefs b
    left join public.brief_reads r on r.brief_id = b.id and r.user_id = auth.uid()
    where b.project_id = p_project_id
      and b.author_id <> auth.uid()
      and (b.status in ('in_progress', 'blocked') or b.finished_at > now() - interval '14 days')
      and (r.seen_seq is null or r.seen_seq < b.seq)
    order by b.updated_at desc
    limit 50;
end;
$$;

create function public.mark_briefs_seen(p_project_id uuid, p_items jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  if not private.is_project_member(p_project_id) then
    raise exception 'not_project_member' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  with wanted as (
    select (i ->> 'id')::uuid as brief_id, (i ->> 'seq')::integer as seq
    from jsonb_array_elements(p_items) as i
    where (i ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and (i ->> 'seq') ~ '^[0-9]{1,7}$'
  ), allowed as (
    -- Only briefs of this project, and never a revision the brief does not have yet.
    select w.brief_id, least(w.seq, b.seq) as seq
    from wanted w join public.work_briefs b on b.id = w.brief_id
    where b.project_id = p_project_id and w.seq >= 1
  )
  insert into public.brief_reads as r (user_id, brief_id, seen_seq)
  select auth.uid(), a.brief_id, a.seq from allowed a
  on conflict (user_id, brief_id) do update set seen_seq = greatest(r.seen_seq, excluded.seen_seq), seen_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.team_catch_up(uuid), public.mark_briefs_seen(uuid, jsonb) from public, anon;
grant execute on function public.team_catch_up(uuid), public.mark_briefs_seen(uuid, jsonb) to authenticated;
