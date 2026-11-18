-- Covering indexes for the Teams foreign keys that the first migration left without one
-- (reported by the Supabase performance advisor). teams.owner_id is also used by the owner checks.
create index teams_owner_id_idx on public.teams (owner_id);
create index team_invitations_created_by_idx on public.team_invitations (created_by);
create index team_invitations_redeemed_by_idx on public.team_invitations (redeemed_by);
create index shared_projects_created_by_idx on public.shared_projects (created_by);
create index work_briefs_author_id_idx on public.work_briefs (author_id);
create index task_reservations_reserved_by_idx on public.task_reservations (reserved_by);
