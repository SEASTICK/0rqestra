-- Database tests for the team chat (migration …_team_chat.sql). Run against a local Supabase stack with
--   supabase start
--   supabase test db
-- Everything runs in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

select has_table('public', 'team_messages', 'the team chat table exists');
select has_function('public', 'send_team_message', array['uuid', 'text', 'text'], 'send_team_message exists');
select has_trigger('public', 'team_messages', 'team_messages_announce', 'new messages are announced');
select is((select relrowsecurity from pg_class where oid = 'public.team_messages'::regclass), true, 'row-level security is on');
select policies_are('public', 'team_messages', array['Project members read the team chat'], 'members only read');
select ok(not has_table_privilege('authenticated', 'public.team_messages', 'INSERT'), 'nobody inserts directly: only the function writes');
select ok(not has_table_privilege('authenticated', 'public.team_messages', 'UPDATE'), 'messages are not edited');
select ok(not has_table_privilege('anon', 'public.team_messages', 'SELECT'), 'anonymous users read nothing');
select ok(not has_function_privilege('anon', 'public.send_team_message(uuid, text, text)', 'EXECUTE'), 'anonymous users cannot send');
select function_privs_are('public', 'send_team_message', array['uuid', 'text', 'text'], 'authenticated', array['EXECUTE'], 'signed-in users may send');

select * from finish();
rollback;
