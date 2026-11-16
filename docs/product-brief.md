# WorkTreeAI — Product Brief

Status: Stage 1 product decisions agreed in conversation. This document records those
decisions; it is not a description of implemented functionality. See
[`WorkTreeAI stages.txt`](../WorkTreeAI%20stages.txt) for the Stage 1 checklist this brief
supports (items 1–5, 7, 8).

## 1. Target users

Developers building software with the help of multiple AI agents, who want to:

- Run more than one AI coding tool against the same local project in a coordinated way.
- Assign different roles (planning, building, review, testing, security) to different
  agents/models instead of one general-purpose assistant doing everything.
- Keep a single point of conversation and oversight instead of switching between several
  CLIs/chats themselves.

## 2. Core workflow

1. **Open project** — the user points WorkTreeAI at an existing local project folder.
2. **Configure tree** — the user edits a visual tree of agents (starting from an editable
   example tree), setting each agent's role, provider, model, instructions, tool permissions,
   and usage limits.
3. **Prompt the Manager** — the user's only conversational input goes to the Manager agent.
4. **Delegate** — the Manager interprets the request, assigns work to configured agents
   according to the tree's permitted connections, and tracks progress.
5. **Review** — agent activity (what each agent is doing, its outputs) is visible to the user
   as it happens.
6. **Report** — the Manager relays results, questions, and final summaries back to the user.
   All user-facing communication is through the Manager; specialist agents don't address the
   user directly.

## 3. Manager and specialist roles

**Manager** — the user's sole conversation partner.

- Analyses incoming prompts to decide how to route the work.
- Delegates detailed planning and specialist work to configured agents; does not write code,
  review code, or solve specialist problems itself.
- Tracks task progress and passes results between agents.
- Follows only the tree's permitted connections; never silently creates agents or changes
  models.
- Runs work automatically within configured permissions.
- Escalates to the user when: a required role is missing, a decision needs user input, or a
  retry limit is reached.
- Pauses only the affected task(s) on escalation — independent work elsewhere in the tree may
  continue.

**App-provided specialist roles** (selectable, and a user may add multiple agents with the
same role):

| Role | Responsibility |
|---|---|
| Planner | Breaks a request into a concrete plan/task list for other agents. |
| Builder | Implements code changes. |
| Code Reviewer | Reviews changes for correctness, quality, and maintainability. |
| Debugger | Investigates and fixes defects. |
| Tester | Writes/runs tests and verifies behavior. |
| Security Reviewer | Reviews changes for security issues. |

Users can customize the tree beyond these defaults: rename, reconfigure, add multiple agents
per role, and edit each agent's instructions.

## 4. Configurable node settings

Every agent node in the tree has:

- **Name** and **role**.
- **Provider** and **model** (e.g. which CLI/provider and which model it uses).
- **Editable instructions** (the agent's system/role prompt).
- **Permitted tools and project access** (what the agent is allowed to touch or run).
- **Usage limits** (bounds on cost/calls/retries, exact mechanism TBD in later stages).

## 5. Tree connections, delegation, and routing rules

- The tree defines **permitted connections** between agents; the Manager may only delegate
  along edges that exist in the tree.
- **Delegation**: the Manager sends planning/specialist work to the agent(s) configured for
  that purpose (e.g. a Planner for breaking down work, a Builder for implementation).
- **Problem routing**: if a problem surfaces (e.g. a bug, a security concern), it is routed to
  the specialist role configured to handle it (Debugger, Security Reviewer, etc.), not solved
  ad hoc by whichever agent found it.
- **Manager-only communication**: regardless of which agents are active or what they produce,
  all user-facing questions and final results pass through the Manager. Agent activity is
  visible as a transparency/monitoring feed, not as a second channel the user is expected to
  respond to.
- **Escalation**: missing roles, decisions requiring user input, and exhausted retry limits are
  surfaced by the Manager to the user; unaffected work continues rather than blocking the
  whole tree.

**Confirmed by the user on 2026-11-16:**

- **"+" adds a connected child agent.** Clicking **+** beside a node adds a new child agent with
  the role, provider, and model the user chooses, automatically connected by an edge from that
  node to the new child.
- **Same-role selection.** Among eligible agents with the same role, the highest-priority idle
  agent is selected.
- **Implicit correction returns** (decision A1). If you draw `Builder → Reviewer`, the
  Reviewer's findings can go back to the Builder for fixes without a drawn return arrow.
- **Ask before finishing unverified work** (decision A2). When no reviewer or tester can check
  finished work, the Manager asks first: add one, or finish as "Completed — unverified".
- **Approve, then continue** (decision A3). An agent added while a request is paused joins that
  request only after you approve a summary of the change. The request then continues once none
  of its tasks are running; finished results are kept.
- **Snapshot per request** (decision A4). A running request keeps the tree it started with.
  Your edits apply to new requests only, unless you apply them through the approved flow above.
- **Limits** (decision A5). Default limits: 25 agent runs per request (retries and fix rounds
  count), 2 retries, 3 review rounds, 3 retries after a provider outage, 50 Manager turns. At
  the request limit, running work finishes, waiting work pauses, and the Manager asks you.
- **Plan first** (decision A6). When a Planner is connected, every building or debugging request
  goes to it first. With no Planner connected, the Manager asks once whether to add one or
  proceed without a plan.
- **Same-role details** (decision A7). Priority always wins, even if your prompt names another
  agent; to steer work, change priorities in the tree. An agent added with "+" gets the lowest
  priority in its role. When every agent with the needed role is busy, new work waits for the
  top-priority one.
- **"+" picker starts empty** (decision A8). Role, provider, and model start unselected, and you
  choose all three before adding the agent.

The rules above are the agreed ones. Precise semantics for them are **proposed, not agreed**, in
[`tree-routing-and-permissions.md`](tree-routing-and-permissions.md). They cover:

- exactly one Manager;
- what an edge authorizes, and whether `Manager → Builder → Reviewer` lets the Manager dispatch
  the Reviewer;
- engine-owned IDs and provenance checks;
- what happens if the top-priority agent becomes unavailable while work waits for it;
- the three permission enforcement layers;
- process ownership and cancellation.

Each has labelled alternatives. None of these is approved yet.

## 7. Distribution

**Agreed:** WorkTreeAI is released publicly as open source.

**Pending, separate decision:** which license to use (for example MIT or Apache-2.0). No LICENSE
file exists until the user chooses.

## 8. High-level structure (decisions vs. proposals)

**Agreed:**

- WorkTreeAI ships as a **Windows PC app and a macOS app** (both full desktop targets from the
  start), plus a **future iOS companion** for monitoring/controlling a connected desktop
  runner. It is not a Mac-only or Windows-only product.
- The system is composed of: a **desktop UI**, a **local orchestration engine** (runs on the
  user's machine, drives the tree, routes work), **provider adapters** (one per supported CLI
  tool, e.g. Codex CLI, Claude Code CLI), and, later, an **iOS companion** that talks to a
  desktop runner rather than running agents itself.
- AI inference happens with the providers (OpenAI, Anthropic, etc.); WorkTreeAI coordinates
  tasks, context, permissions, and results — it does not run its own models.
- Cloud execution of agents is explicitly out of scope for the initial version; the CLIs and
  project operations run on the user's own Windows PC or Mac.

**Agreed 2026-11-16:** the desktop technology stack is **Electron + TypeScript + React**. The
iOS companion will be a separate client of the engine's API.

**Proposed, not yet agreed** (see `docs/architecture.md`):

- Storage format, event contract details, and the companion's transport.
- Provider credential posture: subscription sign-in stays inside each provider's own CLI.
  WorkTreeAI stores only API keys that the user explicitly gives it, in the OS secret store.

## Related documents

- [`docs/provider-integrations.md`](provider-integrations.md) — Stage 1 item 6.
- [`docs/architecture.md`](architecture.md) — Stage 1 items 8–9.
- [`docs/tree-routing-and-permissions.md`](tree-routing-and-permissions.md) — proposed
  semantics for item 5's rules.
- [`docs/acceptance-criteria.md`](acceptance-criteria.md) — Stage 1 item 10.
