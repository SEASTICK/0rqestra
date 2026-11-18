# Teams setup (phase 1)

Teams lets two or more people sign in, join one team, and link their own local checkouts of the
same GitHub repository to one shared project. It runs on a Supabase project. Without one, the
Teams page shows "not set up" and the rest of 0rqestra works as before.

What is stored where:

| On Supabase | Only on each computer |
|---|---|
| Teams, members (with their email), invitations (code hashes only), shared projects (GitHub owner/repository and a name), and the empty tables for work briefs and task reservations | The Teams session (encrypted with the operating system's key store), and which local folder is linked to which shared project (`<user data>/teams/links.json`) |

Checkout paths and branches are never sent to Supabase.

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
`…_teams_fk_indexes.sql`, `…_teams_presence.sql`, `…_teams_run_briefs.sql`, `…_teams_catch_up.sql`).
Without the CLI, paste each file into the dashboard's SQL Editor and run it once, in that order.

The team's test project already has all of them applied (2026-11-18). The local file names carry
the versions recorded there, so `db push` sees them as done.

The database tests in `supabase/tests/teams_phase1_test.sql` run against a local stack
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

Put them in one of these places (first match wins):

1. Environment variables, for development: `ORQESTRA_SUPABASE_URL` and
   `ORQESTRA_SUPABASE_PUBLISHABLE_KEY`.
2. `teams-config.json` in the app's user-data folder, to configure an installed or test build
   (on Windows `%APPDATA%\<package name>\teams-config.json`, for example
   `%APPDATA%\@0rqestra\desktop\teams-config.json`):

   ```json
   { "supabaseUrl": "https://<project-ref>.supabase.co", "publishableKey": "sb_publishable_..." }
   ```

3. `apps/desktop/teams-config.json`, which ships with a build. It is empty in the repository.

Restart the app after changing the configuration.

## 5. Try it with two accounts

Two people, or one person with two user-data folders (for example two isolated test builds with
different package names), and two separate clones of the same GitHub test repository, one cloned
with SSH and one with HTTPS:

1. Account A: Teams → Sign in → enter the code from the email → Create a team.
2. A: Register a repository → choose a local 0rqestra project → choose the SSH clone → Register.
3. A: Invite a teammate → B's email → Copy invite, and send it to B.
4. Account B: Teams → sign in with that email → Join a team → paste the code.
5. B: on the shared project, Link my checkout → choose a project (or "New project …") → choose
   the HTTPS clone → Link checkout. Choosing a clone of another repository is refused.
6. Restart both apps: both stay signed in and show "Linked on this computer".

Rules the database enforces: an invite works once, for the invited email only, until it expires
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
publishes one short brief: the owner's display name, the plan's goal (shortened), the checkout's
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

Not in phase 4: task reservations (phase 5) and the DigitalOcean worker.
