// Friends, as a full page: add someone by username, answer requests, and start shared projects.
// Tabs for Friends, Requests and Project invites; on a wide page the selected friend's details sit
// beside the list, on a narrow one they open full width with Back. Only usernames and display
// names are shown; email addresses stay private. The main process does every step (main/teams);
// this page never handles a token.
import React, { useEffect, useRef, useState } from 'react';
import { AccountForms, UsernameForm } from './AccountWelcome.jsx';
import { candidateState, errorText, friendGroups, friendLabel, friendStatus, friendsLayout, friendsTabCounts, incomingProjectInvites, incomingTeamInvites, initialsOf, projectChoices, projectInvitesWith, projectsTogether, repoName, sendOutcomeText, togetherChoices, togetherStatus } from './teams-ui.mjs';
import { CheckoutPicker, LinkCheckout, ProjectSelect } from './TeamsCheckout.jsx';
import { USERNAME_RULE, cleanUsername } from './account-ui.mjs';

function useAction(notify) {
  const [pending, setPending] = useState(false);
  const run = async (fn) => {
    if (pending) return undefined;
    setPending(true);
    try { return await fn(); } catch (error) { notify?.(errorText(error)); return undefined; } finally { setPending(false); }
  };
  return [pending, run];
}


// Team invitations sent to me. Shown here and on the Teams page.
export function TeamInvitesInbox({ api, view, notify, onView }) {
  const [pending, run] = useAction(notify);
  const invites = incomingTeamInvites(view);
  if (!invites.length) return null;
  return (
    <div className="provider-card teams-card friends-inbox" aria-label="Team invitations">
      <h2>Team invitations</h2>
      <ul className="teams-list">
        {invites.map((i) => (
          <li key={i.id}>
            <span><strong>{i.teamName}</strong> · from @{i.username}</span>
            <span className="friends-actions">
              <button type="button" className="button primary-button" disabled={pending} onClick={() => run(async () => { onView(await api.respondTeamInvite(i.id, true)); notify?.(`You joined ${i.teamName}.`); })}>Join team</button>
              <button type="button" className="button" disabled={pending} onClick={() => run(async () => onView(await api.respondTeamInvite(i.id, false)))}>Decline</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const repoLine = (repo) => (repo ? `github.com/${repoName(repo)}` : 'No GitHub repository linked');

// "Start a project together": choose an existing shared project that is alone in its team, or make
// a new shared project of its own from a project and its GitHub checkout. The summary shows what
// will be shared before the invitation is sent.
function StartTogether({ api, friend, view, projects, onCreateProject, notify, onView, onDone }) {
  const choices = togetherChoices(view, friend.userId);
  const ready = choices.filter((c) => c.ok);
  const [mode, setMode] = useState(ready.length ? 'existing' : 'new');
  const [chosen, setChosen] = useState(ready[0]?.id || '');
  const [local, setLocal] = useState('');
  const [selection, setSelection] = useState(null);
  const [name, setName] = useState('');
  const [pending, run] = useAction(notify);
  const label = friendLabel(friend).name;
  const existing = choices.find((c) => c.id === chosen && c.ok);
  const locals = projectChoices(projects, view.teams);
  const newName = name.trim() || selection?.repo?.name || '';
  const canSend = mode === 'existing' ? Boolean(existing) : Boolean(local && selection?.id && selection.repo && newName);
  const summary = mode === 'existing' ? (existing ? { name: existing.name, repo: existing.repo } : null) : (selection?.repo && newName ? { name: newName, repo: selection.repo } : null);
  const send = () => run(async () => {
    if (mode === 'existing') onView(await api.startProjectTogether({ friendUserId: friend.userId, sharedProjectId: existing.id }));
    else {
      const localProjectId = local === '__new__' ? onCreateProject(newName) : local;
      onView(await api.startProjectTogether({ friendUserId: friend.userId, localProjectId, selectionId: selection.id, name: newName, remote: selection.repo.remote }));
    }
    notify?.(`Invitation sent to ${label}.`);
    onDone();
  });
  return (
    <div className="teams-subform friends-together">
      <h4>Start a project together with {label}</h4>
      <div className="friends-together-modes" role="radiogroup" aria-label="Which project">
        <label><input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} disabled={!choices.length}/> A shared project I own</label>
        <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')}/> A new shared project</label>
      </div>
      {mode === 'existing' ? (
        choices.length ? (
          <ul className="teams-list friends-together-list">
            {choices.map((c) => (
              <li key={c.id}>
                <label className={c.ok ? '' : 'is-disabled'}>
                  <input type="radio" name={`together-${friend.userId}`} disabled={!c.ok} checked={chosen === c.id} onChange={() => setChosen(c.id)}/>
                  <span><strong>{c.name}</strong><small>{repoLine(c.repo)}{c.reason ? ` · ${c.reason}` : ''}</small></span>
                </label>
              </li>
            ))}
          </ul>
        ) : <p className="provider-line">You own no shared projects yet. Start a new one.</p>
      ) : (
        <>
          <ProjectSelect choices={locals} value={local} onChange={(v) => { setLocal(v); const p = projects.find((x) => x.id === v); if (p && !name) setName(p.name); }} newName={newName || 'Shared project'}/>
          <CheckoutPicker api={api} notify={notify} selection={selection} onSelection={(sel) => { setSelection(sel); if (sel?.repo && !name) setName(sel.repo.name); }}/>
          <label className="teams-field">Shared project name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80}/></label>
          <p className="provider-line">It gets a team of its own, so {label} sees only this project. Your folder and branch stay on this computer.</p>
        </>
      )}
      {summary && <p className="friends-together-summary">Invite <strong>{label}</strong> to <strong>{summary.name}</strong> · {repoLine(summary.repo)}</p>}
      <div className="setup-actions">
        <button type="button" className="button primary-button" disabled={pending || !canSend} onClick={send}>Send invitation</button>
        <button type="button" className="button" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

// One shared project we are both in: membership, their presence and my checkout, each on its own,
// and "Open shared project" (which first links this computer's checkout if there is none yet).
function TogetherProject({ api, view, project, team, friend, projects, onCreateProject, onOpenProject, notify, onView }) {
  const [linking, setLinking] = useState(false);
  const status = togetherStatus(view, project, friend.userId);
  const open = () => (project.link?.state === 'linked' ? onOpenProject?.(project.link.localProjectId) : setLinking(true));
  return (
    <div className="fr-project">
      <div className="fr-project-head">
        <span className="fr-project-main"><strong>{project.name}</strong><small>{repoLine(project.repo)} · team {team.name}</small></span>
        {!linking && <button type="button" className="fr-primary" onClick={open}>Open shared project</button>}
      </div>
      <div className="fr-badges">
        <span className="fr-badge fr-badge-good">Member</span>
        <span className={`fr-badge ${status.presence === 'online' ? 'fr-badge-good' : ''}`}>{status.presence === 'unknown' ? 'Status unknown' : status.presence === 'online' ? 'Online' : 'Offline'}</span>
        <span className={`fr-badge ${status.myCheckout === 'ready' ? 'fr-badge-good' : 'fr-badge-warn'}`}>Your checkout: {status.myCheckout}</span>
      </div>
      {linking && (
        <div className="fr-link">
          <p className="fr-muted">Open it on this computer by choosing your own copy of {repoName(project.repo)}. No copy yet? Clone it first (New project → From GitHub, or git clone). Your folder and branch stay on this computer.</p>
          <LinkCheckout api={api} project={project} teams={view.teams} projects={projects} onCreateProject={onCreateProject} notify={notify} onView={onView} onDone={() => setLinking(false)}/>
        </div>
      )}
    </div>
  );
}

// A small "⋯" menu for secondary actions. Escape or a click outside closes it.
function MoreMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <span className="fr-menu" ref={ref}>
      <button type="button" className="fr-icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <span className="fr-menu-list" role="menu">
          {items.map((it) => <button key={it.label} type="button" role="menuitem" className={it.danger ? 'is-danger' : ''} autoFocus={it === items[0]} onClick={() => { setOpen(false); it.onSelect(); }}>{it.label}</button>)}
        </span>
      )}
    </span>
  );
}

function Avatar({ person, size = 'md' }) {
  return <span className={`fr-avatar fr-avatar-${size}`} aria-hidden="true">{initialsOf(person)}</span>;
}

function Who({ person, view = null }) {
  const label = friendLabel(person);
  const status = view ? friendStatus(view, person.userId) : null;
  return <span className="fr-who"><strong>{label.name}{status?.text && <span className={`fr-status fr-status-${status.state}`}><i aria-hidden="true"/>{status.text}</span>}</strong>{label.handle && <small>{label.handle}</small>}</span>;
}

// "Add friend": one username field (paste it with or without @), the matching account before sending,
// and the outcome in words. If they already asked me, Accept and Decline right here.
function AddFriendDialog({ api, onView, onClose, onRespond }) {
  const [name, setName] = useState('');
  const [found, setFound] = useState(null);
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(false);
  const clean = cleanUsername(name);
  const act = async (fn) => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try { await fn(); } catch (error) { setMessage({ tone: 'error', text: errorText(error) }); } finally { setPending(false); }
  };
  const find = () => act(async () => { setFound(null); setFound(await api.findFriend(clean)); });
  const send = () => act(async () => {
    const r = await api.addFriend(found.username);
    onView(r.view);
    setMessage(sendOutcomeText(r.outcome, found.username));
    if (r.outcome === 'incoming_pending' && r.requestId) setFound({ ...found, relation: 'incoming', requestId: r.requestId });
    else setFound({ ...found, relation: r.outcome === 'sent' || r.outcome === 'already_pending' ? 'outgoing' : 'friend' });
  });
  const respond = (accept) => act(async () => {
    await onRespond(found.requestId, accept);
    setMessage({ tone: 'ok', text: accept ? `You and @${found.username} are now friends.` : `Declined @${found.username}'s request.` });
    setFound({ ...found, relation: accept ? 'friend' : 'none', requestId: null });
  });
  const state = found ? candidateState(found) : null;
  return (
    <div className="fr-scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fr-dialog" role="dialog" aria-modal="true" aria-labelledby="fr-add-title" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="fr-dialog-head"><h2 id="fr-add-title">Add friend</h2><button type="button" className="fr-icon" aria-label="Close" onClick={onClose}>×</button></div>
        <form className="fr-add-form" onSubmit={(e) => { e.preventDefault(); if (USERNAME_RULE.test(clean)) find(); }}>
          <label className="fr-field">Username
            <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setFound(null); setMessage(null); }} placeholder="@username" maxLength={26} spellCheck={false} autoComplete="off"/>
          </label>
          <button type="submit" className="fr-secondary" disabled={pending || !USERNAME_RULE.test(clean)}>Find</button>
        </form>
        <p className="fr-muted">Their exact username, with or without the @. Email addresses stay private.</p>
        {found && (
          <div className="fr-candidate">
            <Avatar person={found}/>
            <Who person={found}/>
            {state.text && <small className="fr-muted fr-candidate-state">{state.text}</small>}
            <span className="fr-actions">
              {state.action === 'send' && <button type="button" className="fr-primary" autoFocus disabled={pending} onClick={send}>Send request</button>}
              {state.action === 'accept' && found.requestId && <>
                <button type="button" className="fr-primary" autoFocus disabled={pending} onClick={() => respond(true)}>Accept</button>
                <button type="button" className="fr-secondary" disabled={pending} onClick={() => respond(false)}>Decline</button>
              </>}
            </span>
          </div>
        )}
        {message && <p className={`fr-message fr-message-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
      </div>
    </div>
  );
}

// The selected friend: who, the projects we share, invitations waiting, and starting a new one.
function FriendDetail({ api, friend, view, projects, onCreateProject, onOpenProject, notify, onView, starting, setStarting, onRemove, onBack }) {
  const [pending, run] = useAction(notify);
  const waiting = projectInvitesWith(view, friend.userId, 'outgoing');
  const together = projectsTogether(view, friend.userId);
  return (
    <section className="fr-detail" aria-label={`${friendLabel(friend).name}`}>
      {onBack && <button type="button" className="fr-back" onClick={onBack}>← Back to friends</button>}
      <div className="fr-detail-head">
        <Avatar person={friend} size="lg"/>
        <Who person={friend} view={view}/>
        <MoreMenu label={`More for ${friendLabel(friend).name}`} items={[{ label: 'Remove friend', danger: true, onSelect: onRemove }]}/>
      </div>
      {!starting && <button type="button" className="fr-primary fr-wide" onClick={() => setStarting(true)}>Start a project together</button>}
      {starting && <StartTogether api={api} friend={friend} view={view} projects={projects} onCreateProject={onCreateProject} notify={notify} onView={onView} onDone={() => setStarting(false)}/>}
      {waiting.length > 0 && <div className="fr-block">
        <h3>Invitations waiting for {friendLabel(friend).name}</h3>
        {waiting.map((i) => (
          <div key={i.id} className="fr-pending">
            <span className="fr-project-main"><strong>{i.projectName}</strong><small>{repoLine(i.repo)}</small></span>
            <span className="fr-badge fr-badge-warn">Invitation pending</span>
            <button type="button" className="fr-link-button" disabled={pending} onClick={() => run(async () => { onView(await api.revokeProjectInvite(i.id)); notify?.(`Invitation to ${i.projectName} cancelled.`); })}>Cancel invitation</button>
          </div>
        ))}
      </div>}
      <div className="fr-block">
        <h3>Shared projects</h3>
        {together.length ? together.map(({ project, team }) => <TogetherProject key={project.id} api={api} view={view} project={project} team={team} friend={friend} projects={projects} onCreateProject={onCreateProject} onOpenProject={onOpenProject} notify={notify} onView={onView}/>)
          : <p className="fr-muted">No shared projects yet. Start one together; {friendLabel(friend).name} joins when they accept.</p>}
      </div>
    </section>
  );
}

const TABS = [['friends', 'Friends'], ['requests', 'Requests'], ['invites', 'Project invites']];

export function FriendsPage({ view, onView: setView, onBack, notify, onTeams, projects = [], onCreateProject, onOpenProject }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.teams : null;
  const onView = (v) => { if (v && typeof v === 'object' && v.status) setView(v); };
  const [pending, run] = useAction(notify);
  const [tab, setTab] = useState('friends');
  const [selectedId, setSelectedId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [width, setWidth] = useState(1200);
  const root = useRef(null);
  // Read the lists again every time the page opens.
  useEffect(() => { if (api) api.status(true).then(onView).catch(() => {}); }, []);
  // The layout follows the page's own width (so it adapts when the sidebar is shown or hidden).
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view?.status, view?.username]);
  const layout = friendsLayout(width);
  const groups = friendGroups(view);
  const counts = friendsTabCounts(view);
  const selected = groups.friends.find((f) => f.userId === selectedId) || (layout === 'two' ? groups.friends[0] : null) || null;
  const respond = async (requestId, accept) => onView(await api.respondFriend(requestId, accept));
  const select = (f, start = false) => { setSelectedId(f.userId); setStarting(start); setDetailOpen(true); };
  const remove = (f) => {
    if (!window.confirm(`Remove @${f.username} from your friends? You both lose the friendship, and pending project invitations between you are cancelled. Shared projects stay.`)) return;
    void run(async () => { onView(await api.removeFriend(f.userId)); if (selectedId === f.userId) { setSelectedId(null); setDetailOpen(false); } notify?.(`@${f.username} is no longer your friend.`); });
  };
  const copy = () => navigator.clipboard?.writeText(`@${view.username}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => notify?.('Could not copy. Select the username and copy it.'));
  const tabKeys = (e) => {
    const i = TABS.findIndex(([id]) => id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
    if (next >= 0) { e.preventDefault(); setTab(TABS[next][0]); document.getElementById(`fr-tab-${TABS[next][0]}`)?.focus(); }
  };

  if (!api || !view || view.status !== 'signed_in' || !view.username) {
    return (
      <section className="accounts-page teams-page friends-page" aria-label="Friends">
        <div className="accounts-heading"><div><div className="eyebrow">FRIENDS</div><h1>Friends<span className="account-heading-dot">.</span></h1></div><div className="accounts-actions"><button className="button" onClick={onBack}>Back</button></div></div>
        {!api ? <div className="simulated-notice" role="note"><strong>Preview</strong><h2>Friends works in the installed app.</h2></div>
          : !view ? <p className="provider-line">Loading…</p>
          : view.status === 'unconfigured' ? <div className="provider-card teams-card"><h2>Friends is not available in this build</h2><p className="provider-line">{view.configProblem || 'This build has no 0rqestra server.'}</p></div>
          : view.status !== 'signed_in' ? <div className="provider-card teams-card">{view.serverProblem && <div className="setup-error" role="alert"><span>{view.serverProblem}</span></div>}<p className="provider-line">Friends needs your 0rqestra account.</p><AccountForms api={api} view={view} onView={onView} initialStep="sign_in"/></div>
          : <div className="provider-card teams-card">{view.needsUsername ? <UsernameForm api={api} view={view} onView={onView}/> : <p className="provider-line">Loading your account…</p>}</div>}
      </section>
    );
  }

  const showList = layout === 'two' || !detailOpen || !selected;
  const showDetail = selected && (layout === 'two' || detailOpen);
  return (
    <section className={`fr-page fr-${layout}`} aria-label="Friends" ref={root}>
      <header className="fr-header">
        <div className="fr-header-row">
          <h1>Friends</h1>
          <span className="fr-me">
            <span className="fr-handle" title="Your username">@{view.username}</span>
            <button type="button" className="fr-secondary fr-small" onClick={copy} aria-live="polite">{copied ? 'Copied' : 'Copy'}</button>
          </span>
          <span className="fr-header-actions">
            <button type="button" className="fr-primary" onClick={() => setAdding(true)}>+ Add friend</button>
            <MoreMenu label="More" items={[{ label: 'Teams', onSelect: onTeams }, { label: 'Back to projects', onSelect: onBack }]}/>
          </span>
        </div>
        <div className="fr-tabs" role="tablist" aria-label="Friends sections" onKeyDown={tabKeys}>
          {TABS.map(([id, label]) => (
            <button key={id} id={`fr-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`fr-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={`fr-tab ${tab === id ? 'is-on' : ''}`} onClick={() => setTab(id)}>
              {label}{counts[id] > 0 && <span className="fr-count" aria-label={`${counts[id]} waiting for you`}>{counts[id]}</span>}
            </button>
          ))}
        </div>
        {view.serverProblem && <div className="setup-error" role="alert"><span>Could not reach the 0rqestra server: {view.serverProblem}</span></div>}
      </header>

      {tab === 'friends' && (
        <div className="fr-body" id="fr-panel-friends" role="tabpanel" aria-labelledby="fr-tab-friends">
          {showList && (
            <div className="fr-list-col">
              {groups.friends.length === 0 ? <div className="fr-empty"><p>No friends yet.</p><button type="button" className="fr-primary" onClick={() => setAdding(true)}>+ Add friend</button></div> : (
                <ul className="fr-list" aria-label="Your friends">
                  {groups.friends.map((f) => (
                    <li key={f.requestId} className={`fr-row ${showDetail && selected?.userId === f.userId ? 'is-selected' : ''}`}>
                      <button type="button" className="fr-row-main" aria-current={showDetail && selected?.userId === f.userId ? 'true' : undefined} onClick={() => select(f)}>
                        <Avatar person={f}/><Who person={f} view={view}/>
                        {projectInvitesWith(view, f.userId, 'outgoing').length > 0 && <span className="fr-badge fr-badge-warn">Invitation pending</span>}
                        {projectsTogether(view, f.userId).length > 0 && <span className="fr-badge fr-badge-good">{projectsTogether(view, f.userId).length} shared</span>}
                      </button>
                      <span className="fr-row-actions">
                        <button type="button" className="fr-primary fr-small" onClick={() => select(f, true)}>Start a project together</button>
                        <MoreMenu label={`More for ${friendLabel(f).name}`} items={[{ label: 'Remove friend', danger: true, onSelect: () => remove(f) }]}/>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {showDetail && (
            <FriendDetail key={selected.userId} api={api} friend={selected} view={view} projects={projects} onCreateProject={onCreateProject} onOpenProject={onOpenProject} notify={notify} onView={onView}
              starting={starting} setStarting={setStarting} onRemove={() => remove(selected)} onBack={layout === 'one' ? () => setDetailOpen(false) : null}/>
          )}
        </div>
      )}

      {tab === 'requests' && (
        <div className="fr-body fr-single" id="fr-panel-requests" role="tabpanel" aria-labelledby="fr-tab-requests">
          <div className="fr-block">
            <h3>Incoming</h3>
            {groups.incoming.length === 0 ? <p className="fr-muted">No requests waiting for your answer.</p> : (
              <ul className="fr-list">
                {groups.incoming.map((f) => (
                  <li key={f.requestId} className="fr-row fr-row-static">
                    <span className="fr-row-main"><Avatar person={f}/><Who person={f}/></span>
                    <span className="fr-row-actions">
                      <button type="button" className="fr-primary fr-small" disabled={pending} onClick={() => run(async () => { await respond(f.requestId, true); notify?.(`You and @${f.username} are now friends.`); })}>Accept</button>
                      <button type="button" className="fr-secondary fr-small" disabled={pending} onClick={() => run(async () => { await respond(f.requestId, false); notify?.(`Declined @${f.username}'s request.`); })}>Decline</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="fr-block">
            <h3>Sent</h3>
            {groups.outgoing.length === 0 ? <p className="fr-muted">No requests waiting for someone else.</p> : (
              <ul className="fr-list">
                {groups.outgoing.map((f) => (
                  <li key={f.requestId} className="fr-row fr-row-static">
                    <span className="fr-row-main"><Avatar person={f}/><Who person={f}/><span className="fr-badge fr-badge-warn">Request pending</span></span>
                    <span className="fr-row-actions">
                      <button type="button" className="fr-link-button" disabled={pending} onClick={() => run(async () => {
                        const r = await api.cancelFriend(f.userId);
                        onView(r.view);
                        notify?.(r.result === 'accepted' ? `@${f.username} accepted just before you cancelled. You are friends now.` : `Cancelled your request to @${f.username}.`);
                      })}>Cancel request</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === 'invites' && (
        <div className="fr-body fr-single" id="fr-panel-invites" role="tabpanel" aria-labelledby="fr-tab-invites">
          <div className="fr-block">
            <h3>Invitations to you</h3>
            {incomingProjectInvites(view).length === 0 ? <p className="fr-muted">No project invitations waiting for your answer.</p> : (
              <ul className="fr-list">
                {incomingProjectInvites(view).map((i) => (
                  <li key={i.id} className="fr-row fr-row-static">
                    <span className="fr-row-main"><Avatar person={i}/><span className="fr-who"><strong>{i.projectName}</strong><small>from {friendLabel(i).name}{friendLabel(i).handle ? ` (${friendLabel(i).handle})` : ''} · {repoLine(i.repo)}</small></span></span>
                    <span className="fr-row-actions">
                      <button type="button" className="fr-primary fr-small" disabled={pending} onClick={() => run(async () => {
                        const r = await api.respondProjectInvite(i.id, true);
                        onView(r.view);
                        notify?.(`You joined ${i.projectName}.`);
                        setTab('friends'); setSelectedId(i.userId); setStarting(false); setDetailOpen(true);
                      })}>Accept</button>
                      <button type="button" className="fr-secondary fr-small" disabled={pending} onClick={() => run(async () => { const r = await api.respondProjectInvite(i.id, false); onView(r.view); })}>Decline</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="fr-block">
            <h3>Sent by you</h3>
            {(view.projectInvites || []).filter((i) => i.direction === 'outgoing').length === 0 ? <p className="fr-muted">No invitations waiting for a friend’s answer.</p> : (
              <ul className="fr-list">
                {(view.projectInvites || []).filter((i) => i.direction === 'outgoing').map((i) => (
                  <li key={i.id} className="fr-row fr-row-static">
                    <span className="fr-row-main"><Avatar person={i}/><span className="fr-who"><strong>{i.projectName}</strong><small>to {friendLabel(i).name} · {repoLine(i.repo)}</small></span><span className="fr-badge fr-badge-warn">Invitation pending</span></span>
                    <span className="fr-row-actions"><button type="button" className="fr-link-button" disabled={pending} onClick={() => run(async () => { onView(await api.revokeProjectInvite(i.id)); notify?.(`Invitation to ${i.projectName} cancelled.`); })}>Cancel invitation</button></span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <TeamInvitesInbox api={api} view={view} notify={notify} onView={onView}/>
        </div>
      )}

      {adding && <AddFriendDialog api={api} onView={onView} onClose={() => setAdding(false)} onRespond={respond}/>}
    </section>
  );
}
