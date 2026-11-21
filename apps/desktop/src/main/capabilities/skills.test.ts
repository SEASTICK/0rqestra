import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types.js";
import { buildPrompt } from "../providers/history.js";
import { parsePlan } from "../team/plan.js";
import { TeamRun, type TeamEvent } from "../team/runner.js";
import { parseAgents, parseTeamMembers } from "../team/team-service.js";
import { skillsFor, useSkillStore } from "./registry.js";
import { parseSkill, SkillStore } from "./skill-store.js";

// Skills installed on an agent (Capabilities): stored in the app's data, saved against the agent's
// permanent key, loaded only for a task that needs them, and only for an agent that has them.

let dir: string;
let data: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-skills-"));
  data = path.join(dir, "appdata");
});
afterEach(() => {
  useSkillStore(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const SKILL = "---\nname: Swedish copy\ndescription: Writes interface text in plain Swedish.\n---\n# Swedish copy\nAll interface text is in Swedish. Use du, not ni. SKILL-BODY-MARKER\n";

describe("skill store", () => {
  it("reads a SKILL.md's name and description", () => {
    expect(parseSkill(SKILL, "x")).toMatchObject({ name: "Swedish copy", description: "Writes interface text in plain Swedish." });
    expect(parseSkill("# Release notes\n\nWrite release notes.\n", "fallback")).toMatchObject({ name: "Release notes", description: "Write release notes." });
  });

  it("keeps its own copy of a skill folder, so it works after the original is deleted", () => {
    const src = path.join(dir, "download", "swedish-copy");
    fs.mkdirSync(path.join(src, "examples"), { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), SKILL);
    fs.writeFileSync(path.join(src, "examples", "button.md"), "Spara");
    const store = new SkillStore(data);
    const preview = store.stagePath(src);
    expect(preview).toMatchObject({ name: "Swedish copy", existingId: null });
    expect([...preview.files].sort()).toEqual(["SKILL.md", "examples/button.md"]);
    const record = store.install(preview.selectionId);
    fs.rmSync(path.join(dir, "download"), { recursive: true, force: true });
    expect(store.get(record.id)!.instructions).toContain("SKILL-BODY-MARKER");
    expect(fs.existsSync(path.join(data, "skills", record.id, "examples", "button.md"))).toBe(true);
    expect(() => store.install(preview.selectionId)).toThrow(/again/);
  });

  it("saves skills per agent key: survives a restart, a rename and another project; agents with the same name stay apart", () => {
    const store = new SkillStore(data);
    const id = store.install(store.stageText("SKILL.md", SKILL).selectionId).id;
    store.assign("builder-one", id, "Bob");
    // A restart: a new store on the same folder.
    const after = new SkillStore(data);
    expect(after.installedOn("builder-one")).toEqual([id]);
    // Another Builder, also called Bob, has its own key and no skill.
    expect(after.installedOn("builder-two")).toEqual([]);
    // Renaming keeps it (the key is what counts).
    after.assign("builder-one", id, "Robert");
    expect(after.installedOn("builder-one")).toEqual([id]);
    // Removing from one agent keeps it on another.
    after.assign("reviewer-one", id, "Vera");
    after.unassign("builder-one", id);
    expect(after.installedOn("builder-one")).toEqual([]);
    expect(after.installedOn("reviewer-one")).toEqual([id]);
    expect(after.list().map((s) => s.id)).toEqual([id]);
  });

  it("refuses what is not a skill", () => {
    const store = new SkillStore(data);
    fs.mkdirSync(path.join(dir, "empty"));
    expect(() => store.stagePath(path.join(dir, "empty"))).toThrow(/no SKILL.md/);
    expect(() => store.stageText("SKILL.md", "")).toThrow(/empty/);
    expect(() => store.assign("../x", "a", "b")).toThrow(/Unknown agent/);
    expect(() => store.assign("k", "nope", "b")).toThrow(/Unknown skill/);
  });
});

class Recorder implements ProviderAdapter {
  requests: ChatRequest[] = [];
  constructor(readonly id: ProviderId, private readonly answer: (p: string) => string) {}
  async status(): Promise<ProviderStatus> { throw new Error("not used"); }
  chat(request: ChatRequest) {
    this.requests.push(request);
    const q = new EventQueue<ChatEvent>();
    const text = this.answer(request.text);
    setTimeout(() => { q.push({ type: "completed", text, usage: null, limits: [] }); q.end(); }, 1);
    return { events: q, stop: () => { q.push({ type: "cancelled", text: "" }); q.end(); } };
  }
}

describe("skills in a team run", () => {
  function setup(reviewerHasIt: boolean) {
    const store = new SkillStore(data);
    useSkillStore(store);
    const id = store.install(store.stageText("SKILL.md", SKILL).selectionId).id;
    store.assign("key-bob", id, "Bob");
    if (reviewerHasIt) store.assign("key-vera", id, "Vera");
    const agents = parseAgents([
      { id: "bu", name: "Bob", role: "Builder", priority: 1, tool: "codex", model: null, effort: null, agentKey: "key-bob" },
      { id: "rv", name: "Vera", role: "Code Reviewer", priority: 1, tool: "claude", model: null, effort: null, agentKey: "key-vera" },
    ]);
    return { id, agents };
  }
  const plan = (skills: string[]) => parsePlan({ goal: "g", tasks: [{ id: "t1", title: "Buttons", role: "Builder", goal: "Write the buttons.", dependsOn: [], deliverables: ["ui.txt"], handoff: { acceptance: ["Swedish"], ...(skills.length ? { skills } : {}) } }] }, ["Builder", "Code Reviewer"]);
  async function run(p: ReturnType<typeof plan>, agents: ReturnType<typeof parseAgents>) {
    const codex = new Recorder("codex", () => 'Done.\n<orqestra-file path="ui.txt">\nSpara\n</orqestra-file>');
    const claude = new Recorder("claude", () => '<orqestra-review>{"approved": true, "problems": []}</orqestra-review>');
    const events: TeamEvent[] = [];
    await new TeamRun({ plan: p, agents, adapters: { codex, claude }, workspace: dir, cwd: dir, emit: (e) => void events.push(e) }).start();
    return { codex, claude, skills: events.filter((e) => e.type === "skills") as Extract<TeamEvent, { type: "skills" }>[] };
  }

  it("gives the Builder its skill for a task that needs it, and the Reviewer only if it has it too", async () => {
    const { id, agents } = setup(false);
    expect(agents[0]!.skills).toEqual([{ id, name: "Swedish copy", description: "Writes interface text in plain Swedish." }]);
    expect(agents[1]!.skills).toBeUndefined();
    const r = await run(plan([id]), agents);
    expect(r.codex.requests[0]!.text).toContain("### Skill: Swedish copy\n# Swedish copy\nAll interface text is in Swedish.");
    expect(r.claude.requests[0]!.text).not.toContain("SKILL-BODY-MARKER");
    expect(r.skills).toEqual([
      { type: "skills", taskId: "t1", agentId: "bu", kind: "work", loaded: [{ id, name: "Swedish copy" }], refused: [] },
      { type: "skills", taskId: "t1", agentId: "rv", kind: "review", loaded: [], refused: [id] },
    ]);
    const both = setup(true);
    const r2 = await run(plan([both.id]), both.agents);
    expect(r2.claude.requests[0]!.text).toContain("SKILL-BODY-MARKER");
  });

  it("loads nothing for a task that does not name the skill", async () => {
    const { agents } = setup(false);
    const r = await run(plan([]), agents);
    expect(r.codex.requests[0]!.text).not.toContain("SKILL-BODY-MARKER");
    expect(r.skills).toEqual([]);
  });

  it("lets a project add a skill for all its agents, which one agent can switch off (the window leaves it out)", () => {
    const store = new SkillStore(data);
    useSkillStore(store);
    const id = store.install(store.stageText("SKILL.md", SKILL).selectionId).id;
    expect(skillsFor("someone-new", [id]).map((s) => s.id)).toEqual([id]);
    expect(skillsFor("someone-new", [])).toEqual([]);
  });

  it("tells the Manager each agent's skills in one line, not their instructions", () => {
    const { id } = setup(false);
    const team = parseTeamMembers([{ name: "Bob", role: "Builder", ready: true, tool: "codex", agentKey: "key-bob" }, { name: "Vera", role: "Code Reviewer", ready: true, tool: "claude", agentKey: "key-vera" }]);
    const prompt = buildPrompt([], "Build the buttons", team);
    expect(prompt).toContain(`Skills your agents have: Bob (Builder, Codex): ${id} (Writes interface text in plain Swedish.).`);
    expect(prompt).not.toContain("SKILL-BODY-MARKER");
  });
});
