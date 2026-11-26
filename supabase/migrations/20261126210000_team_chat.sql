-- Team chat in a shared project: short messages that every member of the project reads, and the
-- Manager summaries a member chooses to share. Each member's own Manager reads the latest messages as
-- part of "Team right now", so it can sort what people ask for and point out overlaps.
--
-- Like the work briefs, only a function writes: it takes the author from the session and the name from
-- the profile's username (never an email address), checks membership, length and a rate limit. Members
-- read the project's messages. A new message is announced on the project's existing live topic
-- teams:<project>:briefs as "message_added" (only project members may listen to it, see
-- *_teams_run_briefs.sql), and the apps then read the messages again.

create table public.team_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  author_name text not null default '',
  kind text not null default 'message',
  body text not null,
  created_at timestamptz not null default now(),
  constraint team_messages_kind_check check (kind in ('message', 'summary')),
  constraint team_messages_body_check check (char_length(body) between 1 and 4000)
);
create index team_messages_project_created_idx on public.team_messages (project_id, created_at desc);
create index team_messages_author_idx on public.team_messages (author_id);

alter table public.team_messages enable row level security;
revoke all on public.team_messages from anon, authenticated;
grant select on public.team_messages to authenticated;
create policy "Project members read the team chat" on public.team_messages
  for select to authenticated using (private.is_project_member(project_id));

create function public.send_team_message(p_project_id uuid, p_body text, p_kind text default 'message')
returns table (message_id uuid, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_row public.team_messages%rowtype;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  if not private.is_project_member(p_project_id) then
    raise exception 'not_project_member' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('message', 'summary') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 4000 then
    raise exception 'invalid_message' using errcode = '22023';
  end if;
  if (select count(*) from public.team_messages m where m.author_id = v_uid and m.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'too_many_messages' using errcode = '54000';
  end if;
  insert into public.team_messages (project_id, author_id, author_name, kind, body)
  values (p_project_id, v_uid, left(coalesce(private.username_of(v_uid), 'member'), 80), p_kind, v_body)
  returning * into v_row;
  return query select v_row.id, v_row.created_at;
end;
$$;
revoke all on function public.send_team_message(uuid, text, text) from public, anon;
grant execute on function public.send_team_message(uuid, text, text) to authenticated;

create function private.announce_team_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('message_id', new.id),
    'message_added',
    'teams:' || new.project_id::text || ':briefs',
    true
  );
  return null;
end;
$$;
revoke all on function private.announce_team_message() from public, anon, authenticated;
create trigger team_messages_announce after insert on public.team_messages
  for each row execute function private.announce_team_message();
