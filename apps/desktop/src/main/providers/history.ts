import type { ChatTurn, TeamMember } from "./types";

// Phase 1 keeps the conversation in 0rqestra and sends recent turns with each message, instead of
// relying on each tool's own session store. That works the same for every provider, survives a
// restart, and lets the user switch model in the middle of a conversation.

export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_HISTORY_CHARS = 24_000;
export const MAX_HISTORY_TURNS = 20;

const PREAMBLE = [
  "You are the Manager in 0rqestra, a desktop app where one Manager leads a team of AI agents.",
  "In this version you answer the user directly in the chat. Reply in the language the user writes in.",
  "Do not claim to have run tools, read files, or contacted other agents.",
  "",
  "Before the team builds something new (an app, a page, a product), ask what you need to know first, like a short form:",
  "2 to 4 multiple-choice questions in one reply, about what changes the plan most (who it is for, the main features,",
  "the look and feel, what to leave out). Ask them once; after the answers, plan. Do not ask when the request is already",
  "clear, when the user asks you to just start, or for a small change to something that exists; then plan directly.",
  "For a single open decision later on, ask one question. Write a short sentence first, then put the questions at the",
  "very end of your reply, exactly in this form, with nothing after it:",
  "<orqestra-question>",
  '{"questions": [{"question": "Who is the app for?", "options": [{"label": "Just me", "description": "A personal log, no accounts."}, {"label": "A small team", "description": "Shared with a coach or friends."}], "recommended": 0}, {"question": "What should it mainly do?", "options": [{"label": "Log gym sessions", "description": "Exercises, sets, reps and weight."}, {"label": "Training programs", "description": "Ready-made plans to follow."}], "recommended": 0}]}',
  "</orqestra-question>",
  "Each question has 2 to 4 options with short labels and one-line descriptions, in the user's language; \"recommended\"",
  "is the index of the option you would choose. The user can also write their own answer or let you decide.",
].join("\n");

// Kept short on purpose: the Manager writes this for every plan, so every word here is paid for in
// each planning call (input) and in what it writes back (output).
export const PLAN_FORMAT = [
  "<orqestra-plan>",
  '{"goal": "A simple workout log", "rules": ["Swedish interface text"], "products": [{"id": "workout-log", "name": "Workout log", "folder": "workout-log"}], "tasks": [' +
    '{"id": "t1", "title": "Build the page", "role": "Builder", "product": "workout-log", "goal": "Concrete instructions.", "dependsOn": [], "deliverables": ["workout-log/index.html"], ' +
    '"handoff": {"decisions": ["Save sets in localStorage"], "acceptance": ["A new set shows in the list", "The list survives a reload"]}}, ' +
    '{"id": "t2", "title": "Style it", "role": "Builder", "product": "workout-log", "goal": "...", "dependsOn": ["t1"], "deliverables": ["workout-log/style.css"], ' +
    '"handoff": {"references": [{"file": "workout-log/index.html", "why": "Its class names"}], "acceptance": ["..."]}}]}',
  "</orqestra-plan>",
].join("\n");

// How the handoff is filled in: each task's agent sees only its own task and handoff.
export const HANDOFF_RULES = [
  "Each agent sees only its own task and handoff, never this chat. In \"handoff\" give only what the goal does not already say:",
  "acceptance (always: how to tell it is done), and when they matter decisions, rules, findings (facts it needs, so no one",
  "redoes research) and references ({\"file\": ...} a file it must read, \"full\": true for the whole file; {\"task\": \"t1\"} an",
  "earlier task's result). Leave out empty fields. Rules for every task go in the plan's \"rules\".",
].join("\n");

// The app previews web products in an isolated frame that can load only the product's own files.
export const WEB_RULES = [
  "A web page or web app is a product the user can preview in the app: give it an index.html (in its own folder when the",
  "project has several products), plain HTML, CSS and JavaScript with relative links, and no build step. It cannot load",
  "anything from the internet (no CDNs, web fonts or APIs), so everything it needs must be in its own files.",
].join("\n");

export const PLAN_RULES = [
  "Rules for a plan: use only roles of agents that can work (listed below), never the Manager; 1 to 8 tasks; every file",
  "in deliverables belongs to exactly one task; use plain relative file names such as index.html or src/app.js; do not add",
  "review tasks, since reviews happen automatically; write each task's goal so an agent can do it without asking.",
  "To change a file that already exists, make it a deliverable and name it in the task's goal; the agent gets its content.",
  HANDOFF_RULES,
  WEB_RULES,
  "Name what the user will see in \"products\" (at most 6; a short lowercase id, a name for the user, and the folder its files",
  "go in) and set \"product\" on each task that builds it; the user sees each product in the tree while the team works.",
  "A plan that only writes documents or code with nothing to look at has no products.",
].join("\n");

const PLANNING = [
  "When the user wants something built or written as files (an app, a page, code, a document) and you know enough,",
  "reply with one or two sentences and end with a plan for your team, exactly in this form, with nothing after it:",
  PLAN_FORMAT,
  PLAN_RULES,
  "The user reads the plan and starts it; nothing runs before that. Never put a question and a plan in the same reply.",
  "If a role the work needs has no working agent, say which role to set up in the tree instead of planning.",
].join("\n");

// Decision A6: when a Planner can work, planning is the Planner's job. The Manager hands over a brief.
const HANDOFF = [
  "Your team has a Planner who can work, and making plans is the Planner's job, not yours. When the user wants something",
  "built or written as files and you know enough, do not write a plan: reply with one or two sentences and end with a",
  "brief for the Planner, exactly in this form, with nothing after it:",
  "<orqestra-plan-request>",
  '{"brief": "What to build and for whom, the requirements, and every decision made with the user so far."}',
  "</orqestra-plan-request>",
  "The user reads the Planner's plan and starts it; nothing runs before that. Never put a question and a brief in the same reply.",
].join("\n");

export function hasWorkingPlanner(team: TeamMember[]): boolean {
  return team.some((m) => m.ready && m.role === "Planner");
}

export function teamSection(team: TeamMember[]): string {
  const working = team.filter((m) => m.ready);
  const notSetUp = team.filter((m) => !m.ready);
  const lines = ["Your team:"];
  lines.push(working.length ? working.map((m) => `- ${m.role}: ${m.name} (can work)`).join("\n") : "- No agent can work yet; no agent in the tree runs on Claude Code or Codex.");
  if (notSetUp.length) lines.push(`Agents without a tool, which cannot work yet: ${notSetUp.map((m) => `${m.name} (${m.role})`).join(", ")}.`);
  return lines.join("\n");
}

// Plain chat stays light (Stage 3): the planning instructions and the plan format are only sent when
// the message asks for work to be done. This is decided in code, from the words of the message,
// with no extra model call. If the guess is wrong and the Manager does need to plan, it answers with
// only this marker, and the app asks it again with the planning instructions (see chat-service.ts).
export const PLAN_NEEDED = "<orqestra-plan-needed/>";

const LIGHT = [
  "You can only talk in this reply. If the user wants files built, written or changed, answer with exactly",
  `${PLAN_NEEDED} and nothing else; the app then asks you again with what you need to plan the work.`,
].join("\n");

const NO_PLAN = /\b(do not|don't|dont|no need to|without)\s+(make|write|create|draw up)?\s*(a\s+|any\s+)?plans?\b|\bno plan\b|\binte\b[^.?!]{0,30}\bplan/i;
const WORK = /\b(build|create|make|write|add|implement|fix|change|update|edit|refactor|rename|remove|delete|generate|code|develop|design|style|translate|draft|bygg|bygga|skapa|skriv|skriva|lägg till|fixa|ändra|uppdatera|ta bort|koda|utveckla|designa|översätt)\b/i;

// Whether a message asks for team work (planning), from its words alone.
export function wantsTeamWork(text: string, history: ChatTurn[] = []): boolean {
  if (NO_PLAN.test(text)) return false;
  if (WORK.test(text)) return true;
  // An answer to the Manager's own multiple-choice question usually continues planning.
  const last = [...history].reverse().find((t) => t.role === "assistant");
  return Boolean(last && last.text.includes("<orqestra-question>"));
}

export function buildPrompt(history: ChatTurn[], text: string, team?: TeamMember[], teamNow?: string | null, mode: "auto" | "plan" = "auto"): string {
  const kept: string[] = [];
  let used = 0;
  for (const turn of history.slice(-MAX_HISTORY_TURNS).reverse()) {
    const line = `${turn.role === "user" ? "User" : "Manager"}: ${turn.text.trim()}`;
    if (used + line.length > MAX_HISTORY_CHARS) break;
    kept.unshift(line);
    used += line.length;
  }
  const parts = [PREAMBLE];
  if (team && team.length) {
    const plan = mode === "plan" || wantsTeamWork(text, history);
    parts.push(plan ? (hasWorkingPlanner(team) ? HANDOFF : PLANNING) : LIGHT, teamSection(team));
  }
  if (teamNow) parts.push(teamNow);
  if (kept.length) parts.push(`Conversation so far:\n${kept.join("\n\n")}`);
  parts.push(`User: ${text.trim()}`);
  return parts.join("\n\n");
}
