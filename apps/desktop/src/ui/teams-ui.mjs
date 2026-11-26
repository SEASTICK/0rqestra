// Text and choices for the Teams page, kept apart from the components so they are unit-tested.

export const LINK_TEXT = {
  linked: 'Linked on this computer',
  missing: 'Linked folder is missing',
  mismatch: 'Linked folder points elsewhere',
  unreadable: 'Linked folder cannot be read',
};

export function linkLine(link) {
  if (!link) return { text: 'Not linked on this computer', tone: 'muted' };
  return { text: LINK_TEXT[link.state] || link.state, tone: link.state === 'linked' ? 'good' : 'warn' };
}

export function repoName(repo) {
  return repo ? `${repo.owner}/${repo.name}` : '';
}

export function inviteLine(invite, now = Date.now()) {
  if (invite.state === 'used') return 'Accepted';
  if (invite.state === 'revoked') return 'Withdrawn';
  if (invite.state === 'expired') return 'Expired';
  const hours = Math.max(0, Math.round((Date.parse(invite.expiresAt) - now) / 3600000));
  return hours >= 48 ? `Waiting · expires in ${Math.round(hours / 24)} days` : `Waiting · expires in ${hours} h`;
}

// Local projects a checkout can be linked to: not already linked to another shared project.
export function projectChoices(projects, teams, sharedProjectId = null) {
  const taken = new Set();
  for (const t of teams || []) for (const p of t.projects || []) if (p.link && p.id !== sharedProjectId) taken.add(p.link.localProjectId);
  return (projects || []).filter((p) => !taken.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
}

export function localName(projects, localProjectId) {
  return (projects || []).find((p) => p.id === localProjectId)?.name || 'a project that is no longer on this computer';
}

// Whether a chosen folder has a remote for the shared repository (the main process checks again).
export function selectionMatches(selection, repoKey) {
  return Boolean(selection?.remotes?.some((r) => r.identity?.key === repoKey));
}

export function signInTitle(view) {
  if (!view) return 'Teams';
  if (view.status === 'unconfigured') return 'Teams is not set up';
  if (view.status === 'signed_in') return view.username ? `Signed in as @${view.username} (${view.email})` : `Signed in as ${view.email}`;
  if (view.status === 'code_sent') return `Code sent to ${view.pendingEmail}`;
  return 'Sign in to Teams';
}

export const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---- Phase 2: Team Bridge -------------------------------------------------------------------

// The shared project this local project is linked to on this computer, with its team. Null for a
// solo project, so the tree keeps its usual layout.
export function linkedTeamProject(view, localProjectId) {
  if (!view || view.status !== 'signed_in') return null;
  for (const team of view.teams || []) {
    for (const project of team.projects || []) {
      if (project.link?.localProjectId === localProjectId && project.link.state === 'linked') return { team, project };
    }
  }
  return null;
}

// A teammate's name for the bridge: their username (anything after an @ is dropped).
export function displayName(name) {
  const local = String(name || '').split('@')[0] || 'Teammate';
  return local.length > 24 ? `${local.slice(0, 23)}…` : local;
}

// One person's status on the bridge. Presence is about being online only, never about work.
export function memberStatus(view, projectId, userId) {
  const p = view?.presence?.[projectId];
  if (!p) return 'connecting';
  if (userId === view.userId) return p.publishing ? 'online' : p.connection === 'live' ? 'away' : p.connection;
  if (p.connection !== 'live') return p.connection;
  return p.online.includes(userId) ? 'online' : 'offline';
}

export const STATUS_TEXT = {
  online: 'Online',
  offline: 'Offline',
  away: 'Offline · inactive',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  unavailable: 'Status unavailable',
};

export function bridgeSummary(view, team, project) {
  const p = view?.presence?.[project.id];
  if (!p || p.connection === 'connecting') return 'Connecting…';
  if (p.connection !== 'live') return STATUS_TEXT[p.connection];
  const others = team.members.filter((m) => m.userId !== view.userId);
  const online = others.filter((m) => p.online.includes(m.userId)).length;
  return others.length === 0 ? 'No teammates yet' : `${online} of ${others.length} teammate${others.length === 1 ? '' : 's'} online`;
}

// Positions next to your Manager: Manager ↔ Team Bridge ↔ each teammate's Manager.
export const NODE_W = 224;
export const NODE_H = 159;
export function bridgeLayout(manager, teammateCount) {
  if (!manager) return null;
  const bridge = { x: manager.x + NODE_W + 90, y: manager.y };
  const teammates = Array.from({ length: teammateCount }, (_, i) => ({ x: bridge.x + NODE_W + 90, y: manager.y + i * (NODE_H + 30) }));
  return { bridge, teammates };
}

// Everyone in the shared project as a box on the bridge: you first, then the others by name, each with the
// approved work they run right now (their active briefs). Your own runs that the server does not have yet are
// included from this computer, marked as not synced. Only titles and states: never prompts or chat.
export const MAX_WORK_SHOWN = 2;
export function personBoxes(view, linked) {
  if (!view || !linked) return [];
  const { team, project } = linked;
  const me = view.userId;
  const active = (b) => b.status === 'in_progress' || b.status === 'blocked';
  const briefs = (project.briefs || []).filter(active);
  const known = new Set(briefs.map((b) => b.runId));
  const local = (view.localBriefs?.[project.id] || []).filter((b) => active(b) && !known.has(b.runId))
    .map((b) => ({ id: `local-${b.runId}`, runId: b.runId, title: b.title, status: b.status, authorId: me, updatedAt: b.updatedAt, unsynced: b.sync !== 'synced' }));
  const all = [...briefs, ...local];
  const time = (b) => (typeof b.updatedAt === 'number' ? b.updatedAt : Date.parse(b.updatedAt) || 0);
  const people = [...(team.members || [])].sort((a, b) => Number(b.userId === me) - Number(a.userId === me) || String(a.name).localeCompare(String(b.name)));
  return people.map((m) => {
    const work = all.filter((b) => b.authorId === m.userId).sort((a, b) => time(b) - time(a));
    return {
      userId: m.userId,
      name: displayName(m.name),
      you: m.userId === me,
      owner: m.role === 'owner',
      status: memberStatus(view, project.id, m.userId),
      work: work.slice(0, MAX_WORK_SHOWN).map((b) => ({ id: b.id, title: b.title, status: b.status, unsynced: Boolean(b.unsynced) })),
      more: Math.max(0, work.length - MAX_WORK_SHOWN),
    };
  });
}

// ---- Phase 3: work briefs -------------------------------------------------------------------

export const BRIEF_STATUS_TEXT = { in_progress: 'In progress', blocked: 'Blocked', completed: 'Completed', stopped: 'Stopped', failed: 'Failed' };

export function ago(then, now = Date.now()) {
  const t = typeof then === 'number' ? then : Date.parse(then);
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// The shown briefs may be old when the live connection is not up: say so, with their age.
export function briefsNotice(view, projectId, now = Date.now()) {
  const conn = view?.presence?.[projectId]?.connection;
  const at = view?.briefsAt?.[projectId];
  if (conn === 'live') return null;
  if (!at) return 'Active work has not been loaded yet.';
  return `Shown as of ${ago(at, now)}. It may be out of date until the connection is back.`;
}

// This computer's briefs that the server does not have yet.
export function unsyncedBriefs(view, projectId) {
  return (view?.localBriefs?.[projectId] || []).filter((b) => b.sync !== 'synced');
}

// ---- Friends and team invitations ------------------------------------------------------------

export function friendGroups(view) {
  const all = view?.status === 'signed_in' ? view.friends || [] : [];
  const byName = (a, b) => a.username.localeCompare(b.username);
  return {
    incoming: all.filter((f) => f.state === 'incoming').sort(byName),
    outgoing: all.filter((f) => f.state === 'outgoing').sort(byName),
    friends: all.filter((f) => f.state === 'friend').sort(byName),
  };
}

// A person's name in friends lists: the display name with the username, or the username alone
// when the display name adds nothing. Never an email address.
export function friendLabel(person) {
  const username = String(person?.username || 'unknown');
  const shown = String(person?.displayName || '').trim();
  return shown && shown.toLowerCase() !== username.toLowerCase() ? { name: shown, handle: `@${username}` } : { name: `@${username}`, handle: '' };
}

// What a found person's card says, and which action it offers: "send", "accept" (they asked you
// first) or none.
export function candidateState(candidate) {
  switch (candidate?.relation) {
    case 'self': return { text: 'That is your own username.', action: null };
    case 'friend': return { text: 'You are already friends.', action: null };
    case 'outgoing': return { text: 'Your request is waiting for their answer.', action: null };
    case 'incoming': return { text: 'They already sent you a friend request.', action: 'accept' };
    default: return { text: '', action: 'send' };
  }
}

// The message after "Send request", by what the server did.
export function sendOutcomeText(outcome, username) {
  const at = `@${username}`;
  switch (outcome) {
    case 'already_pending': return { tone: 'info', text: `You already sent ${at} a request. It is waiting for their answer.` };
    case 'already_friends': return { tone: 'info', text: `You and ${at} are already friends.` };
    case 'incoming_pending': return { tone: 'info', text: `${at} already sent you a request. Accept it to become friends.` };
    case 'accepted': return { tone: 'ok', text: `You and ${at} are now friends.` };
    default: return { tone: 'ok', text: `Friend request sent to ${at}.` };
  }
}

export function incomingTeamInvites(view) {
  return view?.status === 'signed_in' ? (view.teamInvites || []).filter((i) => i.direction === 'incoming') : [];
}

// Friends the owner can still invite to this team: not a member, no invitation waiting.
export function invitableFriends(view, team) {
  const waiting = new Set((view?.teamInvites || []).filter((i) => i.direction === 'outgoing' && i.teamId === team.id).map((i) => i.userId));
  const members = new Set(team.members.map((m) => m.userId));
  return friendGroups(view).friends.filter((f) => !members.has(f.userId) && !waiting.has(f.userId));
}

export function outgoingTeamInvites(view, team) {
  return (view?.teamInvites || []).filter((i) => i.direction === 'outgoing' && i.teamId === team.id);
}

// What waits for an answer from this person: friend requests and team invitations.
export function waitingCount(view) {
  return friendGroups(view).incoming.length + incomingTeamInvites(view).length;
}

// ---- Team chat --------------------------------------------------------------------------------

// Messages from others since the person last opened the Team Bridge (seen: ms, or 0 for never).
export function unreadCount(view, projectId, seen) {
  const messages = view?.chat?.[projectId]?.messages || [];
  return messages.filter((m) => m.authorId !== view.userId && Date.parse(m.createdAt) > (Number(seen) || 0)).length;
}

export const SORT_REQUEST = 'Sort what the team asked for in the team chat: who wants what, where it overlaps with what I want, and who should do which part in what order. Do not start any work yet.';

// ---- Starting a project together (Friends) ---------------------------------------------------

// Pending project invitations with this friend, in one direction.
export function projectInvitesWith(view, userId, direction) {
  return view?.status === 'signed_in' ? (view.projectInvites || []).filter((i) => i.userId === userId && i.direction === direction) : [];
}

export function incomingProjectInvites(view) {
  return view?.status === 'signed_in' ? (view.projectInvites || []).filter((i) => i.direction === 'incoming') : [];
}

// Shared projects I could invite this friend to. Team membership opens every project of a team, so
// only a project that is alone in a team I own can be offered; the others say why not.
export function togetherChoices(view, friendUserId) {
  if (view?.status !== 'signed_in') return [];
  const waiting = new Set(projectInvitesWith(view, friendUserId, 'outgoing').map((i) => i.projectId));
  const out = [];
  for (const t of view.teams || []) {
    if (!t.isOwner) continue;
    for (const p of t.projects || []) {
      const member = t.members.some((m) => m.userId === friendUserId);
      const reason = member ? 'Already in this project' : waiting.has(p.id) ? 'Invitation pending' : t.projects.length > 1 ? `Shares the team ${t.name} with other projects` : null;
      if (member) continue;
      out.push({ id: p.id, name: p.name, repo: p.repo, teamName: t.name, linked: Boolean(p.link), ok: !reason, reason });
    }
  }
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || a.name.localeCompare(b.name));
}

// Shared projects both of us are in, with my own checkout's state on this computer.
export function projectsTogether(view, friendUserId) {
  if (view?.status !== 'signed_in') return [];
  return (view.teams || []).flatMap((t) => (t.members.some((m) => m.userId === friendUserId) ? t.projects.map((p) => ({ project: p, team: t })) : []));
}

// Membership, presence and checkout readiness are separate facts about a teammate in a project.
export function togetherStatus(view, project, userId) {
  const online = (view?.presence?.[project.id]?.online || []).includes(userId);
  const live = view?.presence?.[project.id]?.connection === 'live';
  return {
    presence: live ? (online ? 'online' : 'offline') : 'unknown',
    myCheckout: project.link?.state === 'linked' ? 'ready' : project.link ? 'needs attention' : 'needs setup',
  };
}

// The backend the Team Bridge runs through, for the bridge panel (host only, never a key).
export function bridgeBackend(server) {
  try {
    const host = new URL(String(server || '')).host;
    if (!host) return 'No 0rqestra server configured';
    return /\.supabase\.(co|in)$/.test(host) ? `Supabase (${host.split('.')[0]})` : host;
  } catch {
    return 'No 0rqestra server configured';
  }
}

// ---- Shared checklist ---------------------------------------------------------------------------

export const CHECKLIST_STATUS_TEXT = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
const CHECKLIST_ORDER = { blocked: 0, in_progress: 1, todo: 2, done: 3 };

// Done out of all active (not archived) items.
export function checklistProgress(view, projectId) {
  const items = (view?.checklist?.[projectId]?.items || []).filter((i) => !i.archived);
  return { done: items.filter((i) => i.status === 'done').length, total: items.length };
}

// The items to show: active or archived, optionally only mine; blocked first, then in progress, to
// do and done, each newest change first.
export function checklistItems(view, projectId, { mine = false, archived = false } = {}) {
  const me = view?.userId;
  const time = (i) => Date.parse(i.updatedAt) || 0;
  return (view?.checklist?.[projectId]?.items || [])
    .filter((i) => i.archived === archived && (!mine || i.assigneeId === me))
    .sort((a, b) => CHECKLIST_ORDER[a.status] - CHECKLIST_ORDER[b.status] || time(b) - time(a));
}

const LOCAL_RUN_TEXT = { running: 'Running', done: 'Finished', failed: 'Did not finish', stopped: 'Stopped' };

// What the linked run did: this computer's own run if it is here, else its work brief from the
// server. finished: the run ended well, so "Mark done" is offered (the person decides).
export function checklistRunState(item, localRuns = []) {
  if (!item?.runId) return null;
  const local = localRuns.find((r) => r.id === item.runId);
  if (local) return { label: LOCAL_RUN_TEXT[local.status] || local.status, outcome: local.outcome || null, finished: local.status === 'done', title: local.goal || '' };
  if (item.run) return { label: BRIEF_STATUS_TEXT[item.run.status] || item.run.status, outcome: item.run.outcome || null, finished: item.run.status === 'completed', title: item.run.title || '' };
  return { label: 'Run not shared yet', outcome: null, finished: false, title: '' };
}

// The text "Plan with Manager" puts in the message box. The Manager plans; Start still asks first.
export function planPrompt(item) {
  const notes = String(item?.notes || '').trim();
  return `Plan this task from our shared checklist: ${String(item?.title || '').trim()}${notes ? `\n\nNotes: ${notes}` : ''}`;
}

// The message after a claim, naming who has the item when someone else got it first.
export function claimText(result, nameOf) {
  if (result?.outcome === 'claimed') return 'It is yours now.';
  if (result?.outcome === 'yours') return 'It was already yours.';
  if (result?.outcome === 'archived') return 'That item is archived.';
  return `${nameOf(result?.assigneeId) || 'Someone else'} claimed it first.`;
}
