// Friends: find an account by its exact username, send a friend request, and answer requests and
// team invitations. Only usernames and display names are shown; email addresses stay private. The
// main process does every step (main/teams); this page never handles a token.
import React, { useEffect, useState } from 'react';
import { AccountForms, UsernameForm } from './AccountWelcome.jsx';
import { candidateState, errorText, friendGroups, friendLabel, incomingProjectInvites, incomingTeamInvites, projectChoices, projectInvitesWith, projectsTogether, repoName, sendOutcomeText, togetherChoices, togetherStatus } from './teams-ui.mjs';
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

function Person({ person }) {
  const label = friendLabel(person);
  return <span className="friend-person"><strong>{label.name}</strong>{label.handle && <small>{label.handle}</small>}</span>;
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

// Your own username, to share with people who want to add you.
function ShareUsername({ username }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(username).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  return (
    <div className="provider-card teams-card friends-share">
      <span>Your username <strong className="friends-handle">@{username}</strong></span>
      <button type="button" className="button" onClick={copy} aria-live="polite">{copied ? 'Copied' : 'Copy username'}</button>
      <small>Share it so people can add you. Your email address stays private.</small>
    </div>
  );
}

// Look the person up first (exact username, any case), then send or accept.
function AddFriend({ api, onView, onAccept }) {
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
    else { setFound(null); setName(''); }
  });
  const accept = () => act(async () => {
    await onAccept(found.requestId);
    setMessage({ tone: 'ok', text: `You and @${found.username} are now friends.` });
    setFound(null);
    setName('');
  });
  const state = found ? candidateState(found) : null;
  return (
    <div className="provider-card teams-card" aria-label="Add friend">
      <h2>Add friend</h2>
      <form className="teams-inline" onSubmit={(e) => { e.preventDefault(); if (USERNAME_RULE.test(clean)) find(); }}>
        <input aria-label="Username" value={name} onChange={(e) => { setName(e.target.value); setFound(null); setMessage(null); }} placeholder="Their exact username" maxLength={25} spellCheck={false} autoComplete="off" required/>
        <button className="button" type="submit" disabled={pending || !USERNAME_RULE.test(clean)}>Find</button>
      </form>
      {found && (
        <div className="friends-found">
          <Person person={found}/>
          {state.text && <small>{state.text}</small>}
          <span className="friends-actions">
            {state.action === 'send' && <button type="button" className="button primary-button" disabled={pending} onClick={send}>Send request</button>}
            {state.action === 'accept' && found.requestId && <button type="button" className="button primary-button" disabled={pending} onClick={accept}>Accept request</button>}
          </span>
        </div>
      )}
      {message && <p className={`friends-message friends-message-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
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
// and "Open shared project" (or linking my checkout first).
function TogetherProject({ api, view, project, team, friend, projects, onCreateProject, onOpenProject, notify, onView }) {
  const [linking, setLinking] = useState(false);
  const status = togetherStatus(view, project, friend.userId);
  const open = () => (project.link?.state === 'linked' ? onOpenProject?.(project.link.localProjectId) : setLinking(true));
  return (
    <div className="friends-together-project">
      <span><strong>{project.name}</strong><small>Member · {status.presence === 'unknown' ? 'status unknown' : status.presence} · your checkout {status.myCheckout} · {repoLine(project.repo)}</small></span>
      {linking ? (
        <div className="friends-together-link">
          <p className="provider-line">No copy of {repoName(project.repo)} on this computer yet? Clone it first (for example with New project → From GitHub, or git clone), then choose that folder. Your folder and branch stay on this computer.</p>
          <LinkCheckout api={api} project={project} teams={view.teams} projects={projects} onCreateProject={onCreateProject} notify={notify} onView={onView} onDone={() => setLinking(false)}/>
        </div>
      ) : <button type="button" className="button" onClick={open}>{project.link?.state === 'linked' ? 'Open shared project' : 'Set up my checkout'}</button>}
      <small className="friends-together-team">Team {team.name}</small>
    </div>
  );
}

function FriendRow({ api, friend, view, projects, onCreateProject, onOpenProject, notify, onView, pending, run }) {
  const [starting, setStarting] = useState(false);
  const waiting = projectInvitesWith(view, friend.userId, 'outgoing');
  const together = projectsTogether(view, friend.userId);
  return (
    <li className="friends-row">
      <div className="friends-row-head">
        <Person person={friend}/>
        <span className="friends-actions">
          {!starting && <button type="button" className="button" onClick={() => setStarting(true)}>Start a project together</button>}
          <button type="button" className="provider-text-link" disabled={pending} onClick={() => { if (window.confirm(`Remove @${friend.username} from your friends? You both lose the friendship, and pending project invitations between you are cancelled.`)) run(async () => { onView(await api.removeFriend(friend.userId)); notify?.(`@${friend.username} is no longer your friend.`); }); }}>Remove</button>
        </span>
      </div>
      {waiting.map((i) => (
        <div key={i.id} className="friends-together-pending">
          <span>Invitation pending · <strong>{i.projectName}</strong> · {repoLine(i.repo)}</span>
          <button type="button" className="provider-text-link" disabled={pending} onClick={() => run(async () => { onView(await api.revokeProjectInvite(i.id)); notify?.(`Invitation to ${i.projectName} cancelled.`); })}>Cancel invitation</button>
        </div>
      ))}
      {together.map(({ project, team }) => <TogetherProject key={project.id} api={api} view={view} project={project} team={team} friend={friend} projects={projects} onCreateProject={onCreateProject} onOpenProject={onOpenProject} notify={notify} onView={onView}/>)}
      {starting && <StartTogether api={api} friend={friend} view={view} projects={projects} onCreateProject={onCreateProject} notify={notify} onView={onView} onDone={() => setStarting(false)}/>}
    </li>
  );
}

// Project invitations sent to me: who, which project, which repository.
function ProjectInvitesInbox({ api, view, notify, onView }) {
  const [pending, run] = useAction(notify);
  const invites = incomingProjectInvites(view);
  if (!invites.length) return null;
  return (
    <div className="provider-card teams-card friends-inbox" aria-label="Project invitations">
      <h2>Project invitations</h2>
      <ul className="teams-list">
        {invites.map((i) => (
          <li key={i.id}>
            <span className="friend-person"><strong>{i.projectName}</strong><small>from {friendLabel(i).name}{friendLabel(i).handle ? ` (${friendLabel(i).handle})` : ''} · {repoLine(i.repo)}</small></span>
            <span className="friends-actions">
              <button type="button" className="button primary-button" disabled={pending} onClick={() => run(async () => { const r = await api.respondProjectInvite(i.id, true); onView(r.view); notify?.(`You joined ${i.projectName}. Open it from ${friendLabel(i).name}'s row below.`); })}>Accept</button>
              <button type="button" className="button" disabled={pending} onClick={() => run(async () => { const r = await api.respondProjectInvite(i.id, false); onView(r.view); })}>Decline</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FriendsPage({ view, onView: setView, onBack, notify, onTeams, projects = [], onCreateProject, onOpenProject }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.teams : null;
  const onView = (v) => { if (v && typeof v === 'object' && v.status) setView(v); };
  const [pending, run] = useAction(notify);
  // Read the lists again every time the page opens.
  useEffect(() => { if (api) api.status(true).then(onView).catch(() => {}); }, []);
  const groups = friendGroups(view);
  const respond = async (requestId, accept) => onView(await api.respondFriend(requestId, accept));
  return (
    <section className="accounts-page teams-page friends-page" aria-label="Friends">
      <div className="accounts-heading">
        <div>
          <div className="eyebrow">FRIENDS</div>
          <h1>Friends<span className="account-heading-dot">.</span></h1>
          <p>Add the people you work with. Friends can be invited to your teams; everyone sees usernames and display names, never email addresses.</p>
        </div>
        <div className="accounts-actions">
          {view?.status === 'signed_in' && <button className="button" onClick={onTeams}>Teams</button>}
          <button className="button" onClick={onBack}>Back</button>
        </div>
      </div>
      {!api ? (
        <div className="simulated-notice" role="note"><strong>Preview</strong><h2>Friends works in the installed app.</h2></div>
      ) : !view ? (
        <p className="provider-line">Loading…</p>
      ) : view.status === 'unconfigured' ? (
        <div className="provider-card teams-card"><h2>Friends is not available in this build</h2><p className="provider-line">{view.configProblem || 'This build has no 0rqestra server.'}</p></div>
      ) : view.status !== 'signed_in' ? (
        <div className="provider-card teams-card">
          {view.serverProblem && <div className="setup-error" role="alert"><span>{view.serverProblem}</span></div>}
          <p className="provider-line">Friends needs your 0rqestra account.</p>
          <AccountForms api={api} view={view} onView={onView} initialStep="sign_in"/>
        </div>
      ) : !view.username ? (
        <div className="provider-card teams-card">
          {view.serverProblem && <div className="setup-error" role="alert"><span>{view.serverProblem}</span></div>}
          {view.needsUsername ? <UsernameForm api={api} view={view} onView={onView}/> : <p className="provider-line">Loading your account…</p>}
        </div>
      ) : (
        <>
          {view.serverProblem && <div className="setup-error" role="alert"><span>Could not reach the 0rqestra server: {view.serverProblem}</span></div>}
          <ShareUsername username={view.username}/>
          <ProjectInvitesInbox api={api} view={view} notify={notify} onView={onView}/>
          <TeamInvitesInbox api={api} view={view} notify={notify} onView={onView}/>
          <AddFriend api={api} onView={onView} onAccept={(id) => respond(id, true)}/>
          <div className="provider-card teams-card" aria-label="Your friends">
            <h2>Friends <span className="friends-count">{groups.friends.length}</span></h2>
            {groups.friends.length === 0 ? <p className="provider-line">No friends yet. Add someone by their username.</p> : (
              <ul className="teams-list">
                {groups.friends.map((f) => <FriendRow key={f.requestId} api={api} friend={f} view={view} projects={projects} onCreateProject={onCreateProject} onOpenProject={onOpenProject} notify={notify} onView={onView} pending={pending} run={run}/>)}
              </ul>
            )}
          </div>
          <div className="provider-card teams-card" aria-label="Incoming requests">
            <h2>Incoming requests <span className="friends-count">{groups.incoming.length}</span></h2>
            {groups.incoming.length === 0 ? <p className="provider-line">No requests waiting for your answer.</p> : (
              <ul className="teams-list">
                {groups.incoming.map((f) => (
                  <li key={f.requestId}>
                    <Person person={f}/>
                    <span className="friends-actions">
                      <button type="button" className="button primary-button" disabled={pending} onClick={() => run(async () => { await respond(f.requestId, true); notify?.(`You and @${f.username} are now friends.`); })}>Accept</button>
                      <button type="button" className="button" disabled={pending} onClick={() => run(async () => { await respond(f.requestId, false); notify?.(`Declined @${f.username}'s request.`); })}>Decline</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="provider-card teams-card" aria-label="Sent requests">
            <h2>Sent requests <span className="friends-count">{groups.outgoing.length}</span></h2>
            {groups.outgoing.length === 0 ? <p className="provider-line">No requests waiting for someone else's answer.</p> : (
              <ul className="teams-list">
                {groups.outgoing.map((f) => (
                  <li key={f.requestId}><Person person={f}/><small>Waiting for an answer</small>
                    <button type="button" className="provider-text-link" disabled={pending} onClick={() => run(async () => {
                      const r = await api.cancelFriend(f.userId);
                      onView(r.view);
                      notify?.(r.result === 'accepted' ? `@${f.username} accepted just before you cancelled. You are friends now.` : `Cancelled your request to @${f.username}.`);
                    })}>Cancel</button></li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
