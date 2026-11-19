// Friends: find an account by its exact username, send a friend request, and answer requests and
// team invitations. Only usernames are shown; email addresses stay private. The main process does
// every step (main/teams); this page never handles a token.
import React, { useEffect, useState } from 'react';
import { AccountForms } from './AccountWelcome.jsx';
import { errorText, friendGroups, incomingTeamInvites } from './teams-ui.mjs';
import { USERNAME_RULE, cleanUsername } from './account-ui.mjs';

function useAction(notify) {
  const [pending, setPending] = useState(false);
  const run = async (fn) => {
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

function AddFriend({ api, notify, onView }) {
  const [name, setName] = useState('');
  const [pending, run] = useAction(notify);
  const clean = cleanUsername(name);
  return (
    <form className="provider-card teams-card" onSubmit={(e) => { e.preventDefault(); run(async () => {
      const r = await api.addFriend(clean);
      onView(r.view);
      setName('');
      notify?.(r.status === 'accepted' ? `You and @${clean} are now friends.` : `Friend request sent to @${clean}.`);
    }); }}>
      <h2>Add a friend</h2>
      <p className="provider-line">Type their exact username. They see your request the next time 0rqestra is open and can accept or decline it.</p>
      <div className="teams-inline">
        <input aria-label="Username" value={name} onChange={(e) => setName(e.target.value)} placeholder="username" maxLength={25} spellCheck={false} autoComplete="off" required/>
        <button className="button primary-button" type="submit" disabled={pending || !USERNAME_RULE.test(clean)}>Send request</button>
      </div>
    </form>
  );
}

export function FriendsPage({ view, onView: setView, onBack, notify, onTeams }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.teams : null;
  const onView = (v) => { if (v && typeof v === 'object' && v.status) setView(v); };
  const [pending, run] = useAction(notify);
  useEffect(() => { if (api) api.status(true).then(onView).catch(() => {}); }, []);
  const groups = friendGroups(view);
  return (
    <section className="accounts-page teams-page friends-page" aria-label="Friends">
      <div className="accounts-heading">
        <div>
          <div className="eyebrow">FRIENDS</div>
          <h1>Friends<span className="account-heading-dot">.</span></h1>
          <p>Add the people you work with. Friends can be invited to your teams; everyone sees usernames only, never email addresses.</p>
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
      ) : (
        <>
          <p className="provider-line teams-who">{view.username ? `You are @${view.username}` : 'Choose a username first'}</p>
          {view.serverProblem && <div className="setup-error" role="alert"><span>{view.serverProblem}</span></div>}
          <TeamInvitesInbox api={api} view={view} notify={notify} onView={onView}/>
          {groups.incoming.length > 0 && (
            <div className="provider-card teams-card" aria-label="Friend requests">
              <h2>Friend requests</h2>
              <ul className="teams-list">
                {groups.incoming.map((f) => (
                  <li key={f.requestId}>
                    <span>@{f.username}</span>
                    <span className="friends-actions">
                      <button type="button" className="button primary-button" disabled={pending} onClick={() => run(async () => { onView(await api.respondFriend(f.requestId, true)); notify?.(`You and @${f.username} are now friends.`); })}>Accept</button>
                      <button type="button" className="button" disabled={pending} onClick={() => run(async () => onView(await api.respondFriend(f.requestId, false)))}>Decline</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AddFriend api={api} notify={notify} onView={onView}/>
          <div className="provider-card teams-card" aria-label="Your friends">
            <h2>Your friends</h2>
            {groups.friends.length === 0 ? <p className="provider-line">No friends yet. Add someone by their username.</p> : (
              <ul className="teams-list">
                {groups.friends.map((f) => (
                  <li key={f.requestId}><span>@{f.username}</span><small>Friend</small>
                    <button type="button" className="provider-text-link" disabled={pending} onClick={() => run(async () => onView(await api.removeFriend(f.userId)))}>Remove</button></li>
                ))}
              </ul>
            )}
            {groups.outgoing.length > 0 && (
              <>
                <h3>Waiting for an answer</h3>
                <ul className="teams-list">
                  {groups.outgoing.map((f) => (
                    <li key={f.requestId}><span>@{f.username}</span><small>Request sent</small>
                      <button type="button" className="provider-text-link" disabled={pending} onClick={() => run(async () => onView(await api.removeFriend(f.userId)))}>Withdraw</button></li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
