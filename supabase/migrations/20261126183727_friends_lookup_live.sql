-- 0rqestra friends: look a person up before asking, clear answers for repeated requests, a safe
-- cancel, display names, and live updates. Builds on …_accounts_friends.sql and keeps every
-- existing profile and friendship as it is.
--
-- Rules (the acting user is always auth.uid()):
-- * find_friend_candidate: exact username, case-insensitive. Returns the username, display name and
--   how you two are related; never an email address.
-- * send_friend_request no longer accepts a request that person already sent you: it answers
--   'incoming_pending' with that request's id, so the app can ask you to accept it. Repeated and
--   simultaneous requests still leave one row per pair.
-- * cancel_friend_request withdraws only a request you sent that is still pending; it never ends a
--   friendship that was accepted a moment earlier.
-- * Every change to a friendship or a team invitation sends a content-free "friends_changed"
--   broadcast to the private topic friends:<user id> of each person involved; only that user can
--   listen to it, and no client can send on it (no insert policy). The app then reads its lists.

-- ---------------------------------------------------------------------------------------------
-- Display names (chosen at sign-up, kept in the account's metadata)
-- ---------------------------------------------------------------------------------------------

create function private.display_name_of(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select nullif(left(btrim(u.raw_user_meta_data ->> 'display_name'), 60), '') from auth.users u where u.id = p_user;
$$;

-- ---------------------------------------------------------------------------------------------
-- Lookup
-- ---------------------------------------------------------------------------------------------

-- relation: 'self', 'none', 'friend', 'outgoing' (you asked them) or 'incoming' (they asked you).
create function public.find_friend_candidate(p_username text)
returns table (user_id uuid, username text, display_name text, relation text, request_id uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_row public.friendships%rowtype;
begin
  perform private.require_username();
  select pr.user_id into v_target from public.profiles pr where pr.username = private.normalize_username(p_username);
  if v_target is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  select * into v_row from public.friendships f
    where least(f.requester_id, f.addressee_id) = least(v_uid, v_target) and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, v_target);
  return query select v_target, private.username_of(v_target), private.display_name_of(v_target),
    case when v_target = v_uid then 'self'
         when v_row.id is null then 'none'
         when v_row.status = 'accepted' then 'friend'
         when v_row.requester_id = v_uid then 'outgoing'
         else 'incoming' end,
    v_row.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Sending: one row per pair, and a clear answer for every case
-- ---------------------------------------------------------------------------------------------

drop function public.send_friend_request(text);

-- outcome: 'sent', 'already_pending' (you had asked before), 'already_friends', or
-- 'incoming_pending' (they asked you first: request_id is their request, to accept).
create function public.send_friend_request(p_username text)
returns table (request_id uuid, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_row public.friendships%rowtype;
begin
  perform private.require_username();
  select pr.user_id into v_target from public.profiles pr where pr.username = private.normalize_username(p_username);
  if v_target is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if v_target = v_uid then
    raise exception 'cannot_friend_self' using errcode = '22023';
  end if;
  for attempt in 1..2 loop
    select * into v_row from public.friendships f
      where least(f.requester_id, f.addressee_id) = least(v_uid, v_target) and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, v_target)
      for update;
    if found then
      return query select v_row.id, v_row.status,
        case when v_row.status = 'accepted' then 'already_friends'
             when v_row.requester_id = v_uid then 'already_pending'
             else 'incoming_pending' end;
      return;
    end if;
    if (select count(*) from public.friendships f where f.requester_id = v_uid and f.status = 'pending') >= 100 then
      raise exception 'too_many_requests' using errcode = '54000';
    end if;
    begin
      insert into public.friendships (requester_id, addressee_id, status) values (v_uid, v_target, 'pending') returning * into v_row;
      return query select v_row.id, v_row.status, 'sent'::text;
      return;
    exception when unique_violation then
      -- The other person asked at the same moment: the next pass reads their row.
      null;
    end;
  end loop;
  raise exception 'try_again' using errcode = '40001';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Cancelling a sent request (never an accepted friendship)
-- ---------------------------------------------------------------------------------------------

-- Returns 'cancelled', 'accepted' (it was accepted first; nothing changed) or 'gone'.
create function public.cancel_friend_request(p_user_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_row public.friendships%rowtype;
begin
  perform private.current_email();
  select * into v_row from public.friendships f
    where least(f.requester_id, f.addressee_id) = least(v_uid, p_user_id) and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_user_id)
    for update;
  if not found then
    return 'gone';
  end if;
  if v_row.status = 'accepted' then
    return 'accepted';
  end if;
  if v_row.requester_id <> v_uid then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  delete from public.friendships f where f.id = v_row.id;
  return 'cancelled';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Lists carry display names
-- ---------------------------------------------------------------------------------------------

drop function public.list_friends();
create function public.list_friends()
returns table (request_id uuid, user_id uuid, username text, display_name text, state text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.id,
         o.other,
         coalesce(private.username_of(o.other), 'unknown'),
         private.display_name_of(o.other),
         case when f.status = 'accepted' then 'friend' when f.requester_id = auth.uid() then 'outgoing' else 'incoming' end,
         f.created_at
  from public.friendships f
  cross join lateral (select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end as other) o
  where auth.uid() in (f.requester_id, f.addressee_id)
  order by f.created_at desc
  limit 500;
$$;

-- ---------------------------------------------------------------------------------------------
-- Live updates
-- ---------------------------------------------------------------------------------------------

create function private.announce_friends_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_people uuid[];
  v_user uuid;
begin
  if tg_table_name = 'friendships' then
    v_people := array[coalesce(new.requester_id, old.requester_id), coalesce(new.addressee_id, old.addressee_id)];
  else
    v_people := array[coalesce(new.invitee_id, old.invitee_id), coalesce(new.invited_by, old.invited_by)];
  end if;
  foreach v_user in array v_people loop
    perform realtime.send('{}'::jsonb, 'friends_changed', 'friends:' || v_user::text, true);
  end loop;
  return null;
end;
$$;
create trigger friendships_announce after insert or update or delete on public.friendships
  for each row execute function private.announce_friends_change();
create trigger team_member_invites_announce after insert or update or delete on public.team_member_invites
  for each row execute function private.announce_friends_change();

-- Only the user in the topic listens; there is no insert policy, so no client can send on it.
create policy "People listen to their own friend changes" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) = 'friends:' || (select auth.uid())::text);

-- ---------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function private.display_name_of(uuid), private.announce_friends_change() from public, anon, authenticated;
revoke all on function public.find_friend_candidate(text), public.send_friend_request(text), public.cancel_friend_request(uuid), public.list_friends()
  from public, anon;
grant execute on function public.find_friend_candidate(text), public.send_friend_request(text), public.cancel_friend_request(uuid), public.list_friends()
  to authenticated;
