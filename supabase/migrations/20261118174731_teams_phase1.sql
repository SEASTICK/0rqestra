-- 0rqestra Teams, phase 1: teams, memberships, invitations and shared projects, plus the schema
-- foundation for work briefs and task reservations (used by later phases).
--
-- Rules this file enforces in the database, whatever the app sends:
-- * Every table has row-level security. Shared data is visible only to members of its team.
-- * Identity comes from the signed-in session (auth.uid() and auth.users), never from a parameter.
-- * Creating a team, inviting, revoking an invite and registering a shared project are owner-only.
-- * An invitation is redeemed only through public.redeem_invitation, which checks the code, its
--   expiry, that it is unused and not revoked, and that the signed-in email matches, and then
--   creates the membership and marks the code used in one transaction.
-- * Invitation codes are stored only as SHA-256 hashes. The plain code is returned once, to the
--   owner who created it.
-- * The anon role gets nothing. Local checkout paths are never stored here.

-- Helpers for policies live in a schema the Data API does not expose.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  -- Copied from auth.users when the membership is created, so teammates can see who is in the team.
  email text not null,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_id_idx on public.team_members (user_id);
-- Exactly one owner row per team.
create unique index team_members_one_owner_idx on public.team_members (team_id) where role = 'owner';

create table public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  code_hash bytea not null unique,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index team_invitations_team_id_idx on public.team_invitations (team_id);

-- One GitHub repository per shared project, once per team. Only the repository's identity and
-- project metadata are stored: each member's checkout path stays on their own computer.
create table public.shared_projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  repo_host text not null default 'github.com' check (repo_host = 'github.com'),
  repo_owner text not null check (repo_owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  repo_name text not null check (repo_name ~ '^[A-Za-z0-9._-]{1,100}$' and repo_name not in ('.', '..')),
  repo_key text generated always as (lower(repo_host || '/' || repo_owner || '/' || repo_name)) stored,
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (team_id, repo_key)
);
create index shared_projects_team_id_idx on public.shared_projects (team_id);

-- Foundation for later phases: briefs describe work for the team; reservations say who is working
-- on what. Phase 1 creates the tables and their access rules only.
create table public.work_briefs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects (id) on delete cascade,
  author_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  body text not null default '' check (char_length(body) <= 20000),
  status text not null default 'open' check (status in ('draft', 'open', 'done', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index work_briefs_project_id_idx on public.work_briefs (project_id);

create table public.task_reservations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects (id) on delete cascade,
  reserved_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_key text not null check (char_length(btrim(task_key)) between 1 and 200),
  summary text not null default '' check (char_length(summary) <= 2000),
  branch text check (branch is null or char_length(branch) <= 250),
  status text not null default 'active' check (status in ('active', 'released')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '4 hours',
  released_at timestamptz
);
create index task_reservations_project_id_idx on public.task_reservations (project_id);
-- At most one active reservation per task in a project.
create unique index task_reservations_one_active_idx on public.task_reservations (project_id, lower(task_key)) where status = 'active';

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger work_briefs_touch before update on public.work_briefs
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Policy helpers. SECURITY DEFINER so a policy on team_members can ask about team_members without
-- recursing into its own policy. They only answer yes or no for the signed-in user.
-- ---------------------------------------------------------------------------------------------

create function private.is_team_member(p_team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = p_team_id and m.user_id = (select auth.uid())
  );
$$;

create function private.is_team_owner(p_team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.teams t
    where t.id = p_team_id and t.owner_id = (select auth.uid())
  );
$$;

create function private.is_project_member(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shared_projects p
    join public.team_members m on m.team_id = p.team_id
    where p.id = p_project_id and m.user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_team_member(uuid), private.is_team_owner(uuid), private.is_project_member(uuid) from public, anon;
grant execute on function private.is_team_member(uuid), private.is_team_owner(uuid), private.is_project_member(uuid) to authenticated;
revoke all on function private.touch_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and table privileges
-- ---------------------------------------------------------------------------------------------

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invitations enable row level security;
alter table public.shared_projects enable row level security;
alter table public.work_briefs enable row level security;
alter table public.task_reservations enable row level security;

-- Start from nothing, then grant exactly what the app uses. Inserts into teams, team_members and
-- team_invitations happen only inside the functions below.
revoke all on public.teams, public.team_members, public.team_invitations, public.shared_projects,
  public.work_briefs, public.task_reservations from anon, authenticated;

grant select, delete on public.teams to authenticated;
grant update (name) on public.teams to authenticated;
create policy "Members read their teams" on public.teams
  for select to authenticated using (private.is_team_member(id));
create policy "Owners rename their teams" on public.teams
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Owners delete their teams" on public.teams
  for delete to authenticated using (owner_id = (select auth.uid()));

grant select, delete on public.team_members to authenticated;
create policy "Members read their team's members" on public.team_members
  for select to authenticated using (private.is_team_member(team_id));
-- The owner removes a member, or a member leaves. The owner's own row stays.
create policy "Owners remove members, members leave" on public.team_members
  for delete to authenticated using (
    role = 'member' and (user_id = (select auth.uid()) or private.is_team_owner(team_id))
  );

-- The code hash is never readable through the API.
grant select (id, team_id, email, created_by, created_at, expires_at, redeemed_at, redeemed_by, revoked_at)
  on public.team_invitations to authenticated;
create policy "Owners read their team's invitations" on public.team_invitations
  for select to authenticated using (private.is_team_owner(team_id));

grant select, delete on public.shared_projects to authenticated;
grant insert (team_id, name, repo_host, repo_owner, repo_name) on public.shared_projects to authenticated;
grant update (name) on public.shared_projects to authenticated;
create policy "Members read their team's projects" on public.shared_projects
  for select to authenticated using (private.is_team_member(team_id));
create policy "Owners register projects" on public.shared_projects
  for insert to authenticated with check (private.is_team_owner(team_id) and created_by = (select auth.uid()));
create policy "Owners rename projects" on public.shared_projects
  for update to authenticated using (private.is_team_owner(team_id)) with check (private.is_team_owner(team_id));
create policy "Owners remove projects" on public.shared_projects
  for delete to authenticated using (private.is_team_owner(team_id));

grant select, delete on public.work_briefs to authenticated;
grant insert (project_id, title, body, status) on public.work_briefs to authenticated;
grant update (title, body, status) on public.work_briefs to authenticated;
create policy "Project members read briefs" on public.work_briefs
  for select to authenticated using (private.is_project_member(project_id));
create policy "Project members write their own briefs" on public.work_briefs
  for insert to authenticated with check (private.is_project_member(project_id) and author_id = (select auth.uid()));
create policy "Authors edit their briefs" on public.work_briefs
  for update to authenticated using (author_id = (select auth.uid()) and private.is_project_member(project_id))
  with check (author_id = (select auth.uid()) and private.is_project_member(project_id));
create policy "Authors delete their briefs" on public.work_briefs
  for delete to authenticated using (author_id = (select auth.uid()));

grant select, delete on public.task_reservations to authenticated;
grant insert (project_id, task_key, summary, branch, expires_at) on public.task_reservations to authenticated;
grant update (summary, branch, status, expires_at, released_at) on public.task_reservations to authenticated;
create policy "Project members read reservations" on public.task_reservations
  for select to authenticated using (private.is_project_member(project_id));
create policy "Project members reserve for themselves" on public.task_reservations
  for insert to authenticated with check (private.is_project_member(project_id) and reserved_by = (select auth.uid()));
create policy "Holders update their reservations" on public.task_reservations
  for update to authenticated using (reserved_by = (select auth.uid()) and private.is_project_member(project_id))
  with check (reserved_by = (select auth.uid()) and private.is_project_member(project_id));
create policy "Holders delete their reservations" on public.task_reservations
  for delete to authenticated using (reserved_by = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- Functions the app calls. Errors carry a short code as the message (the app maps it to text).
-- ---------------------------------------------------------------------------------------------

-- The signed-in user's confirmed email, or an error.
create function private.current_email() returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  select lower(btrim(u.email)) into v_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
  if v_email is null or v_email = '' then
    raise exception 'email_not_confirmed' using errcode = '28000';
  end if;
  return v_email;
end;
$$;
revoke all on function private.current_email() from public, anon;
grant execute on function private.current_email() to authenticated;

-- Normalizes a typed code: hex digits only, upper case. Dashes and spaces are ignored.
create function private.normalize_invite_code(p_code text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Fa-f]', '', 'g'));
$$;
revoke all on function private.normalize_invite_code(text) from public, anon;
grant execute on function private.normalize_invite_code(text) to authenticated;

-- Creates a team; the caller becomes its owner, in the same transaction.
create function public.create_team(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := private.current_email();
  v_name text := btrim(coalesce(p_name, ''));
  v_team uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'invalid_team_name' using errcode = '22023';
  end if;
  if (select count(*) from public.teams t where t.owner_id = v_uid) >= 20 then
    raise exception 'too_many_teams' using errcode = '54000';
  end if;
  insert into public.teams (name, owner_id) values (v_name, v_uid) returning id into v_team;
  insert into public.team_members (team_id, user_id, role, email) values (v_team, v_uid, 'owner', v_email);
  return v_team;
end;
$$;

-- Owner only. Returns the plain code once; only its hash is stored. An earlier pending invitation
-- for the same email in the same team is revoked, so only the newest code works.
create function public.create_invitation(p_team_id uuid, p_email text, p_valid_hours integer default 72)
returns table (invitation_id uuid, code text, email text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_raw text;
  v_code text;
  v_id uuid;
  v_expires timestamptz;
begin
  perform private.current_email();
  if not private.is_team_owner(p_team_id) then
    raise exception 'not_team_owner' using errcode = '42501';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 254 then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if p_valid_hours is null or p_valid_hours < 1 or p_valid_hours > 168 then
    raise exception 'invalid_validity' using errcode = '22023';
  end if;
  if exists (select 1 from public.team_members m where m.team_id = p_team_id and lower(m.email) = v_email) then
    raise exception 'already_member' using errcode = '23505';
  end if;
  update public.team_invitations i set revoked_at = now()
  where i.team_id = p_team_id and i.email = v_email and i.redeemed_at is null and i.revoked_at is null;
  -- 96 random bits: the first 12 hex digits of two v4 UUIDs are fully random.
  v_raw := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  v_code := substr(v_raw, 1, 6) || '-' || substr(v_raw, 7, 6) || '-' || substr(v_raw, 13, 6) || '-' || substr(v_raw, 19, 6);
  v_expires := now() + make_interval(hours => p_valid_hours);
  insert into public.team_invitations (team_id, email, code_hash, created_by, expires_at)
  values (p_team_id, v_email, sha256(convert_to(v_raw, 'UTF8')), v_uid, v_expires)
  returning id into v_id;
  return query select v_id, v_code, v_email, v_expires;
end;
$$;

-- Owner only.
create function public.revoke_invitation(p_invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
begin
  perform private.current_email();
  select i.team_id into v_team from public.team_invitations i where i.id = p_invitation_id;
  if v_team is null or not private.is_team_owner(v_team) then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  update public.team_invitations i set revoked_at = now()
  where i.id = p_invitation_id and i.redeemed_at is null and i.revoked_at is null;
end;
$$;

-- The only way to join a team. The row lock makes two simultaneous redemptions of one code wait
-- for each other; the second then sees the code as used. Any error rolls back the whole call.
create function public.redeem_invitation(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := private.current_email();
  v_code text := private.normalize_invite_code(p_code);
  v_inv public.team_invitations%rowtype;
begin
  if char_length(v_code) <> 24 then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  select * into v_inv from public.team_invitations i
  where i.code_hash = sha256(convert_to(v_code, 'UTF8'))
  for update;
  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'invite_revoked' using errcode = 'P0001';
  end if;
  if v_inv.redeemed_at is not null then
    raise exception 'invite_used' using errcode = 'P0001';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;
  if v_inv.email <> v_email then
    raise exception 'invite_wrong_email' using errcode = '42501';
  end if;
  if exists (select 1 from public.team_members m where m.team_id = v_inv.team_id and m.user_id = v_uid) then
    raise exception 'already_member' using errcode = '23505';
  end if;
  insert into public.team_members (team_id, user_id, role, email) values (v_inv.team_id, v_uid, 'member', v_email);
  update public.team_invitations i set redeemed_at = now(), redeemed_by = v_uid where i.id = v_inv.id;
  return v_inv.team_id;
end;
$$;

revoke all on function public.create_team(text), public.create_invitation(uuid, text, integer),
  public.revoke_invitation(uuid), public.redeem_invitation(text) from public, anon;
grant execute on function public.create_team(text), public.create_invitation(uuid, text, integer),
  public.revoke_invitation(uuid), public.redeem_invitation(text) to authenticated;
