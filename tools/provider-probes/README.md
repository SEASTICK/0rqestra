# Provider runtime probes

Stage 1 verification tooling for checklist item 6 (gate G6.5). These scripts are **not** part of
the desktop app, the engine, or the Stage 2 interface. They run official provider tools that are
already on the machine and record what those tools do.

## Rules built into the scripts

- **Cleaned environment.** Provider processes get a short allow-list of system variables. No
  provider API key or host-session variable reaches them.
- **Request budget.** At most 5 top-level model requests per provider, counted in
  `out/request-ledger.json` before each request is sent. The scripts refuse to exceed it.
- **No retries.** The scripts retry nothing.
- **Stop on failure.** The signed-in runners stop after the first scenario that ends in a spawn
  error, timeout, missing result, unexpected exit, error result, or exception. A "denied write"
  scenario also fails unless the denial is confirmed (Claude: a `Write` permission denial and
  no `probe.txt`; Codex: a supported approval request for the active thread and turn was
  declined and no `probe.txt`). Unrelated server requests never count. In `approval-declined`,
  every server request is answered without granting anything and every answer is recorded.
  `approval-unanswered-then-interrupt` deliberately leaves the correlated approval unanswered
  until it sends `turn/interrupt`, because that scenario tests the unanswered state. The report
  is saved after every scenario, so partial evidence survives a stop.
- **Exit checks.** Claude Code must exit 0 after a success and 1 after a correlated
  cancellation, with no signal. The Codex app-server must exit 0 by itself once stdin closes,
  after every scenario and after the handshake. Anything else is a failure.
- **Fan-out.** Claude scenarios restrict the tool list, and the recorded lists contain no
  delegation tool. For Codex, fan-out is **not** controlled or verified: `approvalsReviewer:
  "user"` only routes approval requests to this client and does not disable delegation. The
  Codex probes set no project trust entry and no feature overrides, so they exercise Codex's
  defaults. The documented controls for trust, hooks, MCP servers, and subagents
  (`docs/provider-integrations.md` §2.4, revision 4) are not used by these scripts and are
  untested.
- **Billing check.** Codex turns run only if `account/read` reports ChatGPT (subscription) auth.
  Signed-in Claude checks run only if `claude auth status` reports a Claude.ai login. The no-login
  Claude script cannot reach a model at all: it uses an empty temporary config directory.
- **Temporary projects.** Every run uses a fresh fixture project in the temp directory and
  deletes it afterwards.
- **Sanitized output.** Home path, user name, and email addresses are replaced before anything
  is saved. Raw output stays in `out/` (git-ignored); `export-evidence.mjs` copies sanitized
  results to `docs/evidence/provider-runtime/<date>/`.

## Scripts

| Script | Model requests | What it does |
|---|---|---|
| `claude-noauth.mjs` | 0 (impossible) | Runs `claude -p` without credentials against a hostile fixture project under different flag sets, and records which project content loads |
| `claude-login.mjs "<claude>" [login\|status\|logout]` | 0 | Launches Claude Code's own sign-in, status, or sign-out for a dedicated probe config folder. The user completes sign-in in the browser; the script never handles credentials |
| `claude-auth.mjs` | up to 3 | Signed-in checks under the proposed launch profile: a basic reply, a denied write, and a stream-json interrupt. Runs only on a Claude.ai subscription login |
| `codex-appserver.mjs handshake` | 0 | `initialize`, `account/read`, `model/list`, `account/rateLimits/read` |
| `codex-appserver.mjs turns` | up to 3 | A basic reply, a declined approval, and an unanswered approval followed by `turn/interrupt` |
| `export-evidence.mjs <date>` | 0 | Copies sanitized results into `docs/evidence` |

## Offline tests

`runner.test.mjs` tests the runners against fake processes in `test-fixtures/`. It starts only
local Node scripts, so no provider binary runs and no model request is possible. It runs as part
of `npm test`.

## Running

Set the path to each official binary, then run from the repository root:

```bash
WORKTREEAI_CLAUDE_BIN="<path to claude>" node tools/provider-probes/claude-noauth.mjs
```

```bash
WORKTREEAI_CODEX_BIN="<path to codex>" node tools/provider-probes/codex-appserver.mjs handshake
```

```bash
WORKTREEAI_CODEX_BIN="<path to codex>" node tools/provider-probes/codex-appserver.mjs turns
```

Results and their limits are written up in
[`docs/provider-runtime-results.md`](../../docs/provider-runtime-results.md).
