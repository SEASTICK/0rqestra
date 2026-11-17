# 0rqestra — Chat, agents, and backend: plan and priorities

Status: **proposal for review.** Written 2026-11-17. It does not replace any decision in
[`product-brief.md`](product-brief.md) or [`architecture.md`](architecture.md); where this plan
needs one of those changed, it says so under "Decisions this plan changes". Nothing in this plan is
built yet.

## Goal

0rqestra is a team of AI agents behind one chat.

1. The user chats with a **Manager**. The Manager hands work to specialist agents in the tree.
2. Each user brings **their own API keys** (OpenAI, Anthropic, Google, and others). Nothing is
   paid for by 0rqestra.
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

- **Keys never leave their owner without a decision.** Phase 1–5 keep keys on the user's own
  computer. Keys are never written to Git, logs, run files, or sent to the interface after saving.
- **Every call has a cost cap.** A budget per request, enforced before each call; unknown cost
  stops the run. No test or CI job ever calls a real model.
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
| Agents run through the provider tools the user installs (Codex, Claude Code); no API keys held by 0rqestra | Agents call the provider **APIs with the user's own keys** (adapters in 0rqestra) | The goal is own API keys per agent, several providers, and cheap models that have no CLI |
| Cloud execution is out of scope for the first release | Cloud (Supabase, DigitalOcean) comes **after** a working local chat, in phases 6–8 | Backend and parallel agents; the local release stays useful on its own |
| Subscription sign-in stays inside each provider's own tool | Unchanged for the CLI route. API keys are a **separate, additional** route | ChatGPT Plus and Claude Pro are not API access |

## Decisions needed from Philip (defaults assumed below)

| # | Question | Default used in this plan |
|---|---|---|
| D1 | Engine language | **TypeScript**, in `packages/engine` of this repo (the Python engine stays as a reference) |
| D2 | Where keys are stored first | **On the user's computer**, encrypted with the operating system (Electron `safeStorage`); not in Supabase |
| D3 | Cloud key custody (phase 8) | Only when a run must continue with the app closed; encrypted per user; the user can remove it at any time |
| D4 | Monthly cloud budget (Supabase plan, DigitalOcean) | Not set. Phases 6–8 do not start until a number is given |
| D5 | Free agents | Google's free tier, free models via OpenRouter, and local models (Ollama). Free tiers have low limits and may use data for training, so they are labelled in the interface |
| D6 | Who may use cloud features | Philip and Edwin only, until phase 9 |

## Prioritised work, in order

Sizes: S = a few hours, M = about a day, L = several days. They are rough and only show relative
effort. Every phase is a pull request that Codex reviews.

### Phase 0 — Decide and prepare (Philip, S)
- Answer D1–D6. Edwin confirms the changed decisions above.
- Fix the unstable CI step `smoke:failures` (it fails on macOS and Windows without code changes),
  so a red check means something again. (Claude, S)
- **Done when:** the decisions are written into `product-brief.md`, and CI is reliably green.

### Phase 1 — A real chat with one model (Claude, L)
This is the first thing that makes 0rqestra a real chat bot.
- **Key vault** in the main process: add, test, and remove a key per provider; stored encrypted
  with `safeStorage`; the interface only ever sees "connected" and the last four characters.
  Uses the existing "AI accounts" page.
- **Provider adapters** in a new package (`packages/providers`): Anthropic, OpenAI, Google,
  OpenAI-compatible. Text streaming, cancel, timeouts, retries only for rate limits and server
  errors, and one error format for all of them.
- **Model list fetched from each provider** with the user's key, so new models appear without a
  code change. A small editable table adds what lists do not tell: price per million tokens and
  the effort options of each model.
- **Chat** between the interface and the main process: the reply appears word by word, with a
  Stop button; history is saved per project on the computer; each reply shows its cost.
- **Budget cap** per request and a visible running total.
- **Done when:** Philip adds one real key, chats with a real model, sees streamed text and the
  cost, and the same flow is covered by tests that use a recorded or fake provider only.
- **Needs from Philip:** one API key with a small spending limit set at the provider, for a live
  check by hand. Never pasted into chat.

### Phase 2 — Manual control of every agent (Claude, M)
- Each agent node gets **provider, model, and effort** (for example Anthropic Opus with medium
  thinking, an OpenAI model with high reasoning, Gemini with a thinking budget). The effort
  options come from the model table, because the three providers name and limit them differently.
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
- **Orchestrator** (plain code, no AI): runs tasks in dependency order, enforces the budget,
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
- Each free source is labelled with its limits and data terms (D5). Hitting a limit moves the
  request to the next agent or asks the user, never to a paid one silently.
- **Done when:** "what is the capital of Sweden" is answered by the cheap agent in about a
  second at no or very low cost, while a big request still goes through the Manager.

### Phase 5 — The Manager chooses for itself (Claude, L)
- The Manager **classifies** each task (small, medium, large), then picks agents, models, and
  effort **inside the budget**, and says why in one line the user can read.
- Every choice and its outcome (approved, reviewed down, cost, time) goes into a **ledger**. After
  enough samples per kind of task, the router prefers what has worked, as the Python engine does.
- **Manual settings always win.** A pinned agent is never changed by the Manager.
- Measured on a fixed set of 10–20 test requests, compared with always using one strong model,
  for quality, cost, and time. If it does not win, we say so and keep it manual.
- **Done when:** the evaluation exists and the result is written down, whichever way it goes.

### Phase 6 — Supabase (Claude builds, Philip creates the project, L)
- **Accounts** (sign-in), and the tables for projects, messages, runs, tasks, events, and agent
  settings, with row-level security so a user only reaches their own rows.
- **Sync** between computers, and **live updates** to the interface.
- Keys are still **not** in Supabase (D2).
- **Needs from Philip:** a Supabase project and its URL and anon key (these two may live in the
  app); the service key goes only into GitHub or DigitalOcean secrets, never into the app.
- **Done when:** the same project, chats, and agent settings open on a second computer.

### Phase 7 — DigitalOcean worker (Claude builds, Philip creates the account, L)
- A **worker** that reads queued runs from Supabase and runs the orchestrator, so work continues
  with the app closed and runs in parallel.
- **Sandbox for any code an agent writes or runs**: an isolated container with no network, no
  keys, CPU, memory and time limits, and cleanup. Nothing an agent writes runs outside it.
- Deployed by a GitHub workflow with the same **approve or deny** step as app releases.
- **Needs from Philip:** a DigitalOcean account, a spending cap (D4), and a deploy key stored as
  a GitHub secret. Claude never creates accounts or paid resources.
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
- Payment, billing, or selling access.
