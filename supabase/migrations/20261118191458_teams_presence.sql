-- 0rqestra Teams, phase 2: who is online, through Supabase Realtime Presence on private channels.
--
-- Each member publishes presence only on their own topic for a shared project:
--   teams:<shared project id>:user:<user id>
-- Row-level security on realtime.messages decides, when a channel is joined (and again when a new
-- access token is sent):
-- * read (select, extension 'presence'): the caller is a member of the project's team, and the user
--   in the topic is a member of that team too;
-- * publish (insert, extension 'presence'): the same, and the user in the topic is the caller.
-- So presence on a topic always belongs to the account in the topic: a client cannot appear online
-- as a teammate by changing a payload field, and a nonmember can neither listen nor publish.
--
-- Dashboard: Realtime → Settings → turn OFF "Allow public access", so only private channels
-- (which these policies govern) can be joined.

create function private.presence_topic_allowed(p_topic text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_match text[];
  v_project uuid;
  v_user uuid;
begin
  v_match := regexp_match(
    coalesce(p_topic, ''),
    '^teams:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  );
  if v_match is null or auth.uid() is null then
    return false;
  end if;
  v_project := v_match[1]::uuid;
  v_user := v_match[2]::uuid;
  if p_write and v_user <> auth.uid() then
    return false;
  end if;
  return exists (
    select 1
    from public.shared_projects p
    join public.team_members me on me.team_id = p.team_id and me.user_id = auth.uid()
    join public.team_members them on them.team_id = p.team_id and them.user_id = v_user
    where p.id = v_project
  );
end;
$$;
revoke all on function private.presence_topic_allowed(text, boolean) from public, anon;
grant execute on function private.presence_topic_allowed(text, boolean) to authenticated;

create policy "Teams members listen to presence" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'presence' and private.presence_topic_allowed((select realtime.topic()), false));

create policy "Teams members publish their own presence" on realtime.messages
  for insert to authenticated
  with check (realtime.messages.extension = 'presence' and private.presence_topic_allowed((select realtime.topic()), true));
