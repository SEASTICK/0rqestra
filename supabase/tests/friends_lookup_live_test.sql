-- Checks that the objects of migration 20261126183727 (friends_lookup_live) exist with the expected
-- rights. Read only: it runs against a local stack (supabase start; supabase test db) and never changes
-- data. Against the production project, run only the select statements, not this file.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

select has_function('private', 'display_name_of', array['uuid'], 'display_name_of exists');
select has_function('public', 'find_friend_candidate', array['text'], 'find_friend_candidate exists');
select has_function('public', 'send_friend_request', array['text'], 'send_friend_request exists');
select has_function('public', 'cancel_friend_request', array['uuid'], 'cancel_friend_request exists');
select has_function('public', 'list_friends', 'list_friends exists');
select has_function('private', 'announce_friends_change', 'announce_friends_change exists');
select has_trigger('public', 'friendships', 'friendships_announce', 'friendships change is announced');
select has_trigger('public', 'team_member_invites', 'team_member_invites_announce', 'team invites are announced');
select function_privs_are('public', 'send_friend_request', array['text'], 'authenticated', array['EXECUTE'], 'signed-in users may send requests');
select ok(not has_function_privilege('anon', 'public.send_friend_request(text)', 'EXECUTE'), 'anonymous users may not send requests');
select ok(not has_function_privilege('anon', 'public.list_friends()', 'EXECUTE'), 'anonymous users may not list friends');
select policies_are('realtime', 'messages', array['People listen to their own friend changes', 'Teams members listen to brief changes', 'Teams members listen to presence', 'Teams members publish their own presence'], 'realtime policies as in the database');

select * from finish();
rollback;
