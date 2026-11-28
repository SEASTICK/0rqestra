// Pure helpers for an agent's Capabilities tab (Capabilities.jsx): which skills an agent has and
// where they come from, the skill picker's search, and the connectors an agent can use with their
// state and next action. Free of React and Electron, so they are unit-tested.

export const PROVIDER_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };

export function providerOf(node) {
  const tool = node?.agent?.tool;
  return PROVIDER_NAME[tool] ? { id: tool, name: PROVIDER_NAME[tool] } : null;
}

// The agent's skills: installed on the agent (follow it everywhere), then the project's (each agent
// may turn one off). status: 'on', 'off' (for this agent) or 'missing' (not on this computer).
export function skillRows(library, installed, projectSkills, skillsOff) {
  const byId = new Map((library || []).map((s) => [s.id, s]));
  const off = new Set(skillsOff || []);
  const mine = new Set(installed || []);
  const row = (id, source) => {
    const s = byId.get(id);
    const status = !s ? 'missing' : source === 'project' && off.has(id) ? 'off' : 'on';
    return {
      id, source, status,
      name: s?.name || id,
      description: s?.description || '',
      sourceText: source === 'agent' ? 'Installed on this agent' : 'From this project',
      statusText: status === 'on' ? 'On' : status === 'off' ? 'Off for this agent' : 'Not on this computer',
    };
  };
  return [
    ...[...mine].map((id) => row(id, 'agent')),
    ...(projectSkills || []).filter((id) => !mine.has(id)).map((id) => row(id, 'project')),
  ];
}

// The picker: imported skills matching every word of the search (name first, then description),
// marking the ones this agent already has.
export function searchSkills(library, query, installed) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const mine = new Set(installed || []);
  const score = (s) => {
    const name = String(s.name || '').toLowerCase();
    const text = `${name} ${String(s.description || '').toLowerCase()}`;
    if (!words.every((w) => text.includes(w))) return -1;
    return words.filter((w) => name.includes(w)).length;
  };
  return (library || [])
    .map((s) => ({ skill: s, score: score(s) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || String(a.skill.name).localeCompare(String(b.skill.name)))
    .map((x) => ({ ...x.skill, alreadyOn: mine.has(x.skill.id) }));
}

const READ_ONLY = { read: true, write: false, commands: false };

export function accessText(access) {
  if (!access?.read) return 'No access';
  const parts = ['Read files'];
  if (access.write) parts.push('propose changes you review');
  if (access.commands) parts.push('run approved checks');
  return parts.join(', ');
}

// The connectors this agent could use, with their state and the next action:
// 'ready', 'needs_setup' (sign in or connect something first) or 'unavailable' (with why).
// Only "Project folders" has a working integration that 0rqestra limits to one agent today.
export function connectorCatalog({ node, access, github, projectName }) {
  const provider = providerOf(node);
  const folders = access?.folders || [];
  const reachable = folders.filter((f) => f.available !== false);
  const agentAccess = (node?.agentKey && access?.agents?.[node.agentKey]) || null;
  const attached = Boolean(agentAccess?.read);
  const folderEntry = {
    id: 'folders',
    name: 'Project folders',
    description: `Folders granted to ${projectName || 'this project'} on this computer. The app reads and applies files for the agent, within the access you choose.`,
    attached,
    account: 'Your user account on this computer',
    resources: folders.map((f) => ({ label: f.path, ok: f.available !== false, problem: f.problem || null })),
    actions: attached ? accessText(agentAccess) : 'Read files (you can allow more)',
    defaultAccess: agentAccess || READ_ONLY,
  };
  if (!provider) Object.assign(folderEntry, { state: 'unavailable', stateText: 'Unavailable', why: 'This agent has no AI tool yet. Choose Claude Code, Codex or Gemini in its settings first.', next: { label: 'Configure agent', action: 'configure' } });
  else if (!folders.length) Object.assign(folderEntry, { state: 'needs_setup', stateText: 'Needs a folder', why: 'No folder is connected to this project yet.', next: { label: 'Connect a folder', action: 'connect_folder' } });
  else if (!reachable.length) Object.assign(folderEntry, { state: 'needs_setup', stateText: 'Folder not found', why: 'The granted folders cannot be reached on this computer.', next: { label: 'Manage folders', action: 'connect_folder' } });
  else Object.assign(folderEntry, { state: 'ready', stateText: 'Ready', why: null, next: attached ? { label: 'Manage', action: 'manage' } : { label: 'Review and add', action: 'review' } });

  const signedIn = Boolean(github?.signedIn);
  const githubEntry = {
    id: 'github', name: 'GitHub', attached: false,
    description: signedIn ? `Your GitHub account${github.account ? ` (${github.account})` : ''} is connected on this computer for cloning, and for committing and pushing what you approved.` : 'Used on this computer to clone repositories and to commit and push what you approved.',
    state: 'unavailable', stateText: 'Unavailable for agents',
    why: `Agents cannot use GitHub themselves yet: ${provider?.name || 'the agent'} runs without network or tools in 0rqestra, so access could not be limited to this agent. You commit and push yourself after reviewing changes.`,
    next: signedIn ? null : { label: 'Sign in to GitHub (for you)', action: 'github_sign_in' },
  };
  const mcpEntry = {
    id: 'mcp', name: 'MCP servers', attached: false,
    description: `Tools added to ${provider?.name || 'the AI tool'} with its own setup commands.`,
    state: 'unavailable', stateText: 'Unavailable for one agent',
    why: `An MCP server added with ${provider?.name || 'a tool'}'s own commands applies to every agent on this computer that uses it, and 0rqestra starts agents without tools, so it could not be limited to this agent.`,
    next: { label: 'Advanced setup', action: 'advanced' },
  };
  return [folderEntry, githubEntry, mcpEntry];
}

export function searchConnectors(catalog, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return catalog;
  return catalog.filter((c) => `${c.name} ${c.description}`.toLowerCase().includes(q));
}

// The result of "Test": every granted folder reachable now, and what the agent may do there.
export function folderTest(access, agentKey) {
  const folders = access?.folders || [];
  const agent = (agentKey && access?.agents?.[agentKey]) || null;
  const bad = folders.filter((f) => f.available === false);
  if (!agent?.read) return { ok: false, text: 'This agent has no access to the project folders.' };
  if (!folders.length) return { ok: false, text: 'No folder is connected to this project.' };
  if (bad.length === folders.length) return { ok: false, text: `Cannot reach ${bad.map((f) => f.path).join(', ')}.` };
  return { ok: bad.length === 0, text: `${folders.length - bad.length} of ${folders.length} ${folders.length === 1 ? 'folder' : 'folders'} reachable. Allowed: ${accessText(agent)}.${bad.length ? ` Not found: ${bad.map((f) => f.path).join(', ')}.` : ''}` };
}
