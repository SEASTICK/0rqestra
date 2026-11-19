import { describe, expect, it } from 'vitest';
import { ago, briefsNotice, unsyncedBriefs, bridgeLayout, bridgeSummary, displayName, errorText, inviteLine, linkedTeamProject, memberStatus, linkLine, localName, projectChoices, repoName, selectionMatches, signInTitle, friendGroups, incomingTeamInvites, invitableFriends, outgoingTeamInvites, waitingCount } from './teams-ui.mjs';

describe('Teams page text', () => {
  it('says whether this computer has a linked checkout', () => {
    expect(linkLine(null)).toEqual({ text: 'Not linked on this computer', tone: 'muted' });
    expect(linkLine({ state: 'linked' })).toEqual({ text: 'Linked on this computer', tone: 'good' });
    expect(linkLine({ state: 'mismatch' }).tone).toBe('warn');
  });

  it('describes invites', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(inviteLine({ state: 'pending', expiresAt: '2026-11-21T12:00:00Z' }, now)).toBe('Waiting · expires in 3 days');
    expect(inviteLine({ state: 'pending', expiresAt: '2026-11-18T17:00:00Z' }, now)).toBe('Waiting · expires in 5 h');
    expect(inviteLine({ state: 'used' })).toBe('Accepted');
    expect(inviteLine({ state: 'revoked' })).toBe('Withdrawn');
  });

  it('offers only local projects not linked to another shared project', () => {
    const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    const teams = [{ projects: [{ id: 's1', link: { localProjectId: 'a' } }, { id: 's2', link: null }] }];
    expect(projectChoices(projects, teams).map((p) => p.id)).toEqual(['b', 'c']);
    expect(projectChoices(projects, teams, 's1').map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(localName(projects, 'b')).toBe('B');
    expect(localName(projects, 'zz')).toMatch(/no longer/);
  });

  it('checks a chosen folder against the shared repository', () => {
    const selection = { remotes: [{ identity: { key: 'github.com/a/b' } }, { identity: null }] };
    expect(selectionMatches(selection, 'github.com/a/b')).toBe(true);
    expect(selectionMatches(selection, 'github.com/a/c')).toBe(false);
    expect(selectionMatches(null, 'github.com/a/b')).toBe(false);
    expect(repoName({ owner: 'a', name: 'b' })).toBe('a/b');
  });

  it('titles the sign-in state and cleans IPC errors', () => {
    expect(signInTitle({ status: 'signed_in', email: 'a@x.se' })).toBe('Signed in as a@x.se');
    expect(signInTitle({ status: 'unconfigured' })).toBe('Teams is not set up');
    expect(errorText(new Error("Error invoking remote method 'teams:x': Error: Nope"))).toBe('Nope');
  });
});


describe('Team Bridge', () => {
  const team = { id: 't', name: 'T', members: [{ userId: 'me', email: 'me@x.se' }, { userId: 'ann', email: 'ann.k@x.se' }, { userId: 'bo', email: 'bo@x.se' }], projects: [{ id: 'p', link: { localProjectId: 'local', state: 'linked' } }] };
  const view = (presence) => ({ status: 'signed_in', userId: 'me', teams: [team], presence: { p: presence } });

  it('finds the linked shared project, and nothing for solo projects or signed out', () => {
    expect(linkedTeamProject(view({}), 'local')?.project.id).toBe('p');
    expect(linkedTeamProject(view({}), 'solo')).toBeNull();
    expect(linkedTeamProject({ ...view({}), status: 'signed_out' }, 'local')).toBeNull();
    const broken = { ...view({}), teams: [{ ...team, projects: [{ id: 'p', link: { localProjectId: 'local', state: 'missing' } }] }] };
    expect(linkedTeamProject(broken, 'local')).toBeNull();
  });

  it('shows online, offline and connection problems per person', () => {
    const live = view({ connection: 'live', online: ['ann', 'me'], publishing: true });
    expect(memberStatus(live, 'p', 'ann')).toBe('online');
    expect(memberStatus(live, 'p', 'bo')).toBe('offline');
    expect(memberStatus(live, 'p', 'me')).toBe('online');
    expect(memberStatus(view({ connection: 'live', online: [], publishing: false }), 'p', 'me')).toBe('away');
    expect(memberStatus(view({ connection: 'reconnecting', online: [], publishing: false }), 'p', 'ann')).toBe('reconnecting');
    expect(memberStatus(view({ connection: 'unavailable', online: [], publishing: false }), 'p', 'ann')).toBe('unavailable');
    expect(memberStatus({ ...view({}), presence: {} }, 'p', 'ann')).toBe('connecting');
    expect(bridgeSummary(live, team, team.projects[0])).toBe('1 of 2 teammates online');
    expect(bridgeSummary(view({ connection: 'reconnecting', online: [] }), team, team.projects[0])).toBe('Reconnecting…');
  });

  it('names teammates and lays out the bridge beside the Manager', () => {
    expect(displayName('ann.k@x.se')).toBe('ann.k');
    const layout = bridgeLayout({ x: 100, y: 50 }, 2);
    expect(layout.bridge).toEqual({ x: 414, y: 50 });
    expect(layout.teammates).toEqual([{ x: 728, y: 50 }, { x: 728, y: 239 }]);
    expect(bridgeLayout(null, 1)).toBeNull();
  });
});

describe('work briefs in the bridge', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  it('tells how old an update is', () => {
    expect(ago(now - 20_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago('2026-11-18T09:00:00Z', now)).toBe('3 h ago');
  });
  it('warns that briefs may be out of date when not live', () => {
    expect(briefsNotice({ presence: { p: { connection: 'live' } }, briefsAt: { p: now } }, 'p', now)).toBeNull();
    expect(briefsNotice({ presence: { p: { connection: 'reconnecting' } }, briefsAt: { p: now - 120_000 } }, 'p', now)).toBe('Shown as of 2 min ago. It may be out of date until the connection is back.');
    expect(briefsNotice({ presence: {}, briefsAt: {} }, 'p', now)).toMatch(/not been loaded/);
  });
  it('lists my briefs that have not synced', () => {
    const view = { localBriefs: { p: [{ runId: 'a', sync: 'synced' }, { runId: 'b', sync: 'failed' }, { runId: 'c', sync: 'pending' }] } };
    expect(unsyncedBriefs(view, 'p').map((b) => b.runId)).toEqual(['b', 'c']);
    expect(unsyncedBriefs({}, 'p')).toEqual([]);
  });
});

describe('friends and team invitations', () => {
  const view = {
    status: 'signed_in',
    friends: [
      { requestId: 'r1', userId: 'u1', username: 'zed', state: 'friend' },
      { requestId: 'r2', userId: 'u2', username: 'amy', state: 'friend' },
      { requestId: 'r3', userId: 'u3', username: 'kim', state: 'incoming' },
      { requestId: 'r4', userId: 'u4', username: 'lou', state: 'outgoing' },
    ],
    teamInvites: [
      { id: 'i1', teamId: 't1', teamName: 'Duo', userId: 'u1', username: 'zed', direction: 'outgoing' },
      { id: 'i2', teamId: 't9', teamName: 'Other', userId: 'u5', username: 'max', direction: 'incoming' },
    ],
  };
  it('groups friends, lists what can still be invited, and counts what waits for an answer', () => {
    expect(friendGroups(view).friends.map((f) => f.username)).toEqual(['amy', 'zed']);
    expect(friendGroups(view).incoming.map((f) => f.username)).toEqual(['kim']);
    const team = { id: 't1', members: [{ userId: 'me' }] };
    expect(invitableFriends(view, team).map((f) => f.username)).toEqual(['amy']);
    expect(outgoingTeamInvites(view, team).map((i) => i.username)).toEqual(['zed']);
    expect(incomingTeamInvites(view).map((i) => i.teamName)).toEqual(['Other']);
    expect(waitingCount(view)).toBe(2);
    expect(waitingCount({ status: 'signed_out', friends: view.friends })).toBe(0);
  });
});
