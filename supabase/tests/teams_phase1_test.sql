-- Database tests for the Teams phase 1 migration. Run against a local Supabase stack with
--   supabase start
--   supabase test db
-- Everything runs in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- Three confirmed users: A (owner), B (invited teammate), C (not in the team). U is unconfirmed.
insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test', now(), 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test', now(), 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000c', 'c@example.test', now(), 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000d', 'u@example.test', null, 'authenticated', 'authenticated');

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;
create table pg_temp.ids (k text primary key, v text);
grant all on pg_temp.ids to authenticated;

-- Anonymous callers get nothing.
set local role anon;
select throws_ok($$ select * from public.teams $$, '42501', null, 'anon cannot read teams');
select throws_ok($$ select public.create_team('x') $$, '42501', null, 'anon cannot create a team');
reset role;

-- A creates a team and becomes its owner.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into pg_temp.ids values ('team', public.create_team('  Orq team  ')::text);
select is((select name from public.teams), 'Orq team', 'team name is trimmed');
select is((select role from public.team_members where user_id = auth.uid()), 'owner', 'creator is the owner');
select throws_ok($$ insert into public.teams (name, owner_id) values ('x', auth.uid()) $$, '42501', null, 'teams cannot be inserted directly');
select throws_ok($$ insert into public.team_members (team_id, user_id, role, email) values ((select v::uuid from pg_temp.ids where k = 'team'), '00000000-0000-0000-0000-00000000000c', 'member', 'c@example.test') $$, '42501', null, 'members cannot be inserted directly');

-- A registers a repository; a duplicate of the same repository (any case) is refused.
insert into public.shared_projects (team_id, name, repo_owner, repo_name)
  values ((select v::uuid from pg_temp.ids where k = 'team'), 'Demo', 'Seastick', 'Demo-Repo');
select is((select repo_key from public.shared_projects), 'github.com/seastick/demo-repo', 'repository key is normalized');
select throws_ok($$ insert into public.shared_projects (team_id, name, repo_owner, repo_name) values ((select v::uuid from pg_temp.ids where k = 'team'), 'Again', 'SEASTICK', 'demo-repo') $$, '23505', null, 'one shared project per repository per team');

-- A invites B; only the code's hash is stored and it is not readable.
insert into pg_temp.ids select 'code', code from public.create_invitation((select v::uuid from pg_temp.ids where k = 'team'), ' B@Example.test ');
select matches((select v from pg_temp.ids where k = 'code'), '^[0-9A-F]{6}(-[0-9A-F]{6}){3}$', 'code has the expected format');
select is((select email from public.team_invitations), 'b@example.test', 'invited email is normalized');
select throws_ok($$ select code_hash from public.team_invitations $$, '42501', null, 'code hash is not readable');
reset role;

-- C (not a member) cannot see or change anything, and cannot invite.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select is((select count(*) from public.teams), 0::bigint, 'nonmember sees no teams');
select is((select count(*) from public.shared_projects), 0::bigint, 'nonmember sees no projects');
select is((select count(*) from public.team_members), 0::bigint, 'nonmember sees no members');
update public.shared_projects set name = 'hijacked';
delete from public.teams;
reset role;
select is((select name from public.shared_projects), 'Demo', 'nonmember cannot rename or delete');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select throws_ok($$ select * from public.create_invitation((select v::uuid from pg_temp.ids where k = 'team'), 'c@example.test') $$, '42501', 'not_team_owner', 'nonmember cannot invite');
select throws_ok($$ select public.redeem_invitation((select v from pg_temp.ids where k = 'code')) $$, '42501', 'invite_wrong_email', 'wrong account cannot redeem');
reset role;

-- An unconfirmed account cannot redeem.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select throws_ok($$ select public.redeem_invitation((select v from pg_temp.ids where k = 'code')) $$, '28000', 'email_not_confirmed', 'unconfirmed email cannot redeem');
reset role;

-- B redeems once (lower case, without dashes works too); a second use is refused.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select is(public.redeem_invitation(lower(replace((select v from pg_temp.ids where k = 'code'), '-', ''))), (select v::uuid from pg_temp.ids where k = 'team'), 'invited user redeems');
select is((select count(*) from public.team_members), 2::bigint, 'member sees both members');
select is((select count(*) from public.shared_projects), 1::bigint, 'member sees the shared project');
select throws_ok($$ select public.redeem_invitation((select v from pg_temp.ids where k = 'code')) $$, 'P0001', 'invite_used', 'a used code is refused');
select throws_ok($$ insert into public.shared_projects (team_id, name, repo_owner, repo_name) values ((select v::uuid from pg_temp.ids where k = 'team'), 'Other', 'seastick', 'other') $$, '42501', null, 'member cannot register projects');
reset role;

-- Used, revoked and expired codes.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into pg_temp.ids select 'code_c', code from public.create_invitation((select v::uuid from pg_temp.ids where k = 'team'), 'c@example.test');
do $$ begin perform public.revoke_invitation((select id from public.team_invitations where email = 'c@example.test')); end $$;
insert into pg_temp.ids select 'code_c2', code from public.create_invitation((select v::uuid from pg_temp.ids where k = 'team'), 'c@example.test');
reset role;
update public.team_invitations set created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
  where email = 'c@example.test' and revoked_at is null;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select throws_ok($$ select public.redeem_invitation((select v from pg_temp.ids where k = 'code_c')) $$, 'P0001', 'invite_revoked', 'revoked code is refused');
select throws_ok($$ select public.redeem_invitation((select v from pg_temp.ids where k = 'code_c2')) $$, 'P0001', 'invite_expired', 'expired code is refused');
select throws_ok($$ select public.redeem_invitation('000000-000000-000000-000000') $$, 'P0002', 'invite_not_found', 'unknown code is refused');
select is((select count(*) from public.teams), 0::bigint, 'failed redemptions add no membership');
reset role;

select * from finish();
rollback;
