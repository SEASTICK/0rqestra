# 0rqestra — Chat, agents, and backend: plan and priorities

Status: **proposal for review.** Written 2026-11-17, revised the same day: the first users are
Philip and Edwin, who use their own subscriptions and do not want to pay per use, so the
subscription tools come **first** and API keys are added later. It does not replace any decision in
[`product-brief.md`](product-brief.md) or [`architecture.md`](architecture.md); where this plan
needs one of those changed, it says so under "Decisions this plan changes". Nothing in this plan is
built yet.

## Goal

0rqestra is a team of AI agents behind one chat.

1. The user chats with a **Manager**. The Manager hands work to specialist agents in the tree.
2. Each user brings **their own access**. First: their own subscriptions, used through the
   providers' official tools (Claude Code, Codex), plus free sources. Later: their own API keys
   (OpenAI, Anthropic, Google, and others). Nothing is paid for by 0rqestra.
3. Some agents are **cheap or free** and answer easy questions quickly.
4. Every agent can be set **by hand** (provider, model, effort level, for example "Opus, medium").
5. The end goal: the Manager **decides for itself** how big a task is, which agents fit, and
   with which settings, within a budget. The user can always override.
6. Later: the work runs in a **backend** (Supabase for accounts and data, DigitalOcean for
   workers), so it keeps going when the app is closed and agents run in parallel.

## What exists today

| Where | What | State |
|---|---|---|
| `0rqestra` (this repo) | Electron app with the interface, simulated agents, a fake provider, an update pipeline | Interface and updates work. **No real model is called anywhere.** |
| `SEASTICK/Orqestra` `engine/` | Python engine: planner, router, orchestrator, quality checks, cost ledger, adapters for Anthropic, OpenAI, Google and OpenAI-compatible | 145 tests pass. Built for one person on one computer; files only, no server, no users, no streaming, no per-user keys. |

The Python engine is the **model to follow, not a part to attach**. Its ideas carry over (plan,
junior and senior tiers, review by a different provider, budget cap, learning from statistics);
its code does not, because 0rqestra is TypeScript and the backend needs users and keys per user.

## Principles

- **Credentials stay with their owner.** 0rqestra never collects, stores, or forwards a
  subscription sign-in; the user signs in inside the provider's own tool. API keys, once added,
  stay on the user's computer, encrypted by the operating system, and are never written to Git,
  logs, run files, or sent to the interface after saving.
- **Every request has a limit.** In kronor for API calls. A subscription has no price per call,
  so its runs are limited by number of calls, time, and the subscription's own usage allowance.
  The limit is enforced before each call; unknown cost stops the run. No test or CI job ever
  calls a real model.
- **Honest data.** The interface shows real runs. Simulated runs stay labelled "demo".
- **One stage at a time, each releasable.** Every phase ends in something that ships through the
  existing `test` → `stable` → approve workflow. Codex reviews before the next phase starts.
- **Manual first, automatic second.** The Manager's own choices are added on top of manual
  settings and can always be overridden.

## Decisions this plan changes

These are agreed in `product-brief.md` and `provider-integrations.md` today. This plan changes
them, so they need an explicit yes from Philip and Edwin, and a review, before work on them starts.

| Today | This plan | Why |
|---|---|---|
| Agents run through the provider tools the user installs (Codex, Claude Code) | **Kept, and made the first route.** The chat talks to a provider interface, so API-key adapters can be added later without rewriting | Philip and Edwin use it themselves and do not want to pay per use |
| 0rqestra holds no API keys | **Unchanged at first.** API-key adapters (the user's own keys) come in phase 7, when the cloud, priced cheap agents, or a commercial version need them | A subscription gives no API access, and a server cannot use an interactive sign-in |
| Cloud execution is out of scope for the first release | Cloud (Supabase, DigitalOcean) comes **after** a working local chat, in phases 6–8 | Sync and parallel agents; the local release stays useful on its own |
| The providers' terms for this use are an open question (`provider-integrations.md`, G6.4) | **Still open.** Fine for Philip and Edwin using their own subscriptions on their own computers; must be settled before anyone else uses it | Subscription terms differ from API terms |

## Decisions needed from Philip (defaults assumed below)

| # | Question | Default used in this plan |
|---|---|---|
| D1 | Engine language | **TypeScript**, in `packages/engine` of this repo (the Python engine stays as a reference) |
| D2 | Where API keys are stored, once they are used (phase 7) | **On the user's computer**, encrypted with the operating system (Electron `safeStorage`); not in Supabase. Phases 1–6 need no keys at all |
| D3 | Cloud key custody (phase 8) | Only when a run must continue with the app closed; encrypted per user; the user can remove it at any time |
| D4 | Monthly cloud budget (Supabase plan, DigitalOcean) | Not set. Phases 6–8 do not start until a number is given |
| D5 | Free agents | Local models (Ollama), and the free tiers of Google and OpenRouter, which need a free key but no payment. Free tiers have low limits and may use data for training, so they are labelled in the interface |
| D6 | Who may use cloud features | Philip and Edwin only, until phase 9 |

## Prioritised work, in order

Sizes: S = a few hours, M = about a day, L = several days. They are rough and only show relative
effort. Every phase is a pull request that Codex reviews.

### Phase 0 — Decide and prepare (Philip, S)
**Decided 2026-11-17:** Philip and Edwin start with the subscription route; API keys come later.
D1 (TypeScript in this repo) followed from that. D2–D6 keep their defaults until they matter.
- Answer D1–D6. Edwin confirms the changed decisions above.
- Fix the unstable CI step `smoke:failures` (it fails on macOS and Windows without code changes),
  so a red check means something again. (Claude, S)
- **Done when:** the decisions are written into `product-brief.md`, and CI is reliably green.

### Phase 1 — A real chat through your own subscriptions (Claude, L)
**Status 2026-11-17: built, not yet run against the real tools.** What exists:
- Adapters in `apps/desktop/src/main/providers/` (in the app's main process rather than a
  separate package, because workspace packages are not part of the packaged app). Claude Code runs
  in print mode with streamed JSON and profile A; Codex runs through `codex app-server` with an
  ephemeral, read-only thread. Both refuse to send anything unless the tool is signed in with a
  subscription, and every API-key variable is removed from their environment.
- The conversation is kept in 0rqestra and recent turns are sent with each message, so it works
  the same for both tools and survives a restart.
- Chat channels in the main process (`chat-service.ts`, `chat-ipc.ts`) that validate everything
  from the window; at most one reply per project and three at once.
- In the window: tool, model and effort under the message box (Codex lists its models and effort
  levels; Claude Code takes the aliases Default, Opus, Sonnet and Haiku, and no effort setting
  yet), streamed replies, Stop, token use and plan limits after each reply, and a real
  AI accounts page with sign-in steps.
- Verified: 213 tests, including the adapters against fake tools that behave like the recorded
  runs, and the whole chat in a browser with a stubbed bridge.
- **Not verified:** a run with the real Claude Code and Codex. That is the first thing to do
  with the installed app.

This is the first thing that makes 0rqestra a real chat bot, and it costs nothing per use.
- **Provider interface** in a new package (`packages/providers`): one way to start a chat turn,
  stream text, stop, and report usage. Adapters are plugged in behind it.
- **Claude Code adapter** and **Codex adapter**, built on what the probes already showed
  (`provider-runtime-results.md`): streamed output, a working stop, permission prompts, and a
  launch profile that keeps project hooks and tools out. The user signs in inside the tool; 0rqestra
  never sees the credentials.
- **Chat** between the interface and the main process: the reply appears as it is written, with a
  Stop button; history is saved per project on the computer.
- **Model choice** limited to what each tool accepts; the list is read from the tool where it
  offers one. **Usage** is shown as calls and time, and as the subscription's own allowance where
  the tool reports it, never as a made-up price.
- **Limits** per request (calls and time), enforced before each call.
- **Done when:** Philip and Edwin each chat with a real model through their own signed-in tool,
  see streamed text and Stop working, and the flow is covered by tests that use a fake provider only.
- **Needs from Philip and Edwin:** Claude Code and Codex installed and signed in. Some runtime
  checks from `provider-integrations.md` §4 are still open (interrupt during a running command,
  standalone installs, macOS) and are closed here.

### Phase 2 — Manual control of every agent (Claude, M)
- Each agent node gets **provider, model, and effort** (for example Claude with Opus and medium
  thinking, or Codex with a chosen model and reasoning level). The options come from what each tool
  accepts, checked at runtime, because the providers name and limit them differently.
- A **test message** per agent ("try this agent") with its cost.
- Settings are saved with the project and follow the existing rules in
  [`tree-routing-and-permissions.md`](tree-routing-and-permissions.md) (priorities, "+" adds a
  connected child, snapshot per request).
- **Done when:** two agents with different providers answer in the same project, each with the
  model and effort chosen by hand.

### Phase 3 — The Manager and the team work together, locally (Claude, L)
The port of the Python engine's core, in TypeScript.
- **Manager** asks clarifying questions or makes a **plan**: tasks, order, difficulty, and a
  cost cap. It never does specialist work itself.
- **Orchestrator** (plain code, no AI): runs tasks in dependency order, enforces the limits,
  retries with the failure attached, and escalates from a cheaper to a stronger agent.
- **Review by a different provider** than the worker, as in the Python engine. A review that
  cannot be read counts as not approved.
- **Live tree:** each agent shows idle, working, waiting, or done, with real status, replacing
  the simulated one.
- Agents produce text and files into the project folder. **No code is executed yet.**
- **Done when:** a request in the chat becomes a plan, several agents work on it, one reviews,
  and the chat shows the result, the cost, and which agent did what.

### Phase 4 — Cheap and free agents (Claude, M)
- A **quick lane**: simple questions go straight to a cheap or free model and skip the plan.
- The first rule is simple and visible (length, no files, no code, no tools); the user can turn
  it off or choose the agent by hand.
- Free sources are local models (Ollama) and the free tiers of Google and OpenRouter, each labelled
  with its limits and data terms (D5). Hitting a limit moves the request to the next agent or asks
  the user, never to a paid one silently.
- **Done when:** "what is the capital of Sweden" is answered by the cheap agent in about a
  second at no or very low cost, while a big request still goes through the Manager.

### Phase 5 — The Manager chooses for itself (Claude, L)
- The Manager **classifies** each task (small, medium, large), then picks agents, models, and
  effort **inside the limits** (calls, time, and the usage allowance of each subscription), and
  says why in one line the user can read.
- Every choice and its outcome (approved, reviewed down, usage or cost, time) goes into a **ledger**. After
  enough samples per kind of task, the router prefers what has worked, as the Python engine does.
- **Manual settings always win.** A pinned agent is never changed by the Manager.
- Measured on a fixed set of 10–20 test requests, compared with always using one strong model,
  for quality, usage, and time. If it does not win, we say so and keep it manual.
- **Done when:** the evaluation exists and the result is written down, whichever way it goes.

### Phase 6 — Supabase (Claude builds, Philip creates the project, L)
- **Accounts** (sign-in), and the tables for projects, messages, runs, tasks, events, and agent
  settings, with row-level security so a user only reaches their own rows.
- **Sync** between computers, and **live updates** to the interface.
- Credentials are still **not** in Supabase (D2).
- **Needs from Philip:** a Supabase project and its URL and anon key (these two may live in the
  app); the service key goes only into GitHub or DigitalOcean secrets, never into the app.
- **Done when:** the same project, chats, and agent settings open on a second computer.

### Phase 7 — API-key adapters and the DigitalOcean worker (Claude builds, Philip creates the account, L)
- **API-key adapters** behind the same provider interface: Anthropic, OpenAI, Google, and
  OpenAI-compatible (for example OpenRouter). Text streaming, stop, retries only for rate limits
  and server errors, prices per model in an editable table, and a kronor cap per request. Keys are
  stored on the user's computer (D2). This is what a server, exact prices, and priced cheap agents
  need, and what a commercial version later builds on.
- A **worker** that reads queued runs from Supabase and runs the orchestrator, so work continues
  with the app closed and runs in parallel. It uses API adapters only; a subscription sign-in
  cannot run on a server.
- **Sandbox for any code an agent writes or runs**: an isolated container with no network, no
  keys, CPU, memory and time limits, and cleanup. Nothing an agent writes runs outside it.
- Deployed by a GitHub workflow with the same **approve or deny** step as app releases.
- **Needs from Philip:** a DigitalOcean account, a spending cap (D4), a deploy key stored as a
  GitHub secret, and API keys with a spending limit set at the provider. Claude never creates
  accounts, paid resources, or keys.
- **Done when:** a run started in the app finishes in the cloud while the app is closed.

### Phase 8 — Keys for cloud runs (Claude, M)
- Only if a cloud run needs the user's key (D3): the key is encrypted per user, readable only by
  the worker that makes the call, never returned to the app, removable at any time, and every use
  is logged. Per-user and per-day budgets are enforced here too.
- **Done when:** a cloud run uses a key without the key ever appearing in the app, logs, or the
  database in readable form, shown by a test.

### Phase 9 — Hardening before anyone else uses it (Claude and Codex, L)
- Security review of the key handling, the sandbox, and the database rules.
- Rate limits, backups and restore, error reporting, and a runbook.
- Terms check with each provider for the way keys and cheap models are used.
- **Done when:** the review's findings are fixed or accepted in writing.

## Who does what

| Who | Does |
|---|---|
| Claude | Builds each phase, tests it, and writes down what was and was not verified |
| Codex | Reviews each phase independently before the next one starts |
| Edwin | Interface decisions; confirms the changed decisions; runs the release workflow |
| Philip | Decides D1–D6; creates accounts, projects, and keys; sets spending limits at the providers |

Claude does not create accounts, paid resources, or keys, and does not start releases.

## Risks to watch

- **Cost surprises.** Mitigation: caps before every call, unknown cost stops the run, per-user
  limits, and the provider's own account limit as a second guard.
- **Keys on a server** (phase 8) are a real responsibility. That is why they come last and are
  optional.
- **Subscription limits.** Heavy or parallel use can hit a subscription's usage limits. The
  Manager has to spread the work and ask before waiting, and the interface shows the allowance
  when the tool reports it.
- **Terms.** Using subscriptions through an orchestrating app is fine for the two owners on their
  own computers, but is an open question for anyone else (G6.4). Do not give it to other users
  before that is settled.
- **Provider terms and limits** change; free tiers can be withdrawn. The model table is data, not
  code, so it can be corrected without a release.
- **Automatic choices can be wrong.** Hence manual override, a visible reason, and a measured
  evaluation before the automatic mode is on by default.
- **Scope.** The Python engine has more than 3,000 lines of tests and rules. Phase 3 ports the
  parts that matter; it does not port everything.

## Not in this plan

- Running provider command-line tools in the cloud.
- A public service for other users (phase 9 only prepares for it).
- Mobile (iOS) companion.
- Payment, billing, or selling access. Selling usage (users pay 0rqestra, 0rqestra pays the
  providers) needs payments, tax, abuse protection, key custody, and the providers' resale terms.
  Users bringing their own API keys needs none of that.
