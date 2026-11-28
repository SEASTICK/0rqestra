-- 0rqestra: friends see each other online, before they share a project.
--
-- Like the Team Bridge (…_teams_presence.sql), each person publishes Realtime Presence only on
-- their own private topic:
--   friends:presence:<user id>
-- Row-level security on realtime.messages decides, when the channel is joined (and again when a
-- new access token is sent):
-- * read (select, extension 'presence'): the caller is the user in the topic, or an accepted friend
--   of that user. A pending request gives no access.
-- * publish (insert, extension 'presence'): only the user in the topic.
-- So presence on a topic always belongs to its account, and only friends can see it. Ending the
-- friendship ends the access at the next check.

create function private.friend_presence_allowed(p_topic text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_match text[];
  v_user uuid;
begin
  v_match := regexp_match(coalesce(p_topic, ''), '^friends:presence:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if v_match is null or auth.uid() is null then
    return false;
  end if;
  v_user := v_match[1]::uuid;
  if v_user = auth.uid() then
    return true;
  end if;
  if p_write then
    return false;
  end if;
  return private.are_friends(auth.uid(), v_user);
end;
$$;
revoke all on function private.friend_presence_allowed(text, boolean) from public, anon;
grant execute on function private.friend_presence_allowed(text, boolean) to authenticated;

create policy "Friends listen to each other's presence" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'presence' and private.friend_presence_allowed((select realtime.topic()), false));

create policy "People publish their own friends presence" on realtime.messages
  for insert to authenticated
  with check (realtime.messages.extension = 'presence' and private.friend_presence_allowed((select realtime.topic()), true));
