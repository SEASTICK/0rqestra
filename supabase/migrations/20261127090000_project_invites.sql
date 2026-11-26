-- 0rqestra: start a project together with a friend.
--
-- A project invitation names one shared project. Team membership opens every project of a team, so
-- an invitation is only allowed for a project that is alone in its team; "start a new shared
-- project" makes a team of its own for it (start_project_together). The invited person sees the
-- project's name and repository through list_project_invites, nothing else, until they accept.
--
-- Rules (the acting user is always auth.uid()):
-- * Only the owner of the project's team invites, and only an accepted friend. One pending
--   invitation per project and person; inviting again returns it.
-- * Only the invited person accepts or declines. Accepting adds the membership and marks the
--   invitation accepted in one transaction, under a row lock, so repeated or simultaneous accepts
--   give one membership. If the team gained another project meanwhile, accepting is refused.
-- * The inviter or the team owner cancels a pending invitation. Ending the friendship cancels it.
-- * While an invitation is pending nothing changes in the team: the project, its briefs and its
--   reservations stay readable by members only (their existing row-level security).
-- * Every change is announced to both people's private friends:<user> topic (live updates), and an
--   acceptance to the project's members through the existing team_changed broadcast.

create table public.project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  invitee_id uuid not null references auth.users (id) on delete cascade,
  invited_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (invitee_id <> invited_by)
);
create unique index project_invites_one_pending_idx on public.project_invites (project_id, invitee_id) where status = 'pending';
create index project_invites_invitee_idx on public.project_invites (invitee_id);
create index project_invites_invited_by_idx on public.project_invites (invited_by);
create index project_invites_project_idx on public.project_invites (project_id);
create index project_invites_team_idx on public.project_invites (team_id);
alter table public.project_invites enable row level security;
revoke all on public.project_invites from anon, authenticated;
grant select on public.project_invites to authenticated;
create policy "People read their own project invites" on public.project_invites
  for select to authenticated using ((select auth.uid()) in (invitee_id, invited_by));

create trigger project_invites_announce after insert or update or delete on public.project_invites
  for each row execute function private.announce_friends_change();

-- Whether a project is the only one in its team (so membership exposes nothing else).
create function private.project_alone_in_team(p_project uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.shared_projects o where o.team_id = p.team_id) = 1
  from public.shared_projects p where p.id = p_project;
$$;

create function private.create_project_invite(p_project uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_team uuid;
  v_id uuid;
begin
  select p.team_id into v_team from public.shared_projects p where p.id = p_project;
  if v_team is null or not private.is_team_owner(v_team) then
    raise exception 'not_team_owner' using errcode = '42501';
  end if;
  if p_user is null or not private.are_friends(v_uid, p_user) then
    raise exception 'not_friends' using errcode = '42501';
  end if;
  if exists (select 1 from public.team_members m where m.team_id = v_team and m.user_id = p_user) then
    raise exception 'already_member' using errcode = '23505';
  end if;
  if not private.project_alone_in_team(p_project) then
    raise exception 'project_team_has_other_projects' using errcode = '42501';
  end if;
  select i.id into v_id from public.project_invites i where i.project_id = p_project and i.invitee_id = p_user and i.status = 'pending';
  if v_id is not null then
    return v_id;
  end if;
  if (select count(*) from public.project_invites i where i.invited_by = v_uid and i.status = 'pending') >= 50 then
    raise exception 'too_many_invites' using errcode = '54000';
  end if;
  begin
    insert into public.project_invites (project_id, team_id, invitee_id, invited_by) values (p_project, v_team, p_user, v_uid) returning id into v_id;
  exception when unique_violation then
    select i.id into v_id from public.project_invites i where i.project_id = p_project and i.invitee_id = p_user and i.status = 'pending';
  end;
  return v_id;
end;
$$;

-- Invites a friend to an existing shared project (alone in a team the caller owns).
create function public.invite_friend_to_project(p_project_id uuid, p_user_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_username();
  return private.create_project_invite(p_project_id, p_user_id);
end;
$$;

-- A new shared project of its own: a team named after it (the caller owns it), the project for this
-- GitHub repository, and the invitation, all in one transaction.
create function public.start_project_together(p_name text, p_repo_owner text, p_repo_name text, p_user_id uuid)
returns table (invite_id uuid, project_id uuid, team_id uuid, repo_key text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_team uuid;
  v_project public.shared_projects%rowtype;
  v_invite uuid;
begin
  perform private.require_username();
  if p_user_id is null or not private.are_friends(v_uid, p_user_id) then
    raise exception 'not_friends' using errcode = '42501';
  end if;
  v_team := public.create_team(p_name);
  insert into public.shared_projects (team_id, name, repo_owner, repo_name, created_by)
    values (v_team, btrim(p_name), p_repo_owner, p_repo_name, v_uid) returning * into v_project;
  v_invite := private.create_project_invite(v_project.id, p_user_id);
  return query select v_invite, v_project.id, v_team, v_project.repo_key;
end;
$$;

-- The invited person accepts (returns the project) or declines (returns null).
create function public.respond_project_invite(p_invite_id uuid, p_accept boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := private.current_email();
  v_inv public.project_invites%rowtype;
begin
  perform private.require_username();
  select * into v_inv from public.project_invites i where i.id = p_invite_id and i.invitee_id = v_uid for update;
  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_inv.status = 'accepted' then
    return v_inv.project_id;
  end if;
  if v_inv.status = 'revoked' then
    raise exception 'invite_revoked' using errcode = 'P0001';
  end if;
  if v_inv.status = 'declined' then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if not coalesce(p_accept, false) then
    update public.project_invites i set status = 'declined', responded_at = now() where i.id = v_inv.id;
    return null;
  end if;
  if not private.project_alone_in_team(v_inv.project_id) then
    raise exception 'project_team_has_other_projects' using errcode = '42501';
  end if;
  insert into public.team_members (team_id, user_id, role, email) values (v_inv.team_id, v_uid, 'member', v_email)
    on conflict (team_id, user_id) do nothing;
  update public.project_invites i set status = 'accepted', responded_at = now() where i.id = v_inv.id;
  return v_inv.project_id;
end;
$$;

-- The inviter or the team owner withdraws a pending invitation. Cancelling twice is harmless.
create function public.revoke_project_invite(p_invite_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.project_invites%rowtype;
begin
  perform private.current_email();
  select * into v_inv from public.project_invites i where i.id = p_invite_id for update;
  if not found or not (v_inv.invited_by = v_uid or private.is_team_owner(v_inv.team_id)) then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'pending' then
    return v_inv.status;
  end if;
  update public.project_invites i set status = 'revoked', responded_at = now() where i.id = v_inv.id;
  return 'revoked';
end;
$$;

-- Pending invitations to me (incoming) and from me (outgoing): who, the project's name and its
-- repository. Usernames and display names only.
create function public.list_project_invites()
returns table (invite_id uuid, project_id uuid, team_id uuid, project_name text, repo_owner text, repo_name text, user_id uuid, username text, display_name text, direction text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.project_id, i.team_id, p.name, p.repo_owner, p.repo_name,
         o.other, coalesce(private.username_of(o.other), 'unknown'), private.display_name_of(o.other),
         case when i.invitee_id = auth.uid() then 'incoming' else 'outgoing' end,
         i.created_at
  from public.project_invites i
  join public.shared_projects p on p.id = i.project_id
  cross join lateral (select case when i.invitee_id = auth.uid() then i.invited_by else i.invitee_id end as other) o
  where i.status = 'pending' and auth.uid() in (i.invitee_id, i.invited_by)
  order by i.created_at desc
  limit 200;
$$;

-- Ending a friendship also withdraws pending project invitations between the two people.
create or replace function public.remove_friend(p_user_id uuid) returns void
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
  update public.project_invites i set status = 'revoked', responded_at = now()
    where i.status = 'pending' and ((i.invited_by = v_uid and i.invitee_id = p_user_id) or (i.invited_by = p_user_id and i.invitee_id = v_uid));
end;
$$;

revoke all on function private.project_alone_in_team(uuid), private.create_project_invite(uuid, uuid) from public, anon, authenticated;
revoke all on function public.invite_friend_to_project(uuid, uuid), public.start_project_together(text, text, text, uuid),
  public.respond_project_invite(uuid, boolean), public.revoke_project_invite(uuid), public.list_project_invites() from public, anon;
grant execute on function public.invite_friend_to_project(uuid, uuid), public.start_project_together(text, text, text, uuid),
  public.respond_project_invite(uuid, boolean), public.revoke_project_invite(uuid), public.list_project_invites() to authenticated;
