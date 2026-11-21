import { SKILL_ID, AGENT_KEY, type SkillStore } from "./skill-store";

// The one skill store of this app session (set when the app starts; tests set their own). Team runs
// and the Manager's prompt read from it through these helpers.

let store: SkillStore | null = null;

export function useSkillStore(s: SkillStore | null): void {
  store = s;
}

export function skillStore(): SkillStore | null {
  return store;
}

export interface SkillSummary { id: string; name: string; description: string }

// From the window: the agent's permanent key and the project's skills that are on for it.
export function parseSkillRefs(raw: Record<string, unknown>): { agentKey?: string; projectSkills?: string[] } {
  const agentKey = typeof raw.agentKey === "string" && AGENT_KEY.test(raw.agentKey) ? raw.agentKey : undefined;
  const projectSkills = Array.isArray(raw.projectSkills) ? raw.projectSkills.filter((s): s is string => typeof s === "string" && SKILL_ID.test(s)).slice(0, 20) : [];
  return { ...(agentKey ? { agentKey } : {}), ...(projectSkills.length ? { projectSkills } : {}) };
}

// What an agent may use: short descriptions only (the full instructions load when a task needs them).
export function skillsFor(agentKey: string | undefined, projectSkills: string[] | undefined): SkillSummary[] {
  if (!store) return [];
  return store.allowedFor(agentKey, projectSkills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description }));
}

export function loadSkill(id: string): { name: string; instructions: string } | null {
  const s = store?.get(id);
  return s ? { name: s.record.name, instructions: s.instructions } : null;
}
