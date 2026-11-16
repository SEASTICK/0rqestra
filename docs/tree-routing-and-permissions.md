# WorkTreeAI — Tree, Routing, Permission, and Process Semantics

Revision 3, 2026-11-16. Revised after the third independent review round. §4.2 was updated after
the review of 4e812f3: when clean interruption is unavailable, forced cleanup starts immediately;
the 13 s deadline applies in every path.

- §1 restates the **agreed** product requirements, including those the user confirmed on
  2026-11-16: the "+" child agent, highest-priority idle selection, and decisions A1–A8.
- **Everything else in §2–§4 is a draft proposal pending the user's decision**, except where a
  rule is explicitly marked **Agreed**.
- Where alternatives exist, the draft choice is marked **Draft** and the others **Alternative**.
- [`acceptance-criteria.md`](acceptance-criteria.md) is written against the Draft choices.

## 1. Agreed requirements these rules must preserve

- Users configure their own team (nodes, roles, providers, models, instructions, tools, limits).
- The Manager routes and communicates. It does not write code, review code, or solve
  specialist problems.
- Specialists do the technical work.
- Only configured agents receive work, along permitted tree connections.
- No silent agent creation, and no silent model or provider changes.
- Work runs automatically within configured permissions.
- The Manager asks the user when a role is missing, a decision needs input, or a retry limit is
  reached. Affected work pauses; independent work may continue.
- All user-facing questions and final results come through the Manager. Agent activity is
  visible.

**Confirmed by the user on 2026-11-16:**

- **Adding a child agent with "+".** Clicking **+** beside a node adds a new child agent with
  the role, provider, and model the user chooses. The child is automatically connected by an
  edge from that node to the new child. On the Manager, this creates a `Manager → child` edge.
  This is user-initiated creation, so it does not conflict with "no silent agent creation".
- **Same-role selection.** Among eligible agents with the same role, the **highest-priority idle**
  agent is selected. "Eligible" means permitted by §2.4 and available per §2.9.
- **Implicit correction returns** (decision A1). A forward edge such as `Builder → Reviewer` also
  lets the Manager send the Reviewer's findings back to the Builder to fix the same work. No
  drawn `Reviewer → Builder` edge is needed. Details are in §2.5.
- **Ask before finishing unverified work** (decision A2). When no Code Reviewer or Tester can
  check finished implementation work, the Manager asks the user first: add a verifier, or finish
  as "Completed — unverified". Details are in §2.7.
- **User-approved rebase** (decision A3). An agent added or connected while a request is paused
  reaches that request only after the user reviews a summary of the changes and approves it.
  The request then continues on the updated tree once none of its tasks are running. Finished
  results are kept and not re-run, and queued work is re-checked against permissions. Details
  are in §2.11.
- **Snapshot per request** (decision A4). A request runs on the tree as it was when the prompt
  was sent. Later edits apply to new requests only, unless the user applies them through the
  approved rebase. To stop work that was just reconfigured, the user cancels it.
- **Limits** (decision A5). Defaults: 25 agent launches per request (first attempts, retries,
  correction rounds, and outage retries all count), 2 retries after a failed task, 3 review
  rounds per work item, 3 outage retries, and 50 Manager turns per request. When a request
  reaches its limit, running tasks finish, queued work pauses, and the Manager asks the user.
  Details are in §2.6.
- **Plan first** (decision A6). When a Planner is connected, every building or debugging request
  goes to it before implementation. Requests the app can answer from its own state are not
  planned. With no Planner connected, the Manager asks once per request whether to add one or
  proceed without a plan. Details are in §2.10.
- **Same-role details** (decision A7). Priority always wins, even when the prompt names another
  agent. An agent added with "+" gets the lowest priority in its role. When every eligible agent
  is busy, new work waits for the top-priority one. Details are in §2.8.
- **"+" picker starts empty** (decision A8). The picker opens with role, provider, and model
  unselected. The user chooses all three before the agent can be added. Nothing is pre-filled.

## 2. Proposal — tree and routing semantics

### 2.1 Tree structure

- **Exactly one Manager per tree.** Saving a tree with zero or more than one Manager node is
  rejected with a message. The Manager node cannot be deleted, only reconfigured.
- **No incoming edges to the Manager.** Every specialist result returns to the Manager
  automatically (§2.3). An edge `X → Manager` would therefore mean nothing, so the editor
  rejects it at save time rather than ignoring it silently.
- **Specialist nodes** have exactly one role from the role list, and may share a role with other
  nodes.
- **Edges** are directed, between distinct nodes, with no duplicates. Cycles between specialists
  are allowed; execution is bounded by §2.6.

### 2.2 Engine-owned identifiers

The engine creates every identifier. They are opaque random values (e.g. UUIDv4), never derived
from model text.

| ID | Created when | Scope |
|---|---|---|
| `requestId` | The user submits a prompt | One user request |
| `workItemId` | The engine accepts a dispatch that starts new work (rule a or b below) | One logical piece of work inside a request |
| `taskId` | The engine launches an agent run (every attempt, retry, or correction round) | One provider run |
| `outputRef` | A task completes with output | One immutable output record |

Each output record stores its provenance:

- `requestId`, `workItemId`, `taskId`;
- the producing node;
- the parent output (for derived work);
- the correction round;
- whether it has been superseded by a newer output of the same work item.

The Manager only ever refers to work through these IDs, which the engine shows it.

### 2.3 The Manager is the only dispatcher

- The Manager's run produces structured decisions: `dispatch(node, input refs, instructions)`,
  `ask_user`, `report`.
- The engine validates every decision before acting on it.
- Specialists never contact each other. Provider-native delegation is disabled (§3.2).
- Every specialist result returns to the Manager.
- The Manager is launched with no technical tools (§3.1). Free-form Manager text is shown to the
  user. Only structured decisions can cause actions.

### 2.4 What a directed edge authorizes, and how dispatches are validated

The engine accepts `dispatch(Y, …)` only if exactly one of these holds.

**(a) New work.** The input comes from the current request's user prompt or Manager
coordination, and edge `Manager → Y` exists. This creates a new `workItemId`.

**(b) Handoff.** The input names an `outputRef` O such that:

- O belongs to the **current** `requestId`;
- O is **current** (not superseded);
- O's producing node is X, and edge `X → Y` exists.

This creates a new `workItemId` whose parent is O.

**(c) Correction.** The dispatch names a work item W and a findings `outputRef` F such that:

- W's current output O was produced by node Y (**author affinity**: corrections go back to the
  node that produced the work, never to another node with the same role);
- F is a current output of node Z, produced by reviewing O;
- edge `Y → Z` exists (§2.5).

This keeps the same `workItemId` and increments its correction round.

**Rejected, logged, and reported to the Manager:**

- an unknown or fabricated ID;
- an output from another request (cross-request);
- a superseded output (stale) — the Manager is told the current `outputRef`;
- a missing edge;
- a nonexistent node;
- a node outside the request's configuration snapshot (§2.11).

A rejected decision launches nothing and uses no dispatch budget. After 3 consecutive rejected
decisions in one request, the engine pauses the request and tells the user the Manager is not
making valid decisions.

**Example.** Tree: `Manager → Builder → Reviewer`, with no `Manager → Reviewer` edge.

- After the Builder completes, the Manager **may** dispatch the Reviewer with the Builder's
  current output, under rule (b) through the `Builder → Reviewer` edge.
- The Manager **may not** send the Reviewer fresh user work, because rule (a) needs a
  `Manager → Reviewer` edge.

### 2.5 Correction return paths

- **Agreed (user, 2026-11-16, decision A1) — implicit return.** A forward edge `Y → Z` also
  authorizes rule (c): returning Z's findings to Y for rework on the same work item.
  - Corrections go only to the authoring node.
  - Explicit `Z → Y` edges are needed only to send Z's output to Y as *new* work under rule (b).
  - The number of correction rounds is bounded by §2.6 (default 3, agreed in decision A5).
- *Rejected alternative:* explicit return edges required for corrections.

### 2.6 Bounds

**Agreed (user, 2026-11-16, decision A5):** the default values below, what counts toward each
limit, and the behavior when a request-wide limit is reached. The defaults are starting values;
each tree can change them.

**Draft — not approved:** the wait times between outage retries (5 s, then 20 s, then 60 s). The
count of 3 outage retries is agreed; these timings are not.

| Counter | Default | Counts | Scope |
|---|---|---|---|
| Retries after task failure | per node, default 2 | Same-node re-run after a task failure | per task chain |
| Review rounds | 3 | Correction rounds on one work item | per work item |
| Outage retries (WorkTreeAI level) | 3 (backoff timings: Draft, see above) | Re-runs after a provider availability error | per task chain |
| **Request dispatch limit** | **25** | **Every agent launch for the request:** initial attempts, retries, correction rounds, and outage retries. Not counted: provider-internal retries, rejected decisions | per request |
| Manager turns | 50 | Manager runs for the request | per request |

**When a request-wide limit is reached (Agreed, decision A5):**

- No new launch starts for that request.
- **Running** tasks continue to completion (the user can cancel them). Their outputs are
  recorded, but nothing is dispatched from them.
- **Queued** items are held as `paused: request limit`.
- The Manager asks the user to: raise the limit by a chosen amount, stop (queued items are
  cancelled and a final summary is produced), or continue only selected items.

*Rejected alternative:* cancelling running tasks immediately when the limit is reached.

### 2.7 Missing verification roles

This applies when implementation work completes and no Code Reviewer or Tester is reachable for
it under §2.4.

- **Agreed (user, 2026-11-16, decision A2) — ask before skipping.** This is treated as a missing
  role, consistent with the agreed rule "ask when a role is missing".
  - The work item pauses in `awaiting-user`.
  - The Manager asks once per request: add or connect a verifier, or finish without
    verification.
  - If the user chooses to finish, the item is reported as **"Completed — unverified (user
    chose to skip verification)"**. It is never reported as reviewed, tested, or verified.
  - An added verifier reaches the paused request through the user-approved rebase in §2.11
    (agreed, decision A3).
- *Rejected alternatives:* automatic "completed — unverified" with no question; a per-tree
  "require verification" setting.

### 2.8 Selecting among agents with the same role

**Agreed (user, 2026-11-16):** among eligible candidates, the **highest-priority idle**
candidate is selected. Candidates are the nodes with the needed role that are permitted by §2.4
and available per §2.9.

**Agreed (user, 2026-11-16, decision A7):**

1. **Priority always wins over a named agent.** Naming an agent in the prompt does not change
   selection. To steer work to a particular agent, the user changes priorities in the tree.
   *Rejected:* the named agent overriding priority.
2. **New agents get the lowest priority.** A node added with "+" gets the next free (lowest)
   priority in its role. Existing nodes keep their order, and the user can reorder later.
   *Rejected:* asking for a priority in the "+" picker.
3. **All busy: wait for the top-priority agent.** When work arrives and every eligible candidate
   is busy, the work waits for the highest-priority eligible candidate. It stays bound to that
   agent even if a lower-priority candidate becomes idle sooner. *Rejected:* giving it to the
   first candidate that becomes idle; asking the user.

How this fits the highest-priority idle rule: selection happens when the work arrives.

- If at least one eligible candidate is idle at that moment, the highest-priority idle one is
  selected.
- If none is idle, rule 3 applies.

**Agreed in decision A1:** corrections always return to the authoring node (§2.4c), regardless of
priority.

**Draft — still pending:**

- **Priority uniqueness.** Priorities are unique within a role, and the editor enforces this
  (for example when the user reorders agents).
- **Ties.** If uniqueness is enforced, ties cannot occur. As a safeguard, the engine breaks any
  tie by node creation order.
- **Visibility.** Every choice is shown in the activity feed.
- **Top-priority candidate becomes unavailable while work waits for it** (for example its
  provider signs out). Draft: the Manager asks the user; the work is not moved silently.

### 2.9 Other edge cases

- **Disconnected node** (no path from the Manager): never receives work and does not provide its
  role. The UI marks it.
- **Missing role:** the item pauses, and the Manager asks the user to add or connect a node, or to
  skip the step. No node is ever created automatically. A node the user adds reaches the paused
  request only through the user-approved rebase in §2.11. The live tree changes immediately, but
  the running request's snapshot does not.
- **Unavailable node** (CLI not installed, not signed in, model unavailable): treated as
  unavailable. The Manager asks the user. Provider and model are never switched.

### 2.10 Planning rule

**Agreed (user, 2026-11-16, decision A6).**

- **Plan first:** if a Planner is reachable under rule (a), every request that the Manager would
  route to implementation (Builder or Debugger) goes to a Planner first.
- **Not planned:** requests answerable from WorkTreeAI's own state, such as "what is running?",
  "summarize the last result", or "cancel task 3".
- **No Planner reachable:** the Manager asks once per request whether to add one or to proceed
  without a plan. The choice is recorded on the request.

### 2.11 Configuration snapshot

- **Agreed (user, 2026-11-16, decision A4).** When the user submits a request, the engine snapshots the tree configuration (nodes,
  edges, roles, providers, models, instructions, permissions, limits). The whole request runs on
  that snapshot. Edits apply to **new** requests only. The UI shows when an active request is
  using an older configuration. To stop work that the user has just reconfigured, the user
  cancels it.
- The only way an edit reaches an active request is the user-approved rebase below (decision
  A3).
- *Rejected alternative:* permission and limit tightening applying immediately to tasks not yet
  launched.

**The contradiction this resolves.** Under the snapshot rule, a request never sees tree edits.
But the missing-role rule asks the user to add or connect an agent so the request can continue.
Without an explicit bridge, an added agent could never help the paused request.

**Agreed (user, 2026-11-16, decision A3) — user-approved rebase of a paused request.**

1. **Offer.** When an item pauses for a missing role (or any question whose answer is a tree
   edit), the Manager's question offers: *edit the tree, then apply it to this request*.
2. **Edit.** The user edits the live tree, for example with "+" (§1). Nothing changes for the
   request yet.
3. **Review and approve.** The user clicks *Apply to this request*. WorkTreeAI shows a diff of
   snapshot v*n* against the edited tree: nodes, edges, roles, providers, models, permissions,
   and limits. Loosened permissions and changed models are highlighted. Nothing is applied
   without this explicit approval.
4. **Quiesce.** The rebase waits until the request has no running task. Running tasks finish or
   the user cancels them, and queued items stay held. No task runs under a mix of two snapshots.
5. **Apply.** The engine creates snapshot v*n+1* for the request and records the version on
   every later task.
6. **Preserve results.** Completed outputs are kept unchanged, with their original snapshot
   version in their provenance. They are not re-run.
7. **Revalidate before resuming.** Every queued item and the paused item is re-checked under
   v*n+1*: node exists, edge exists (§2.4), and permissions satisfied with the fail-closed check
   (§3.4).
   - An output whose producing node was removed stays readable, but cannot be handed off along
     edges that no longer exist.
   - Items that fail revalidation stay paused, and the Manager explains why.
8. **Counters carry over.** The request dispatch count and per-item counters continue. Limits
   from v*n+1* apply; a lowered limit can immediately pause the request.
9. **Decline.** If the user declines, the item stays paused or the user skips it. The edited live
   tree applies to new requests only.

*Rejected alternatives:* restarting the request on the edited tree; rebasing without waiting for
running tasks to finish.

### 2.12 Decisions for the user

| Topic | Draft | Alternatives |
|---|---|---|
| Correction return path | **Agreed (A1):** implicit via forward edge | — |
| Missing verification | **Agreed (A2):** ask before skipping | — |
| Same-role selection | **Agreed:** highest-priority idle eligible agent. **Agreed (A7):** priority wins over a named agent; "+" nodes get the lowest priority; when all are busy, wait for the top-priority agent | — |
| Top-priority agent becomes unavailable while work waits for it | Manager asks the user (§2.8) | Move the work to the next priority |
| Request limit reached | **Agreed (A5):** running tasks finish; queued paused | — |
| Editing the tree during a request | **Agreed (A4):** snapshot per request | — |
| Applying an added or connected agent to a paused request | **Agreed (A3):** user-approved rebase once no task is running (§2.11) | — |
| Default bounds | **Agreed (A5):** table in §2.6 | — |
| Planning | **Agreed (A6):** plan first when a Planner is connected (§2.10) | — |
| Matched orphan processes after a crash | Terminate automatically and report (§4.3) | Ask first |
| Processes of unknown ownership | Block resume until the user resolves them (§4.4) | — |
| Descendants left behind by a finished task | Terminate tracked descendants (§4.3) | Allow with explicit permission (later) |
| Change attribution between writing tasks | Serialized writers per project, with captured baselines ([acceptance-criteria.md AC-18](acceptance-criteria.md#ac-18-accurate-summaries-backed-by-reconciliation-fixture)) | Isolated workspace per writing task |

**Agreed, not pending:**

- the "+" child-agent behavior (§1);
- highest-priority idle selection (§2.8);
- implicit correction returns (§2.5, decision A1);
- asking before finishing unverified work (§2.7, decision A2);
- the user-approved rebase of a paused request (§2.11, decision A3);
- one configuration snapshot per request (§2.11, decision A4);
- the default limits and the behavior at a request limit (§2.6, decision A5);
- the plan-first rule (§2.10, decision A6);
- the same-role details (§2.8, decision A7): priority wins over a named agent; new agents get
  the lowest priority; when all are busy, work waits for the top-priority agent;
- the "+" picker starting empty (§1, decision A8).

## 3. Proposal — permission enforcement layers

Actions such as shell commands and file edits are generated **inside** provider CLIs.
Enforcement therefore has three layers, each with different guarantees.

### 3.1 Layer 1 — WorkTreeAI dispatch (fully enforced by WorkTreeAI code)

| What | How | Guarantee |
|---|---|---|
| Which node gets work | §2.4 validation | Complete |
| No silent node creation | Engine runs only snapshot nodes | Complete |
| Provider and model per node | Engine builds launch commands from the snapshot; actual model checked after each turn | Complete for launch; detecting provider-side substitution needs runtime tests |
| Limits, retries, review rounds | §2.6 counters | Complete |
| Manager has no technical tools | Manager launched with `--tools ""` and Profile A (Claude), or equivalent | Depends on Layer 2; runtime test required |

### 3.2 Layer 2 — actions inside provider CLIs (configured by WorkTreeAI, enforced by the provider)

| Control | Claude Code | Codex app-server |
|---|---|---|
| Tool availability | `--tools`, `--disallowedTools` (`"Agent"`, `"mcp__*"`). `--allowedTools` only auto-approves | Sandbox + approval policy; tool-restriction surface not yet researched |
| Per-action approval | Profile A: deny anything that would prompt. Profile B: WorkTreeAI approval MCP tool ([provider-integrations.md §1.4](provider-integrations.md#14-what-ordinary--p-loads-and-suppression-profiles)) | `requestApproval` requests answered by WorkTreeAI |
| Project hooks, MCP, subagents | Suppressed **before launch** by profile flags | Not yet researched (provider-integrations §2.4) |
| Startup check | `system/init` **detects** unexpected config and stops the run. It cannot undo hooks that already ran | Runtime test required |

### 3.3 Layer 3 — filesystem and process isolation

| Platform | Claude Code | Codex | WorkTreeAI |
|---|---|---|---|
| Windows (native) | OS sandboxing **not supported** (WSL 2 only) | `mxc` / `elevated` / `unelevated` | `cwd` = project root; cleaned environment; no elevation; process-tree termination (§4) |
| macOS | Sandboxing documented as available (details not read) | Sandbox available (details not read) | Same, using process groups |

WorkTreeAI provides no OS sandbox of its own in the initial scope.

### 3.4 Fail-closed rule

- Each node's permission profile lists required restrictions.
- Before launch, the engine checks them against the adapter's `capabilities()` for the current
  provider and platform.
- **If any restriction cannot be enforced, or its support is unknown or untested, the node does
  not start.**
- The Manager channel then offers three choices: relax that permission, use a different
  provider, or use a supporting environment.
- A permission is never weakened silently.

## 4. Proposal — process ownership and cancellation

### 4.1 Ownership model

- **Draft — dedicated processes.** Every task launch gets its own provider process: one
  `claude -p` per Claude task, and one `codex app-server` (one thread) per Codex task. The engine
  is the parent and owns the whole process tree.
  - Cancelling or killing one task's tree affects no other task.
  - The cost is process start-up time per task.
- **Alternative — shared processes.** One long-lived `codex app-server` per node or project
  serves several tasks.
  - Cancellation uses `turn/interrupt` per task.
  - A forced termination kills every task on that process, and each must then be reported as
    `interrupted`, naming the cancellation that caused it.
  - Not drafted, because of that blast radius.

### 4.2 Cancelling task A while task B continues (Draft)

Each adapter reports, per platform, whether **clean interruption** is supported. That means a
documented way to end the current turn cleanly, which a runtime test has confirmed. The cancel
path depends on that capability:

| Adapter / platform | Clean interruption | Mechanism |
|---|---|---|
| Codex app-server, Windows and macOS | Supported (runtime gate pending) | `turn/interrupt` |
| Claude Code, macOS | Supported (runtime gate pending) | SIGINT |
| Claude Code, native Windows | **Unavailable**, until the runtime gate confirms a `stream-json` interrupt ([provider-integrations.md §1.7](provider-integrations.md#17-cancellation-and-errors)) | — |

Until a "runtime gate pending" entry passes its gate, it is treated as **unavailable** (fail
closed toward a forced stop).

1. **Clean interruption supported.**
   - Send the interrupt.
   - Wait **up to 10 seconds** for the turn to end and the provider root to exit.
   - If it exits in time, the task ends `cancelled (graceful)`, and forced cleanup is still run
     for any tracked descendant that remains.
   - If it hasn't exited at 10 s, forced cleanup starts then.
2. **Clean interruption unavailable.** Send no interrupt and do not wait: **forced cleanup starts
   immediately.** The task ends `cancelled (forced; clean interrupt unavailable)`.
3. **Forced cleanup.** Stop every process WorkTreeAI tracks for task A (§4.3), and nothing
   belonging to task B.
   - Windows: `taskkill /PID <pid> /T /F` on the provider root, then terminate any tracked
     descendant that is still alive.
   - macOS: SIGTERM to A's process group, then SIGKILL to the group after up to 3 s (sooner if
     the 13 s deadline requires it), then terminate any tracked descendant that left the group.
   - When forced cleanup follows a missed graceful window, the task ends `cancelled (forced)`.
   - **Deadline: in every path, forced cleanup is complete within 13 seconds of the cancel.**
4. **Record the outcome.**
   - Files changed before the stop are found by reconciliation and reported as "possibly
     partial" (AC-18).
   - Any tracked process that could not be terminated is reported by PID and executable.
     Ownership then becomes "unresolved" (§4.4).
   - Task B runs in a different process tree and keeps running.

**Containment limits.** `taskkill /T` and process groups do **not** guarantee complete
containment:

- `taskkill /T` follows only current parent→child links. It misses descendants whose parent
  already exited, and processes started through services, the Task Scheduler, COM, or WMI.
- A process group misses descendants that call `setsid` or `setpgid`, and daemons that
  double-fork.
- Descendant tracking (§4.3) narrows these gaps but cannot close them. It only knows what it
  observed.

A Windows Job Object with kill-on-close and no breakaway would contain more, but still not
everything. It needs a native module and is a later option, not part of this draft. Until a
mechanism is verified at runtime, the product must describe cleanup as "tracked processes
terminated", never as "all processes terminated".

### 4.3 Process ledger, descendant tracking, and crash recovery

**Ledger writes, in order** (each persisted durably before the next step):

1. **Before spawn:** `{taskId, appInstanceId, launchToken, state: launching, launchedAt}`.
   - `appInstanceId` identifies this WorkTreeAI process: its PID and start time, recorded at app
     startup.
   - `launchToken` is a fresh UUID. For Claude, the engine-assigned `--session-id` UUID serves as
     the token, because it appears on the provider's command line.
2. **Immediately after spawn returns,** before reading any output: `pid`, process start time,
   executable path, and (macOS) process group ID.
3. **While running:** every 2 s, enumerate the provider root's descendants and append any new
   ones to the ledger as `{pid, start time, executable, parentPid}`.
   - Windows: `Win32_Process` via CIM.
   - macOS: `ps -A -o pid=,ppid=,pgid=,lstart=,comm=`.
4. **On exit:** the exit code, and the exit time of each tracked process that has ended.

**The provider parent exits while descendants remain** (for example a dev server started by a
shell tool). When the provider root exits — success, failure, or crash — the engine checks
every tracked descendant of that task (identity checked by PID, start time, and executable).

- Draft: any that are still alive are terminated, and the task result lists them.
- Alternative: allow a task to leave a process running, only with an explicit node permission
  (later; not drafted).

This relies on the 2 s descendant polling. A short-lived intermediate process can spawn and exit
between polls, so this is best effort. The limits in §4.2 apply.

**Startup recovery after a WorkTreeAI crash.** For every ledger task without an exit record:

- **PID was persisted (step 2 done):** check whether that PID exists with the same start time and
  executable. This guards against PID reuse.
  - If it matches, it is an orphan. Draft: terminate it and its tracked descendants, record
    "orphan terminated after restart", and tell the user. Alternative: ask first.
  - If nothing matches, the root is gone. Tracked descendants are still checked and terminated
    if alive.
- **Crash between spawn and PID persistence (step 1 done, step 2 not):** ownership is
  **unknown**.
  - The engine searches for candidates: processes with the provider's executable, started after
    `launchedAt` and before the crash.
  - The best evidence is the `launchToken` on the command line (Claude `--session-id`), readable
    via `Win32_Process.CommandLine` on Windows and `ps -o command=` on macOS. Next best: on
    Windows, a `ParentProcessId` equal to the crashed app instance's PID (Windows keeps the stale
    value; macOS reparents to PID 1, so this signal does not exist there).
  - A candidate that matches the `launchToken` is treated as an orphan, as above.
  - Anything weaker — candidates with no token match, or no way to read command lines — is
    **not** terminated automatically. It goes to §4.4.
- Every affected task is marked `interrupted`.

**Runtime gates:**

- whether Codex app-server accepts an engine-chosen identifier usable as a launch token;
- whether reading command lines is reliable on both operating systems without elevation;
- descendant enumeration cost at 2 s intervals.

### 4.4 Unknown ownership, duplicate prevention, and resume

- **Never automatic.** A task in `launching` or `running` at startup becomes `interrupted` and is
  never relaunched automatically.
- **Ownership states:** each interrupted task has an ownership state:
  - `clear` — no live process of the task exists;
  - `orphan-terminated`;
  - `unresolved` — a candidate process exists but can't be confidently attributed, or a tracked
    process couldn't be terminated.
- **Unknown ownership blocks resume.** While a task is `unresolved`, resuming or re-dispatching
  its work item is **blocked**. The Manager channel shows the candidate processes (PID,
  executable, start time, command line where readable) and offers:
  - terminate these processes;
  - they're not WorkTreeAI's — ignore them;
  - keep the item stopped.

  Only the user's choice changes the state to `clear`.
- **Resuming** is a user action, allowed only when ownership is `clear` or `orphan-terminated`.
  It creates a **new** `taskId` that reuses the work item's provider session reference.
- **Single-flight.** At most one live process per `taskId`, and at most one live task per
  `workItemId`. The engine refuses a launch that would break either rule.
- **Idempotent answers.** User answers carry a `questionId` and are applied at most once (AC-16).
