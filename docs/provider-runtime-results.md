# Provider Runtime Results (Stage 1, item 6, gate G6.5)

Run on 2026-11-16, Windows 11, by Claude under the user's authorization for minimal
subscription-based integration tests. For independent review; item 6 stays partial.

- Scripts: [`tools/provider-probes/`](../tools/provider-probes/README.md)
- Sanitized evidence: [`docs/evidence/provider-runtime/2026-11-16/`](evidence/provider-runtime/2026-11-16/)
- Statements here are runtime observations of specific builds. They are not legal findings.
- **Revision 2 (same day), after independent review.** Offline corrections only: no probe was
  rerun and the evidence files are unchanged. §7 lists what changed and what the existing
  evidence does not retain. The evidence was produced by the runner scripts as committed in
  `38ccc30`, before the hardening described in §7.

## 1. Summary

| Provider | Model requests used (limit 5) | Billing mode observed | Outcome |
|---|---|---|---|
| Claude Code | **3** | Claude.ai subscription (`pro`), no API key | Checks without a login ran first (§3). After the user signed in, the launch profile, a denied write, and an interrupt behaved as recorded in §3a |
| Codex | **3** | ChatGPT subscription (`plus`), credit balance 0 | Handshake, a basic turn, a declined approval, and an interrupt all behaved as recorded in §4 |

- **Retries.** The probe scripts retried nothing. The Claude Code evidence shows no `api_retry`
  event. Codex's own internal retries were not disabled; its evidence shows no `error`
  notification.
- **Fan-out.** For Claude Code, the recorded tool lists contain no delegation tool. For Codex,
  **the absence of delegation or fan-out is unverified**: tool availability was not recorded,
  and `approvalsReviewer: "user"` only routes approval requests to the client (see §7).
- **Billing.** No API key was used. No credits were bought and no overage was enabled.

## 2. What was actually run

**Neither CLI is installed as a standalone tool on this machine.** `claude` and `codex` are not on
`PATH`, and there is no native, npm, or WinGet install of either. The probes used the official
binaries bundled with the providers' desktop apps:

| Tool | Version | Where it came from | Signature |
|---|---|---|---|
| Claude Code | 2.1.325 | Bundled with the Claude desktop app | Valid, "Anthropic, PBC" |
| Codex CLI | 0.166.0-alpha.5.1 | Bundled with the Codex desktop app (Microsoft Store package) | Valid, "OpenAI OpCo, LLC" |

Consequences:

- These are official, unmodified binaries, but they are **not** the standalone installs
  WorkTreeAI will ask users to make. Results should be re-confirmed on standalone installs.
- The Codex build is an **alpha**, and `codex app-server --help` labels the command
  "[experimental]".
- Every provider process got a cleaned environment: system variables only, with no provider API
  keys and none of the Claude desktop app's session variables.

## 3. Claude Code — checks without a login (0 model requests)

**Why no login at first.** Run with a cleaned environment, `claude auth status` reported
`loggedIn: false, authMethod: "none"`. This session's own Claude access comes from the desktop
app, and that session was deliberately **not** reused: doing so would mean handling another
tool's session credentials, and the billing mode would be unclear. The user signed in later;
see §3a.

**Method.** Each case ran `claude -p "Reply with exactly: OK"` in a fresh hostile fixture project,
with an empty temporary `CLAUDE_CONFIG_DIR`. With no credentials, no model request is possible;
every run ended with "Not logged in". The fixture contains:

- a `SessionStart` hook that writes `HOOK_RAN.txt`;
- a `.mcp.json` server whose command writes `MCP_STARTED.txt`;
- a project subagent named `rogue`.

| Case | Hook ran | MCP server process started | `rogue` agent listed | Tools listed |
|---|---|---|---|---|
| No suppression flags (control) | **Yes** | **Yes** | **Yes** | Full default set |
| Only `--setting-sources user` | No | No | No | Full default set |
| Only `--safe-mode` | No | No | No | Full default set |
| Only `--strict-mcp-config` | **Yes** | No | **Yes** | Full default set |
| Profile A (all flags) | No | No | No | `Read` only |

**Findings**

- **C1. The risk is real.** With no suppression, `claude -p` ran the project's hook and started
  the project's MCP server process with no prompt, in a folder never trusted. The hook events
  (`hook_started`, `hook_response`) came **before** `system/init`. A startup check therefore
  cannot prevent a hook; only launch flags can.
- **C2. Profile A suppressed all three** in this build: no hook, no MCP server process, no
  project subagent. `--tools "Read"` left exactly one tool.
- **C3. `--safe-mode` is accepted together with `-p`**, and on its own it suppressed the hook, the
  MCP server, and the project subagent. `--setting-sources user` alone did the same.
  `--strict-mcp-config` alone stops only MCP servers.
- **C4. Built-in plugins were listed in every recorded case.** Four `cc-plugin-*@builtin` entries
  appear in `system/init` in each case run with this build, including Profile A. "Every case"
  means the cases recorded here for Claude Code 2.1.325, not all builds or configurations. A
  startup check should allow-list built-in plugins rather than require an empty plugin list.
- **C5. Built-in agents were listed in every recorded case** (`claude`, `Explore`,
  `general-purpose`, `Plan`), including the case with tools restricted to `Read`. In these cases
  the agents list was not a safety signal; the tools list was. In this build the delegation tool
  appears as `Task`, not `Agent`.
- **C6. Not-logged-in behavior.** Exit code 1. With `--output-format json`, the output is one
  result object with `subtype: "success"`, `is_error: true`, and
  `result: "Not logged in · Please run /login"`, at `total_cost_usd: 0`. An adapter must check
  `is_error` and the exit code, not `subtype`.
- **C7. An interrupt protocol is advertised.** `system/init` lists capabilities such as
  `interrupt_receipt_v1` and `interrupt_cancel_queued_v1`. It was not exercised.

**Not covered by the no-login checks:** anything needing a login. See §3a.

## 3a. Claude Code — signed-in checks (3 model requests)

**Sign-in.** The user signed in through Claude Code's own `claude auth login` flow in their
terminal and browser. The probe script only launched that command; it never saw or stored
credentials. The login lives in a dedicated config folder (`~/.worktreeai-probe/claude-config`),
so the user's normal Claude Code and desktop app configuration was not touched.

**Billing check (no model request).** Before each scenario, `claude auth status` had to report
`loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`. It reported
`subscriptionType: "pro"`. The environment held no API key, and `system/init` reported
`apiKeySource: "none"` in every run.

**Scenarios.** Each ran in a fresh hostile fixture project with Profile A, the model pinned to
`claude-haiku-5-5`, and `CLAUDE_CODE_MAX_RETRIES=0`. No `api_retry` event occurred.

| # | Scenario | Result |
|---|---|---|
| 1 | Profile A, tools `Read`, prompt "Reply with exactly: OK" | Exit 0 in 2.7 s. Reply "OK". No hook ran and no MCP server started. Tools listed: `Read` only |
| 2 | Profile A, tools `Read,Write`, prompt asks to create `probe.txt` | The model called `Write`; a `system/permission_denied` event followed; `permission_denials` lists `Write`; the file was not created; the turn continued and exited 0 |
| 3 | Profile A, no tools, `--input-format stream-json`; an interrupt control request is sent at the first text delta | `control_response` `success` after 3 ms; the turn ended 11 ms after the interrupt with `result.subtype: "error_during_execution"`; partial text "1 2 3 4"; exit code 1 once input closed |

**Findings**

- **C8. Profile A keeps subscription authentication.** `--safe-mode` with `-p` and the other
  Profile A flags completed a request on the Claude.ai login.
- **C9. Model as requested, where it was reported.** Requested `claude-haiku-5-5`.
  - `system/init.model` was `claude-haiku-5-5` in all three runs.
  - `result.modelUsage` had the single key `claude-haiku-5-5` in the two completed runs. It is an
    object keyed by model name.
  - In the interrupted run, `result.modelUsage` was **empty**. That run therefore has no
    result-level confirmation of which model served it.
- **C10. Denials are reported, not silent.** With `--permission-mode default` and
  `--permission-prompts none`, a tool call that needs approval is denied, reported as a
  `system/permission_denied` event and in `result.permission_denials`, and the turn continues.
  The result is still `subtype: "success"`, `is_error: false`, so an adapter must read
  `permission_denials`.
- **C11. Clean interrupt works on Windows through stream-json.** A
  `{"type":"control_request","request":{"subtype":"interrupt"}}` message on stdin ended the turn
  within about 15 ms. No signal was needed.
- **C12. An interrupted turn looks like an error.** Its result has
  `subtype: "error_during_execution"`, `is_error: true`, and the process exited with code 1.
  - An adapter may classify a turn as `cancelled` **only** when all of these hold: it sent an
    interrupt request; a `control_response` with the **same `request_id`** and `subtype:
    "success"` arrived; and the `error_during_execution` result for that turn arrived after that
    acknowledgement.
  - Any other error result is an independent failure and must stay `failed`. This includes an
    `error_during_execution` with no acknowledgement, an acknowledgement for a different
    request, an error that arrived before the acknowledgement, and any other error subtype.
  - What the existing evidence shows: the acknowledgement arrived 3 ms after the request and the
    result 8 ms after that. The evidence recorded the acknowledgement's subtype and time, **not
    its `request_id`**, so correlation by ID is not demonstrated by it. The runner now records
    and checks the ID (§7).
- **C13. Project instructions were not followed under Profile A.** The fixture's `AGENTS.md` says
  to end every reply with "BANANA"; the scenario 2 reply did not. (The built-in
  `cc-plugin-agents-md` plugin is still listed, so this shows the instruction had no visible
  effect, not that the file was never read.)
- **C14. Rate-limit events are emitted.** A `rate_limit_event` message appeared in the first two
  runs. Its contents were not recorded.

**Not covered**

- User-level settings, plugins, and mods: the dedicated config folder holds only the login. In
  production WorkTreeAI would run against the user's real configuration.
- Whether `CLAUDE_CODE_MAX_RETRIES=0` actually disables provider-internal retries (none occurred).
- Interrupt during a running tool or shell command; surviving child processes.
- Whether `--disallowedTools "Agent"` alone removes the `Task` tool.
- Profile B (the permission-MCP profile); expired credentials; a `fallbackModel` in user settings.
- A standalone install; macOS.

## 4. Codex — app-server (3 model requests)

**Billing check (no model request).** `account/read` returned `type: "chatgpt"`,
`planType: "plus"`. `account/rateLimits/read` showed a 300-minute and a 10,080-minute window and a
credit balance of 0 (`hasCredits: false`). `codex login status` printed "Logged in using ChatGPT".
The turns below ran only after this check passed.

**Handshake (no model request).** `initialize` succeeded. `model/list` returned 8 models with
their reasoning efforts; the default was `gpt-6.1-sol`. Schema generation for this version
produced 320 files.

**Turns.** Each ran in its own `codex app-server` process, in a fresh fixture project, on an
ephemeral thread with `sandbox: "read-only"`, the smallest listed model (`gpt-5.6-luna`), and
effort `low`.

| # | Scenario | Result |
|---|---|---|
| 1 | Basic reply, `approvalPolicy: "never"` | Reply "OK". Turn `completed` in 4.9 s. 13,719 input tokens, 5 output tokens |
| 2 | Write a file, `approvalPolicy: "untrusted"`; the probe answers `decline` | One `item/commandExecution/requestApproval` with the command and working directory. After `decline`: command not run, file not created, turn `completed`, `serverRequest/resolved` sent |
| 3 | Same prompt; the probe does not answer for 12 s, then sends `turn/interrupt` | No events and no turn end during the 12 s. After `turn/interrupt`: `{}` response, turn `interrupted` 108 ms later, `serverRequest/resolved` sent, file not created |

**Findings**

- **X1. Model as requested.** Requested `gpt-5.6-luna`; `thread/start` reported `gpt-5.6-luna` in
  all three runs, with no model-change notification.
- **X2. Per-action approval works.** With `untrusted` and a read-only sandbox, a shell command
  was sent to the client for approval before running. Declining stopped the command and let the
  turn continue.
- **X3. Unanswered approvals wait.** The server waited at least 12 s without ending the turn.
  The upper bound is unknown. WorkTreeAI needs its own timeout.
- **X4. Clean interrupt worked on Windows in this case.** `turn/interrupt` during a pending
  approval ended the turn as `interrupted` in about 0.1 s and cleared the pending request.
  Interrupting during generation or during a running command was not tested. The same
  correlation rule as C12 applies: `cancelled` requires our `turn/interrupt` to be acknowledged
  and a `turn/completed` with status `interrupted` for the **same turn ID**, arriving after our
  request. The existing evidence did not retain turn IDs; the runner now does (§7).
- **X5. Project instructions are loaded.** The fixture's `AGENTS.md` says to end every reply
  with "BANANA". In scenario 2 the final message was "BANANA". Codex therefore reads `AGENTS.md`
  from the opened project and follows it. (In scenario 1 the explicit "Reply with exactly: OK"
  won.) How to suppress this is still unresearched.
- **X6. MCP startup-status notifications were observed.** The runs produced 8, 6, and 6
  `mcpServer/startupStatus/updated` notifications. Only the counts were retained. **Not
  retained:** how many servers were involved, whether any started successfully, their names, and
  where they were configured. The evidence therefore does not show that user-level servers
  started, only that Codex reported MCP startup activity while using the real Codex home.
- **X7. Token totals differ by scenario.** The last reported totals were about 13,700 tokens
  for scenario 1 and about 29,000 for scenario 2. The number of underlying model calls in a turn
  was **not recorded** and is not inferred here. The budget above counts turns.
- **X8. Process exit.** Each app-server exited with code 0 within 5 s of its input closing.

**Not covered**

- **Tool availability and fan-out.** Which tools Codex had, and whether it could delegate to
  subagents, was not recorded or restricted. `approvalsReviewer: "user"` does not disable
  delegation.
- `on-request` approval policy, `workspace-write` sandbox, and file-change approval requests.
- Interrupt during generation or command execution; surviving child processes.
- Which MCP servers Codex starts, from where, and how to suppress them and project instructions.
- A standalone, non-alpha Codex CLI; macOS.
- Whether WorkTreeAI's use of app-server fits OpenAI's conditions
  ([provider-integrations.md §2.2](provider-integrations.md#22-authentication-and-deployment-conditions)).

## 5. Effect on the gates in provider-integrations.md §4

| Gate | Status after these runs |
|---|---|
| Claude Profile A behavior | **Observed** for project content, with and without login: hooks, MCP, and project agents suppressed; subscription auth kept (C2, C3, C8). User-level settings and Profile B are still open |
| Missing-credential behavior | **Observed for Claude Code** (C6). Expired credentials and Codex are still open |
| Unanswered-approval behavior in app-server | **Observed** (X3): waits at least 12 s. Upper bound open |
| Clean interrupt on Windows | **Observed for both** in one case each: Codex `turn/interrupt` (X4), Claude Code stream-json interrupt (C11). Interrupt during a running command is still open |
| Model-substitution detection | **Partly observed** in the simple case: requested and reported models matched where a model was reported (X1, C9). The interrupted Claude run reported no model usage. A forced substitution was not produced |
| Codex project-config loading | **Observed that `AGENTS.md` is loaded** (X5). MCP startup activity was seen but its source is unknown (X6). Suppression still open |

Every gate above remains **partial**. None is closed by these runs.

## 6. What is blocked, and by what

- **Budget.** Claude Code: 3 of 5 requests used. Codex: 3 of 5 used. The remaining 2 per
  provider are unused; nothing further is planned without a reason from review.
- **Standalone CLIs.** Installing either CLI is a download and install on the user's machine and
  was not done. Until then, every result here is for the desktop-app-bundled builds.
- **The probe login.** The Claude.ai login for the probes remains in
  `~/.worktreeai-probe/claude-config`. Remove it with
  `node tools/provider-probes/claude-login.mjs "<path to claude>" logout`, or by deleting that
  folder.
- **macOS environment.** None available; all results are Windows only.

## 7. Corrections after review (offline; evidence unchanged)

**Statements corrected in this document**

| Item | Correction |
|---|---|
| Fan-out (probe README, §1, §4) | The probe README's claim that `approvalsReviewer: "user"` prevented Codex fan-out is withdrawn. Tool availability and delegation are unverified for the existing Codex evidence |
| X6 | Narrowed to the observed notification counts. Server count, successful startup, and source were not retained |
| X7 | The inference that two token-usage updates prove two model calls is removed |
| C9 | Qualified: `init` matches in all three runs; `modelUsage` matches in the two completed runs and is empty for the interrupted run |
| C12, X4 | Qualified: cancellation requires a correlated acknowledgement and the matching turn or result; independent failures stay failures |
| C4, C5 | "Always" replaced by "in every recorded case" of this build |

**What the existing evidence does not retain**

- The `request_id` of the Claude interrupt acknowledgement.
- Codex turn IDs on `turn/completed`.
- MCP server names, counts, statuses, and sources for Codex.
- The number of model calls inside a turn.
- Codex tool availability.

**Runner hardening (not exercised against a provider)**

The two signed-in runners (`claude-auth.mjs`, `codex-appserver.mjs turns`) now:

- stop the sequence after the first scenario that ends in a spawn error, timeout, missing
  result or missing `turn/completed`, unexpected process exit, unexpected exit code, error
  result, unexpected turn status, or an exception;
- save the report after **every** scenario, so partial evidence exists before anything stops,
  with `stoppedAfter` and `notRun` recorded;
- record and check the interrupt correlation described in C12 and X4;
- exit non-zero when the sequence did not complete;
- (added 2026-11-17, after review of `ed7eee0`) treat a "denied write" scenario as failed unless
  the denial is confirmed: for Claude Code, a `Write` entry in `permission_denials` and no
  `probe.txt`; for Codex, at least one approval request answered and no `probe.txt`. Before
  this, a run in which the write happened could have been recorded as `succeeded`. The
  existing evidence already meets these conditions (Claude: one `Write` denial, no file; Codex:
  one approval answered, no file), and it was not changed.
- (added 2026-11-17, after review of `6aa633c`) count, for the Codex declined approval and the
  unanswered approval, only **supported** approval requests (`item/commandExecution/requestApproval`
  or `item/fileChange/requestApproval`) whose `threadId` and `turnId` match the active thread
  and turn. Every server request now gets an answer that grants nothing, and each answer is
  recorded (`serverRequestResponses`): the first correlated approval is declined; any other
  approval is cancelled; any other request (for example `item/tool/requestUserInput`) gets a
  JSON-RPC error. An approval that arrives before `turn/start` has returned the turn ID cannot
  be correlated and does not count.
  - That approval requests carry `threadId` and `turnId` comes from the app-server
    documentation (O1, re-checked 2026-11-17), **not from the evidence**: the 2026-11-16 runs
    recorded the method, command, working directory, and item ID of each approval, not its
    thread or turn ID. Whether the observed approvals would pass the new correlation check is
    therefore not demonstrated.
- (added 2026-11-17, after review of `6aa633c`) validate the final process exit for every
  outcome:
  - Claude Code: `succeeded` requires exit code 0 and no signal; `cancelled` (with the
    correlation in C12) requires exit code 1 and no signal, the exit observed for the
    interrupted run. Any other exit makes the scenario fail and stops the sequence, while the
    report keeps the correlated acknowledgement and result.
  - Codex: after each scenario, and after the handshake, the app-server must exit by itself
    once stdin is closed, with code 0 and no signal (all four observed shutdowns did). A
    non-zero code, a signal, a spawn error, or a forced kill after 5 s makes the scenario (or
    the handshake) fail. Before this, the handshake exited 0 whatever the shutdown.

These changes are verified only by offline tests against fake processes
(`tools/provider-probes/runner.test.mjs`): no provider binary runs and no model request is
possible. The hardened runners have **not** been run against Claude Code or Codex, because that
would spend subscription requests.
