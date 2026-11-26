// Friends: find an account by its exact username, send a friend request, and answer requests and
// team invitations. Only usernames and display names are shown; email addresses stay private. The
// main process does every step (main/teams); this page never handles a token.
import React, { useEffect, useState } from 'react';
import { AccountForms, UsernameForm } from './AccountWelcome.jsx';
import { candidateState, errorText, friendGroups, friendLabel, incomingTeamInvites, sendOutcomeText } from './teams-ui.mjs';
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

export function FriendsPage({ view, onView: setView, onBack, notify, onTeams }) {
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
          <TeamInvitesInbox api={api} view={view} notify={notify} onView={onView}/>
          <AddFriend api={api} onView={onView} onAccept={(id) => respond(id, true)}/>
          <div className="provider-card teams-card" aria-label="Your friends">
            <h2>Friends <span className="friends-count">{groups.friends.length}</span></h2>
            {groups.friends.length === 0 ? <p className="provider-line">No friends yet. Add someone by their username.</p> : (
              <ul className="teams-list">
                {groups.friends.map((f) => (
                  <li key={f.requestId}><Person person={f}/>
                    <button type="button" className="provider-text-link" disabled={pending} onClick={() => { if (window.confirm(`Remove @${f.username} from your friends? You both lose the friendship.`)) run(async () => { onView(await api.removeFriend(f.userId)); notify?.(`@${f.username} is no longer your friend.`); }); }}>Remove</button></li>
                ))}
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
