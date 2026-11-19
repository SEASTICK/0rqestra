# Teams setup

Teams lets two or more people sign in, join one team, and link their own local checkouts of the
same GitHub repository to one shared project. It runs on the shared 0rqestra Supabase project,
whose address ships with every build (`apps/desktop/teams-config.json`), so an installed app needs
no setup. A build without it shows "Teams is not available in this build" and the rest of
0rqestra works as before.

What is stored where:

| On Supabase | Only on each computer |
|---|---|
| Usernames, friends and friend requests, teams, members (their email is stored but only usernames are readable by others), invitations (to friends, or by code: code hashes only), shared projects (GitHub owner/repository and a name), work briefs and task reservations | The Teams session (encrypted with the operating system's key store), and which local folder is linked to which shared project (`<user data>/teams/links.json`) |

Checkout paths and branches are never sent to Supabase.

## The 0rqestra account

Teams and the app share one account: the same Supabase Auth user and session.

- **First launch** shows a welcome screen with **Create account**, **Sign in** and **Continue
  without an account** (local projects work without one; Teams needs one). The choice to continue
  without an account is remembered; the profile menu offers "Sign in or create account" later.
- **Create account** asks for an email and a **username**, checks that the username is free
  before any email is sent, emails a one-time code, and after the code is entered creates the
  profile (`public.profiles`). A username has 3 to 24 lower-case letters, digits or `_` and is
  unique. An address that already has an account keeps its account and its username. **Sign in**
  emails a code only to an existing account: it never creates one (an unknown address gets
  "There is no 0rqestra account …").
- An account **without a username** (made before usernames existed, or whose name was taken while
  it was being created) is asked to choose one right after signing in.
- If the server **cannot be reached**, the welcome screen, Teams and Friends say so ("Can't reach
  the 0rqestra server …") instead of offering a form that cannot work.
- A new code can be requested after 60 seconds (or after the wait Supabase reports). A wrong or
  expired code, or a connection problem, keeps the email filled in.
- The session stays in the main process, encrypted with the operating system's key store
  (`<user data>/teams/session.bin`); the window never holds a token. It is restored at startup
  (a short "Checking your account…" state, so a returning user never sees the welcome screen),
  refreshed when needed, and kept through restarts and updates (updates keep the user-data folder).
- **Offline at startup** the app opens signed in and local projects work; Teams says it cannot
  connect and checks again when the connection is back. If Supabase refuses the session (expired
  or revoked), the app asks to sign in again (and still allows continuing without an account).
- The profile menu shows the account as `@username` with its email; **Sign out** there deletes the saved session, stops Teams' live connection and clears
  Teams data from the window; local projects and settings stay.
- Claude Code and Codex keep their own sign-in under AI accounts, unrelated to this account.

Email settings this needs (see also section 3): both the **Confirm signup** template (used for a
new account's first code) and the **Magic Link** template (later sign-ins) must show `{{ .Token }}`;
"Allow new users to sign up" must stay on for Create account; and for more than a few emails an
hour, set up custom SMTP.

## 1. Create a Supabase project (Philip)

Use a project made for this, not one that holds other data. The free plan is enough to test.

## 2. Apply the migration

With the [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started), from the repository root:

```powershell
supabase login
```

```powershell
supabase link --project-ref <project-ref>
```

```powershell
supabase db push
```

`db push` applies the files in `supabase/migrations/` in order (`…_teams_phase1.sql`,
`…_teams_fk_indexes.sql`, `…_teams_presence.sql`, `…_teams_run_briefs.sql`, `…_teams_catch_up.sql`,
`…_teams_reservations.sql`, `…_teams_membership_changes.sql`, `…_accounts_friends.sql`).
Without the CLI, paste each file into the dashboard's SQL Editor and run it once, in that order.

The shared project has all of them applied (`…_accounts_friends.sql` on 2026-11-19). The local file names carry
the versions recorded there, so `db push` sees them as done.

The database tests in `supabase/tests/` run against a local stack
(`supabase start`, then `supabase test db`; this needs Docker).

## 3. Dashboard settings for email sign-in

- **Authentication → Sign In / Providers → Email:** keep Email enabled. Leave "Allow new users to
  sign up" on, so a teammate's first code creates their account.
- **Authentication → Emails → Templates → Magic Link:** the app signs in with a typed code, not a
  link. Make the template show the code, for example:

  ```html
  <h2>Your 0rqestra Teams code</h2>
  <p>Enter this code in 0rqestra: {{ .Token }}</p>
  ```

  (Supabase sends the Magic Link template for email OTP; `{{ .Token }}` is the code.)
- **Authentication → Emails → Templates → Confirm signup:** change it the same way. The very first
  sign-in of a new address uses this template, not Magic Link; without the code in it, a new
  teammate gets a link that opens the Site URL (by default `http://localhost:3000`) and fails.
- **Email OTP length and expiry** (same Email provider page): any length from 6 to 10 digits
  works; keep the expiry at one hour or less.
- **Sending email:** Supabase's built-in email service only sends a few messages per hour and is
  meant for testing. For more than a quick test, set up custom SMTP under Authentication → Emails.
  If a code does not arrive, check Authentication → Logs and the spam folder.
- No redirect URLs are needed: nothing in the app opens a link.

## 4. Configure the app

The app needs two values, both safe to ship in an app:

| Name | Where to find it |
|---|---|
| `supabaseUrl` | Project URL, `https://<project-ref>.supabase.co` (Connect dialog, or Settings → API) |
| `publishableKey` | Settings → API Keys → Publishable key, `sb_publishable_…` (a legacy `anon` key also works until Supabase retires it) |

Never use the secret key (`sb_secret_…`) or the legacy `service_role` key: the app refuses them
and they must not be committed anywhere.

Where the app reads them (first match wins):

1. Environment variables, for development against another project: `ORQESTRA_SUPABASE_URL` and
   `ORQESTRA_SUPABASE_PUBLISHABLE_KEY`.
2. `teams-config.json` in the app's user-data folder, to point one installed or test build at
   another project
   (on Windows `%APPDATA%\<package name>\teams-config.json`, for example
   `%APPDATA%\@0rqestra\desktop\teams-config.json`):

   ```json
   { "supabaseUrl": "https://<project-ref>.supabase.co", "publishableKey": "sb_publishable_..." }
   ```

3. `apps/desktop/teams-config.json`, which ships inside every build. It holds the shared
   0rqestra project's URL and publishable key, so users never edit a file. (Until 2026-11-19 it was
   empty in the repository, which is why installed builds said "Teams is not set up on this
   computer".)

Restart the app after changing the configuration.

## 5. Try it with two accounts

Two people, or one person with two user-data folders (for example two isolated test builds with
different package names), and two separate clones of the same GitHub test repository, one cloned
with SSH and one with HTTPS:

1. A and B: Create account (email and username) → enter the code from the email.
2. A: Friends → type B's exact username → Send request. B sees it under Friends (a badge shows on
   Friends within about 20 seconds) → Accept.
3. A: Teams → Create a team → Invite a friend → choose B → Invite.
4. B: the invitation shows on Teams and Friends → Join team.
5. A: Register a repository → choose a local 0rqestra project → choose the SSH clone → Register.
6. B: on the shared project, Link my checkout → choose a project (or "New project …") → choose
   the HTTPS clone → Link checkout. Choosing a clone of another repository is refused.
7. Open the linked project and its team tree: each sees the other's Manager on the Team Bridge.
8. Restart both apps: both stay signed in and show "Linked on this computer".

The older way still works: Invite by email code instead (on the team card) → send the code → the
teammate pastes it under "Join with an invite code".

Rules the database enforces for friends: only the person a request was sent to can accept or
decline it; one request per pair (a repeat returns the same request, and a request back accepts
it); only accepted friends can be invited to a team, only by its owner; only the invited person can
accept, and accepting twice changes nothing. Others see usernames, never email addresses.

Rules for code invites: an invite works once, for the invited email only, until it expires
(72 hours) or the owner withdraws it; only the owner invites and registers repositories; one
shared project per repository per team; people outside the team see nothing.

## Phase 2: Team Bridge and online status

For a project linked to a shared project, the tree shows **Your Manager ↔ Team Bridge ↔
[name]'s Manager** for each teammate. The teammate's Manager is drawn next to your tree, never saved
into it, and cannot be edited or run. Clicking the bridge opens the team name, the repository, each
person's status, and Active work (open work briefs; empty until briefs are published in phase 3).
Solo projects keep their usual tree.

Online status uses Supabase Realtime Presence on private channels:

- Migration `…_teams_presence.sql` adds row-level security policies on `realtime.messages`.
  Each person publishes only on their own topic per project, `teams:<project id>:user:<user id>`,
  and the database allows that only for the user in the topic; members of the project's team may
  listen to each other's topics. A nonmember can do neither, and nobody can appear online as a
  teammate.
- **Dashboard: Realtime → Settings → turn off "Allow public access".** Then only private channels,
  which these policies govern, can be joined. (Tested: even with public access on, a public channel
  of the same name does not show up as presence on the private one, but turning it off is the rule
  the docs give for enforcing private channels.)
- Online means: the app is open, signed in to Teams, connected, and the computer has had keyboard or
  mouse input in the last 10 minutes (the operating system's idle time, so working in an editor
  counts). Offline after sign-out, quit, a lost connection, or 10 minutes idle; Online again on the
  next input. Several sessions of one person: Online while any of them is.
- If this app loses its own connection, the bridge shows "Reconnecting…", and "Status unavailable"
  after 45 seconds, until the presence state has synced again. Offline never changes anyone's work.

## Phase 3: work briefs

When an approved team run actually starts in a project linked to a shared project, the owner's app
publishes one short brief: the owner's username, the plan's goal (shortened), the checkout's
Git branch, the plan's repository-relative files, the status and the last update time. The same
brief is updated when the run delivers files outside the plan, when a task fails or is blocked
(status Blocked), and when the run completes, stops or fails, with the runner's own short summary
as the outcome. Prompts, chat, file contents, credentials and absolute local paths are never sent
(local paths in text are replaced with "[local path]", and the database refuses any path that is
not repository-relative).

- Migration `…_teams_run_briefs.sql` extends `work_briefs` and adds `publish_run_brief`, the only
  way to write a brief. The author comes from the session; only project members may publish or
  read; (project, author, run) is unique; an update applies only with a higher sequence number and
  never after the brief is finished. Retries, duplicates and late updates are therefore harmless.
- Every change sends a content-free "brief_changed" broadcast on the private topic
  `teams:<project id>:briefs`. Only members can listen, and no client can send on it. The app then
  reads the active briefs through the API; it also reads them on every (re)connect and once a
  minute, so missed changes are recovered. While the connection is down the bridge says how old
  the shown briefs are.
- Finished briefs leave Active work but keep `outcome` and `finished_at` in Supabase for the
  phase 4 catch-up.
- A brief that cannot be sent waits in `<user data>/teams/briefs.json` and is retried (backoff,
  and whenever the connection comes back). The bridge shows the owner which briefs have not synced.
- Presence stays separate: going idle or offline never changes a brief.

## Phase 4: catch-up and "What is [name] working on?"

- **Catch-up.** When the app restores a linked project at startup, or after you sign in, it asks
  Supabase for your teammates' briefs you have not seen at their current revision: work started or
  changed, and runs finished in the last 14 days. If there is anything, one informational Manager
  message appears in that project's chat: what is underway, what finished (with its outcome), and
  which files or folders to work around. It is not part of the conversation sent to a model and
  has no buttons, so it never starts work. Nothing new: no message.
- **Read tracking.** Migration `…_teams_catch_up.sql` adds `brief_reads` (per user, the newest
  revision of each brief they were shown) with `team_catch_up` and `mark_briefs_seen`. Revisions
  are marked seen only after the message is in the chat and saved on this computer. The message id
  is derived from the brief revisions it shows, so a retry, reconnect or restart never adds it
  twice. If the app starts offline, it checks again when the connection comes back. Each account
  sees and writes only its own read state, only for projects it belongs to, and never beyond a
  brief's real revision.
- **"What is [name] working on?"** A button per teammate above the message box of a linked
  project, also when they are offline. It reads that teammate's current briefs (active ones and
  runs finished in the last 7 days). With Claude Code or Codex connected, the Manager explains the
  task, branch, expected files, last update and what you could do in parallel; the request carries
  no planning instructions, the brief fields are fenced as data, and the reply cannot show a plan or
  question card. Without a connected tool (or if the reply fails) the same facts are shown as a
  plain summary. If Supabase cannot be reached, the last known briefs are labelled as such; with
  none known, the status is "unavailable".

## Phase 5: path reservations

Before an approved team run starts in a linked project, the app reserves the plan's
repository-relative files in Supabase, and the run starts only if the whole set is granted.

- **Overlap.** Two reservations overlap when they name the same path, or one is a folder of the
  other, compared without case: `src/auth/` overlaps `src/auth/session.ts`, but not `src/auth-old/`.
  Branches do not matter. A refused start shows who holds the overlapping paths, their task, and
  which paths overlap; press Start on the plan to retry, or ask the Manager to change the files.
  Without a connection to Supabase a coordinated run does not start.
- **Atomic.** Migration `…_teams_reservations.sql` extends `task_reservations` and adds
  `acquire_reservation`, `renew_reservation`, `expand_reservation` and `release_reservation`.
  Acquisition locks the shared project's row, so of two simultaneous overlapping starts exactly one
  is granted. The same run id (one per approved plan) returns the same reservation on a retry.
- **Leases.** A reservation lasts 2 minutes (server time) and is renewed every 30 seconds while the
  run is active. Renewing, expanding and releasing need the lease token and the holder's own
  account; a token is never readable by others, and an old session cannot renew or release a
  reservation that has since replaced it. After a crash the reservation expires by itself.
- **Enforced at the write.** The runner asks the reservation before every file it writes. A file
  outside the reservation needs an atomic expansion first; a refused expansion keeps the
  reservation unchanged and the file is not written. If the lease can no longer be confirmed
  (connection lost past its expiry), writing pauses until Supabase confirms it again, and the
  run's writing stops if that does not happen within 90 seconds. The reservation is released once
  the run has stopped writing (completed, failed or stopped).
- **What can write.** Team-run agents cannot write files themselves: Claude Code runs with no tools
  and Codex with a read-only sandbox, so the runner is the only writer. It writes into the app's
  project folder (`<user data>/projects/<id>/workspace`), never into your checkout, and refuses
  symbolic links and Windows junctions.
- **Not covered.** Reservations cover writes through 0rqestra's team runs only. Edits made by hand
  in an editor, or with other tools, are outside this coordination.
- The Team Bridge lists active reservations under **Reserved files**, next to the work briefs.

Not in phase 5: the DigitalOcean worker.
