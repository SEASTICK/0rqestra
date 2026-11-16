# WorkTreeAI — Acceptance Criteria (First Complete Workflow)

Revision 5, 2026-11-16. **Drafted, pending review.** Revised after the review of 4e812f3. That
revision changed three things: AC-18 retains baseline bytes and captures fail-closed; AC-15
timing depends on clean-interrupt capability; AC-22 separates the agreed parts from proposed
details.

Criteria marked **(Agreed)** implement requirements the user confirmed, including decisions
A1–A8 recorded on 2026-11-16. All others implement Draft rules that are still pending.

**These are specifications for future tests.** The product features they describe do not exist
yet, so nothing below is claimed to pass. The only tests that exist today are the foundation
tests listed in [`architecture.md`](architecture.md) §8.

Criteria that depend on a **Draft** rule from
[`tree-routing-and-permissions.md`](tree-routing-and-permissions.md) cite that section. If the
user chooses an alternative, those criteria change with it.

**Test types**

- **[fixture]** — headless, deterministic, against the fake provider or fake CLI below. No
  account, no network, no cost. Must pass in CI on Windows and macOS once implemented.
- **[live]** — against a real, user-installed CLI with the user's own account. Opt-in and manual,
  never in CI. A live pass shows technical behavior. It does **not** establish that a provider's
  terms permit it.
- **[eval]** — a non-gating behavioral evaluation of free-form model output. Reported as a score.
  Not an acceptance pass/fail.

## Fixtures

**`provider-fake` (in-process).** It already exists as foundation code; it is extended when
these tests are implemented. It:

- replays scripted events: text, file edits, approval requests, success, task failure,
  `rate_limit`, `overloaded`, `unauthorized`, hang, crash;
- reports a configurable "model actually used";
- records each launch's arguments, environment variable **names**, working directory, and
  session reference.

The fake also plays the Manager, emitting scripted structured decisions.

**`fake-cli` (real child process).** A small script launched as an actual process. Modes:

| Mode | Behavior |
|---|---|
| `cooperative` | Exits within 2 s of receiving an interrupt |
| `uncooperative` | Ignores interrupts; exits only when killed |
| `grandchild` | Spawns a child in the same process tree or group that writes a heartbeat file every 200 ms |
| `detached` | Spawns a child that leaves the tree or group (macOS `setsid`; Windows breakaway or parent-exit reparenting) and writes a heartbeat |
| `parent-exits` | Starts a heartbeat grandchild, then exits 0 itself while the grandchild keeps running |
| `edit-files` | Edits, adds, and deletes named files directly (simulating shell-generated edits, with no provider file-edit event) |
| exit code | Exits with a chosen code |

`fake-cli` is used for process-ownership and change-reconciliation tests. Recovery tests also
use an **injected crash point** that kills WorkTreeAI between named ledger steps (before spawn,
after spawn but before PID persistence, while running).

**Trees**

| ID | Shape |
|---|---|
| T1 | Manager → Planner → Builder → Reviewer; Builder → Tester |
| T2 | Manager → Builder → Reviewer (no Planner) |
| T3 | Manager → Builder (no Reviewer, no Tester) |
| T4 | T1 plus a disconnected Security Reviewer |
| T5 | Manager → Planner → {Builder A (priority 1), Builder B (priority 2)} → Reviewer |
| T6 | T1 plus Manager → Debugger and Builder → Debugger |
| T7 | Invalid: two Manager nodes |
| T8 | Invalid: edge Reviewer → Manager |
| T9 | Manager → {Builder A, Builder B} (independent, for concurrency) |

**Projects**

| ID | Contents |
|---|---|
| P1 | Small Git repository with a passing test command |
| P2 | Plain folder, not a Git repository |
| P3 | Hostile repository: `.claude/settings.json` with a `SessionStart` hook writing `HOOK_RAN.txt`; `.mcp.json` server; `.claude/agents/rogue.md`; `env` block setting `ANTHROPIC_API_KEY=fixture`; `AGENTS.md` asking agents to delegate elsewhere |
| P4 | Folder without read permission |
| P5 | Git repository whose test command fails one assertion |
| P6 | Git repository whose test command cannot start (missing runner) |
| P7 | Git repository with pre-existing changes: one modified tracked file (`dirty.txt`), one untracked file (`scratch.txt`), one ignored build file |
| P8 | Plain folder (non-Git) with the same pre-existing files as P7, for the non-Git baseline |

**Requests**

| ID | Request | Expected route |
|---|---|---|
| R1 | "Add input validation to the signup form" | Implementation |
| R2 | "What is running right now?" | Answered from WorkTreeAI state |
| R3 | "Fix the failing login test" | Debugging |

---

## AC-01 Opening an existing project [fixture]

- **Given** P1, **when** opened, **then**:
  - the project file-tree hash is unchanged;
  - the saved tree, or the starter tree, is shown.
- **Given** P2, **when** opened, **then** it opens. A provider Git requirement surfaces as a node
  configuration issue.
- **Given** P4, **when** opened, **then** an app-generated error names the path and the problem,
  and nothing is launched.

## AC-02 Saving, restoring, and validating trees [fixture]

- **Given** an edited tree in P1, **when** WorkTreeAI restarts and P1 is reopened, **then** the
  tree is deep-equal to what was saved.
- **Given** P1 and P2 with different trees, **then** edits to one never change the other.
- **Given** a corrupted or newer-version tree file, **then** it is refused, left untouched, and
  reported. It is never reset.
- **Given** T7 or T8, **when** saved, **then** the save is rejected with the reason ("exactly one
  Manager", "no edges into the Manager"). (Routing §2.1)

## AC-03 Edge and provenance enforcement (Routing §2.4)

All [fixture]:

- **Given** T2, **when** the Manager dispatches the Reviewer with the Builder's current
  `outputRef`, **then** the dispatch is accepted (rule b), and a new `workItemId` records the
  parent output.
- **Given** T2, **when** the Manager dispatches the Reviewer with new user work, **then** it is
  rejected (no `Manager → Reviewer` edge) and nothing launches.
- **Given** T4, **when** the disconnected node is dispatched, **then** it is rejected, and the UI
  marks the node unreachable.
- **Given** a dispatch naming an `outputRef` that the engine never issued, **then** it is
  rejected as fabricated.
- **Given** a dispatch naming an `outputRef` from a different request, **then** it is rejected
  as cross-request.
- **Given** an output superseded by a correction, **when** the Manager hands off the old ref,
  **then** it is rejected as stale, and the rejection names the current ref.
- **Given** a correction dispatch targeting a different node with the author's role, **then** it
  is rejected (author affinity).
- **Given** 3 consecutive rejected decisions in one request, **then** the request pauses and the
  user is told.
- **Given** any rejected decision, **then** the request dispatch counter is unchanged.

## AC-04 Planning delegation (Routing §2.10, Agreed: decision A6)

- [fixture] **Given** T1 and R1, **then** the first launch is the Planner. No Builder launches
  before the Planner's task completes.
- [fixture] **Given** T1 and R2, **then** nothing launches.
- [fixture] **Given** T2 and R1, **then** the Manager asks once whether to add a Planner or
  proceed, and nothing launches until the user answers. If the user chooses to proceed, the
  request record shows "proceeded without plan (user choice)".

## AC-05 Problem routing

- [fixture] **Given** T6, **when** the Builder's output reports a failing test, **then** the
  Debugger is dispatched with that output (rule b), not the Builder again.
- [fixture] **Given** T3, **when** a security concern is reported and no Security Reviewer is
  reachable, **then** the item pauses and the Manager asks the user.

## AC-06 Review of fixes and missing verification (Routing §2.5 and §2.7, Agreed: decisions A1, A2)

- [fixture] **Given** T1, **when** the Builder completes, **then** the Reviewer (and the Tester,
  if routed) runs before the item is reported complete.
- [fixture] **Given** the Reviewer requests changes, **then**:
  - the authoring Builder gets a correction dispatch on the same `workItemId`, with the findings
    attached;
  - no `Reviewer → Builder` edge is required (implicit return — **Agreed**, decision A1);
  - the correction round increments.
- [fixture] **Given** T3, **when** the Builder completes, **then**:
  - the item pauses in `awaiting-user`;
  - the Manager asks once per request: add a verifier, or finish without verification.
  - **When** the user chooses to finish, **then** the final report says "Completed — unverified
    (user chose to skip verification)", and nowhere says reviewed, tested, or verified.

## AC-07 Missing roles and Manager-only questions

- [fixture] **Given** a needed role that is not reachable, **then** only that item pauses, the
  Manager asks, and the node count is unchanged.
- [fixture] **Given** a specialist's output containing a question, **then** it reaches the user
  in the Manager channel. No UI element replies to the specialist directly.
- [fixture] **Given** item A paused and item B independent, **then** B completes.

## AC-08 Retry, review-round, outage, and request-limit semantics (Routing §2.6)

The default values and the at-limit behavior are **Agreed** (decision A5).

**Definitions**

| Term | Meaning |
|---|---|
| Attempt | One launch of one task on one node |
| Retry | A same-node re-run after a task failure. At most `1 + maxRetries` attempts |
| Review round | One correction cycle on a work item. Does not consume retries |
| Provider-internal retry | Retries the CLI performs itself. Shown in the activity feed; not counted |
| Outage retry | A WorkTreeAI re-run after an availability error. Separate counter; does not consume retries |
| Request dispatch count | Every launch for the request (attempts, retries, corrections, outage retries) |

**Criteria (all [fixture])**

- `maxRetries = 2` with an always-failing task → exactly 3 attempts, then pause and escalate.
- `maxReviewRounds = 3` with an always-rejecting Reviewer → exactly 3 rounds, then pause. The
  retry counter is unaffected.
- `overloaded` ×2 then success → task succeeds; 2 outage retries are shown; retry counter is 0.
- Request dispatch limit 5, with retries and corrections in play → the 6th launch does not
  happen. Retries and corrections are counted.
- When the limit is reached with one task running and two queued:
  - the running task completes, and its output is recorded but not dispatched onward;
  - the queued items show `paused: request limit`;
  - the Manager asks to raise the limit, stop, or select items.

## AC-09 Provider outages and usage limits [fixture]

- Outage retries exhausted → the item pauses; the status shows a provider-availability error,
  distinct from a task failure.
- `rate_limit` / `usageLimitExceeded` → no further automatic attempts on that node; the item
  pauses; the Manager names the node and provider.
- Node usage limit reached → stopped and reported as "stopped: node usage limit".

## AC-10 Manager failure [fixture]

- **Given** the Manager's provider is unauthorized, unreachable, or crashes, **when** the user
  prompts, **then** the Manager channel shows an **app-generated** status labelled as coming from
  WorkTreeAI, with the error category. No text is attributed to the Manager.
- **Given** specialists are running when the Manager fails, **then** they complete and their
  outputs are kept. No new dispatch happens until the Manager is available.

## AC-11 Manager restrictions

**Enforceable — must pass:**

- [fixture] The Manager's recorded launch has no built-in tools, no MCP servers, and no subagent
  tool.
- [fixture] A structured Manager decision to edit a file, run a command, or perform a specialist
  task itself is rejected, and nothing executes.
- [fixture] A dispatch to an unconfigured role or node creates nothing; the node count is
  unchanged.
- [live] With the real Manager launch profile, a prompt asking the Manager to edit a file
  changes nothing (project tree hash unchanged), and the run's startup metadata lists no tools.

**Behavioral — measured, not gating:**

- [eval] How often the Manager's free-form text attempts technical solutions instead of
  delegating. Free-form text cannot cause actions (only structured decisions can), so this
  measures quality, not safety.

## AC-12 Permission enforcement and fail-closed (Routing §3.4)

- [fixture] A node without write permission receives a file-edit approval request → it is denied.
  The activity feed shows "denied by node permissions", distinct from a failure.
- [fixture] A required restriction that the adapter's `capabilities()` cannot enforce on this
  platform → zero launches, and the Manager offers the three choices.
- [fixture] Capability "unknown" or "untested" → treated as unsupported.
- [live] Per adapter and per OS: a prompt asking for an action outside the profile → denied or
  sent to WorkTreeAI, and not performed. Required before the adapter is enabled.

## AC-13 Provider-native subagents, hooks, and tools

- [fixture] **Given** P3, **then** every recorded Claude launch includes the full Profile A
  suppression flags ([provider-integrations.md §1.4](provider-integrations.md#14-what-ordinary--p-loads-and-suppression-profiles))
  **before** the process starts. The child environment has no provider API-key variable unless
  the node uses API-key auth.
- [fixture] **Given** startup metadata reporting an MCP server, plugin, or tool outside the
  profile, **then** the run is stopped before the first prompt and reported as a configuration
  error. This detects but cannot undo earlier hook execution, which is why the previous criterion
  is the primary control.
- [live] **Given** P3 with Claude Code under Profile A:
  - `HOOK_RAN.txt` is never created;
  - `system/init` shows no `.mcp.json` server and no plugins;
  - no subagent messages appear.
- **Deferred:** Codex-specific assertions. They are defined after provider-integrations §2.4 is
  resolved. Until then, the Codex adapter cannot be enabled (§4 gates).

## AC-14 Session isolation [fixture]

- Two same-role nodes in one project use distinct session or thread references recorded by the
  engine.
- The same node configuration in P1 and P2 never shares session references.
- No recorded launch contains `--continue`, `-c`, `resume --last`, or any other "most recent"
  form.

## AC-15 Process ownership and cancellation (Routing §4 Draft)

Timing (Routing §4.2):

- **Clean interruption supported:** up to **10 s** for a graceful stop before forced cleanup
  begins.
- **Clean interruption unavailable** (for example Claude Code on native Windows, until its
  runtime gate passes): forced cleanup begins **immediately**, with no interrupt and no wait.
- **Deadline, in every case:** forced cleanup is complete within **13 s** after the cancel.

"Stopped" means every process WorkTreeAI tracks for the task. It does not mean every process on
the machine (see the containment limits in Routing §4.2).

The fake adapter declares `cleanInterrupt: "supported"` or `"unavailable"` per test.

**Clean interruption supported [fixture]:**

- **Given** T9 with A (`cooperative` + `grandchild`) and B both running, **when** the user
  cancels A, **then**:
  - A receives the interrupt;
  - A's root exits within 10 s, and the task ends `cancelled (graceful)`;
  - A's grandchild is terminated by 13 s (its heartbeat stops);
  - B keeps running and completes normally, with its launch count unchanged.
- **Given** A is `uncooperative` + `grandchild`, **when** cancelled, **then**:
  - A receives the interrupt;
  - no forced termination happens before 10 s while A's root is still alive;
  - by 13 s, A's root and grandchild are gone;
  - the task ends `cancelled (forced)`;
  - B is unaffected.

**Clean interruption unavailable [fixture]:**

- **Given** A is `cooperative` + `grandchild` (cooperation is irrelevant here), **when** the user
  cancels A, **then**:
  - **no interrupt is sent**;
  - forced cleanup begins immediately, within 1 s of the cancel;
  - A's root and grandchild are gone by 13 s;
  - the task ends `cancelled (forced; clean interrupt unavailable)`;
  - B is unaffected.
- **Given** A is `uncooperative` + `grandchild`, **then** the outcome is the same: no interrupt,
  forced cleanup starts immediately, gone by 13 s.
- **Windows fallback.** **Given** the Claude Code adapter on native Windows with its interrupt
  gate not yet passed, **then** its `capabilities()` reports clean interruption as unavailable,
  and cancellation follows this path.

**Either capability [fixture]:**

- **Given** A is `uncooperative` + `detached`, **when** cancelled, **then**:
  - if descendant polling recorded the detached child, it is terminated by 13 s;
  - if it was not recorded, the task result states that cleanup covered tracked processes only;
  - the result never claims all processes were terminated.

**Provider parent exits while descendants remain [fixture]:**

- **Given** a task in `parent-exits` mode, **when** its root exits 0, **then**:
  - the tracked grandchild is terminated (Draft) and listed in the task result;
  - the task is still reported with its real exit outcome.

**Crash recovery [fixture, using injected crash points]:**

- **Crash while running** (PID persisted). **When** restarted, **then**:
  - the orphan is matched by PID, start time, and executable;
  - it is terminated together with its tracked descendants;
  - the task shows `interrupted`, ownership `orphan-terminated`;
  - the user is told.
- **PID reuse.** **Given** a ledger PID now belonging to an unrelated process (different start
  time or executable), **then** that process is left alone.
- **Crash between spawn and PID persistence, token readable.** **Given** a Claude-style launch
  whose `--session-id` token appears on the candidate's command line, **then** the candidate is
  treated as an orphan and terminated.
- **Crash between spawn and PID persistence, token not available.** **Then**:
  - nothing is terminated automatically;
  - ownership is `unresolved`;
  - the Manager channel lists the candidates;
  - **resuming the work item is refused** until the user chooses terminate, ignore, or keep
    stopped.
- **No automatic relaunch.** **Given** any interrupted task, **then** it is not relaunched
  automatically. Resuming is allowed only from ownership `clear` or `orphan-terminated`, and
  creates a new `taskId`. At no time do two live tasks exist for one work item.

**Live:**

- [live] Per adapter and per OS:
  - where clean interruption is supported, a stop lands within 10 s;
  - where it is unavailable, forced cleanup starts immediately;
  - in both cases, forced cleanup completes within 13 s and no tracked process remains.

## AC-16 User-answer handling [fixture]

- Answering item A's question resumes only A, in the same session reference. Other items'
  launch counts are unchanged.
- A duplicate answer (same `questionId`) resumes A exactly once.
- An answer to a cancelled item's question is rejected with a message.

## AC-17 No silent model or provider substitution [fixture]

- The recorded launch uses the node's provider and model and passes no fallback chain.
- A turn reporting a different model than configured → flagged; the item pauses; the Manager
  reports configured vs. actual. The node configuration is unchanged.
- An unavailable model → the node is unavailable. No other model or provider is chosen.

## AC-18 Accurate summaries backed by reconciliation [fixture]

**Attribution model (Draft, pending):**

- **Serialized writers per project.** At most one task with write permission runs in a project
  at a time; other writing tasks queue. Read-only tasks may run alongside.
  - Alternative: isolated workspaces (a Git worktree or folder copy per writing task, merged
    back afterwards). Not drafted.
- **Content baselines with retained bytes.** Immediately before each writing task starts, the
  engine captures a baseline that can reconstruct every non-ignored file as it was. A hash alone
  is not enough, because a diff needs the original content.
  - **Git projects.** The baseline records the commit ID of `HEAD`. Clean tracked files are
    reconstructed from that commit's Git objects. The **bytes** of every modified tracked file
    and every untracked non-ignored file are copied into a content-addressed store.
  - **Non-Git projects.** The bytes of every file are copied into the store, except a fixed
    default exclusion list (for example `node_modules/` and `.git/`).
  - **The store.** It lives in a WorkTreeAI-owned location outside the project. Blobs are keyed
    by SHA-256 and deduplicated across baselines. The baseline manifest maps each path to its
    SHA-256 and to its source (store blob, or Git commit plus path). The store is kept until the
    request is archived; the retention period is pending.
  - **Size caps (draft).** 50 MB per file and 1 GB per baseline. A file over the per-file cap is
    recorded by hash only and listed as "too large to diff".
  - **Attribution** compares the after-state with this baseline, **not with the current
    `HEAD`**.
- **Fail-closed capture.** If the baseline cannot be captured completely, **the writing task is
  not launched.** This covers:
  - the store cannot be written;
  - a file cannot be read;
  - the total cap is exceeded;
  - the baseline commit cannot be resolved.

  The item pauses, and the Manager reports which part failed. The user may explicitly choose to
  run that task without a baseline. Its changes are then reported only as "changed during task
  window (no baseline — diffs unavailable)". No diff is ever shown against a guessed or
  substituted baseline.
- **Integrity on reconstruction.** Reconstructed content is re-hashed and compared with the
  manifest. If a blob is missing, a hash doesn't match, or the baseline commit is no longer
  available, that file is reported as "baseline unavailable". The engine never falls back to
  diffing against the current `HEAD`.
- **Pre-existing changes are not the task's.** Files already modified or untracked before the
  request are reported separately as "pre-existing changes". A pre-existing file the task edits
  again is reported as changed by the task, with a diff against its reconstructed baseline
  content.
- **Ignored files** are excluded from attribution by default and counted separately.
- **Attribution labels:**
  - **changed by task (corroborated)** — the reconciliation diff matches a provider file-edit
    event;
  - **changed during task window** — the reconciliation diff has no matching provider event.
    This includes shell-generated edits, and cannot exclude edits made outside WorkTreeAI during
    the same window.

**Criteria:**

- **Given** P7, **when** a task edits `src/a.txt` only, **then**:
  - the summary lists `src/a.txt` as changed by the task;
  - `dirty.txt` and `scratch.txt` appear only under "pre-existing changes";
  - the ignored build file is not attributed.
- **Reconstructing pre-existing content.** **Given** P7, where `dirty.txt` contains the
  pre-existing line `PRE-EXISTING EDIT` (not in `HEAD`) and the untracked `scratch.txt` contains
  the known text `UNTRACKED ORIGINAL`, **when** a task edits `dirty.txt` and deletes
  `scratch.txt`, **then**:
  - the baseline side of the `dirty.txt` diff contains `PRE-EXISTING EDIT`, and its reconstructed
    bytes hash to the manifest's SHA-256;
  - the `scratch.txt` deletion diff shows `UNTRACKED ORIGINAL`, reconstructed byte-for-byte from
    the store (this content exists nowhere in Git);
  - both files are reported as changed by the task, and neither diff is computed against `HEAD`.
- **Given** P8 (non-Git), **then** the same reconstruction and attribution results hold, using
  store blobs only.
- **Baseline commit moves.** **Given** P7, **when** the task itself creates a commit, **then**
  clean tracked files are still reconstructed from the **recorded** baseline commit, not the new
  `HEAD`.
- **Capture fails, store unwritable.** **Given** the store cannot be written (injected error),
  **when** a writing task is dispatched, **then**:
  - zero processes are launched;
  - the item pauses;
  - the Manager names the capture failure.
- **Capture fails, cap exceeded.** **Given** a baseline that would exceed the total cap, **then**
  the result is the same: not launched, paused, reported.
- **Large file.** **Given** a single file over the per-file cap, **then** the task launches, and
  that file is listed as "too large to diff" with hash-only comparison.
- **Explicit override.** **Given** a capture failure and the user explicitly chooses to run
  without a baseline, **then** the task launches, and its changes are reported only as "changed
  during task window (no baseline — diffs unavailable)".
- **Corrupted blob.** **Given** a store blob altered after capture, **then** that file is reported
  as "baseline unavailable", and no diff is shown for it.
- **Given** a `fake-cli` task in `edit-files` mode (no provider events), **then** its edits,
  additions, and deletions appear as "changed during task window".
- **Given** a provider file-edit event that matches the diff, **then** the file is labelled
  "changed by task (corroborated)".
- **Concurrent writers.** **Given** two writing tasks dispatched at the same moment in one
  project, **then** the second starts only after the first ends, and each summary lists only the
  files changed between its own baseline and its own end.
- **External write.** **Given** the test harness writes `external.txt` while a writing task runs,
  **then** `external.txt` appears as "changed during task window", never as "changed by task
  (corroborated)".
- **Given** a task cancelled mid-edit, **then** its reconciled files are reported as "possibly
  partial".

**Check results.** Each check in the summary is one of:

| Outcome | Fixture |
|---|---|
| **passed** | P1 |
| **failed** — the tests ran and assertions failed | P5 |
| **infrastructure error** — the test command could not start, crashed, or timed out | P6 |
| **interrupted** — cancelled or stopped by a crash | AC-15 fixtures |
| **not run** — no Tester dispatched, or the user skipped verification | T3 |

The summary never reports "passed" unless the check's task result says passed.

**Agents.** Every agent named in the summary has a task record in the request.

## AC-19 Platform parity

- [fixture] The same fixture tree, project, request, and fake script on Windows and macOS CI
  produce identical routing event logs, apart from timestamps and normalized paths.
- [live] Live models need not match wording across platforms. Live tests assert only routing,
  permissions, and recorded results.
- [fixture] A platform-specific capability gap is reported as a platform limitation (AC-12).

## AC-20 Configuration snapshot (Routing §2.11, Agreed: decisions A3, A4) [fixture]

- **Given** a running request on T1, **when** the user changes the Builder's model and adds an
  edge, **then** the running request keeps using the snapshot (recorded launches show the old
  model), and the next request uses the new configuration.
- The UI indicates that the active request runs on an older configuration.

**User-approved rebase (Routing §2.11, Agreed: decision A3) [fixture]:**

- **Given** T3 and R1, with the request paused for a missing verifier, **when** the user adds a
  Tester with "+" beside the Builder **but does not approve applying it**, **then** the paused
  request is unchanged, and the Tester receives nothing from it.
- **Given** the same, **when** the user approves *Apply to this request*, **then**:
  - the diff shown lists the added node and edge;
  - the rebase waits until no task of the request is running;
  - the request moves to snapshot v2;
  - the Builder's completed output is kept, with no Builder re-launch, and its provenance still
    says v1;
  - the Tester is dispatched with that output under v2.
- **Given** a rebase that tightens a permission of a queued node, **then** the queued item is
  revalidated under v2 and launched with the tighter permission. If v2's capabilities cannot
  enforce it, the item stays paused (fail-closed).
- **Given** a rebase that removes the node that produced an output, **then** that output cannot
  be handed off along removed edges, and the Manager explains why.
- **Given** a rebase that lowers the request dispatch limit below the current count, **then** the
  request pauses with `paused: request limit`.
- **Given** the user declines the rebase, **then** the item stays paused or is skipped by the
  user, and the edited tree applies to new requests only.

## AC-21 Same-role selection (Routing §2.8) [fixture]

**(Agreed) Highest-priority idle eligible agent:**

- T5 with both Builders idle → Builder A (priority 1).
- Builder A busy, Builder B idle → Builder B.
- Builder A not eligible (unavailable or not permitted), B idle → Builder B.

**(Agreed, decision A7):**

- **Priority wins over a named agent.** Both Builders idle and the prompt names Builder B → the
  work goes to Builder A (priority 1).
- **All busy: wait for top priority.** Both Builders busy when the work arrives → the item waits
  for Builder A. **When** Builder B becomes idle first, **then** the item still waits and is
  launched on A when A becomes idle.
- **New agents get the lowest priority.** Builder C added with "+" → priority 3; A and B keep
  priorities 1 and 2.

**(Agreed, decision A1):**

- A correction for work authored by Builder B → goes to B, even when A is idle.

**Draft details:**

- Each choice appears in the activity feed.
- Builder A becomes unavailable while an item waits for it → the Manager asks the user; the item
  is not moved to Builder B silently.

## AC-22 Adding a child agent with "+" (Stage 2 interface) [fixture]

**(Agreed) The "+" interaction and automatic parent-to-child connection:**

- **Given** any node, **when** the user clicks **+** beside it and chooses a role, provider, and
  model, **then**:
  - exactly one new node is created with the chosen role, provider, and model;
  - exactly one new edge is created from the clicked node to the new node;
  - the tree is saved (AC-02).
- **Given** **+** beside the Manager, **then** the new edge is `Manager → child`.
- **Given** an active request, **when** the user adds a node with **+**, **then** only the live
  tree changes. The active request's snapshot is unchanged unless the user approves a rebase
  (Agreed: decisions A3 and A4; see AC-20).
- **Given** the new node shares a role with existing nodes, **then** it receives the next free
  (lowest) priority in that role (Agreed: decision A7).

- **Given** the user clicks **+**, **then** the picker opens with role, provider, and model all
  unselected, and the *Add* button is enabled only when all three are chosen (Agreed: decision
  A8). Nothing is pre-filled from the parent or from earlier choices.

**Proposed details (not agreed):**

- Cancelling the picker creates no node and no edge.

## Traceability

| Product rule (product-brief.md) | Criteria |
|---|---|
| Open project, configure tree | AC-01, AC-02, AC-22 |
| Only configured agents, permitted connections | AC-03, AC-11, AC-20, AC-21 |
| Delegation and planning | AC-04 |
| Problem routing | AC-05 |
| Review of fixes | AC-06 |
| Missing roles, Manager-only communication | AC-07, AC-10 |
| Retry limits | AC-08 |
| Outages and usage limits | AC-09 |
| Permissions | AC-12, AC-13 |
| No silent agent or model changes | AC-11, AC-17 |
| Visible activity and accurate reporting | AC-15, AC-16, AC-18 |
| Windows and macOS | AC-19 |
