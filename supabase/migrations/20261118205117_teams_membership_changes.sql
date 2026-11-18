-- 0rqestra Teams: announce membership changes to the team's projects.
--
-- Found while verifying phases 1-5: when someone joined (or left) a team, the other members' apps
-- did not notice until they restarted, so the new member's status and Manager did not appear in
-- their Team Bridge. A content-free "team_changed" broadcast now goes to every project of the team
-- on its private briefs topic (which only members can listen to); the app then reads the team again.

create function private.announce_team_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid := coalesce(new.team_id, old.team_id);
  v_project uuid;
begin
  for v_project in select p.id from public.shared_projects p where p.team_id = v_team loop
    perform realtime.send(jsonb_build_object('team_id', v_team), 'team_changed', 'teams:' || v_project::text || ':briefs', true);
  end loop;
  return null;
end;
$$;
revoke all on function private.announce_team_change() from public, anon, authenticated;
create trigger team_members_announce after insert or delete on public.team_members
  for each row execute function private.announce_team_change();
