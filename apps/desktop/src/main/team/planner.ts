import { PLAN_FORMAT, PLAN_RULES, teamSection } from "../providers/history";
import type { TeamMember } from "../providers/types";
import type { AgentRef } from "./prompts";

// The Planner turns the Manager's brief into a plan (decision A6). Its answer is read like the
// Manager's own plan used to be, and validated again before it is shown.

export function plannerPrompt(brief: string, planner: AgentRef, team: TeamMember[], existing: string[]): string {
  return [
    `You are ${planner.name}, the Planner in a team of AI agents led by a Manager in the app 0rqestra.`,
    "The Manager has talked with the user and asks you for a plan the team can carry out.",
    `The Manager's brief:\n${brief}`,
    existing.length ? `Files already in the project folder: ${existing.join(", ")}` : "The project folder is empty.",
    [
      "Answer with one short sentence about the plan, then end with it exactly in this form, with nothing after it:",
      PLAN_FORMAT,
      PLAN_RULES,
      "You cannot run tools or commands. Plan only work the agents can do by writing files.",
    ].join("\n"),
    teamSection(team),
  ].join("\n\n");
}

const PLAN = /<orqestra-plan>\s*([\s\S]*?)\s*<\/orqestra-plan>\s*$/;

// The plan as JSON from the end of the Planner's answer, and the sentence before it.
export function extractPlan(text: string): { summary: string; value: unknown } {
  const match = PLAN.exec(text.trim());
  if (!match) throw new Error("The Planner's answer did not end with a plan.");
  let value: unknown;
  try {
    value = JSON.parse(match[1]!);
  } catch {
    throw new Error("The Planner's plan could not be read.");
  }
  return { summary: text.trim().slice(0, match.index).trim().slice(0, 600), value };
}
