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
  "When a decision from the user would clearly change what you do (for example what an app should mainly do, or",
  "which of a few directions to take), ask ONE multiple-choice question instead of guessing. Write a short",
  "sentence first, then put the question at the very end of your reply, exactly in this form, with nothing after it:",
  "<orqestra-question>",
  '{"question": "What should the app mainly help you with?", "options": [{"label": "Log gym sessions", "description": "Exercises, sets, reps and weight."}, {"label": "Training programs", "description": "Ready-made plans to follow."}], "recommended": 0}',
  "</orqestra-question>",
  "Use 2 to 4 options with short labels and one-line descriptions, in the user's language. \"recommended\" is the",
  "index of the option you would choose. Ask at most one question per reply, and none when the request is already clear.",
].join("\n");

export const PLAN_FORMAT = [
  "<orqestra-plan>",
  '{"goal": "A simple workout log in the browser", "tasks": [{"id": "t1", "title": "Build the page", "role": "Builder", "goal": "Concrete instructions for the agent.", "dependsOn": [], "deliverables": ["index.html"]}, {"id": "t2", "title": "Style it", "role": "Builder", "goal": "...", "dependsOn": ["t1"], "deliverables": ["style.css"]}]}',
  "</orqestra-plan>",
].join("\n");

export const PLAN_RULES = [
  "Rules for a plan: use only roles of agents that can work (listed below), never the Manager; 1 to 8 tasks; every file",
  "in deliverables belongs to exactly one task; use plain relative file names such as index.html or src/app.js; do not add",
  "review tasks, since reviews happen automatically; write each task's goal so an agent can do it without asking.",
  "To change a file that already exists, make it a deliverable and name it in the task's goal; the agent gets its content.",
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
  const demo = team.filter((m) => !m.ready);
  const lines = ["Your team:"];
  lines.push(working.length ? working.map((m) => `- ${m.role}: ${m.name} (can work)`).join("\n") : "- No agent can work yet; every agent in the tree is a demo agent.");
  if (demo.length) lines.push(`Demo agents that cannot work yet: ${demo.map((m) => `${m.name} (${m.role})`).join(", ")}.`);
  return lines.join("\n");
}

export function buildPrompt(history: ChatTurn[], text: string, team?: TeamMember[]): string {
  const kept: string[] = [];
  let used = 0;
  for (const turn of history.slice(-MAX_HISTORY_TURNS).reverse()) {
    const line = `${turn.role === "user" ? "User" : "Manager"}: ${turn.text.trim()}`;
    if (used + line.length > MAX_HISTORY_CHARS) break;
    kept.unshift(line);
    used += line.length;
  }
  const parts = [PREAMBLE];
  if (team && team.length) parts.push(hasWorkingPlanner(team) ? HANDOFF : PLANNING, teamSection(team));
  if (kept.length) parts.push(`Conversation so far:\n${kept.join("\n\n")}`);
  parts.push(`User: ${text.trim()}`);
  return parts.join("\n\n");
}
