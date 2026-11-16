# Provider Integrations — Verification (Stage 1, item 6)

Revision 3, 2026-11-16. Revised after the second independent Stage 1 review.

**Revision history**

- **Revision 1** conflated `claude -p` with `--bare`, treated npm distribution as a Node.js
  runtime requirement, and relied on secondary news coverage.
- **Revision 2** fixed those errors, but still:
  - presented a WorkTreeAI policy (not bundling provider binaries) as if it were a provider rule;
  - omitted OpenAI's statement that local and open-source apps may continue;
  - implied that terminal login avoids deployment restrictions;
  - mixed a deny-all-MCP profile with a permission-MCP profile.
- **Revision 3** corrects all of these.

This is not legal advice. Statements about terms quote the provider's own text. They are not a
legal clearance for WorkTreeAI.

## How to read this document

Every finding is in one of three kinds of block:

| Block | Meaning |
|---|---|
| **Provider statement** | What the official source says, quoted or closely paraphrased, with its source ID. Checked against the source on the verification date. Not tested by running anything. |
| **WorkTreeAI decision** | An engineering or policy choice WorkTreeAI makes. It may be stricter than the provider requires. Proposals are labelled as such. |
| **Unresolved** | Interpretation the sources don't settle, or behavior only a runtime test can confirm. Must not be relied on. |

No provider CLI was run and no billable request was made for this document.

## Sources (all fetched directly on 2026-11-16)

A1, A4, and O1 were re-fetched for revision 3. The A4 text was byte-identical to the earlier
same-day fetch.

| ID | Source | URL |
|---|---|---|
| A1 | Claude Code — Legal and compliance | https://code.claude.com/docs/en/legal-and-compliance |
| A2 | Claude Code — Run Claude Code programmatically | https://code.claude.com/docs/en/headless |
| A3 | Claude Code — Advanced setup | https://code.claude.com/docs/en/setup |
| A4 | Claude Code — CLI reference | https://code.claude.com/docs/en/cli-reference |
| A5 | Claude Help Center — Use the Claude Agent SDK with your Claude plan | https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan |
| A6 | Anthropic Consumer Terms (effective Oct 8, 2025) | https://www.anthropic.com/legal/consumer-terms |
| A7 | Anthropic Commercial Terms (effective Jun 17, 2025) | https://www.anthropic.com/legal/commercial-terms |
| A8 | Claude Code — Model configuration (read to char. 100,000 of ~135,000) | https://code.claude.com/docs/en/model-config |
| A9 | Claude Code — Configure permissions | https://code.claude.com/docs/en/permissions |
| O1 | Codex — App Server | https://learn.chatgpt.com/docs/app-server |
| O2 | openai/codex README | https://github.com/openai/codex |
| O3 | openai/codex `codex-cli/package.json` | https://raw.githubusercontent.com/openai/codex/main/codex-cli/package.json |
| O4 | Codex — Non-interactive mode | https://learn.chatgpt.com/docs/non-interactive-mode |
| O5 | Codex — Authentication | https://learn.chatgpt.com/docs/auth |
| O6 | Codex — Windows Sandbox | https://learn.chatgpt.com/docs/windows/windows-sandbox |
| O7 | Sign in with ChatGPT — Quickstart | https://developers.openai.com/siwc/quickstart |

---

## 1. Anthropic — Claude Code

### 1.1 Terms: products that run Claude Code, and subscription credentials

**Provider statement (A1, "Can customers offer Claude Code in their products?"):**

- "preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes
  or other agent infrastructure) requires agreeing to our Commercial Terms of Service and
  complying with the conditions below".
- **Condition 1 — unmodified binary.** "The Claude Code binary must not be modified. Claude Code
  must be installed and run as published by Anthropic, and customers may not remove, disable, or
  restrict any authentication method built into it".
- **Condition 2 — no intermediating usage.** "Customers may not pay for, resell, or intermediate
  Claude usage on their end users' behalf. Each end user must authenticate with their own
  Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential".
- **Naming.** A product may say in plain text that it "has Claude Code preinstalled or that it
  runs Claude Code". It may not use the names or logos in its own product name or logo, or
  suggest endorsement.

A1 permits **preinstalling** Claude Code in a product under these conditions. It does not
prohibit bundling.

**Provider statement (A1, "Authentication and credential use"):**

- Developers building products, "including those using the Agent SDK, should use API key
  authentication".
- Anthropic "does not permit third-party developers to offer Claude.ai login into their own
  applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf
  of their users".
- Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens —
  sign-in to a Claude account must complete through Anthropic's own flow."
- The exception: this "does not ... prevent an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription, including where a platform hosts Claude Code
  as described under *Can customers offer Claude Code in their products?*"
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so
  without prior notice."

**Other provider statements:**

- A1: "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of
  Claude Code and the Agent SDK."
- A6 (Consumer Terms §3) prohibits automated access "through a bot, script, or otherwise" except
  "via an Anthropic API Key or where we otherwise explicitly permit it". Credentials may not be
  shared.
- A7 permits use "to power products and services Customer makes available to its own customers
  and end users", and prohibits reselling "except as expressly approved by Anthropic".
- A5: when signed in with a plan, "the Claude Agent SDK and `claude -p` still draw from your
  subscription limits"; "third-party app usage" draws from them too. A5 does not say whether a
  third-party app may use a plan.

**WorkTreeAI decisions:**

1. **Policy: WorkTreeAI does not bundle, preinstall, or modify the Claude Code binary.** The user
   installs it. This is WorkTreeAI's own choice, not an Anthropic prohibition. It keeps WorkTreeAI
   away from the "preinstalling" case.
2. WorkTreeAI never offers its own Claude.ai login UI. It never reads, copies, stores, proxies,
   or forwards Claude credentials or session tokens. Sign-in happens in the user's own `claude`
   binary through Anthropic's flow. (Provider requirement.)
3. WorkTreeAI never pays for, pools, or resells usage, and never disables the binary's
   authentication methods. (Provider requirement.)
4. WorkTreeAI does not use the Agent SDK with subscription credentials. If the SDK is used at
   all, it is only with the user's own API key. (Follows A1's developer guidance.)
5. The name and logo contain no "Claude Code" or "Anthropic". Docs may say WorkTreeAI "runs
   Claude Code". (Provider requirement.)

**Unresolved:**

- **Does the product clause apply?** A1's "running Claude Code in your products or services"
  clause would require the maintainer to accept the Commercial Terms. It is unclear whether it
  covers a free, local, open-source app that launches a binary the user installed. A1's examples
  ("hosted sandboxes or other agent infrastructure") suggest hosted platforms, but the text
  doesn't decide the local case. Not bundling the binary (decision 1) does not settle this,
  because the clause also says "running". **This is a maintainer decision**, possibly to be
  asked of Anthropic via A1's contact link.
- **Does the exception cover WorkTreeAI's pattern?** The A1 exception covers "an end user ...
  signing in to the unmodified Claude Code binary". Whether a separate app *launching* that
  signed-in binary for the user stays within "ordinary use" is an interpretation, not a
  provider statement.
- **Unread sources:** the Anthropic Usage Policy (https://www.anthropic.com/legal/aup).
- **Technical success is not permission.** A successful run would not establish contractual
  permission.

### 1.2 Platforms, installation, runtime dependencies

**Provider statement (A3):**

- **Supported systems:** macOS 13.0+; Windows 10 1809+ or Windows Server 2019+. 4 GB+ RAM, x64 or
  ARM64. Shells: Bash, Zsh, PowerShell, CMD.
- **Windows options:**
  - native Windows — Git for Windows optional; OS sandboxing **not supported**;
  - WSL 2 — sandboxing supported;
  - WSL 1 — sandboxing not supported.
- **No WSL or admin rights required.** Without Git for Windows, shell commands use the PowerShell
  tool.
- **Install channels:** native installer, Homebrew, WinGet, apt/dnf/apk, npm.
- **No Node.js at runtime.** The npm package needs Node.js 22+ to install, but "installs the same
  native binary" and "The installed `claude` binary does not itself invoke Node."
- **Signing:** the macOS binary is signed and notarized; the Windows binary is signed; release
  manifests are GPG-signed.
- **Accounts:** Claude Code requires a Pro, Max, Ultra, Team, Enterprise, or Console account. The
  free plan has no Claude Code access.

**Unresolved (runtime):**

- PATH resolution from a GUI-launched process.
- Auto-update replacing the binary during a running session.

### 1.3 Authentication modes

**Provider statement:**

- **Ordinary `claude -p` uses the normal credential sources**, including a subscription login
  made in the interactive CLI. A5 confirms `claude -p` draws from subscription limits when the
  user is signed in with a plan. `/login` itself is unavailable inside `-p` (A2).
- **`claude --bare -p` never reads OAuth credentials or the system keychain** (A2). It needs
  `ANTHROPIC_API_KEY` or an `apiKeyHelper` passed in `--settings`.
- **API key:** if `ANTHROPIC_API_KEY` is set and approved, it skips the login prompt (A3).

**WorkTreeAI decisions:**

- `--bare` is not used for subscription-authenticated agents.
- For such agents, provider API-key variables are removed from the child environment, so that a
  key inherited from the user's shell cannot silently change billing.

**Unresolved (runtime):**

- Behavior with an `ANTHROPIC_API_KEY` that has never been approved.
- Output and exit code when no login exists.

### 1.4 What ordinary `-p` loads, and suppression profiles

**Provider statement (A2):**

- Without `--bare`, `claude -p` "discovers and loads them as an interactive session would,
  including anything configured in the working directory or `~/.claude`". "Them" means hooks,
  skills, custom commands, subagents, plugins, MCP servers, auto memory, and CLAUDE.md.
- "a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers
  in its `.mcp.json`, even in a folder you've never trusted", with "no workspace trust dialog".
- **Hooks run before `system/init`.** That event is "the first event in the stream unless startup
  events precede it", including `hook_started` / `hook_progress` / `hook_response` "while a
  configured `SessionStart` or `Setup` hook runs".

**Provider statement (A9, `claude -p` in an untrusted folder):**

| Repository content | Under `claude -p` in an untrusted folder |
|---|---|
| Hooks in settings files, the `env` block, `apiKeyHelper` and similar helpers, project skill hooks and `allowed-tools` | **Used** |
| `.mcp.json` servers | **Connected without asking** |
| `permissions.allow` rules and `additionalDirectories` in project settings | Not used |
| Project subagent frontmatter hooks and inline MCP servers; `@skills-dir` plugins | Not used |

**Provider statement (A4) — controls:**

| Control | What it does | What it does not do |
|---|---|---|
| `--safe-mode` | "Start with all customizations disabled": CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents, output styles, workflows, LSP servers, auto memory. "Authentication, model selection, built-in tools, and permissions work normally". | Managed-settings policy still applies. A4 does not say whether it combines with `-p`. |
| `--setting-sources user` | Loads only user settings; skips project settings files and `.mcp.json` (A9). | User-level hooks and settings still load. |
| `--settings '{"disableAllHooks": true}'` | Turns hooks off for the run. A9: setting it in user settings alone "isn't enough", because project settings take precedence. | — |
| `--strict-mcp-config` | Skips MCP servers from `.mcp.json`, `~/.claude.json`, or plugins; loads only servers passed with `--mcp-config`. | — |
| `--tools` | Restricts **built-in** tools. | "doesn't affect MCP tools". |
| `--disallowedTools` | A bare name removes the tool (`"Agent"`, `"mcp__*"`, `"*"`). A scoped rule such as `Bash(rm *)` denies only matching calls. | Bash rule limits (A9). |
| `--allowedTools` | **Only auto-approves**: "To restrict which tools are available, use `--tools` instead." | Does not restrict availability. |
| `--permission-prompt-tool mcp__<server>__<tool>` | Sends permission prompts to an MCP tool on a server the run loads. | Cannot approve tools that require user interaction. |
| `--permission-prompts none` (v2.1.259+) | Denies anything that would prompt. | — |
| `--restricted` (v2.1.248+) | Removes command- and code-running tools unless named in `--tools`; confines file tools; loads only managed settings and `--settings`. | A4 does not say whether subscription auth is kept. |

Further caveats from A2 and A9:

- with `dontAsk`, "a mod you installed can still approve some of those calls";
- managed-settings denies cannot be overridden by flags;
- file-tool write blocking does not cover shell commands.

**WorkTreeAI proposals — two separate launch profiles.** Neither has been run, and the combined
behavior of the flags in each is untested.

**Profile A — deny-all MCP (default for specialists).** No MCP server loads, and anything that
would prompt is denied.

```
claude -p
  --safe-mode
  --setting-sources user
  --settings <generated.json>              # {"disableAllHooks": true, "switchModelsOnFlag": false}
  --strict-mcp-config                      # with no --mcp-config: no MCP servers at all
  --tools "<node's permitted built-in tools>"
  --disallowedTools "Agent" "mcp__*"
  --permission-mode default
  --permission-prompts none
  --model <pinned model>  --session-id <engine UUID>
  --output-format stream-json --verbose --input-format stream-json
  --max-turns <node limit>
```

**Profile B — WorkTreeAI permission MCP (only if per-action approval is needed).** Same as
Profile A, except:

```
  --strict-mcp-config --mcp-config <file with ONLY WorkTreeAI's approval server>
  --permission-prompt-tool mcp__worktreeai__approve
  --disallowedTools "Agent"                # NOT "mcp__*": see the unresolved item below
  (no --permission-prompts none)
```

**What startup metadata can and cannot do.**

- WorkTreeAI can read `system/init` (model, tools, `mcp_servers`, `plugins`) and stop the run if
  it shows anything outside the profile. That **detects** unexpected configuration.
- It **cannot undo** anything that already ran. Hooks run before `system/init` (A2).
- Suppression must therefore come from launch flags, applied **before** launch. The startup check
  is a second line of defense, not a substitute.

**Unresolved (runtime gates before the Claude adapter is enabled):**

1. Whether `--safe-mode` works with `-p` as described, and keeps subscription auth.
2. Whether Profile A loads anything from user settings that could approve actions (for example
   installed mods).
3. In Profile B: whether `--disallowedTools "mcp__*"` would also disable the
   `--permission-prompt-tool` (A4 doesn't say), and whether the approval server's own tools
   become callable by the model.
4. Whether project hooks run at all under Profile A — checked with a hostile fixture project.
5. Whether shell tools can be fully unavailable on native Windows while file tools stay
   available.

### 1.5 Models: selection, discovery, silent substitution

**Provider statement (A4, A8):**

- **Selecting a model:** `--model` takes an alias or a full name. Aliases "update over time".
- **No model-listing command.** No CLI command lists models; `/model` is an interactive picker.
- **`--fallback-model` / `fallbackModel`** switches models for that turn when the primary is
  overloaded or unavailable. "`/status` doesn't display it."
- **Content-based fallback:** flagged requests re-run on another model, and "the session
  continues on the fallback model". `switchModelsOnFlag: false` disables this. In non-interactive
  mode a flagged request then "ends the turn with a refusal".
- **Detecting the model actually used:** headless callers read it from the result's
  `modelUsage`.

**WorkTreeAI decision (proposal):**

- pass no fallback chain;
- set `switchModelsOnFlag: false`;
- pin full model names when the user chose a version;
- compare `modelUsage` and `system/init` with the configured model after every turn.

A mismatch pauses the item and is reported to the user.

**Unresolved (runtime):**

- Whether a `fallbackModel` in the user's own settings still applies under Profile A.
- The exact `modelUsage` shape.

### 1.6 Structured I/O, streaming, sessions

**Provider statement (A2, A4):**

- **Formats:** `--output-format text|json|stream-json`, `--input-format stream-json`,
  `--json-schema` (result in `structured_output`, absent if the run ends without valid output).
- **`system/init`:** model, tools, MCP servers, plugins, errors, and a `capabilities` array.
- **`system/api_retry`:** `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, and an
  `error` category — `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`,
  `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`,
  `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`.
- **Sessions:**
  - `--session-id <uuid>` uses a caller-chosen ID;
  - `--resume <id|path>` searches every project on the machine if the ID isn't local;
  - `--continue` loads "the most recent conversation in the current directory";
  - also `--fork-session` and `--no-session-persistence`.
- **Costs** are client-side estimates. **Piped stdin** is capped at 10 MB.

**WorkTreeAI decision:** one engine-assigned session UUID per (project, node, work item).
Resumption uses only that exact ID; `--continue` is never used.

### 1.7 Cancellation and errors

**Provider statement (A2):**

- **Exit codes:** 0 on success, non-zero on failure.
- **SIGTERM:** exit 143. The turn in progress is left unfinished; running Bash process trees are
  killed; `SessionEnd` hooks run.
- **SIGINT** or the SDK's `interrupt()` ends the turn cleanly.
- **Resume after interruption:** the interrupted turn is left as-is unless
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`.
- **Background work:** a run can stay open up to 10 minutes after its final turn, waiting for
  background work.

**Unresolved (runtime, Windows):** Windows has no POSIX SIGINT for arbitrary child processes. A
clean end-of-turn mechanism on Windows (for example a `stream-json` input control message) must
be tested. Until then, the Claude adapter reports clean interruption as unavailable on native
Windows. A cancel there starts forced cleanup immediately, completes within 13 s, and ends the
task as `cancelled (forced; clean interrupt unavailable)`, with changes reported as possibly
partial. See
[tree-routing-and-permissions.md §4.2](tree-routing-and-permissions.md#42-cancelling-task-a-while-task-b-continues-draft).

### 1.8 Open-source distribution

**Provider statement (A1):**

- A product may say in plain text that it runs Claude Code.
- Preinstalling or running Claude Code in a product requires the Commercial Terms plus the
  conditions in §1.1.

**WorkTreeAI decision:** do not bundle the binary (policy, §1.1 decision 1).

**Unresolved:** see §1.1.

---

## 2. OpenAI — Codex

### 2.1 Platforms, installation, runtime dependencies

**Provider statement:**

- **License:** the openai/codex repository is "licensed under the Apache-2.0 License" (O2).
- **Install channels:** install script, `npm install -g @openai/codex`, Homebrew, GitHub Releases
  (O2).
- **npm needs Node.js to launch.** The npm package's `bin` is `bin/codex.js` with
  `engines.node >=16` (O3).
- **Platforms:** macOS (arm64, x86_64), Linux, Windows (O2).
- **Windows (O6):** Codex "can run natively in PowerShell with a Windows sandbox instead of
  requiring WSL or a virtual machine".
  - Sandbox options: `mxc` (Windows 11 24H2/25H2 MXC capabilities), `elevated` (admin-approved
    setup), `unelevated` (weaker).
  - "Remaining child processes stop when the foreground command exits."

**Unresolved:**

- O2 implies, but doesn't state, that Release archives contain native binaries with no Node.js
  dependency. Confirm by inspecting an installed binary.
- macOS sandbox details were not read.

### 2.2 Authentication and deployment conditions

**Provider statement (O5):**

- **Two sign-in methods:** "Sign in with ChatGPT for subscription access" and "Sign in with an API
  key for usage-based access". API-key use is billed at standard API rates.
- **Credential storage:** `~/.codex/auth.json` (plaintext) or the OS credential store; modes
  `file`, `keyring`, `auto`, `ephemeral`.
- **Automation:** "API keys are still the recommended default for automation".

**Provider statement (O1, "Auth endpoints", in order):**

1. "If you've built a local or open-source application using Codex app-server authentication,
   you can continue using it, though we recommend migrating to Sign in with ChatGPT so users have
   greater control over and visibility into their usage."
2. "App-server authentication has never been permitted for commercial or hosted services."
3. "We launched Sign in with ChatGPT to support these use cases".

O1 also documents the auth modes:

- managed `chatgpt` — "Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them
  automatically";
- `apiKey` and `chatgptDeviceCode`;
- experimental `chatgptAuthTokens`, where the host app supplies the tokens.

**Provider statement (O7, Sign in with ChatGPT):**

- It lets users sign in to an app with ChatGPT and, where eligible, use their ChatGPT plan for AI
  requests.
- "Sign in with ChatGPT is currently available to selected commercial partners through a limited
  trial."
- "ChatGPT plan usage is available to all open-source partners and selected private clients."
- For open-source developers: "Let users run AI workloads in your tools with their ChatGPT plan,
  without requiring them to provide an API key."
- The flow is OAuth/OIDC with PKCE and issues tokens "for eligible Responses API requests".
- O7 does **not** say whether this covers driving Codex or app-server.

**WorkTreeAI decisions (proposal):**

- WorkTreeAI does not use `chatgptAuthTokens` and never handles ChatGPT tokens.
- WorkTreeAI reads `account/read` to show auth state.
- The user signs in through Codex's own flow (`codex login`).
- Provider API-key variables are removed from the child environment unless the agent is
  configured for API-key auth.

Signing in with `codex login` in a terminal instead of calling `account/login/start` is a
credential-handling choice. **It does not change which deployment conditions apply.** The O1
statements concern "Codex app-server authentication" by an application, whichever login path is
used.

**Unresolved:**

- **Classification.** WorkTreeAI is intended to be a free, local, open-source app. The O1
  continuation sentence appears to cover that case, but its scope (for example "built" before a
  date) is not defined in O1.
- **Migration.** OpenAI recommends Sign in with ChatGPT. Whether that path can authorize a local
  Codex/app-server process at all is not stated in O7. Joining as an "open-source partner" may
  involve registration or approval.
- **Unread sources:** OpenAI Terms of Use, Service Terms, Usage Policies, and the open-source
  sign-in guide O7 references.
- **Rate limits:** numeric plan rate limits are not published in the sources read.

### 2.3 `codex exec` vs `codex app-server`

**Provider statement:**

- **`codex exec` (O4):**
  - stderr carries progress; stdout carries the final message.
  - `--json` JSONL events; `--output-schema`, `-o`, `--ephemeral`.
  - `resume --last` / `resume <SESSION_ID>`.
  - Sandbox is read-only by default.
  - `--full-auto` was removed; `--approve-for-me` exists.
  - Git repo required unless `--skip-git-repo-check`.
  - O4 documents no client approval channel, no exit-code table, and no cancellation mechanism.
- **`codex app-server` (O1):**
  - JSON-RPC 2.0 over stdio JSONL.
  - `thread/start|resume|fork|read|list`, `turn/start`, `turn/steer`.
  - **`turn/interrupt`** ends a turn with `status: "interrupted"`.
  - **`model/list`**.
  - Approval requests from the server: `item/commandExecution/requestApproval` and
    `item/fileChange/requestApproval`, answered with `accept`, `acceptForSession`, `decline`, or
    `cancel`.
  - Sandbox policies `readOnly`, `workspaceWrite`, `externalSandbox`.
  - `codexErrorInfo` includes `contextWindowExceeded`, `usageLimitExceeded`, `unauthorized`,
    `sandboxError`.
  - Schemas are generated per version.

| Criterion | `codex exec` | `codex app-server` |
|---|---|---|
| Authentication | Saved login or `CODEX_API_KEY` | Saved login; `account/read`. Deployment conditions per §2.2 |
| Model discovery | None documented | `model/list` |
| Structured events | Coarse JSONL | Item lifecycle, deltas, status |
| Approvals | No client channel documented | Per-action approval requests |
| Sessions | Resume by ID | Thread IDs |
| Interruption | Undocumented (process kill) | `turn/interrupt` |
| Complexity | Low | Higher; version-specific protocol |

**WorkTreeAI decision (proposal):** use `codex app-server` over stdio, with **one app-server
process per task** (see
[tree-routing-and-permissions.md §4](tree-routing-and-permissions.md#4-proposal--process-ownership-and-cancellation)).

- Pin the Codex version and generate its schema.
- Avoid experimental methods.
- Keep `codex exec --json` as a smoke-test fallback.

This depends on the unresolved items in §2.2.

**Unresolved (runtime gates before the Codex adapter is enabled):**

- Unanswered-approval behavior.
- Whether `on-request` + `workspaceWrite` routes every out-of-policy action to the client.
- Whether reported models match the requested model.
- Behavior on native Windows under each sandbox type.

### 2.4 Project-supplied configuration

**Runtime observation (2026-11-16, Codex CLI 0.166.0-alpha.5.1; see
[provider-runtime-results.md](provider-runtime-results.md) X5, X6):**

- Codex loaded the opened project's `AGENTS.md` and followed it.
- Codex emitted MCP startup-status notifications in the test sessions. Only their counts were
  retained, so which servers were involved, whether they started, and where they were configured
  is not known.

**Unresolved:** what else a repository can supply (project configuration files, MCP servers), and
how to suppress project instructions and user-level servers. **This remains a documentation and
runtime gate before the Codex adapter is enabled.** AC-13's Codex assertions are deferred until
it is answered.

---

## 3. Cross-cutting conclusions

1. **Non-interactive driving.** Both CLIs document non-interactive driving with structured output
   and resumable sessions. (Provider statements.)
2. **Windows.** Both run natively on Windows without WSL. Claude Code's OS sandboxing is not
   supported on native Windows. Codex's native sandbox depends on the Windows build and policy.
3. **Node.js.** Neither CLI needs Node.js at runtime when installed natively. Codex's npm channel
   launches through a Node script; Claude Code's npm channel installs a native binary.
4. **Credentials.** Credential custody stays with each provider tool (WorkTreeAI decision).
   Whether WorkTreeAI's use pattern fits each provider's deployment conditions is **unresolved**
   for both (§1.1, §2.2). Keeping credentials out of WorkTreeAI does not by itself satisfy those
   conditions.
5. **Usage limits** are not published numerically. Rate- and usage-limit errors are expected
   conditions and must be surfaced to the user through the Manager.

## 4. Gates before real adapters are enabled

None of these is a Stage 2 (interface) blocker. They gate enabling a real provider adapter, or a
public release.

| Gate | Type | Blocks |
|---|---|---|
| Does A1's product clause apply to a free local OSS app? (maintainer decision; may ask Anthropic) | Legal | Public release |
| Does the O1 continuation statement cover WorkTreeAI? Is migrating to Sign in with ChatGPT feasible? (may ask OpenAI) | Legal / docs | Enabling the Codex adapter for users; public release |
| Read Anthropic Usage Policy and OpenAI terms | Docs | Public release |
| Codex project-config loading and suppression (§2.4) | Docs + runtime | Enabling the Codex adapter |
| Claude Profile A / Profile B behavior (§1.4 items 1–5) | Runtime | Enabling the Claude adapter |
| Clean interrupt on Windows for Claude Code (§1.7) | Runtime | Cancellation acceptance tests |
| Model-substitution detection (§1.5, §2.3) | Runtime | Enabling either adapter |
| Unanswered-approval behavior in app-server (§2.3) | Runtime | Enabling the Codex adapter |
| Missing or expired credential behavior, both CLIs | Runtime | Enabling either adapter |

**First runtime results (2026-11-16)** are in
[provider-runtime-results.md](provider-runtime-results.md), with the status of each gate in its
§5. In short:

- Claude Code Profile A suppressed project hooks, MCP servers, and project subagents, kept
  subscription authentication, reported a denied tool call, and honored a stream-json interrupt
  on Windows, using 3 subscription requests.
- Codex app-server delivered per-action approvals, waited on an unanswered approval, and
  honored `turn/interrupt` on Windows, using 3 subscription requests.
- User-level provider configuration was not exercised for Claude Code. For Codex, MCP startup
  activity was seen but its source was not retained.
- Whether Codex could delegate to subagents or other tools during these runs is unverified.
- Both tools were the builds bundled with the providers' desktop apps, not standalone installs.

No gate in the table above is fully closed by these runs.

Runtime tests must use the user's own accounts, minimal prompts, and the user's explicit
authorization.
