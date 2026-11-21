-- 0rqestra Teams: transfer ownership, so an owner can leave a team that still has members.
-- Only the current owner can call it, only to a current member, in one transaction. Removing a
-- member (owner), leaving (member) and deleting a team (owner) stay with the existing policies.

create function public.transfer_team_ownership(p_team_id uuid, p_new_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  perform private.current_email();
  if not private.is_team_owner(p_team_id) then
    raise exception 'not_team_owner' using errcode = '42501';
  end if;
  if p_new_owner is null or p_new_owner = v_uid then
    raise exception 'invalid_new_owner' using errcode = '22023';
  end if;
  if not exists (select 1 from public.team_members m where m.team_id = p_team_id and m.user_id = p_new_owner) then
    raise exception 'not_a_member' using errcode = 'P0002';
  end if;
  -- One owner row per team: step down first, then promote.
  update public.team_members m set role = 'member' where m.team_id = p_team_id and m.user_id = v_uid;
  update public.team_members m set role = 'owner' where m.team_id = p_team_id and m.user_id = p_new_owner;
  update public.teams t set owner_id = p_new_owner where t.id = p_team_id;
  -- Pending invitations stay valid; only the new owner can manage them from now on.
end;
$$;
revoke all on function public.transfer_team_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_team_ownership(uuid, uuid) to authenticated;

-- Members also hear when a role changes (an ownership transfer), like joins and removals.
create trigger team_members_announce_update after update of role on public.team_members
  for each row execute function private.announce_team_change();
