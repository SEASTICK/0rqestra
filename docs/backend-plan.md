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

**Status 2026-11-17: CI made stable (in review).** Over 56 recent CI jobs, about 13 failed without a
code change: the `smoke:failures` step on both systems, a timing-dependent test in the old probe
tooling on macOS, and a Windows test-cleanup error in the new provider tests. Causes and fixes:
- The probe tooling's reader handled two lines from one chunk back to back, so under load an approval
  request was seen before the answer to `turn/start` had set the turn id. Lines are now handled one at
  a time. The tests that failed in CI now pass four times in a row with the CPU saturated.
- Time limits were too tight for a busy machine (8 s to start Electron, 2 s for fake tools, 5 s per
  test). Cases that must finish now get 30 s; only cases that are meant to hang keep a short limit.
- `smoke:failures` runs a failing case one more time and says so (a warning annotation on the run, and
  "Passed only on the second try" in the log); a case that fails twice is an error annotation with the
  tool's last output, readable without signing in to GitHub.
- The provider tests clean up their temporary folder after all tests, which Windows needs.
Not verified: the Electron step itself could not be run here, only its logic with a stand-in. If a
`smoke:failures` case still fails twice, the annotation now says which one and why.
The first annotated failure (2026-11-17) showed the real Windows cause: in "BrowserWindow construction
throws", the app printed the right verdict and then Electron crashed while shutting down (exit
0xC0000005 instead of 1). On Windows that exit is now accepted only with the right verdict and
handler, and it is reported as a warning every time it happens.

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
**Status 2026-11-17: built, in review.** What exists: in the agent editor, **Runs on** (Demo,
Claude Code, or Codex, listing only tools that are installed and signed in with a subscription),
then **Model** and **Effort** from what the tool reports (Codex lists its models and effort levels;
Claude Code offers Default, Opus, Sonnet and Haiku and no effort setting yet). **Try this agent**
sends one short real request with the chosen settings and shows the answer and the usage. A real
agent shows its tool, model and effort on its card in the tree, and the demo allowance ring and
recovery stack are hidden for it. The Manager node's settings are the settings of the Manager chat:
the box under the chat and the editor change the same thing. Agents other than the Manager do not
run yet; that is phase 3.
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
**Already built (2026-11-17): the Manager asks questions.** When a decision from the user would
change what it does, the Manager ends its reply with one multiple-choice question (2–4 options and
its own recommendation). The chat shows it as a card, as Lovable does: the Manager's pick is
preselected, the user can write their own answer or skip, and the answer becomes the next message.
Phase 3 uses the same question card when the plan needs a decision.

**Status 2026-11-17: first release built, not yet run against the real tools.** What exists:
- The Manager knows the agents in the tree (and which can work) and, for a request that needs files,
  ends its reply with a plan: tasks, roles, order, and the files each task delivers.
- The plan shows as a card with the agent each task starts with. **Nothing runs until the user
  presses Start.** A role without a working agent blocks Start and links to the tree.
- `apps/desktop/src/main/team/`: the plan is validated again in the main process (roles, order,
  no circles, each file owned by one task, plain relative file names). Tasks run in dependency
  order, two at a time. Agents keep their tools switched off and hand over files as text; the main
  process writes them into the project's folder (`<user data>/projects/<id>/workspace`), never
  outside it and never through a link. Earlier tasks' files are given to the tasks that depend on them.
- A Code Reviewer (preferably on the other tool) reviews each task. Work that is not approved goes
  back with the problems listed; a retry goes to the next agent of the same role by priority. Limits
  from decision A5: at most 3 attempts per task and 25 agent requests per run. Without a reviewer the
  work is marked "not reviewed".
- The tree shows who is working, reviewing or waiting; the chat shows each task, its agent, review
  notes, files, and the totals; Stop works; Open project folder opens the files.
- Verified: unit tests for every part with scripted agents, and the whole flow in a browser with a
  stubbed bridge. **Not verified:** a run with the real Claude Code and Codex, and whether the
  models follow the plan and file formats reliably.
- Not yet: running or previewing what the agents built (phase 5b).

**Status 2026-11-18: the Planner plans, and the Manager re-plans.** What was added:
- Decision A6: when the tree has a Planner on a working tool, the Manager no longer writes the plan
  itself. It writes a short brief, and the Planner turns it into the plan. The chat shows "The
  architect is planning" with Stop, and the plan card says who made it. Without a working Planner
  the Manager plans as before. The plan is validated in the main process in the same way.
- After a failed or stopped run, the run card offers "Ask the Manager to fix it". It sends the
  Manager what failed, the review notes and the files that exist, and the Manager makes a new plan.
- Agents see existing files: a task gets the files from the tasks it depends on, and also existing
  files in the project folder that its goal names or that it is about to replace.
- **Task handoffs, stage 1 (2026-11-19).** The Manager (or the Planner) writes a handoff for every
  task inside the plan, with no extra model call: the expected deliverable, decisions already made,
  the task's rules (plus the plan's project `rules`), findings, references (a dependency's file, the
  task's own file, a project file, or an earlier task's result; `full` only when the whole file is
  needed), acceptance criteria and how to verify. Every role reads the same format
  (`main/team/handoff.ts`): a worker gets the requirements and the referenced files; a reviewer gets
  the requirements, the submitted changes and the automatic checks. References are checked against
  the task's dependencies when the plan is read, project files before the run starts, and the rest
  just before the task runs; a missing one blocks the task instead of being dropped. Agents never
  get the chat. Plans made before handoffs get one built from the task's goal and dependencies.
- **Task handoffs, stage 2 (2026-11-19).** Every worker ends with a return brief
  (`<orqestra-brief>`: summary, decisions, findings tagged for the tasks that need them, evidence,
  what it verified, what is open). The runner adds what it observed itself ("checked by the app")
  and labels the agent's own claims "agent-reported". Later tasks get the brief with only the
  findings tagged for them (the rest by id), the reviewer gets the latest files plus the brief as
  evidence, and the Manager's next turn gets every brief in short (`main/team/return-brief.ts`).
  An agent can answer `<orqestra-need>` instead of files: the runner answers from the plan and the
  finished tasks, asks the earlier task's agent one follow-up question when the detail is not
  written down, refuses anything outside the task's readable files, and sends new decisions or a
  missing file to the Manager chat (the task is blocked; independent tasks go on). Requests are
  answered once each, at most 2 rounds per task (`main/team/context-request.ts`).
- **Task handoffs, stage 3 (2026-11-19): usage.** Every request a run makes is recorded once
  (`main/team/usage-ledger.ts`): agent, task, kind (work, review, follow-up), attempt, outcome, and
  the input, cached-input and output tokens the tool reported, as numbers only. Claude Code reports
  cached input apart from its input count; Codex includes it; both are normalised to "all input, of
  which N cached" (`main/providers/usage.ts`). Codex's repeated usage updates replace each other;
  a request without usage is "Unavailable" and makes the totals "Partial". The run card shows the
  planning call and each agent. Reviewers now read the criteria, the checks and a diff first (the
  whole file only when new, short or too long to compare); a retry gets its problems and its last
  submitted version; broken JSON or JavaScript is caught before any review.
  Plain chat stays light: the planning instructions and plan format go only with messages that ask
  for work (decided from the words, no extra model call); if the Manager still needs to plan it
  answers `<orqestra-plan-needed/>` and the app asks once more in plan mode, hiding the marker and
  adding both usages. Prompts show only the handoff sections that say something, list referenced
  files once, send the web rules only for web files, and ask a task nothing builds on for a short
  brief. Found while benchmarking (2026-11-20): a reviewer asked to check facts from a file it was
  not given, with no tools, made Claude Code write `<invoke name="Bash">cat sources.md</invoke>` as
  text in an endless loop, so the call ran to the time limit (also in the old version). Reviewers
  now get the files the author worked from (up to 6,000 characters), every agent is told it has no
  tools, and the Claude Code adapter ends a reply that loops on fake tool calls (3 repeats or 15 s)
  or goes silent (90 s) instead of waiting 10 minutes. Not yet: skills.
- Verified: unit tests, and the flow in a browser with a stubbed bridge. **Not verified:** the
  Planner and the re-plan with the real Claude Code and Codex.
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

### Phase 5b — Products in the tree, with live previews (Claude, L)
The user's idea (2026-11-17), inspired by Lovable's preview window, but built for many products at once.
- **A product is its own branch in the tree**: for example "Web app", "Landing page", "API". The agents
  that work on it (design, code, test) are connected to that product node, so it is visible which
  agents work on which product.
- **Each product node opens a live preview** of what is being built, which updates while the agents
  change it. In a big project several previews can be open side by side.
- **The Manager creates product nodes** when a request means several products, and asks the user
  (with a question card) when it is unclear how to split the work.
- **Needs first:** phase 3 (agents that write files), and a sandbox for running what agents write
  (phase 7), because a preview runs code that an agent wrote. The preview shows in its own isolated
  view with no access to the app, the user's files outside the product's folder, or any keys, and it
  can only load the product's own local address.
- **Done when:** a request for a small web app shows a product node with a preview, and the preview
  changes while a Builder agent works on it.

**Status 2026-11-18: first release built, for web pages.** What exists:
- The main process finds the products in the project's folder: each folder with an `index.html` (or
  else the shallowest `.html` file) is a web product, named after the page's title.
- Each product is a node in the tree, the same size as an agent, with a small live picture of the page.
  It is linked with dotted lines to the agents that wrote or reviewed its files, and placed under them.
  While the team works on it, it shows "Building".
- Clicking the node opens the live preview beside the chat (desktop or phone size, reload, open folder,
  back to the tree). The preview reloads when the team writes files, and when the window gets focus
  after the files changed. A finished run card has an "Open preview" button.
- Agents are told how to build a web product that the preview can show: an `index.html`, plain HTML,
  CSS and JavaScript with relative links, and nothing from the internet.
- Security: see docs/architecture.md §4. The agents' code runs only as web code in an isolated frame,
  with no Node.js, no network and no keys. **No sandbox for server code yet** (phase 7): products that
  need a server, a build step or packages are not previewed.
- Verified: unit tests (finding products, serving files, refusing paths out of the folder and links),
  and the real Electron app with its OS sandbox: the node, the links, the preview, the phone size,
  storage in the page, a file change showing in the open preview, and that the page cannot read the
  window, use `window.orqestra`, reach the network, or navigate away. **Not verified:** a real run with
  Claude Code and Codex building a product while the preview updates.
- Not yet: several previews side by side, and products other than web pages.

**Status 2026-11-20: Auto picks the model per message, and the project has a memory.**
- **Auto** (the default when no model is chosen) lets the main process pick the Manager's model per
  message: a quick question (short, nothing attached, no work asked for, by the same word check that
  decides planning) gets a light, fast model (Claude: Haiku; Codex: a "mini" model when it has one), and
  work, files and longer questions a stronger one (Claude: Sonnet; Codex: its default). When a reply that
  looked quick turns out to need a plan, the planning request uses the stronger model. The reply's label
  says "Auto → <model>". A model chosen by hand is used as before.
- **Project memory.** The Manager saves lasting facts and decisions with
  `<orqestra-remember>…</orqestra-remember>` (hidden in the reply; a line under it says what was saved).
  They are kept with the project (at most 40, no duplicates) and sent with every message, so the Manager
  keeps to them. **Memory** in the project's header shows them; the user can remove or add facts.
- Verified with unit tests and in the real Electron app with the stand-in Claude Code: a quick question
  started it with `--model haiku`, a request for work with `--model sonnet` and both saved facts in the
  prompt; the Memory dialog removed and added facts. **Not verified:** how well the real Manager decides
  what to remember.

**Status 2026-11-20: a chat like Claude's, attachments, and the model per task.**
- **Formatted replies.** Replies are drawn from Markdown (`ui/markdown.mjs` reads it into plain data,
  `ui/Markdown.jsx` draws it with React; no HTML is ever parsed): headings, lists, quotes, tables, inline
  code, simple formulas, and code blocks with a Copy button. Links open in the user's own browser, and
  only web addresses (`chat:open-link`). The chat looks like Claude's: replies as plain text across a
  centred column, the user's messages in a soft bubble on the right.
- **Attachments.** The + button, drag and drop, and paste add images (PNG, JPEG, GIF, WebP, 5 MB), PDFs
  (10 MB) and text files (300 kB), at most 6 per message. The main process decides the kind from the
  content, keeps the file for a week (`main/attachments.ts`), and sends it with that message only:
  Claude Code gets images and PDFs as their own blocks, Codex gets images as local image files (and is
  told it cannot read PDFs here), and text files go into the message. Later messages only say what was
  attached.
- **The model per task.** The Manager sees which models each tool offers and may set a task's `"model"`
  (the strongest for hard work, a lighter one for simple work). The main process keeps it only when the
  task's agent's tool offers that model, and the runner uses it for that task; the plan card shows the
  model each task will run on.
- Verified with unit tests and in the real Electron app with the stand-in tools: an image and a CSV were
  attached and the stand-in Claude received an image block and the file's text; a reply with a heading,
  a table and code was drawn; the plan card showed "Claude · haiku" for the task the Manager put on Haiku,
  and the agent's own model where the Manager asked for one its tool does not have. **Not verified:** the
  real Claude Code and Codex reading attachments (their input formats were followed, not tried).

**Status 2026-11-20: Claude and ChatGPT work together, and the Manager decides who does what.**
- The Manager (and the Planner) now see which tool and model each agent runs on, and, when the team has
  both, a short guide to what each is good at (Claude Code: planning, interfaces and design, text, careful
  reviews; Codex: implementing, logic and data, debugging, tests, precise changes). They are told to make
  the two work together.
- A plan task may name its agent (`"agent"`, with a short `"why"`). The main process keeps a name that
  matches a working agent with the task's role and makes it the task's first agent; any other name is
  dropped, and the role's usual agent does the task. The plan card shows each task's agent with a
  Claude/ChatGPT label and the reason, and says when both tools work on the plan; the run card shows the
  tool of the agent on each task. Reviews still go to an agent on the other tool when there is one.
- **Set up the team** gives each role the tool that suits it (Planner, reviews and the Manager on Claude,
  Builder and Tester on Codex), and spreads several agents of one role over both tools. When both tools are
  connected but the whole team runs on one, the chat and the tree offer **Use both**, which moves agents
  the same way (Undo restores).
- Verified with unit tests and in the real Electron app with the stand-in tools: a team on Claude only was
  mixed with Use both, the Manager's plan gave the logic to the Codex builder and the design to the Claude
  builder with reasons, and the run used both (one Codex request, Claude for the design and the reviews).
  **Not verified:** how well the real Manager chooses, and whether it names agents reliably.

**Status 2026-11-20: undo a run's changes.** Before a run writes a file for the first time, the main
process keeps the file as it was (or notes that it did not exist) in `<project>/history/<runId>/`
(`main/team/history.ts`; the newest 20 runs are kept). **Undo changes** on the run card puts those
files back and removes files the run created. Runs are undone newest first: the button is only on
the newest run that wrote files, and the main process refuses an older one while a newer change is
not undone, so a later change is never lost. Not while the team works in the project, and not in a
shared Teams project (there the Manager changes it back, so the team's reservations see the change).
The card then says how many files are back, the preview reloads, and the Manager's history says the
user undid the run. Verified with unit tests and in the real Electron app (two changes undone in
order; the files on disk were checked).

**Status 2026-11-20: ask one agent directly.** The agent's panel in the tree has a box to ask that agent
directly, without the Manager and without a plan to approve ("make the heading bigger", "what is on
the page?"). The main process makes a one-task plan for that agent (`directPlan`, `team:direct`): the
agent reads the project's files (up to the context limit) and delivers the files it changes or
creates (at most 8, plain relative names inside the project folder), which another agent reviews as
usual; a question is only answered, with nothing written or reviewed. The chat shows "To <agent>"
and a card with the agent's reply, its files and the activity; the Manager's history marks such
requests as not addressed to it. An agent without a tool cannot be asked, and nothing can be asked
while the team works. In a Teams project the reservation grows when the files are written, as for
other runs. Verified with unit tests and in the real Electron app with the stand-in tools.
The interface build now also parses the whole bundle, so a syntax error (a name declared twice, as
the end-to-end test found) stops the build instead of showing a blank window.

**Status 2026-11-19: what each agent is doing.** A click on an agent in the tree opens a panel beside
it: **Now** shows what the agent is writing while it writes (text, each file it delivers with its line
count, "writing…" until the file is complete) and how long it has worked; **Earlier** lists its
answers, newest first (worked on or reviewed which task, which attempt, how long, when), with review
verdicts and failures; **Files it wrote** lists its files. The runner sends what an agent writes as
`output` events (the latest part every 0.4 s while it writes, then the whole answer cut to 12,000
characters); the window keeps up to 16 answers of 6,000 characters per run with the project. What the
agents write is never passed to Teams. Verified with unit tests and in the real Electron app with the
stand-in tools. Also fixed: primary buttons (such as **Restart now** in the update dialog) had dark
text on a dark button; they now use the shell's accent colours.

**Status 2026-11-19: one question at a time, a working animation, the team's activity, and usage left.**
- The Manager's questions come one at a time, like Lovable: a click on an option shows the next question
  (Back goes to the previous one), "Write your own" and "Let the Manager decide" work per question, and
  the last answer sends them all as one message.
- While the Manager answers: a turning star with "Thinking", then "Writing", and the time so far. The
  team's run card and the Planner's card show the same, and a finished run says how long it took.
- **Activity** on the run card lists each step with its time, like Claude's lines: who started which
  task, which files were written (with sizes), reviews (approved or the changes asked for), retries,
  and the end. While the team works the last four steps show; the whole list opens with a click.
- **Usage left** in the sidebar: the 5-hour and weekly windows of Claude and ChatGPT, as percent left.
  Codex is asked directly (`account/rateLimits/read`). Claude Code reports its windows only during a
  reply (`rate_limit_event`), so Claude's values are the latest seen, with their time, and before the
  first reply the card says so. Nothing extra is sent to the models to read them.
- Verified: unit tests, and the whole flow in the real Electron app with stand-in `claude` and `codex`
  programs (the test fixtures, no models): question steps and Back, the answers message, the plan,
  Start, the activity steps, the time, and usage before and after a reply. **Not verified:** the
  shape of `rate_limit_event` from the user's own Claude Code version (older versions may report only
  the window that limits right now, or nothing; then the card keeps saying "Shown after the next reply").

**Status 2026-11-19: Select a part of the preview and ask for a change.** Like Lovable's visual edit:
**Select** in the preview's toolbar outlines what the mouse is over; a click picks that part (and does
not follow links or press buttons). A bar shows what was picked ("<h1> "Träningslogg"") and asks what
should change; **Ask the Manager** sends the part (tag, CSS path, text, the start of its HTML), the
request and the product's files, so the Manager plans a change to just that. Verified in the real
Electron app. **Not verified:** the change made by real models from such a request.

**Status 2026-11-19: Arrange, a larger tree, and questions like a short form.**
- **Arrange** in the tree's toolbar places the Manager on top, each agent one row below the agent it is
  connected from (rows ordered so that lines cross as little as possible), and products under the
  lowest of their agents. Only places change, so it also works while the team runs; Undo restores them.
- The tree is easier to read: larger type in the nodes, tighter rows, a fit that uses more of the panel,
  and less empty space above the chat and the tree.
- Before the team builds something new, the Manager asks 2 to 4 multiple-choice questions at once, like
  Lovable's form (who it is for, main features, look and feel). Each has the Manager's pick preselected,
  your own answer, or "Let the Manager decide"; the answers go back as one message. It does not ask when
  the request is clear, when you say to start, or for small changes.
- Verified in the real Electron app (a messy tree arranged, Undo, the three-question form). **Not
  verified:** how often the real models ask questions, and how good those questions are.

**Status 2026-11-19: the plan names the products.** The Manager and the Planner list what the user
will see in the plan (`products`: an id, a name and a folder, at most 6) and mark the tasks that build
each one. The plan card shows them, and each becomes a node in the tree, linked to the agents of its
tasks, as soon as the run starts ("Planned", or "Building" while the team works on it). When its files
arrive it becomes the live preview, in the same place and with the name from the plan. The main process
validates the products like the rest of the plan. Verified with unit tests and in the real Electron app
(two named products, then files for one of them). **Not verified:** whether the real models fill in
`products` reliably; a plan without them still works as before (products then appear from the files).

**Status 2026-11-19: the preview reports problems, and product nodes can be moved.**
- The main process reads the console of previewed pages (only frames from a known preview host) and
  sends three kinds of problems to the window: a script error (with file and line), a file the page
  asks for that does not exist, and something it tried to load from the internet. The same problem is
  sent once a minute at most, and at most 30 per project a minute; messages are cut short.
- The product node shows "N problems", and the preview shows a list with **Ask the Manager to fix**,
  which sends the problems and the product's files to the Manager as a message, so it can plan a fix.
  Problems are cleared when the files change or the preview reloads, and come back if they remain.
- Product nodes can be dragged in the tree; the place is saved with the project.
- Verified: unit tests, and the real Electron app with a broken page (missing CSS file, a script from
  a CDN, a script error): all three were shown, a drag did not open the preview, the place was kept
  after a restart, and the problems went away after the page was fixed. **Not verified:** the fix
  request with a real Manager on Claude Code or Codex (the test machine has none connected).

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

**Status 2026-11-20: the local sandbox (Docker on the user's computer) is built; the cloud part is not.**
Decision (Philip, 2026-11-20): run apps in Docker on the user's computer now, and move the same runs to the
cloud later. What exists (`apps/desktop/src/main/sandbox/`):
- A product whose folder has a `package.json` with a `dev` or `start` script is an **app** (a node in the
  tree marked "Product · App"). Agents are told to prefer plain pages, and to make a Node.js app (listening
  on `process.env.PORT`, 3000, and host 0.0.0.0) only when a server or packages are needed.
- **Start app** in the preview copies the app's folder to `<user data>/sandbox/<project>/<product>/app`
  (never the project folder itself, never through a link), runs `npm ci`/`npm install` in a container
  when the package files changed, then `npm run dev|start` in another, and shows the app when it answers.
  The preview reaches it through the `orqestra-preview` scheme (its own host per app), so the frame has the
  same origin rules, CSP and Select as a plain page; requests go only to the app's port on 127.0.0.1.
- The container: the official `node:22-alpine` image, user `node` (not root), all Linux capabilities
  dropped, `no-new-privileges`, 1 GB memory, 1 CPU, 256 processes (installing: 2 GB, 2 CPUs, 512), the
  port published on 127.0.0.1 only, no environment from this computer (only fixed values such as PORT),
  only the copy mounted. Installing may take 10 minutes at most, starting 90 seconds, and an app stops
  after an hour. The server can reach the internet (like any app the user runs); keys never reach it.
- While an app runs, the team's file changes reach its copy (dev servers reload them); changed package
  files restart it. Stop app removes the container; quitting the app removes them all, and leftovers from
  a crash are removed at the next start. The log is shown while it starts and with **Log** while it runs.
- If Docker is missing or not running, the preview says so (Docker Desktop must be installed once).
- Verified: unit tests (the exact `docker run` arguments, the copy, start and stop with a stand-in
  Docker, the proxy, finding apps), and in the real Electron app with a real Docker engine: an Express
  app with an API was installed and run; GET and POST went through the preview; inside the container it
  ran as uid 1000 with no keys; limits and the single mount were checked with `docker inspect`; the
  project folder stayed without `node_modules`; Stop and quitting left no container. In the test
  environment the install step had to reach the registry through its proxy, set with the test-only
  `ORQESTRA_SANDBOX_INSTALL_ARGS`. **Not verified:** Docker Desktop on Windows and macOS (paths and file
  sharing), and apps built by the real models.
- Not yet: the cloud worker (still needs Philip's DigitalOcean account and spending cap), live reload over
  websockets through the preview (pages reload on file changes instead), and apps in other languages.

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
