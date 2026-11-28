import { describe, expect, it } from 'vitest';
import { ago, briefsNotice, unsyncedBriefs, bridgeLayout, bridgeSummary, displayName, errorText, inviteLine, linkedTeamProject, memberStatus, linkLine, localName, projectChoices, repoName, selectionMatches, signInTitle, friendGroups, incomingTeamInvites, invitableFriends, outgoingTeamInvites, waitingCount, friendLabel, candidateState, sendOutcomeText, togetherChoices, projectInvitesWith, incomingProjectInvites, projectsTogether, togetherStatus, bridgeBackend, checklistProgress, checklistItems, checklistRunState, planPrompt, claimText, initialsOf, friendsTabCounts, friendsLayout, friendStatus, shareOptions } from './teams-ui.mjs';

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

describe('adding friends', () => {
  it('shows display names with usernames, never emails, and only when they add something', () => {
    expect(friendLabel({ username: 'bob_user', displayName: 'Bob Builder' })).toEqual({ name: 'Bob Builder', handle: '@bob_user' });
    expect(friendLabel({ username: 'bob_user', displayName: 'BOB_USER' })).toEqual({ name: '@bob_user', handle: '' });
    expect(friendLabel({ username: 'bob_user', displayName: null })).toEqual({ name: '@bob_user', handle: '' });
  });

  it('offers the right action for a found person and words every send outcome', () => {
    expect(candidateState({ relation: 'none' }).action).toBe('send');
    expect(candidateState({ relation: 'incoming' })).toEqual({ text: 'They already sent you a friend request.', action: 'accept' });
    expect(candidateState({ relation: 'friend' })).toEqual({ text: 'You are already friends.', action: null });
    expect(candidateState({ relation: 'outgoing' }).action).toBe(null);
    expect(candidateState({ relation: 'self' }).action).toBe(null);
    expect(sendOutcomeText('sent', 'bob').text).toBe('Friend request sent to @bob.');
    expect(sendOutcomeText('already_pending', 'bob').text).toMatch(/already sent @bob a request/);
    expect(sendOutcomeText('already_friends', 'bob').text).toMatch(/already friends/);
    expect(sendOutcomeText('incoming_pending', 'bob').text).toMatch(/Accept it/);
    expect(sendOutcomeText('accepted', 'bob').tone).toBe('ok');
  });
});

import { MAX_WORK_SHOWN, personBoxes } from './teams-ui.mjs';
describe('People on the Team Bridge', () => {
  const linked = {
    team: { members: [{ userId: 'f', name: 'friend', role: 'member' }, { userId: 'me', name: 'seastick', role: 'owner' }, { userId: 'a', name: 'anna@example.com', role: 'member' }] },
    project: { id: 'p', briefs: [
      { id: 'b1', runId: 'r1', title: 'Fix login', status: 'in_progress', authorId: 'f', updatedAt: '2026-11-26T10:00:00Z' },
      { id: 'b2', runId: 'r2', title: 'Old work', status: 'completed', authorId: 'f', updatedAt: '2026-11-26T11:00:00Z' },
      { id: 'b3', runId: 'r3', title: 'Tests', status: 'blocked', authorId: 'f', updatedAt: '2026-11-26T12:00:00Z' },
      { id: 'b4', runId: 'r4', title: 'Docs', status: 'in_progress', authorId: 'f', updatedAt: '2026-11-26T09:00:00Z' },
      { id: 'b5', runId: 'r5', title: 'My synced run', status: 'in_progress', authorId: 'me', updatedAt: '2026-11-26T08:00:00Z' },
    ] },
  };
  const view = {
    userId: 'me',
    presence: { p: { connection: 'live', online: ['f'], publishing: true } },
    localBriefs: { p: [
      { runId: 'r5', title: 'My synced run', status: 'in_progress', updatedAt: 1, sync: 'synced' },
      { runId: 'r9', title: 'My new run', status: 'in_progress', updatedAt: Date.parse('2026-11-26T13:00:00Z'), sync: 'pending' },
      { runId: 'r8', title: 'Finished', status: 'completed', updatedAt: 2, sync: 'pending' },
    ] },
  };

  it('puts you first, then the others by name, with role and online status', () => {
    const people = personBoxes(view, linked);
    expect(people.map((p) => [p.name, p.you, p.owner, p.status])).toEqual([['seastick', true, true, 'online'], ['anna', false, false, 'offline'], ['friend', false, false, 'online']]);
  });

  it('shows each person only their active work, newest first, with how many more', () => {
    const [me, anna, friend] = personBoxes(view, linked);
    expect(friend.work.map((w) => w.title)).toEqual(['Tests', 'Fix login']);
    expect(friend.work).toHaveLength(MAX_WORK_SHOWN);
    expect(friend.more).toBe(1);
    expect(anna.work).toEqual([]);
    // Your own run that the server does not have yet shows from this computer, marked; a synced one once.
    expect(me.work).toEqual([{ id: 'local-r9', title: 'My new run', status: 'in_progress', unsynced: true }, { id: 'b5', title: 'My synced run', status: 'in_progress', unsynced: false }]);
  });

  it('shows nothing without a linked project', () => {
    expect(personBoxes(view, null)).toEqual([]);
    expect(personBoxes(null, linked)).toEqual([]);
  });
});

describe('starting a project together', () => {
  const me = 'me';
  const view = {
    status: 'signed_in', userId: me,
    teams: [
      { id: 't1', name: 'Solo', isOwner: true, members: [{ userId: me }], projects: [{ id: 'p1', name: 'Alpha', repo: { owner: 'o', name: 'alpha', key: 'k1' }, link: { state: 'linked' } }] },
      { id: 't2', name: 'Big', isOwner: true, members: [{ userId: me }], projects: [{ id: 'p2', name: 'Beta', repo: { owner: 'o', name: 'b' } }, { id: 'p3', name: 'Gamma', repo: { owner: 'o', name: 'g' } }] },
      { id: 't3', name: 'Theirs', isOwner: false, members: [{ userId: me }], projects: [{ id: 'p4', name: 'Delta', repo: { owner: 'o', name: 'd' } }] },
      { id: 't4', name: 'Duo', isOwner: true, members: [{ userId: me }, { userId: 'f' }], projects: [{ id: 'p5', name: 'Epsilon', repo: { owner: 'o', name: 'e' }, link: null }] },
      { id: 't5', name: 'Wait', isOwner: true, members: [{ userId: me }], projects: [{ id: 'p6', name: 'Zeta', repo: { owner: 'o', name: 'z' } }] },
    ],
    projectInvites: [
      { id: 'i1', projectId: 'p6', userId: 'f', direction: 'outgoing', projectName: 'Zeta' },
      { id: 'i2', projectId: 'p9', userId: 'g', direction: 'incoming', projectName: 'Other' },
    ],
    presence: { p5: { connection: 'live', online: ['f'] } },
  };

  it('offers only projects alone in a team I own, and says why the others cannot be offered', () => {
    const choices = togetherChoices(view, 'f');
    expect(choices.filter((c) => c.ok).map((c) => c.name)).toEqual(['Alpha']);
    expect(choices.find((c) => c.name === 'Beta').reason).toMatch(/other projects/);
    expect(choices.find((c) => c.name === 'Zeta').reason).toBe('Invitation pending');
    expect(choices.map((c) => c.name)).not.toContain('Delta');
    expect(choices.map((c) => c.name)).not.toContain('Epsilon');
  });

  it('lists pending invitations by friend and direction, and the projects we share', () => {
    expect(projectInvitesWith(view, 'f', 'outgoing').map((i) => i.id)).toEqual(['i1']);
    expect(incomingProjectInvites(view).map((i) => i.id)).toEqual(['i2']);
    expect(projectsTogether(view, 'f').map((x) => x.project.name)).toEqual(['Epsilon']);
    expect(incomingProjectInvites({ ...view, status: 'signed_out' })).toEqual([]);
  });

  it('keeps membership, presence and my checkout readiness apart', () => {
    const [{ project }] = projectsTogether(view, 'f');
    expect(togetherStatus(view, project, 'f')).toEqual({ presence: 'online', myCheckout: 'needs setup' });
    expect(togetherStatus(view, view.teams[0].projects[0], 'f')).toEqual({ presence: 'unknown', myCheckout: 'ready' });
  });
});

describe('bridge backend', () => {
  it('names Supabase by project ref and never shows more than the host', () => {
    expect(bridgeBackend('https://abcd.supabase.co')).toBe('Supabase (abcd)');
    expect(bridgeBackend('http://localhost:54321')).toBe('localhost:54321');
    expect(bridgeBackend(null)).toBe('No 0rqestra server configured');
  });
});

describe('shared checklist', () => {
  const item = (o) => ({ id: o.id, projectId: 'p', title: o.title || o.id, notes: o.notes || '', status: o.status || 'todo', assigneeId: o.assigneeId ?? null, archived: Boolean(o.archived), runId: o.runId ?? null, run: o.run ?? null, updatedAt: o.updatedAt || '2026-11-27T10:00:00Z' });
  const view = { userId: 'me', checklist: { p: { items: [
    item({ id: 'a', status: 'done' }),
    item({ id: 'b', status: 'blocked', assigneeId: 'me' }),
    item({ id: 'c', status: 'todo', updatedAt: '2026-11-27T09:00:00Z' }),
    item({ id: 'd', status: 'todo', updatedAt: '2026-11-27T11:00:00Z', assigneeId: 'f' }),
    item({ id: 'e', status: 'in_progress', assigneeId: 'me' }),
    item({ id: 'z', status: 'done', archived: true }),
  ] } } };

  it('counts progress over active items and orders blocked, in progress, to do, done', () => {
    expect(checklistProgress(view, 'p')).toEqual({ done: 1, total: 5 });
    expect(checklistItems(view, 'p').map((i) => i.id)).toEqual(['b', 'e', 'd', 'c', 'a']);
    expect(checklistItems(view, 'p', { mine: true }).map((i) => i.id)).toEqual(['b', 'e']);
    expect(checklistItems(view, 'p', { archived: true }).map((i) => i.id)).toEqual(['z']);
    expect(checklistProgress({}, 'p')).toEqual({ done: 0, total: 0 });
  });

  it('shows a linked run from this computer or from its brief, and offers Mark done only when it finished', () => {
    expect(checklistRunState(item({ id: 'x' }))).toBeNull();
    expect(checklistRunState(item({ id: 'x', runId: 'r1' }), [{ id: 'r1', status: 'done', goal: 'Build' }])).toMatchObject({ label: 'Finished', finished: true });
    expect(checklistRunState(item({ id: 'x', runId: 'r2', run: { status: 'failed', outcome: 'Tests failed', title: 'T' } }))).toMatchObject({ label: 'Failed', outcome: 'Tests failed', finished: false });
    expect(checklistRunState(item({ id: 'x', runId: 'r3', run: { status: 'completed', outcome: null, title: 'T' } })).finished).toBe(true);
    expect(checklistRunState(item({ id: 'x', runId: 'r4' })).label).toBe('Run not shared yet');
  });

  it('carries the title and notes into the Manager, and names who claimed first', () => {
    expect(planPrompt({ title: ' Login page ', notes: 'Use the design' })).toBe('Plan this task from our shared checklist: Login page\n\nNotes: Use the design');
    expect(planPrompt({ title: 'Docs', notes: '' })).toBe('Plan this task from our shared checklist: Docs');
    const nameOf = (id) => ({ f: 'friend' })[id];
    expect(claimText({ outcome: 'taken', assigneeId: 'f' }, nameOf)).toBe('friend claimed it first.');
    expect(claimText({ outcome: 'claimed' }, nameOf)).toBe('It is yours now.');
  });
});

describe('friends page layout', () => {
  it('makes initials from the display name or the username', () => {
    expect(initialsOf({ displayName: 'Bob Builder', username: 'bob' })).toBe('BB');
    expect(initialsOf({ username: 'anna_k' })).toBe('AK');
    expect(initialsOf({ username: 'zed' })).toBe('ZE');
    expect(initialsOf({})).toBe('?');
  });

  it('counts what needs an answer on each tab', () => {
    const view = { status: 'signed_in', friends: [{ requestId: 'r', userId: 'u', username: 'x', state: 'incoming' }, { requestId: 's', userId: 'v', username: 'y', state: 'outgoing' }], teamInvites: [{ id: 't', direction: 'incoming' }], projectInvites: [{ id: 'p', direction: 'incoming' }, { id: 'q', direction: 'outgoing' }] };
    expect(friendsTabCounts(view)).toEqual({ friends: 0, requests: 1, invites: 2 });
    expect(friendsTabCounts({ status: 'signed_out' })).toEqual({ friends: 0, requests: 0, invites: 0 });
  });

  it('switches to one column below the breakpoint', () => {
    expect(friendsLayout(1200)).toBe('two');
    expect(friendsLayout(759)).toBe('one');
  });
});

describe('friends status and sharing a project', () => {
  it('shows online, offline, unavailable and checking in words', () => {
    const live = { friendsPresence: { connection: 'live', online: ['b'] } };
    expect(friendStatus(live, 'b')).toEqual({ state: 'online', text: 'Online' });
    expect(friendStatus(live, 'c')).toEqual({ state: 'offline', text: 'Offline' });
    expect(friendStatus({ friendsPresence: { connection: 'unavailable', online: [] } }, 'b').text).toBe('Status unavailable');
    expect(friendStatus({ friendsPresence: { connection: 'reconnecting', online: ['b'] } }, 'b')).toEqual({ state: 'checking', text: 'Reconnecting…' });
    expect(friendStatus({}, 'b').state).toBe('checking');
  });

  const me = { userId: 'me', isYou: true, name: 'ann' };
  const base = {
    status: 'signed_in', userId: 'me',
    friends: [{ requestId: 'r1', userId: 'b', username: 'bob', state: 'friend' }, { requestId: 'r2', userId: 'c', username: 'cat', state: 'friend' }, { requestId: 'r3', userId: 'd', username: 'dan', state: 'friend' }],
    teams: [
      { id: 't1', name: 'Shop team', isOwner: true, members: [me, { userId: 'b', name: 'bob' }], projects: [{ id: 'p1', name: 'Shop', link: { localProjectId: 'local-shop' } }] },
      { id: 't2', name: 'Big', isOwner: true, members: [me, { userId: 'e', name: 'eve' }], projects: [{ id: 'p2', name: 'One' }, { id: 'p3', name: 'Two' }] },
      { id: 't3', name: 'Theirs', isOwner: false, members: [me], projects: [] },
    ],
    projectInvites: [{ id: 'i1', direction: 'outgoing', projectId: 'p1', userId: 'c' }],
  };

  it('shows who already has access, who is pending, and which teams it could be shared with', () => {
    const o = shareOptions(base, 'local-shop');
    expect(o.linked.team.name).toBe('Shop team');
    expect(o.friends.map((f) => [f.username, f.reason])).toEqual([['bob', 'Already has access'], ['cat', 'Pending'], ['dan', null]]);
    expect(o.teams.map((t) => [t.name, t.gaining.map((m) => m.name), t.otherProjects])).toEqual([['Big', ['eve'], ['One', 'Two']]]);
  });

  it('explains why friends cannot be invited to a project in a shared team, and offers every owned team for an unshared project', () => {
    const notOwner = { ...base, teams: [{ ...base.teams[0], isOwner: false }] };
    expect(shareOptions(notOwner, 'local-shop').friends.find((f) => f.username === 'dan').reason).toMatch(/Only the owner/);
    const unshared = shareOptions(base, 'local-new');
    expect(unshared.linked).toBeNull();
    expect(unshared.friends.every((f) => f.reason === null)).toBe(true);
    expect(unshared.teams.map((t) => t.name)).toEqual(['Shop team', 'Big']);
  });
});
