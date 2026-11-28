// "Add friend or team…" from a project's ⋯ menu: invite a friend to this project, or share it with a
// team you own. Before anything changes it shows who has access now, who is pending, and who would
// gain access. It reuses the project invitation and shared-project calls (main/teams); each person's
// folder and Git branch stay on their own computer.
import React, { useState } from 'react';
import { CheckoutPicker } from './TeamsCheckout.jsx';
import { displayName, errorText, friendLabel, friendStatus, initialsOf, repoName, shareOptions } from './teams-ui.mjs';

function Status({ view, userId }) {
  const s = friendStatus(view, userId);
  if (!s.text) return null;
  return <span className={`fr-status fr-status-${s.state}`}><i aria-hidden="true"/>{s.text}</span>;
}

export function ShareProjectDialog({ project, view, onView, notify, onClose }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.teams : null;
  const options = shareOptions(view, project.id);
  const [mode, setMode] = useState('friend');
  const [friendId, setFriendId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [selection, setSelection] = useState(null);
  const [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(null);
  const run = async (fn) => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try { await fn(); } catch (error) { setMessage({ tone: 'error', text: errorText(error) }); } finally { setPending(false); }
  };

  if (!api || !options) {
    return <div className="share-dialog">
      <h2 id="dialog-title">Add friend or team</h2>
      <p className="fr-muted">Sign in to your 0rqestra account (profile menu) to invite friends or share this project with a team.</p>
      <div className="share-actions"><button type="button" className="fr-secondary" onClick={onClose}>Close</button></div>
    </div>;
  }
  const { linked, friends, teams } = options;
  const friend = friends.find((f) => f.userId === friendId) || null;
  const team = teams.find((t) => t.id === teamId) || null;
  const repoReady = Boolean(selection?.id && selection.repo);
  const sendInvite = () => run(async () => {
    const v = linked
      ? await api.startProjectTogether({ friendUserId: friend.userId, sharedProjectId: linked.project.id })
      : await api.startProjectTogether({ friendUserId: friend.userId, localProjectId: project.id, selectionId: selection.id, name: name.trim() || project.name, remote: selection.repo.remote });
    onView(v);
    setFriendId('');
    setMessage({ tone: 'ok', text: `Invitation sent to ${friendLabel(friend).name}. It shows as Pending until they accept.` });
  });
  const shareWithTeam = () => run(async () => {
    const v = await api.registerProject({ teamId: team.id, selectionId: selection.id, localProjectId: project.id, name: name.trim() || project.name, remote: selection.repo.remote });
    onView(v);
    notify?.(`${project.name} is shared with ${team.name}.`);
    onClose();
  });

  return <div className="share-dialog" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
    <div className="share-head">
      <h2 id="dialog-title">Add friend or team to “{project.name}”</h2>
      <button type="button" className="fr-icon" aria-label="Close" onClick={onClose}>×</button>
    </div>

    <section className="share-access" aria-label="Who has access">
      {linked ? <>
        <p className="share-line"><strong>Shared with {linked.team.name}</strong> · github.com/{repoName(linked.project.repo)}</p>
        <ul className="share-people">
          {linked.team.members.map((m) => <li key={m.userId}><span className="fr-avatar fr-avatar-sm" aria-hidden="true">{initialsOf({ username: m.name })}</span><span className="share-name">{displayName(m.name)}{m.isYou ? ' (you)' : ''}</span><small>{m.role === 'owner' ? 'Owner' : 'Member'}</small>{!m.isYou && <Status view={view} userId={m.userId}/>}</li>)}
          {options.pending.map((i) => <li key={i.id}><span className="fr-avatar fr-avatar-sm" aria-hidden="true">{initialsOf(i)}</span><span className="share-name">{friendLabel(i).name}</span><span className="fr-badge fr-badge-warn">Pending</span></li>)}
        </ul>
      </> : <p className="share-line">Only you have this project now. It is not shared yet.</p>}
    </section>

    <div className="fr-tabs share-tabs" role="tablist" aria-label="Add to this project">
      <button type="button" role="tab" aria-selected={mode === 'friend'} className={`fr-tab ${mode === 'friend' ? 'is-on' : ''}`} onClick={() => { setMode('friend'); setMessage(null); }}>Invite a friend</button>
      <button type="button" role="tab" aria-selected={mode === 'team'} className={`fr-tab ${mode === 'team' ? 'is-on' : ''}`} onClick={() => { setMode('team'); setMessage(null); }}>Share with a team</button>
    </div>

    {mode === 'friend' ? (
      <section className="share-body" role="tabpanel" aria-label="Invite a friend">
        {friends.length === 0 ? <p className="fr-muted">No friends yet. Add one on the Friends page first.</p> : (
          <ul className="share-choices" role="radiogroup" aria-label="Friends">
            {friends.map((f) => (
              <li key={f.userId}>
                <label className={`share-choice ${friendId === f.userId ? 'is-on' : ''} ${f.reason ? 'is-disabled' : ''}`}>
                  <input type="radio" name="share-friend" value={f.userId} disabled={Boolean(f.reason)} checked={friendId === f.userId} onChange={() => setFriendId(f.userId)}/>
                  <span className="fr-avatar fr-avatar-sm" aria-hidden="true">{initialsOf(f)}</span>
                  <span className="share-name"><strong>{friendLabel(f).name}</strong>{friendLabel(f).handle && <small>{friendLabel(f).handle}</small>}</span>
                  <Status view={view} userId={f.userId}/>
                  {f.reason && <small className={f.pending ? 'fr-badge fr-badge-warn' : 'share-reason'}>{f.reason}</small>}
                </label>
              </li>
            ))}
          </ul>
        )}
        {!linked && friend && <div className="share-repo">
          <p className="fr-muted">The invitation shares this project’s GitHub repository in a team of its own, so {friendLabel(friend).name} sees only this project. Choose your checkout of it:</p>
          <CheckoutPicker api={api} notify={notify} selection={selection} onSelection={setSelection}/>
          <label className="fr-field">Shared project name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80}/></label>
        </div>}
        {friend && (linked || repoReady) && <p className="share-summary">Invite <strong>{friendLabel(friend).name}</strong> to <strong>{linked ? linked.project.name : (name.trim() || project.name)}</strong> · github.com/{repoName(linked ? linked.project.repo : selection.repo)}. They can accept the next time they open 0rqestra; they do not need to be online now.</p>}
        <div className="share-actions">
          <button type="button" className="fr-primary" disabled={pending || !friend || (!linked && !repoReady)} onClick={sendInvite}>Send invitation</button>
          <button type="button" className="fr-secondary" onClick={onClose}>Close</button>
        </div>
      </section>
    ) : (
      <section className="share-body" role="tabpanel" aria-label="Share with a team">
        {linked ? <p className="fr-muted">This project is already shared with {linked.team.name}. To share it with another team, remove it from {linked.team.name} first (project ⋯ menu → Remove from team).</p>
          : teams.length === 0 ? <p className="fr-muted">You own no teams yet. Create one on the Teams page, or invite a friend instead.</p>
          : <>
            <ul className="share-choices" role="radiogroup" aria-label="Teams you own">
              {teams.map((t) => (
                <li key={t.id}>
                  <label className={`share-choice ${teamId === t.id ? 'is-on' : ''}`}>
                    <input type="radio" name="share-team" value={t.id} checked={teamId === t.id} onChange={() => setTeamId(t.id)}/>
                    <span className="share-name"><strong>{t.name}</strong><small>{t.gaining.length ? `${t.gaining.length} ${t.gaining.length === 1 ? 'member' : 'members'} besides you` : 'Only you'}{t.otherProjects.length ? ` · also shares ${t.otherProjects.join(', ')}` : ''}</small></span>
                  </label>
                </li>
              ))}
            </ul>
            {team && <div className="share-repo">
              <p className="share-line"><strong>These people will gain access:</strong> {team.gaining.length ? team.gaining.map((m) => displayName(m.name)).join(', ') : 'nobody else yet (only you are in this team)'}.</p>
              <p className="fr-muted">Choose your GitHub checkout of this project. Each member links their own folder and branch on their own computer.</p>
              <CheckoutPicker api={api} notify={notify} selection={selection} onSelection={setSelection}/>
              <label className="fr-field">Shared project name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80}/></label>
            </div>}
            <div className="share-actions">
              <button type="button" className="fr-primary" disabled={pending || !team || !repoReady} onClick={shareWithTeam}>{team ? `Share with ${team.name}` : 'Share with team'}</button>
              <button type="button" className="fr-secondary" onClick={onClose}>Close</button>
            </div>
          </>}
      </section>
    )}
    {message && <p className={`fr-message fr-message-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
  </div>;
}
