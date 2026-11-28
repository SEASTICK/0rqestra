import { describe, expect, it } from 'vitest';
import { accessText, connectorCatalog, folderTest, providerOf, searchConnectors, searchSkills, skillRows } from './capabilities-ui.mjs';

const library = [
  { id: 's1', name: 'Code review', description: 'Checks pull requests' },
  { id: 's2', name: 'Testing', description: 'Writes unit tests for code' },
  { id: 's3', name: 'Docs', description: 'Writes documentation' },
];

describe('skills on an agent', () => {
  it('lists installed skills first, then project skills, with source and status in words', () => {
    const rows = skillRows(library, ['s1'], ['s1', 's2', 'gone'], ['s2']);
    expect(rows.map((r) => [r.id, r.source, r.status, r.sourceText, r.statusText])).toEqual([
      ['s1', 'agent', 'on', 'Installed on this agent', 'On'],
      ['s2', 'project', 'off', 'From this project', 'Off for this agent'],
      ['gone', 'project', 'missing', 'From this project', 'Not on this computer'],
    ]);
  });

  it('searches every word, names first, and marks what the agent already has', () => {
    expect(searchSkills(library, 'code', ['s1']).map((s) => [s.id, s.alreadyOn])).toEqual([['s1', true], ['s2', false]]);
    expect(searchSkills(library, 'writes tests', []).map((s) => s.id)).toEqual(['s2']);
    expect(searchSkills(library, '', []).map((s) => s.id)).toEqual(['s1', 's3', 's2']);
    expect(searchSkills(library, 'nothing here', [])).toEqual([]);
  });
});

describe('connectors for an agent', () => {
  const node = { agentKey: 'builder-1', name: 'Builder', agent: { tool: 'claude' } };
  const access = { folders: [{ id: 'f1', path: 'C:/code/app', available: true, write: true }], agents: {} };

  it('offers project folders as ready, and GitHub and MCP as unavailable with a reason', () => {
    const [folders, github, mcp] = connectorCatalog({ node, access, github: { signedIn: true, account: 'octo' }, projectName: 'Shop' });
    expect(folders).toMatchObject({ id: 'folders', state: 'ready', attached: false, next: { action: 'review' }, account: 'Your user account on this computer', resources: [{ label: 'C:/code/app', ok: true }] });
    expect(github).toMatchObject({ state: 'unavailable', next: null });
    expect(github.description).toContain('octo');
    expect(github.why).toMatch(/Claude Code runs without network/);
    expect(mcp).toMatchObject({ state: 'unavailable', next: { action: 'advanced' } });
  });

  it('says what is needed first: an AI tool, a folder, or a reachable folder', () => {
    expect(connectorCatalog({ node: { ...node, agent: null }, access })[0]).toMatchObject({ state: 'unavailable', next: { action: 'configure' } });
    expect(connectorCatalog({ node, access: { folders: [], agents: {} } })[0]).toMatchObject({ state: 'needs_setup', stateText: 'Needs a folder', next: { action: 'connect_folder' } });
    expect(connectorCatalog({ node, access: { folders: [{ path: 'X', available: false }], agents: {} } })[0]).toMatchObject({ state: 'needs_setup', stateText: 'Folder not found' });
    expect(connectorCatalog({ node, access, github: { signedIn: false } })[1].next).toMatchObject({ action: 'github_sign_in' });
  });

  it('shows an attached connection with what the agent may do, and finds connectors by search', () => {
    const withAccess = { ...access, agents: { 'builder-1': { read: true, write: true, commands: false } } };
    const [folders] = connectorCatalog({ node, access: withAccess });
    expect(folders).toMatchObject({ attached: true, actions: 'Read files, propose changes you review', next: { action: 'manage' } });
    expect(providerOf(node)).toEqual({ id: 'claude', name: 'Claude Code' });
    expect(searchConnectors(connectorCatalog({ node, access }), 'git').map((c) => c.id)).toEqual(['github']);
    expect(accessText({ read: true, write: true, commands: true })).toBe('Read files, propose changes you review, run approved checks');
  });

  it('tests the folder connection: reachable folders and the allowed actions', () => {
    const agents = { 'builder-1': { read: true, write: false, commands: false } };
    expect(folderTest({ ...access, agents }, 'builder-1')).toEqual({ ok: true, text: '1 of 1 folder reachable. Allowed: Read files.' });
    expect(folderTest({ folders: [{ path: 'C:/x', available: false }], agents }, 'builder-1')).toEqual({ ok: false, text: 'Cannot reach C:/x.' });
    expect(folderTest(access, 'builder-1').ok).toBe(false);
  });
});
