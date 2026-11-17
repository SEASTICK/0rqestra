# Provider Integrations — Verification (Stage 1, item 6)

Revision 4, 2026-11-17. Adds the outstanding documentation research (usage policies and terms,
Sign in with ChatGPT, Codex configuration loading) to revision 3.

**Revision history**

- **Revision 1** conflated `claude -p` with `--bare`, treated npm distribution as a Node.js
  runtime requirement, and relied on secondary news coverage.
- **Revision 2** fixed those errors, but still:
  - presented a WorkTreeAI policy (not bundling provider binaries) as if it were a provider rule;
  - omitted OpenAI's statement that local and open-source apps may continue;
  - implied that terminal login avoids deployment restrictions;
  - mixed a deny-all-MCP profile with a permission-MCP profile.
- **Revision 3** corrects all of these.
- **Revision 4** (2026-11-17) reads the sources revision 3 listed as unread: the Anthropic Usage
  Policy (A10), the OpenAI Terms of Use, Usage Policies, Service Terms and Sign in with ChatGPT
  Terms (O8–O11, with both the current and the announced Usage Policies, O9 and O9b), and the
  open-source Sign in with ChatGPT guide (O12–O15). It re-fetches A1,
  A6 and O1, and documents Codex configuration loading and its documented controls (O16–O23,
  §2.4). It adds the block types **Interpretation** and **Runtime observation**, and splits §4
  into documentation, adapter, release, and macOS gates. No provider was contacted, no provider
  binary was run, and nothing was installed for this revision.
  - Corrected the same day after review of commit 93b289d: the current OpenAI Usage Policies
    (effective October 29, 2025, O9) are cited next to the announced version (O9b); starting
    Codex in a subdirectory is no longer described as limiting `AGENTS.md`; the limits of
    `plugins._default.enabled` and a fail-closed rule were added to §2.4; O11's exception for
    permitted token handling is quoted; provider naming requirements are separated from project
    policy; and "only way" claims about asking providers were replaced by optional written
    clarification.

This is not legal advice. Statements about terms quote the provider's own text. They are not a
legal clearance for WorkTreeAI.

## How to read this document

Every finding is in one of five kinds of block:

| Block | Meaning |
|---|---|
| **Provider statement** | What the official source says, quoted or closely paraphrased, with its source ID. Checked against the source on the verification date. Not tested by running anything. |
| **WorkTreeAI decision** | An engineering or policy choice WorkTreeAI makes. It may be stricter than the provider requires. Proposals are labelled as such. |
| **Interpretation** | How the project currently reads a provider statement. Not a provider statement and not legal advice; it may be wrong. |
| **Runtime observation** | What a probe actually saw, with the version and date. Points to [`provider-runtime-results.md`](provider-runtime-results.md). |
| **Unresolved** | Interpretation the sources don't settle, or behavior only a runtime test can confirm. Must not be relied on. |

No provider CLI was run and no billable request was made for this document itself. Limited
runtime probes were run later (2026-11-16, Windows); their results are in
[`provider-runtime-results.md`](provider-runtime-results.md), not here.

## Sources

A1–A9 and O1–O7 were fetched directly on 2026-11-16; A1, A4, and O1 were re-fetched for
revision 3 (the A4 text was byte-identical to the earlier same-day fetch). For revision 4, A1,
A6, and O1 were re-fetched and the sources marked "2026-11-17" were read for the first time.
Pages fetched through a summarizing reader are quoted only where the quote was returned
verbatim; long pages were read in parts. O8–O11 were read in full in a browser. OpenAI served
the Europe version of its Terms of Use (O8) for this location.

Codex documentation pages state no version number; they describe current release behavior
(O20 says so explicitly). The probes in `provider-runtime-results.md` used Codex CLI
0.166.0-alpha.5.1 and Claude Code 2.1.325, so whether every documented control below applies to
those builds is a runtime question.

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
| O7 | Sign in with ChatGPT — Quickstart (re-read 2026-11-17) | https://developers.openai.com/siwc/quickstart |
| A10 | Anthropic Usage Policy (effective Nov 12, 2026; read 2026-11-17) | https://www.anthropic.com/legal/aup |
| O8 | OpenAI Europe Terms of Use (updated 16 Jan 2026; read 2026-11-17) | https://openai.com/policies/terms-of-use/ (served as /en-GB/) |
| O9 | OpenAI Usage Policies — **current** version, effective October 29, 2025 (read 2026-11-17) | https://openai.com/policies/usage-policies/revisions/2025-10-29/ |
| O9b | OpenAI Usage Policies — **announced** version, effective November 20, 2026 (changelog 2026-10-21; read 2026-11-17) | https://openai.com/policies/usage-policies/ |
| O10 | OpenAI Service Terms (updated 13 Nov 2026; read 2026-11-17) | https://openai.com/policies/service-terms/ |
| O11 | OpenAI Sign in with ChatGPT Terms (effective Nov 4, 2026; read 2026-11-17) | https://openai.com/policies/sign-in-with-chatgpt-terms/ |
| O12 | Sign in with ChatGPT — open-source overview (2026-11-17) | https://developers.openai.com/siwc/token-sharing-open-source |
| O13 | Sign in with ChatGPT — open-source sign-in guide (2026-11-17) | https://developers.openai.com/siwc/token-sharing-open-source/sign-in |
| O14 | Sign in with ChatGPT — Codex app-server (2026-11-17) | https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server |
| O15 | Sign in with ChatGPT — preview limitations (2026-11-17) | https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations |
| O16 | Codex — Config basics (2026-11-17) | https://learn.chatgpt.com/docs/config-file/config-basic |
| O17 | Codex — Advanced configuration (2026-11-17) | https://learn.chatgpt.com/docs/config-file/config-advanced |
| O18 | Codex — Configuration reference (read to char. 100,000 of ~155,000; 2026-11-17) | https://learn.chatgpt.com/docs/config-file/config-reference |
| O19 | Codex — Custom instructions with AGENTS.md (2026-11-17) | https://learn.chatgpt.com/docs/agent-configuration/agents-md |
| O20 | Codex — Hooks (2026-11-17) | https://learn.chatgpt.com/docs/hooks |
| O21 | Codex — Model Context Protocol (2026-11-17) | https://learn.chatgpt.com/docs/extend/mcp |
| O22 | Codex — Subagents (2026-11-17) | https://learn.chatgpt.com/docs/agent-configuration/subagents |
| O23 | Codex — Plugins (2026-11-17) | https://learn.chatgpt.com/docs/plugins |

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

**Provider statements re-checked 2026-11-17 (A1, A6):**

- A1 is unchanged in substance. It also says OAuth authentication "is intended exclusively for
  purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is
  designed to support ordinary use of Claude Code and other native Anthropic applications", and
  that Claude Code usage "is subject to the Anthropic Usage Policy". For questions "about
  permitted authentication methods for your use case", A1 links to Anthropic's contact-sales
  page.
- A1: the license for Free, Pro, Max, and Ultra users is the Consumer Terms (A6); for Team,
  Enterprise, and API users, the Commercial Terms (A7).
- A6 is still the version effective Oct 8, 2025. It does not mention Claude Code.

**Provider statement (A10, Anthropic Usage Policy, effective Nov 12, 2026):**

- Scope: the policy covers "individuals using our apps (such as Claude.ai and Claude Code)" and
  "the end users of products or services integrating Claude".
- Agentic use: "Agentic use cases must comply with the Usage Policy. Users are responsible for
  ensuring that agents they build or deploy, including actions those agents take through tools,
  browsers, or connected systems, comply with this Usage Policy."
- Under "Do Not Abuse Our Platform", it prohibits:
  - "Resell, proxy, or otherwise provide access to Claude through unauthorized means, including
    services that route requests through consumer subscriptions or misrepresent the product or
    client being used";
  - "Intentionally bypass or interfere with capabilities, restrictions, or guardrails
    established within our products, including by circumvention of the account sign-up or
    log-in process ... without prior authorization from Anthropic".
- Products for consumers: chatbots and agents that face consumers "must disclose to users that
  they are interacting with AI rather than a human".

**Interpretation (project, not legal advice):**

- A10's "services that route requests through consumer subscriptions" is the provider text
  closest to WorkTreeAI's pattern. WorkTreeAI would launch the user's own signed-in `claude`
  binary on the user's own machine for the user's own requests; it would not run a service, hold
  credentials, or serve other people. The project's reading is that this is not "routing
  requests through consumer subscriptions" on someone's behalf, but **A10 does not define
  "services" or "route", so this reading is not confirmed.**
- "Misrepresent the product or client being used" is relevant to launch flags: WorkTreeAI must
  not disguise its launches as another client. The proposed launch profile only uses documented
  `claude` flags and does not alter identification.
- WorkTreeAI's agents are configured by the user for the user's own code, not a chatbot for
  third parties. Whether A10's AI-disclosure rule applies is not settled; showing each agent's
  provider and model in the interface (planned in the node settings) would make the AI use
  explicit either way.

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
   Claude Code". (A1 states this for products that run Claude Code; WorkTreeAI follows it as
   project policy whether or not A1's product clause applies.)

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
- **Does A10's routing prohibition reach a local launcher?** Not settled by A10 (see the
  interpretation above).
- **Not explicitly covered.** No Anthropic source read says that a separate local application
  may launch a user-installed, user-signed-in Claude Code binary on the user's behalf. The
  closest texts are A1's end-user exception and A10's prohibition. Asking Anthropic (A1's
  contact link) for optional written clarification is a user decision (G6.4); it is not required
  by any source read.
- **Technical success is not permission.** The successful probe runs (2026-11-16) and the
  user's existing Pro subscription do not establish contractual permission.

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

**WorkTreeAI proposals — two separate launch profiles.** When this section was written, neither
had been run. Profile A was later probed on Windows with Claude Code 2.1.325 (see
[`provider-runtime-results.md`](provider-runtime-results.md)); Profile B has not been run.

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
- **Migration.** OpenAI recommends Sign in with ChatGPT. (Answered 2026-11-17: O14 documents
  how a local app passes a SIWC token to a Codex app-server child process; O13 shows client
  registration happens in the sign-in flow, with no separate approval step described.) Still
  unresolved: whether an app must be registered or approved beyond that flow to count as an
  "open-source partner" (O7, O12); whether a user-installed Codex can be used this way or the
  app must launch its own (O14 describes only an app-launched child process).
- **Not explicitly covered.** No OpenAI source read says that a new local open-source app may
  drive a user-installed Codex that the user signed in to with `codex login`. The O1
  continuation sentence is the closest text. Asking OpenAI for optional written clarification is
  a user decision (G6.4); it is not required by any source read.
- **Technical success is not permission.** The successful probe runs and the user's existing
  ChatGPT subscription do not establish permission.
- **Rate limits:** numeric plan rate limits are not published in the sources read.

**O1 re-checked 2026-11-17:** the three "Auth endpoints" sentences above are unchanged. O1 also
says the external-token mode `chatgptAuthTokens` is "experimental" and for use "only when a host
application owns the user's ChatGPT auth lifecycle", and that `chatgptDeviceCode` is for when
"your client owns the sign-in ceremony".

**Provider statement (O8, OpenAI Europe Terms of Use, updated 16 Jan 2026):**

- Scope: ChatGPT and OpenAI's other services for individuals, "along with any associated
  software applications"; the Business Terms govern the APIs and services for developers.
- "You may not share your account credentials or make your account available to anyone else".
- Prohibited, among others: "Automatically or programmatically extracting data or Output";
  "Interfering with or disrupting our Services, including circumventing any rate limits or
  restrictions or bypassing any protective measures or safety mitigations".
- The Usage Policies, Service Terms, and other listed policies form part of these Terms.
- O8 does not mention Codex, app-server, or third-party applications that drive Codex.

**Provider statement (O9, OpenAI Usage Policies currently in effect, effective October 29,
2025):**

- Prohibits, among others, "circumventing our safeguards", "unsolicited safety testing", and
  "automation of high-stakes decisions in sensitive areas without human review".
- It contains **no** clause on model-access intermediaries and no clause on training other
  models with outputs.

**Provider statement (O9b, announced OpenAI Usage Policies, effective November 20, 2026 — three
days after this revision; until then O9 applies):**

- Keeps "circumventing our safeguards".
- **New:** "If you operate a model-access intermediary platform or other service that enables
  third parties to directly access OpenAI models, you must obtain our prior review and approval.
  This requirement does not apply solely because an application integrates OpenAI models to
  power its features or functionality."
- **New:** a section on training and developing models, which forbids using OpenAI models or
  outputs to prepare training material for models "intended as alternatives to or substitutes
  for OpenAI models or services", and adds: "You may use OpenAI models for research, software
  development, model evaluation and benchmarking, and product development, within these
  boundaries."
- **Changed:** "automation of high-stakes decisions" becomes "automation of high-stakes
  actions in sensitive areas without human review".

**Provider statement (O10, OpenAI Service Terms, updated 13 Nov 2026):**

- §4: output of code-generation features, "including OpenAI Codex, may be subject to third party
  licenses, including, without limitation, open source licenses."
- §15: "If you use SIWC in your services, the Sign in with ChatGPT Terms apply."

**Provider statement (O11, Sign in with ChatGPT Terms, effective Nov 4, 2026)** — these apply to
a developer who integrates Sign in with ChatGPT (SIWC), not to the current design:

- Tokens only "through OpenAI's supported sign-in flow and as authorized by the user"; "Any
  persistent storage of Authentication Tokens must be local and under the user's control, not in
  a remote or managed environment."
- For the ChatGPT Plan scope (§3.1), the app must not enable "Pooling, transferring, reselling,
  gifting, or sharing ChatGPT plan usage or Authentication Tokens, except for token handling
  expressly permitted by these Terms" or "Using one user's
  subscription to fulfill another user's requests", and must meet: "Requests must originate from
  the user's local runtime or a remote runtime only that user controls"; requests "for the
  authenticated user" from "their activity or expressly authorized automations or background
  processes" with "express consent before background use"; "Use the user's plan only for the
  application they connected. Do not provide general-purpose API access for other tools";
  "Users must be able to use their ChatGPT plan through SIWC without paying you".
- §4 forbids altering or reverse engineering the SIWC software and sublicensing it.

**Provider statement (O12–O15, open-source Sign in with ChatGPT guide):**

- O12: the guide is for "open-source and locally hosted apps"; for "a paid or remotely hosted
  app", developers are sent to an interest form. O12 does not define "open-source partner" or
  list license requirements, and describes no approval step.
- O13: the first sign-in registers the app with `client_id=dynamic_agent_client`; the callback
  returns an issued client ID to "Save ... and reuse". The app keeps a local credential record
  (ID, access, and refresh tokens, scopes, identity fields), writes it "atomically with
  owner-only permissions" ("`0600` on Unix"), must "never commit or log" it, uses PKCE `S256`,
  and must check for the scope `chatgpt.tokens.use.direct`: "A valid ID token alone does not
  authorize ChatGPT plan usage."
- O14 (Codex app-server): the app sets "`ACCESS_TOKEN` in the app-server child process's
  environment"; "No separate Codex sign-in is required"; on renewal, restart app-server with the
  new token and use `thread/resume`; treat `model/list` "as a catalog, not an entitlement
  check".
- O15: preview limits apply to Codex app-server too, including "Configurations that emit
  Responses `tool_search` will fail" and "Your app must refresh the OAuth token."

**Interpretation (project, not legal advice):**

- **Current design (user's own `codex login`, managed `chatgpt` mode).** The O1 continuation
  sentence is the only provider text that names "a local or open-source application using Codex
  app-server authentication", and it says such an app "can continue using it". WorkTreeAI is
  intended to be local and open source and never handles tokens. O1 does not say whether
  "continue" covers an app first released after Sign in with ChatGPT launched.
- **Current requirements (O9)** contain no rule that specifically addresses a local app
  launching the user's own Codex. The closest general item is "circumventing our safeguards".
  The project intends the proposed design not to circumvent any safeguard, but whether it
  complies is the project's interpretation, not something OpenAI has confirmed.
- **Future requirement (O9b, from November 20, 2026): the intermediary rule** does not appear to
  apply: WorkTreeAI does not let third parties access OpenAI models; it runs the user's own Codex
  for the user. O9b's training restrictions do not concern WorkTreeAI's use, which sends no
  outputs to train models.
- **O8's "programmatically extracting ... Output"** is aimed at extraction; WorkTreeAI drives
  the supported app-server protocol that OpenAI documents for integrations. Not confirmed by
  OpenAI.
- **Migration to SIWC** is technically documented for local open-source apps (O12–O14) and its
  terms (O11 §3.1) fit a local, free, single-user design. But it would make WorkTreeAI obtain,
  store, refresh, and pass ChatGPT tokens, which **reverses the current decision that WorkTreeAI
  never handles ChatGPT tokens**. Choosing it is a user decision.

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

**Provider statements (O16–O23, O1; read 2026-11-17):**

| What | Where it can come from | Documented control | Source |
|---|---|---|---|
| Config layers | CLI flags and `--config` overrides; project `.codex/config.toml` from project root to cwd ("closest wins; trusted projects only"); `--profile`; user `~/.codex/config.toml`; cloud-managed defaults; system `/etc/codex/config.toml`; built-in defaults (highest first). `requirements.toml` constrains behavior | `-c key=value` (value parsed as TOML, dot notation for nested keys) | O16, O17 |
| Project trust | `projects.<path>.trust_level` = `"trusted"` or `"untrusted"` in user config | "Untrusted projects skip project-scoped `.codex/` layers, including project-local config, hooks, and rules." User and system config still load. **The default for a project with no entry is not stated** | O16, O18 |
| Keys a project cannot set | Project-local config | Ignored with a warning: `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `model_provider`, `model_providers`, `notify`, `profile`, `profiles`, `experimental_realtime_ws_base_url`, `otel` | O17 |
| `AGENTS.md` | Global: `AGENTS.override.md` or `AGENTS.md` in `CODEX_HOME` (default `~/.codex`). Project: one file per directory from project root down to cwd (`AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames`); combined limit `project_doc_max_bytes` (default 32 KiB) | **No documented way to turn project instructions off.** Starting in a subdirectory only stops the walk *below* that directory: files from the project root down to it are still loaded, so it is **not** a suppression mechanism. `CODEX_HOME` changes only the global file. Whether `project_doc_max_bytes = 0` disables loading is not stated. O19 does not say whether trust affects `AGENTS.md`. O1: `thread/start` returns `instructionSources`, "an array of loaded instruction-file paths" — **detection, not suppression** | O19, O1 |
| Hooks | User, project (`.codex/hooks.json` or `[hooks]`), plugins, managed sources | "Hooks are enabled by default"; `[features] hooks = false` turns them off. Project hooks load only for trusted projects, and each non-managed hook must be reviewed and trusted by hash before it runs. Admins: `allow_managed_hooks_only = true` | O20 |
| MCP servers | User config, project config ("trusted projects only"), plugins | Per server `enabled = false`; per tool `enabled_tools` / `disabled_tools`. **No global switch documented.** Plugins: `plugins._default.enabled` sets only the default — "An explicit `plugins.<plugin>.enabled` overrides this default for plugins their source enables" — and `plugins.<plugin>.enabled` "does not override workspace-managed enabled states"; per plugin MCP server: `plugins.<plugin>.mcp_servers.<server>.enabled`. A server marked `required` makes `thread/start` fail if it does not start | O21, O18, O1 |
| Plugins | Installed, marketplace, workspace-managed, and default plugins; a plugin can bundle skills, MCP servers, and hooks | `plugins._default.enabled = false` does **not** override an explicit per-plugin `enabled` setting and does **not** guarantee that managed plugins are off ("does not override workspace-managed enabled states"; workspace-installed or default plugins may be controlled by the administrator). "Marketplace refresh can install or refresh configured plugins even when disabled." Plugin hooks must be reviewed and trusted before they run | O18, O23 |
| Apps (connectors) | Workspace / plugins | `features.apps` ("on by default") | O18 |
| Native delegation (subagents) | Built in; custom agents in `~/.codex/agents/` or project `.codex/agents/` | "Current Codex releases enable subagent workflows by default." `agents.enabled = false` "to disable multi-agent tools" (O22, O18); O18 also lists `features.multi_agent` (on by default). Subagents in local clients "inherit your current sandbox policy" and, in the CLI, the parent's approval settings. O22 does not say whether project-defined agents need trust | O22, O18 |
| Skills | Bundled and installed | `skills.bundled.enabled`; `skills.config` rules by name or path | O18 |

**Runtime observation (2026-11-16, Codex CLI 0.166.0-alpha.5.1; see
[provider-runtime-results.md](provider-runtime-results.md) X5, X6):**

- Codex loaded the opened project's `AGENTS.md` and followed it. The probe set no trust entry
  and no feature overrides.
- Codex emitted MCP startup-status notifications in the test sessions. Only their counts were
  retained, so which servers were involved, whether they started, and where they were configured
  is not known.

**WorkTreeAI proposal (not run, not agreed) — a Codex launch profile:**

- Mark the opened project untrusted for WorkTreeAI's launches (for example
  `-c 'projects."<path>".trust_level="untrusted"'`), so project config, hooks, rules, and
  project MCP servers are skipped.
- `-c features.hooks=false`, `-c agents.enabled=false` (and `features.multi_agent=false`),
  `-c features.apps=false`, `-c plugins._default.enabled=false`, and `enabled = false` for each
  user MCP server WorkTreeAI did not configure. Because `plugins._default.enabled=false` can be
  overridden by explicit per-plugin settings and does not reach managed plugins, the profile
  also disables each enabled plugin explicitly and, after start, compares the loaded plugins
  and tools with an allow-list (see the fail-closed rule below).
- **Fail closed:** if a required suppression cannot be enforced or verified — for example a
  managed or explicitly enabled plugin that stays on, an MCP server that still starts, or
  delegation tools that remain — the task does not start, or is stopped before its first
  prompt, and is reported as a configuration error.
- Read `instructionSources` from `thread/start` and show the user which instruction files were
  loaded, since `AGENTS.md` cannot be turned off by a documented control.
- Stay on documented, non-experimental controls; never rely on project-local config to set
  provider or auth settings (O17 already ignores those).

**Unresolved (runtime tests needed before the Codex adapter is enabled):**

- whether `-c` overrides given to `codex app-server` apply to the threads it starts;
- the trust default for a project with no entry under `codex app-server`, and whether an
  `untrusted` entry set by `-c` is honored;
- whether trust or any setting stops project `AGENTS.md` from loading (for example
  `project_doc_max_bytes = 0`), or whether detection through `instructionSources` is the limit;
- whether `agents.enabled = false` / `features.multi_agent = false` removes the delegation tools
  from the model's tool list in the pinned version (fan-out is unverified so far, see
  provider-runtime-results.md);
- which user-level MCP servers, plugins, and apps load on the user's machine, and that the
  proposed overrides stop them;
- plugin cases: a plugin with an explicit `plugins.<plugin>.enabled = true` while
  `plugins._default.enabled = false`; a workspace-managed or default plugin; and whether the
  explicit per-plugin `false` override reaches each; and how a remaining plugin shows up so the
  fail-closed check can detect it;
- that these controls exist in the pinned Codex version (docs carry no version).

AC-13's Codex assertions stay deferred until these runtime results exist.

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

## 4. Gates

None of these is a Stage 2 (interface) blocker.

### 4.1 Stage 1 item 6 documentation (accepted 2026-11-17)

| Gate | Status |
|---|---|
| Read the Anthropic Usage Policy and the OpenAI terms, policies, and open-source Sign in with ChatGPT guide | **Done in revision 4** (A10, O8–O15, O9b). Accepted by independent review |
| Document Codex configuration loading and its documented controls (§2.4) | **Done in revision 4** for documentation (O16–O23). Accepted; the runtime items are in 4.2 |
| Independent review verdict on this document (revision 4) as a whole | **Accepted 2026-11-17**, with the corrections made after review of 93b289d. This covers documentation only: no adapter is verified at runtime, and the gates in 4.2–4.4 stay open |

### 4.2 Gates before enabling each real adapter

**Claude Code adapter**

| Gate | Type |
|---|---|
| User decision on A1's product clause, A10's routing prohibition, and whether to ask Anthropic (§1.1) | User / legal |
| Profile A / Profile B behavior (§1.4 items 1–5), including user-level configuration | Runtime |
| Clean interrupt on Windows, including during a running command (§1.7) | Runtime |
| Model-substitution detection (§1.5) | Runtime |
| Missing or expired credential behavior | Runtime |

**Codex adapter**

| Gate | Type |
|---|---|
| User decision: keep the user's own `codex login` (relying on O1's continuation sentence) or move to Sign in with ChatGPT (WorkTreeAI then handles tokens under O11); and whether to ask OpenAI (§2.2) | User / legal |
| The §2.4 runtime items: `-c` overrides on app-server, trust default, `AGENTS.md` suppression or detection, delegation tools removed, user MCP/plugins/apps stopped | Runtime |
| Approval routing for `on-request` + `workspaceWrite`; model-substitution detection (§2.3) | Runtime |
| Missing or expired credential behavior | Runtime |

### 4.3 Release gates (before a public release)

| Gate | Type |
|---|---|
| License choice (checklist C1) | User |
| The provider-condition decisions in 4.2 settled for every adapter that ships enabled | User / legal |
| Naming, provider requirements: no "Claude Code" or "Anthropic" name or logo in the product name or logo and no implied endorsement (A1, for products running Claude Code); OpenAI names and logos only per its Brand Guidelines (O8) and, with SIWC, only as authorized and without implied sponsorship (O11 §5) | Docs |
| Naming, project policy (stricter than the providers require): no "Claude Code", "Anthropic", "OpenAI", or "Codex" in the product name or logo | Docs |
| If Sign in with ChatGPT is chosen: privacy notice, consent and revocation controls, local owner-only token storage (O11 §2.3–2.4, O13) | Docs + implementation |

### 4.4 macOS verification (deferred by the user on 2026-11-17)

Not passed and not removed: running the adapter runtime tests in a macOS environment (SIGINT,
OS sandbox, Keychain), and macOS packaging and signing. See checklist G6.6 and item 9.

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

No adapter gate in §4.2 is fully closed by these runs.

Runtime tests must use the user's own accounts, minimal prompts, and the user's explicit
authorization.
