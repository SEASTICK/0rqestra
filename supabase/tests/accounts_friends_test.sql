-- Database tests for usernames, friends and team invitations to friends
-- (migration …_accounts_friends.sql). Run against a local Supabase stack with
--   supabase start
--   supabase test db
-- Everything runs in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'fa@example.test', now(), 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'fb@example.test', now(), 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 'fc@example.test', now(), 'authenticated', 'authenticated');

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;
create table pg_temp.ids (k text primary key, v text);
grant all on pg_temp.ids to authenticated;

-- Usernames
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.send_friend_request('x_b') $$, '28000', 'username_required', 'friends need a username first');
select throws_ok($$ select public.set_username('A') $$, '22023', 'invalid_username', 'a too short username is refused');
select is(public.set_username('  Test_Alice '), 'test_alice', 'usernames are trimmed and lower case');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.set_username('test_alice') $$, '23505', 'username_taken', 'a username is unique');
select is(public.set_username('test_bob'), 'test_bob', 'B takes another username');
select is((select count(*) from public.profiles)::int, 1, 'a user reads only their own profile');
reset role;
set local role anon;
select is(public.username_available('test_alice'), false, 'anon can ask whether a username is free (taken)');
select is(public.username_available('free_name'), true, 'anon can ask whether a username is free (free)');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is(public.set_username('test_carol'), 'test_carol', 'C takes a username');
reset role;

-- Friend requests
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.send_friend_request('nobody_here') $$, 'P0002', 'user_not_found', 'an unknown username is reported');
select throws_ok($$ select public.send_friend_request('test_alice') $$, '22023', 'cannot_friend_self', 'no request to yourself');
insert into pg_temp.ids select 'req', request_id::text from public.send_friend_request('TEST_BOB');
select is((select status from public.send_friend_request('test_bob')), 'pending', 'a repeated request stays pending');
select is((select count(*) from public.friendships)::int, 1, 'a repeated request makes no duplicate');
select throws_ok($$ select public.respond_friend_request((select v::uuid from pg_temp.ids where k = 'req'), true) $$, 'P0002', 'request_not_found', 'the sender cannot accept their own request');
select throws_ok($$ insert into public.friendships (requester_id, addressee_id, status) values (auth.uid(), '00000000-0000-0000-0000-0000000000c1', 'accepted') $$, '42501', null, 'friendships cannot be written directly');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*) from public.friendships)::int, 0, 'others cannot see the request');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is(public.respond_friend_request((select v::uuid from pg_temp.ids where k = 'req'), true), 'accepted', 'the addressee accepts');
select is(public.respond_friend_request((select v::uuid from pg_temp.ids where k = 'req'), true), 'accepted', 'accepting again is harmless');
reset role;

-- Team invitations to friends
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into pg_temp.ids values ('team', public.create_team('Friends test')::text);
select throws_ok($$ select public.invite_friend_to_team((select v::uuid from pg_temp.ids where k = 'team'), '00000000-0000-0000-0000-0000000000c1') $$, '42501', 'not_friends', 'only accepted friends can be invited');
insert into pg_temp.ids values ('inv', public.invite_friend_to_team((select v::uuid from pg_temp.ids where k = 'team'), '00000000-0000-0000-0000-0000000000b1')::text);
select is(public.invite_friend_to_team((select v::uuid from pg_temp.ids where k = 'team'), '00000000-0000-0000-0000-0000000000b1')::text, (select v from pg_temp.ids where k = 'inv'), 'inviting again returns the same invitation');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select throws_ok($$ select public.respond_team_invite((select v::uuid from pg_temp.ids where k = 'inv'), true) $$, 'P0002', 'invite_not_found', 'nobody else can accept the invitation');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is(public.respond_team_invite((select v::uuid from pg_temp.ids where k = 'inv'), true)::text, (select v from pg_temp.ids where k = 'team'), 'the invited friend joins');
select is(public.respond_team_invite((select v::uuid from pg_temp.ids where k = 'inv'), true)::text, (select v from pg_temp.ids where k = 'team'), 'accepting again returns the same team and adds nothing');
select throws_ok($$ select email from public.team_members $$, '42501', null, 'teammates cannot read each other''s email');
reset role;

select * from finish();
rollback;
