-- 0rqestra accounts: unique usernames, friends, and team invitations to friends.
--
-- Rules this file enforces in the database, whatever the app sends:
-- * A username is unique (lower case), set only by its owner, and only with a confirmed email.
-- * Email addresses stay private: friends and teammates see usernames, never emails.
--   team_members.email is no longer readable through the API.
-- * A friend request is created, answered and removed only through the functions below. Only the
--   person a request was sent to can accept or decline it. One row per pair of people, so a
--   repeated or crossing request never makes a duplicate; a request back accepts the first one.
-- * Only a team's owner can invite, and only an accepted friend. Only the invited person can accept
--   or decline. Accepting creates the membership and marks the invitation in one transaction;
--   accepting again returns the same team and changes nothing.

-- ---------------------------------------------------------------------------------------------
-- Usernames
-- ---------------------------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9_]{2,23}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
create policy "Users read their own profile" on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));

create function private.normalize_username(p text) returns text
language sql immutable set search_path = '' as $$
  select lower(btrim(coalesce(p, '')));
$$;

create function private.username_of(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select pr.username from public.profiles pr where pr.user_id = p_user;
$$;

-- Whether a username can be taken; asked before an account is created (so also by anon). It only
-- answers yes or no.
create function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.normalize_username(p_username) ~ '^[a-z0-9][a-z0-9_]{2,23}$'
    and not exists (select 1 from public.profiles pr where pr.username = private.normalize_username(p_username));
$$;

-- Sets or changes the caller's username. Teammates see the new name right away.
create function public.set_username(p_username text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_name text := private.normalize_username(p_username);
begin
  perform private.current_email();
  if v_name !~ '^[a-z0-9][a-z0-9_]{2,23}$' then
    raise exception 'invalid_username' using errcode = '22023';
  end if;
  begin
    insert into public.profiles (user_id, username) values (v_uid, v_name)
    on conflict (user_id) do update set username = excluded.username, updated_at = now();
  exception when unique_violation then
    raise exception 'username_taken' using errcode = '23505';
  end;
  update public.team_members m set username = v_name where m.user_id = v_uid and m.username is distinct from v_name;
  return v_name;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Teammates see usernames, not emails
-- ---------------------------------------------------------------------------------------------

alter table public.team_members add column username text;
update public.team_members m set username = pr.username from public.profiles pr where pr.user_id = m.user_id;

create function private.team_member_username() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.username := private.username_of(new.user_id);
  return new;
end;
$$;
create trigger team_members_username before insert on public.team_members
  for each row execute function private.team_member_username();

revoke select on public.team_members from authenticated;
grant select (team_id, user_id, role, username, joined_at) on public.team_members to authenticated;

-- Briefs and reservations carry the author's username (it was the part of the email before the @).
create function private.brief_author_name() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.author_name := coalesce(private.username_of(new.author_id), 'teammate');
  return new;
end;
$$;
create trigger work_briefs_author_name before insert or update on public.work_briefs
  for each row execute function private.brief_author_name();

create function private.reservation_holder_name() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.reserved_by_name := coalesce(private.username_of(new.reserved_by), 'teammate');
  return new;
end;
$$;
create trigger task_reservations_holder_name before insert or update on public.task_reservations
  for each row execute function private.reservation_holder_name();

-- Existing rows keep their name until their author next writes them (no profiles exist yet).

-- ---------------------------------------------------------------------------------------------
-- Friends
-- ---------------------------------------------------------------------------------------------

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users (id) on delete cascade,
  addressee_id uuid not null references auth.users (id) on delete cascade,
  status text not null check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);
-- One row per pair, whoever asked first.
create unique index friendships_pair_idx on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index friendships_requester_idx on public.friendships (requester_id);
create index friendships_addressee_idx on public.friendships (addressee_id);
alter table public.friendships enable row level security;
revoke all on public.friendships from anon, authenticated;
grant select on public.friendships to authenticated;
create policy "People read their own friendships" on public.friendships
  for select to authenticated using ((select auth.uid()) in (requester_id, addressee_id));

create function private.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted' and least(f.requester_id, f.addressee_id) = least(a, b) and greatest(f.requester_id, f.addressee_id) = greatest(a, b)
  );
$$;

-- The caller must be signed in with a confirmed email and have a username to use friends.
create function private.require_username() returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_name text;
begin
  perform private.current_email();
  v_name := private.username_of(auth.uid());
  if v_name is null then
    raise exception 'username_required' using errcode = '28000';
  end if;
  return v_name;
end;
$$;

-- Sends a request to the account with exactly this username. Returns the pair's state:
-- 'pending' (sent, or already sent before) or 'accepted' (they had asked you, or you are friends).
create function public.send_friend_request(p_username text)
returns table (request_id uuid, status text)
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
      if v_row.status = 'pending' and v_row.addressee_id = v_uid then
        update public.friendships f set status = 'accepted', responded_at = now() where f.id = v_row.id returning * into v_row;
      end if;
      return query select v_row.id, v_row.status;
      return;
    end if;
    if (select count(*) from public.friendships f where f.requester_id = v_uid and f.status = 'pending') >= 100 then
      raise exception 'too_many_requests' using errcode = '54000';
    end if;
    begin
      insert into public.friendships (requester_id, addressee_id, status) values (v_uid, v_target, 'pending') returning * into v_row;
      return query select v_row.id, v_row.status;
      return;
    exception when unique_violation then
      -- The other person asked at the same moment: read their row and answer it.
      null;
    end;
  end loop;
  raise exception 'try_again' using errcode = '40001';
end;
$$;

-- Only the person the request was sent to answers it. Declining removes the request (it can be
-- sent again later). Accepting an accepted request again is harmless.
create function public.respond_friend_request(p_request_id uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_row public.friendships%rowtype;
begin
  perform private.require_username();
  select * into v_row from public.friendships f where f.id = p_request_id and v_uid in (f.requester_id, f.addressee_id) for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_row.status = 'accepted' then
    return 'accepted';
  end if;
  if v_row.addressee_id <> v_uid then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if coalesce(p_accept, false) then
    update public.friendships f set status = 'accepted', responded_at = now() where f.id = v_row.id;
    return 'accepted';
  end if;
  delete from public.friendships f where f.id = v_row.id;
  return 'declined';
end;
$$;

-- Withdraws a request you sent, or ends a friendship. Pending team invitations between the two
-- people are withdrawn too.
create function public.remove_friend(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  perform private.current_email();
  delete from public.friendships f
    where least(f.requester_id, f.addressee_id) = least(v_uid, p_user_id) and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_user_id)
      and (f.status = 'accepted' or f.requester_id = v_uid);
  update public.team_member_invites i set status = 'revoked', responded_at = now()
    where i.status = 'pending' and ((i.invited_by = v_uid and i.invitee_id = p_user_id) or (i.invited_by = p_user_id and i.invitee_id = v_uid));
end;
$$;

-- Friends and requests, with usernames only.
create function public.list_friends()
returns table (request_id uuid, user_id uuid, username text, state text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.id,
         case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end,
         coalesce(private.username_of(case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end), 'unknown'),
         case when f.status = 'accepted' then 'friend' when f.requester_id = auth.uid() then 'outgoing' else 'incoming' end,
         f.created_at
  from public.friendships f
  where auth.uid() in (f.requester_id, f.addressee_id)
  order by f.created_at desc
  limit 500;
$$;

-- ---------------------------------------------------------------------------------------------
-- Team invitations to friends
-- ---------------------------------------------------------------------------------------------

create table public.team_member_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  invitee_id uuid not null references auth.users (id) on delete cascade,
  invited_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create unique index team_member_invites_one_pending_idx on public.team_member_invites (team_id, invitee_id) where status = 'pending';
create index team_member_invites_invitee_idx on public.team_member_invites (invitee_id);
create index team_member_invites_team_idx on public.team_member_invites (team_id);
create index team_member_invites_invited_by_idx on public.team_member_invites (invited_by);
alter table public.team_member_invites enable row level security;
revoke all on public.team_member_invites from anon, authenticated;
grant select on public.team_member_invites to authenticated;
create policy "Invitees and owners read team invites" on public.team_member_invites
  for select to authenticated using (invitee_id = (select auth.uid()) or private.is_team_owner(team_id));

-- Owner only, and only an accepted friend. Inviting again returns the pending invitation.
create function public.invite_friend_to_team(p_team_id uuid, p_user_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  perform private.require_username();
  if not private.is_team_owner(p_team_id) then
    raise exception 'not_team_owner' using errcode = '42501';
  end if;
  if p_user_id is null or not private.are_friends(v_uid, p_user_id) then
    raise exception 'not_friends' using errcode = '42501';
  end if;
  if exists (select 1 from public.team_members m where m.team_id = p_team_id and m.user_id = p_user_id) then
    raise exception 'already_member' using errcode = '23505';
  end if;
  select i.id into v_id from public.team_member_invites i where i.team_id = p_team_id and i.invitee_id = p_user_id and i.status = 'pending';
  if v_id is not null then
    return v_id;
  end if;
  if (select count(*) from public.team_member_invites i where i.team_id = p_team_id and i.status = 'pending') >= 50 then
    raise exception 'too_many_invites' using errcode = '54000';
  end if;
  begin
    insert into public.team_member_invites (team_id, invitee_id, invited_by) values (p_team_id, p_user_id, v_uid) returning id into v_id;
  exception when unique_violation then
    select i.id into v_id from public.team_member_invites i where i.team_id = p_team_id and i.invitee_id = p_user_id and i.status = 'pending';
  end;
  return v_id;
end;
$$;

-- The invited person accepts (returns the team) or declines (returns null). The row lock makes two
-- simultaneous answers wait for each other.
create function public.respond_team_invite(p_invite_id uuid, p_accept boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := private.current_email();
  v_inv public.team_member_invites%rowtype;
begin
  perform private.require_username();
  select * into v_inv from public.team_member_invites i where i.id = p_invite_id and i.invitee_id = v_uid for update;
  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_inv.status = 'accepted' then
    return v_inv.team_id;
  end if;
  if v_inv.status = 'revoked' then
    raise exception 'invite_revoked' using errcode = 'P0001';
  end if;
  if v_inv.status = 'declined' then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if not coalesce(p_accept, false) then
    update public.team_member_invites i set status = 'declined', responded_at = now() where i.id = v_inv.id;
    return null;
  end if;
  if not exists (select 1 from public.team_members m where m.team_id = v_inv.team_id and m.user_id = v_uid) then
    insert into public.team_members (team_id, user_id, role, email) values (v_inv.team_id, v_uid, 'member', v_email);
  end if;
  update public.team_member_invites i set status = 'accepted', responded_at = now() where i.id = v_inv.id;
  return v_inv.team_id;
end;
$$;

-- Owner only: withdraws a pending invitation.
create function public.revoke_team_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
begin
  perform private.current_email();
  select i.team_id into v_team from public.team_member_invites i where i.id = p_invite_id;
  if v_team is null or not private.is_team_owner(v_team) then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  update public.team_member_invites i set status = 'revoked', responded_at = now() where i.id = p_invite_id and i.status = 'pending';
end;
$$;

-- Pending invitations: to me (incoming), and from the teams I own (outgoing). Usernames only.
create function public.list_team_invites()
returns table (invite_id uuid, team_id uuid, team_name text, user_id uuid, username text, direction text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.team_id, t.name,
         case when i.invitee_id = auth.uid() then i.invited_by else i.invitee_id end,
         coalesce(private.username_of(case when i.invitee_id = auth.uid() then i.invited_by else i.invitee_id end), 'unknown'),
         case when i.invitee_id = auth.uid() then 'incoming' else 'outgoing' end,
         i.created_at
  from public.team_member_invites i join public.teams t on t.id = i.team_id
  where i.status = 'pending' and (i.invitee_id = auth.uid() or t.owner_id = auth.uid())
  order by i.created_at desc
  limit 200;
$$;

-- ---------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function private.normalize_username(text), private.username_of(uuid), private.team_member_username(),
  private.brief_author_name(), private.reservation_holder_name(), private.are_friends(uuid, uuid), private.require_username()
  from public, anon, authenticated;
grant execute on function private.normalize_username(text), private.username_of(uuid), private.are_friends(uuid, uuid), private.require_username() to authenticated;

revoke all on function public.username_available(text), public.set_username(text), public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean), public.remove_friend(uuid), public.list_friends(),
  public.invite_friend_to_team(uuid, uuid), public.respond_team_invite(uuid, boolean), public.revoke_team_invite(uuid),
  public.list_team_invites() from public, anon;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.set_username(text), public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean), public.remove_friend(uuid), public.list_friends(),
  public.invite_friend_to_team(uuid, uuid), public.respond_team_invite(uuid, boolean), public.revoke_team_invite(uuid),
  public.list_team_invites() to authenticated;
