# 0rqestra — Architecture

Revision 2, 2026-11-16 — revised after the independent Stage 1 review.

Every section is labelled:

- **Decision** — agreed in conversation (Stage 1 items 1–8).
- **Proposal** — not agreed; needs the user's review.

**Update 2026-11-16:** the user chose **Electron + TypeScript + React** as the desktop stack
(§3). Other sections marked Proposal remain proposals.

Related:

- [`provider-integrations.md`](provider-integrations.md) — verified CLI behavior.
- [`tree-routing-and-permissions.md`](tree-routing-and-permissions.md) — routing and
  enforcement semantics.

## 1. Decision — high-level components

- **Desktop app for Windows and macOS.** Both are full targets from the start.
- **Local orchestration engine.** It runs on the user's machine and:
  - owns tree configuration;
  - validates every Manager dispatch;
  - supervises provider processes;
  - records task state;
  - emits events.
- **Provider adapters**, one per provider integration (initially Claude Code and Codex).
- **Future iOS companion.** It monitors and controls a Windows or Mac runner over a network
  connection. It never runs provider CLIs itself.
- **Inference runs with the providers.** CLI processes and project file operations run on the
  user's own machine. Cloud execution is out of scope for the initial release.

## 2. Requirement — engine and contracts independent of the desktop UI

This came from the review. The layering below is the target structure. Its detailed contents are
proposals.

```
+------------------------------- Desktop shell (Electron) ----------------------------+
|  UI (renderer/webview): tree editor, Manager chat, activity feed, node settings     |
|        |  narrow, validated, versioned command/event API (no raw process access)    |
+--------|-----------------------------------------------------------------------------+
         v
+------------------ Orchestration engine (UI-independent, TypeScript) ----------------+
|  Tree model + validation | Dispatch validator | Task state machine | Event log      |
|  Permission profiles     | Limits / retries   | Persistence        | Recovery       |
|        |  ProviderAdapter interface                                                  |
+--------|-----------------------------------------------------------------------------+
         v
  Claude Code adapter (claude -p, stream-json)    Codex adapter (codex app-server, JSON-RPC)
         |                                                 |
   user-installed, unmodified `claude`              user-installed `codex`
```

**Engine–UI contract.** The engine exposes one contract:

- commands: `project.open`, `tree.save`, `prompt.submit`, `task.cancel`, `question.answer`,
  `approval.respond`, …;
- a stream of typed events.

Both are defined as versioned JSON schemas. The desktop UI and the future iOS companion consume
the same contract. The companion reaches it through an authenticated remote transport that will
be designed later.

**Engine independence.** The engine has no dependency on Electron APIs. It can run:

- as an Electron utility process;
- headless under a test runner with a deterministic fake provider;
- behind a remote transport for the future iOS companion.

Most acceptance criteria can therefore be tested without any UI or live model.

## 3. Decision — desktop stack (chosen by the user 2026-11-16: Electron)

The comparison below is kept as the record of why Electron was chosen.

**Corrected premise:** both Electron and Tauri can launch and supervise external executables.
Neither CLI needs Node.js at runtime (see
[provider-integrations.md §3](provider-integrations.md#3-cross-cutting-conclusions)). That is
therefore not a reason to prefer either option.

| Criterion | Electron + TypeScript + React | Tauri 2 + Rust core + TypeScript/React UI |
|---|---|---|
| Implementation complexity | One language (TypeScript) for UI and engine; engine runs in a Node utility process | Two languages. Engine in Rust, or a TypeScript engine bundled as a sidecar (which needs Node or a compiled bundle). More build plumbing |
| UI ecosystem | Same web ecosystem (React Flow for the tree, xterm.js for raw output) | Same web ecosystem in the webview. Webview differences between WebView2 (Windows) and WKWebView (macOS) need testing |
| Packaging / signing / updates | Mature, widely documented Windows + macOS signing, notarization, auto-update | Supported and documented, smaller community; updater and signing need their own setup |
| Resource usage | Larger install (bundled Chromium) and higher idle memory | Smaller binaries, lower idle memory (system webview) |
| Maintainability | Frequent Chromium security updates must be shipped; one-language codebase | Fewer runtime updates to ship; two-language codebase |
| Security model | Safe only with strict configuration (see §4) | Capability-based permission system by default; still needs a narrow command surface |
| iOS companion | Separate codebase in either case. The companion talks to the engine contract, not to the desktop shell | Tauri has iOS targets, but the companion's job (remote view and control) differs from the desktop's job, so sharing a shell gains little |

**Decision: Electron + TypeScript + React**, with the engine in TypeScript outside the
renderer. It was recommended in revision 2 and chosen by the user on 2026-11-16.

- The deciding factors are one language across UI and engine, and the most proven Windows +
  macOS packaging and signing path. This matters for a small team developing on Windows first.
- The cost is size and memory, plus a security configuration that must be done right.
- Because the engine is UI-independent (§2), moving to Tauri later means replacing only the
  shell, not the engine.

Tauri remains the documented alternative if install size or memory footprint later outweighs
a single-language codebase.

## 4. Requirement — Electron security

These came from the review and apply to the chosen Electron stack. What the foundation actually
verifies for each item is listed in §8 under "What the security checks prove". Items 3–5 apply to
every IPC channel added later.

1. **Renderer is sandboxed and isolated:**
   - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`;
   - no `remote` module;
   - no loading of remote content;
   - navigation and `window.open` blocked;
   - strict Content-Security-Policy (no inline scripts, no remote origins).
   - The one exception is the product preview (2026-11-18). Pages the agents built are shown in an
     `<iframe>` from the `orqestra-preview://` scheme. The main process serves only files inside that
     project's `workspace/`, never through a link. Each project gets its own host (a hash of the id),
     so the frame has its own origin and cannot reach the window, `window.orqestra` or IPC. The page's
     CSP allows only its own files (no network, no forms sent anywhere), the window's CSP allows only
     that scheme as a frame, frames cannot navigate anywhere else, and downloads are refused. The
     agents' code therefore runs only as web code in Chromium's sandbox, never in Node.js and never
     with keys in its environment.
2. **Narrow preload API.** `contextBridge` exposes a small, typed set of intent methods, for
   example `submitPrompt(text)`, `cancelTask(taskId)`, `answerQuestion(questionId, text)`,
   `respondToApproval(requestId, decision)`, `saveTree(tree)`. It never exposes `ipcRenderer`
   itself.
3. **Validated IPC:**
   - every IPC channel is allow-listed;
   - every payload is schema-validated in the main process before use;
   - the sender frame is checked;
   - invalid messages are rejected and logged.
4. **No command execution exposed to the renderer.** There is no IPC method that runs a command,
   spawns a process, reads an arbitrary path, or sets environment variables. The renderer
   expresses intents. Only the engine decides what process runs, with which arguments, in which
   directory.
5. **Privileged work stays out of the renderer.** Process supervision, provider adapters,
   filesystem access, and credential access run in the main process or an Electron utility
   process. Project paths are canonicalized and checked by the engine.

## 5. Proposal — credential ownership

| Credential | Owner | 0rqestra's role |
|---|---|---|
| Claude subscription login (OAuth) | Claude Code binary (its own storage) | **Never reads, copies, stores, proxies, or forwards it.** Opens a terminal running the user's own `claude` so the user signs in through Anthropic's flow. Detects status from CLI output only. Required by Anthropic's terms ([provider-integrations.md §1.1](provider-integrations.md#11-terms-products-that-run-claude-code-and-subscription-credentials)). |
| ChatGPT sign-in for Codex | Codex (`auth.json` or OS keyring, per its `cli_auth_credentials_store` setting) | Same posture: user runs `codex login`. 0rqestra reads only `account/read` status; it never uses external-token mode. |

Keeping credentials inside the provider tools is a custody decision. It does **not** by itself
settle whether 0rqestra's use fits each provider's deployment conditions. That remains
unresolved ([provider-integrations.md §1.1, §2.2](provider-integrations.md#22-authentication-and-deployment-conditions)).
| Provider API keys the user explicitly gives 0rqestra | 0rqestra | Stored only in the OS secret store (Windows Credential Manager / macOS Keychain, e.g. via Electron `safeStorage`). Injected only into the environment of the specific child process for an agent configured for API-key auth. Never sent to the renderer, never logged, never written to project or config files. |

**Environment hygiene.** For agents configured for subscription auth, 0rqestra removes
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, and similar variables from the child
environment. A key inherited from the user's shell would otherwise take over billing silently.

## 6. Proposal — supporting subsystems

- **Storage:**
  - tree configuration per project in a 0rqestra-owned location (not inside the project
    folder unless the user opts in), as versioned JSON;
  - task state, event log, and session-ID mapping in SQLite.
  - The final choice is open; see §9.
- **Provider adapter interface:**
  - `checkInstalled`, `authStatus`, `listModels` (may return "not supported" — Claude Code has no
    model-listing command);
  - `startTask(profile, sessionRef)`, `send`, `interrupt`, `forceStop`;
  - a normalized event stream;
  - `capabilities()` — which permission controls this provider and platform can actually
    enforce. This feeds the fail-closed check in
    [tree-routing-and-permissions.md §3](tree-routing-and-permissions.md#3-proposal--permission-enforcement-layers).
- **Task state machine:** `queued → starting → running → (awaiting-user | awaiting-approval) →
  succeeded | failed | cancelled | interrupted`. It carries attempt, retry, and review-round
  counters (definitions in [acceptance-criteria.md AC-08](acceptance-criteria.md#ac-08-retry-review-round-outage-and-request-limit-semantics-routing-26)).
- **Identifiers and provenance:** engine-owned request, work-item, task, and output IDs
  ([tree-routing-and-permissions.md §2.2](tree-routing-and-permissions.md#22-engine-owned-identifiers)).
- **Event streaming:**
  - adapters normalize provider events (status, text deltas, tool and file actions, approvals,
    errors, usage, model actually used);
  - the engine appends them to the event log, then fans them out to the UI, the Manager's
    context, and (later) the companion.
- **Process ownership and recovery:** one provider process per task, a persisted process
  ledger, orphan detection after a crash, and no automatic relaunch. See
  [tree-routing-and-permissions.md §4](tree-routing-and-permissions.md#4-proposal--process-ownership-and-cancellation).

## 7. What can be built and tested on Windows vs. what needs a Mac

| Area | Windows (current dev machine) | Needs a Mac |
|---|---|---|
| Engine, tree validation, routing, task state, persistence, recovery | Yes, headless with fake provider | — |
| UI (tree editor, chat, activity feed) | Yes | Visual check on macOS |
| Electron security configuration tests | Yes | Re-run on macOS |
| Claude Code adapter | Yes, native Windows. Note: no OS sandbox on native Windows; clean interrupt needs a runtime test | macOS behavior, including OS sandbox availability |
| Codex adapter | Yes, with Windows sandbox caveats (build- and policy-dependent) | macOS sandbox behavior |
| OS secret storage | Windows Credential Manager | macOS Keychain |
| Packaging, code signing, notarization | Windows installer and signing | macOS signing and notarization (Mac + Apple Developer account) |
| CI | `windows-latest` runners | `macos-latest` runners can run engine/UI tests; signing still needs credentials |

## 8. Development foundation (Electron, established 2026-11-16)

**Layout (npm workspaces):**

| Path | Contents |
|---|---|
| `packages/contracts` | Foundation-level provider adapter types (`ProviderAdapter`, `ProviderEvent`, `TaskRequest`) |
| `packages/provider-fake` | Deterministic fake provider that replays scripted events and records launches |
| `packages/engine` | Foundation-level `runTask` plus tests against the fake provider. Routing, retries, and the task state machine come in a later stage (Stage 2 is the interface) |
| `apps/desktop` | Electron shell: secure window settings; navigation, popup, webview, and permission guards; one sender-validated IPC channel; placeholder page (no React yet — the interface is Stage 2); `--smoke` self-check; failure-case verifier; electron-builder config |
| `.github/workflows/ci.yml` | Lint, typecheck, test, smoke, and smoke failure cases on `windows-latest` and `macos-latest`. Job timeout 20 min |

**Pinned tool versions:** Electron 44.10.1, electron-builder 26.18.0, TypeScript 6.0.3,
Vitest 4.1.12, ESLint 10.14.0, typescript-eslint 8.72.1.

- Each was the newest release at least two weeks old on 2026-11-16 that was compatible with the
  others.
- TypeScript 7 is not used, because typescript-eslint 8.72 supports only TypeScript `<6.1.0`.

**Node.js:** `^24.11.0`, the Node 24 LTS line.

- Every installed dependency accepts Node 24. ESLint 10 requires `^20.19 || ^22.13 || >=24`,
  which is why the earlier `>=22.12.0` was wrong.
- No dependency needs a specific 24.x minor version.
- `package.json` `engines`, `.nvmrc` (`24`), CI (`node-version-file: .nvmrc`), and the README all
  agree.
- `.npmrc` sets `engine-strict=true`. A probe package requiring Node `^99` failed with
  `EBADENGINE`, confirming npm enforces the range.

**What the security checks prove**

| Requirement (§4) | Unit test (`security.test.ts`) | Runtime smoke (`smoke.ts`), real window |
|---|---|---|
| Sandbox | Configured value `sandbox: true` | Preload reports `process.sandboxed === true` (Electron's own flag inside the renderer). A copy with the sandbox disabled fails |
| Context isolation | Configured value | Preload reports `process.contextIsolated === true`. A copy with isolation disabled fails |
| No Node.js in the page | Configured values | Page sees `typeof require/process === "undefined"` |
| Narrow preload API | — | Page's `window.orqestra` has exactly `["getAppInfo"]`. A copy exposing an extra method fails |
| Sender-validated IPC | Exact webContents ID, main frame, and canonical file URL; negative cases for a wrong webContents, a subframe, other origins and files, query strings, and a missing frame | IPC round trip from the real page succeeds |
| `window.open` denied | — | Returns `null`. A copy without the guard fails |
| Navigation blocked | — | URL unchanged after an attempt. A copy without the guard fails |
| CSP, permission-request handler, webview blocking | Configured only | **Not exercised at runtime** |

Smoke diagnostics travel from the preload to the main process on a smoke-only IPC channel. The
renderer flag that enables them is set only in smoke mode. **Nothing new is exposed to the
page.**

**Smoke termination.** `smoke-outcome.ts` holds the verdict. `main.ts` creates it at module
load, before `app.whenReady()` or any other asynchronous startup. That one outcome object:

- owns the 20 s watchdog;
- installs the uncaught-exception and unhandled-rejection handlers;
- is idempotent: the first verdict wins, and later calls are ignored. Unit tests cover this.

Every outcome prints exactly one `SMOKE PASSED` (exit 0), or one `FAIL  [<handler>] <reason>`
line followed by one `SMOKE FAILED` (exit 1).

Failure handlers:

| Handler | Covers |
|---|---|
| `watchdog` | No verdict in time |
| `startup` | Rejection of `app.whenReady()`, or any throw in permission setup or `BrowserWindow` construction |
| `uncaught-exception`, `unhandled-rejection` | Errors outside a promise chain |
| `preload-error` | The preload throws |
| `did-fail-load`, `load-rejected` | The page fails to load |
| `render-process-gone` | The renderer process dies |
| `unresponsive` | The window stops responding |
| `window-closed` | The window closes before checks finish |
| `check-threw` | A check throws |
| `check` | A check assertion fails |

**Failure-case verifier.** `npm run smoke:failures` copies the build to a temp directory,
breaks the copy, runs smoke, and deletes the copy; the real build is never modified.

- An unmodified copy must pass.
- Every failure case must exit **exactly 1**, print exactly one `SMOKE FAILED`, and be caught by
  a handler on its expected list.
- Inherently racy cases (a crash or close at preload start, a hang) list every handler that may
  legitimately win.

Results of the latest run:

| Case | Handler that caught it |
|---|---|
| unmodified copy | (passes) |
| app never becomes ready | `watchdog` |
| app readiness rejects | `startup` |
| permission setup throws | `startup` |
| BrowserWindow construction throws | `startup` |
| uncaught exception during startup | `uncaught-exception` |
| unhandled rejection during startup | `unhandled-rejection` |
| preload throws | `preload-error` |
| renderer crashes at preload start (racy) | `load-rejected` |
| renderer crashes while checks wait | `render-process-gone` |
| renderer hangs (racy) | `watchdog` |
| window closes itself early (racy) | `did-fail-load` |
| window closes while checks wait | `window-closed` |
| renderer page missing | `did-fail-load` |
| preload exposes an extra API | `check` |
| preload API throws during a check | `check-threw` |
| sandbox disabled | `check` |
| context isolation disabled | `preload-error` |
| popup guard removed | `check` |
| navigation guard removed | `did-fail-load` |

**Handlers exercised: 11 of 12.** **`unresponsive` is not exercised.** Chromium's hang detection
fires later than the watchdog, so a hang is caught by `watchdog` instead. The `unresponsive`
handler exists, but no test proves it fires.

The verifier also caught a real bug in an earlier round. A strict string comparison of file URLs
rejected the app's own page when it ran from a Windows short path (`MINDAT~1`). Node encodes `~`
as `%7E`; Chromium does not. URLs are now compared as decoded file paths.

**Check results (2026-11-16, Windows 11, Node 24.14.1, npm 11.11.0, run after the latest changes)**

| Check | Command | Result |
|---|---|---|
| Clean install | `npm ci` | exit 0 (406 packages) |
| Lint, typecheck, unit tests | `npm run check` | exit 0; 22 tests in 3 files |
| Smoke (dev build) | `npm run smoke` | exit 0; 5/5 PASS; `SMOKE PASSED` |
| Smoke failure cases | `npm run smoke:failures -w @0rqestra/desktop` | exit 0; 20/20 as expected (1 pass, 19 fail-closed with exit 1); 11/12 handlers exercised |
| Package | `npm run package -w @0rqestra/desktop` | exit 0; unsigned `win-unpacked`, default icon |
| Smoke (packaged app) | `release/win-unpacked/0rqestra.exe --smoke` | exit 0; `SMOKE PASSED` |
| CI on Windows and macOS runners | GitHub Actions run for `fbf8dd3` (old repository) | **Passed on both runners, as reported by the user on 2026-11-16.** Not observed by Claude |
| macOS install and smoke | Same run, `macos-latest` job | **Passed, as reported by the user.** Not run on a physical Mac |

The table above is a historical record from the old repository. Its commands used the old
workspace name; the current one is `@0rqestra/desktop`.

**CI history in SEASTICK/0rqestra (observed by Claude through the GitHub CLI, 2026-11-17)**

| Commits | Result |
|---|---|
| `be12f67`, `97a88ef`, `895d808`, `7371844`, `b57f908`, `f95ee9c` | Both jobs passed |
| `f877f7d`, `5da0a98` | `windows-latest` failed: smoke failure case "BrowserWindow construction throws" crashed with exit code 3221225477 (0xC0000005) instead of exiting 1 |
| `36ee43c` | Both failed: the Windows crash above, and the macOS case below |
| `06faa18`, `7752279`, `83f8a88` | `macos-latest` failed: smoke failure case "navigation guard removed" exited 0 instead of failing closed (`did-fail-load` or `check` expected) |

Both failures are intermittent (the same cases pass in other runs) and are not yet explained.
CI was not changed to hide them. The user accepted item 9 for the Windows-only scope on
2026-11-17 and **deferred** macOS verification: it is neither passed nor dropped.

**Latest local run (2026-11-17, Windows 11, Node 24.14.1, commit `83f8a88`):** `npm run check`
exit 0, 103 tests in 9 files (including tests added later for the release tools and in-app
updates).

**Later addition.** Offline tests for the provider probe runners were added under
`tools/provider-probes/`. `npm run check` now runs 60 tests in 4 files (22 foundation tests plus
38 probe-runner tests against fake processes). They passed locally on Windows. They have since
run in CI as part of `npm test` in the new repository. On 2026-11-17 four regression tests were
added for the denied-write checks, bringing the probe-runner tests to 42; later the same day
11 more were added for approval correlation and exit checks, bringing them to 53.

No environment failures occurred in this run. One permission-classifier timeout in the assistant
tooling delayed a command; it was retried unchanged and is unrelated to the application.

**`npm audit`** (exit 1): 13 moderate, 0 high or critical. All 13 come from a single advisory,
**GHSA-g3hv-75wg-m249** — minimatch `>=7.0.0 <11.0.1`, "potential denial of service via
globparts amplification".

Vulnerable copies (all dev-only; the shipped app has no runtime dependencies):

- `minimatch@10.2.6`, required by `eslint@10.14.0` (`^10.2.6`),
  `@typescript-eslint/typescript-estree@8.72.1` (`^10.2.2`), and `app-builder-lib@26.18.0`
  (`^10.2.5`, via electron-builder);
- `minimatch@9.0.9`, under `@electron/universal` (via electron-builder).

Remediation options considered, none applied:

| Option | Assessment |
|---|---|
| (a) `eslint@10.15.0` | Depends on minimatch `^11.0.5`. Published 2026-11-13, newer than the two-week pinning rule. Fixes only ESLint's path |
| (b) npm `overrides` forcing minimatch `^11.0.5` | Crosses a major version for packages declaring `^9`/`^10`. Untested |
| (c) npm's suggested `electron-builder@25.1.0` / `typescript-eslint@8.36.0` | Older releases (downgrades) |

Exposure: the advisory needs attacker-controlled glob patterns, but these tools only use the
repository's own fixed patterns. Revisit when typescript-eslint and electron-builder move to
minimatch 11, or if the user approves testing option (b).

**Other known limitations:**

- `appId` `dev.orqestra.desktop` is a placeholder; replace it before any signed release.
- Code signing and notarization are out of scope until a release stage.
- File-URL comparison is case-insensitive only on Windows.

## 9. Open questions

- ~~Stack~~ — resolved 2026-11-16: Electron.
- **License** for the public open-source release (for example MIT or Apache-2.0) — user
  decision. It is separate from the already agreed decision to release as open source.
- **Storage format** details (JSON + SQLite proposed).
- **iOS companion** transport, pairing, and authentication — later stage.
- **Provider gates** in [provider-integrations.md §4](provider-integrations.md#4-gates-before-real-adapters-are-enabled).
- **Routing and process proposals** awaiting decision:
  [tree-routing-and-permissions.md §2.12](tree-routing-and-permissions.md#212-decisions-for-the-user).

**Stage boundary.** The agreed Stage 2 is the **interface**. Orchestration (routing, retries,
the task state machine) and real provider adapters are built in later stages, which are not yet
scheduled. Each adapter is enabled only after its gates in provider-integrations.md §4.
