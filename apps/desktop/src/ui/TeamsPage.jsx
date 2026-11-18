// Teams: sign in with an email code, create or join a team, and link this computer's checkout of a
// GitHub repository to a project the team shares. The main process does every step
// (main/teams/teams-ipc.ts); this page never handles a token or a folder path it typed itself.
// Solo projects work without any of this.
import React, { useEffect, useState } from 'react';
import { errorText, inviteLine, linkLine, localName, projectChoices, repoName, selectionMatches, signInTitle } from './teams-ui.mjs';

function useAction(notify) {
  const [pending, setPending] = useState(false);
  const run = async (fn) => {
    setPending(true);
    try { return await fn(); } catch (error) { notify?.(errorText(error)); return undefined; } finally { setPending(false); }
  };
  return [pending, run];
}

function SignIn({ api, view, notify, onView }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, run] = useAction(notify);
  if (view.status === 'code_sent') {
    return (
      <form className="provider-card teams-card" onSubmit={(e) => { e.preventDefault(); run(async () => { onView(await api.verifyCode(code)); setCode(''); }); }}>
        <h2>Enter the code</h2>
        <p className="provider-line">We sent a one-time code to <strong>{view.pendingEmail}</strong>. It can take a minute to arrive; check spam too.</p>
        <label className="teams-field">Code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" maxLength={12} required/></label>
        <div className="setup-actions">
          <button className="button primary-button" type="submit" disabled={pending || !code.trim()}>Sign in</button>
          <button className="button" type="button" disabled={pending} onClick={() => run(async () => onView(await api.sendCode(view.pendingEmail)))}>Send a new code</button>
          <button className="button" type="button" disabled={pending} onClick={() => run(async () => onView(await api.cancelCode()))}>Use another email</button>
        </div>
      </form>
    );
  }
  return (
    <form className="provider-card teams-card" onSubmit={(e) => { e.preventDefault(); run(async () => onView(await api.sendCode(email))); }}>
      <h2>Sign in to Teams</h2>
      <p className="provider-line">Teams has its own account, separate from Claude Code and Codex. Enter your email and we send you a one-time code; there is no password.</p>
      <label className="teams-field">Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" maxLength={254} required/></label>
      <div className="setup-actions"><button className="button primary-button" type="submit" disabled={pending || !email.trim()}>Send code</button></div>
    </form>
  );
}

function StartTeam({ api, notify, onView }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [pending, run] = useAction(notify);
  return (
    <div className="teams-start">
      <form className="provider-card teams-card" onSubmit={(e) => { e.preventDefault(); run(async () => { onView(await api.createTeam(name)); setName(''); notify?.('Team created. You are its owner.'); }); }}>
        <h2>Create a team</h2>
        <p className="provider-line">You become the owner: you invite people and register the repositories the team shares.</p>
        <label className="teams-field">Team name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Our studio" required/></label>
        <div className="setup-actions"><button className="button primary-button" type="submit" disabled={pending || !name.trim()}>Create team</button></div>
      </form>
      <form className="provider-card teams-card" onSubmit={(e) => { e.preventDefault(); run(async () => { onView(await api.acceptInvite(code)); setCode(''); notify?.('You joined the team.'); }); }}>
        <h2>Join a team</h2>
        <p className="provider-line">Paste the invite code the owner sent you. It only works for the email you are signed in with.</p>
        <label className="teams-field">Invite code<input value={code} onChange={(e) => setCode(e.target.value)} maxLength={60} placeholder="1A2B3C-4D5E6F-7A8B9C-0D1E2F" autoComplete="off" spellCheck={false} required/></label>
        <div className="setup-actions"><button className="button primary-button" type="submit" disabled={pending || !code.trim()}>Join team</button></div>
      </form>
    </div>
  );
}

// Chooses a folder in the system dialog and shows what the main process found in it.
function CheckoutPicker({ api, notify, selection, onSelection }) {
  const [pending, run] = useAction(notify);
  return (
    <div className="teams-picker">
      <button type="button" className="button" disabled={pending} onClick={() => run(async () => { const s = await api.chooseCheckout(); if (s) onSelection(s); })}>{selection ? 'Choose another folder' : 'Choose checkout folder…'}</button>
      {selection && (
        <div className="teams-selection">
          <p className="setup-path" title={selection.path}>{selection.path}</p>
          {selection.branch !== undefined && selection.id && <p className="provider-line">Branch: {selection.branch || 'detached HEAD'}{selection.repo ? ` · ${repoName(selection.repo)} (remote ${selection.repo.remote})` : ''}</p>}
          {selection.needsRemoteChoice && (
            <label className="teams-field">Which remote is the shared repository?
              <select defaultValue="" onChange={(e) => e.target.value && run(async () => onSelection(await api.chooseRemote(selection.id, e.target.value)))}>
                <option value="">Choose a remote…</option>
                {selection.remotes.filter((r) => r.identity).map((r) => <option key={r.name} value={r.name}>{r.name}: {repoName(r.identity)}</option>)}
              </select>
            </label>
          )}
          {selection.problem && !selection.needsRemoteChoice && <div className="setup-error" role="alert"><span>{selection.problem}</span></div>}
        </div>
      )}
    </div>
  );
}

function ProjectSelect({ choices, value, onChange, newName }) {
  return (
    <label className="teams-field">0rqestra project on this computer
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a project…</option>
        {choices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        {newName && <option value="__new__">New project “{newName}”</option>}
      </select>
    </label>
  );
}

function RegisterProject({ api, team, teams, projects, notify, onView, onDone }) {
  const [selection, setSelection] = useState(null);
  const [local, setLocal] = useState('');
  const [name, setName] = useState('');
  const [pending, run] = useAction(notify);
  const choices = projectChoices(projects, teams);
  const chosen = projects.find((p) => p.id === local);
  const ready = selection?.repo && local && name.trim();
  const submit = () => run(async () => {
    onView(await api.registerProject({ teamId: team.id, selectionId: selection.id, remote: selection.repo.remote, localProjectId: local, name: name.trim() }));
    notify?.(`${repoName(selection.repo)} is now shared with ${team.name}.`);
    onDone();
  });
  return (
    <div className="teams-subform">
      <h4>Register a repository</h4>
      <ProjectSelect choices={choices} value={local} onChange={(v) => { setLocal(v); const p = projects.find((x) => x.id === v); if (p && !name) setName(p.name); }}/>
      <CheckoutPicker api={api} notify={notify} selection={selection} onSelection={(s) => { setSelection(s); if (s.repo && !name) setName(chosen?.name || s.repo.name); }}/>
      <label className="teams-field">Shared project name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required/></label>
      <div className="setup-actions">
        <button type="button" className="button primary-button" disabled={pending || !ready} onClick={submit}>Register {selection?.repo ? repoName(selection.repo) : 'repository'}</button>
        <button type="button" className="button" onClick={onDone}>Cancel</button>
      </div>
      {choices.length === 0 && <p className="provider-line">Every project here is already linked. Create a new project in the sidebar first.</p>}
    </div>
  );
}

function LinkCheckout({ api, project, teams, projects, onCreateProject, notify, onView, onDone }) {
  const [selection, setSelection] = useState(null);
  const [local, setLocal] = useState(project.link?.localProjectId || '');
  const [pending, run] = useAction(notify);
  const choices = projectChoices(projects, teams, project.id);
  const matches = selectionMatches(selection, project.repo.key);
  const submit = () => run(async () => {
    const localProjectId = local === '__new__' ? onCreateProject(project.name) : local;
    onView(await api.linkCheckout({ sharedProjectId: project.id, selectionId: selection.id, localProjectId }));
    notify?.(`Your checkout is linked to ${project.name}.`);
    onDone();
  });
  return (
    <div className="teams-subform">
      <h4>Link your checkout of {repoName(project.repo)}</h4>
      <ProjectSelect choices={choices} value={local} onChange={setLocal} newName={onCreateProject ? project.name : null}/>
      <CheckoutPicker api={api} notify={notify} selection={selection} onSelection={setSelection}/>
      {selection?.id && !matches && <div className="setup-error" role="alert"><span>This folder is not a clone of {repoName(project.repo)}{selection.repo ? ` (it is ${repoName(selection.repo)})` : ''}. Choose your checkout of {repoName(project.repo)}.</span></div>}
      {selection?.id && matches && <p className="provider-line setup-use-current">✓ This folder is a clone of {repoName(project.repo)}. Your current branch stays as it is.</p>}
      <div className="setup-actions">
        <button type="button" className="button primary-button" disabled={pending || !matches || !local} onClick={submit}>Link checkout</button>
        <button type="button" className="button" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function SharedProject({ api, project, teams, projects, onCreateProject, notify, onView }) {
  const [linking, setLinking] = useState(false);
  const [pending, run] = useAction(notify);
  const line = linkLine(project.link);
  return (
    <li className="teams-project">
      <div className="teams-project-head">
        <div><strong>{project.name}</strong><small>github.com/{repoName(project.repo)}</small></div>
        <span className={`provider-badge teams-tone-${line.tone}`}>{line.text}</span>
      </div>
      {project.link && <p className="provider-line">In “{localName(projects, project.link.localProjectId)}” · <span className="setup-path" title={project.link.path}>{project.link.path}</span>{project.link.branch ? ` · branch ${project.link.branch}` : ''}</p>}
      {project.link?.problem && <div className="setup-error" role="alert"><span>{project.link.problem}</span></div>}
      {linking ? (
        <LinkCheckout api={api} project={project} teams={teams} projects={projects} onCreateProject={onCreateProject} notify={notify} onView={onView} onDone={() => setLinking(false)}/>
      ) : (
        <div className="setup-actions">
          <button type="button" className={`button ${project.link ? '' : 'primary-button'}`} onClick={() => setLinking(true)}>{project.link ? 'Link another checkout' : 'Link my checkout'}</button>
          {project.link?.state === 'linked' && <button type="button" className="button" disabled={pending} onClick={() => run(() => api.openCheckout(project.id))}>Open folder</button>}
          {project.link && <button type="button" className="button" disabled={pending} onClick={() => run(async () => onView(await api.unlink(project.id)))}>Unlink</button>}
        </div>
      )}
    </li>
  );
}

function Invites({ api, team, notify, onView }) {
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState(null);
  const [pending, run] = useAction(notify);
  const open = team.invites.filter((i) => i.state === 'pending');
  return (
    <div className="teams-section">
      <h3>Invite a teammate</h3>
      <form className="teams-inline" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.createInvite(team.id, email); setCreated(r.invite); onView(r.view); setEmail(''); }); }}>
        <input type="email" aria-label="Teammate's email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" maxLength={254} required/>
        <button className="button" type="submit" disabled={pending || !email.trim()}>Create invite</button>
      </form>
      {created && (
        <div className="teams-invite-code" role="status">
          <span>Invite for <strong>{created.email}</strong>. Send it yourself; it works once, for that email only.</span>
          <div className="setup-command"><code>{created.code}</code><button type="button" className="button" onClick={() => run(async () => { await api.copyInvite(created.id); notify?.('Invite copied. Paste it into a message to your teammate.'); })}>Copy invite</button></div>
        </div>
      )}
      {open.length > 0 && (
        <ul className="teams-list">
          {open.map((i) => (
            <li key={i.id}><span>{i.email}</span><small>{inviteLine(i)}</small><button type="button" className="provider-text-link" disabled={pending} onClick={() => run(async () => { onView(await api.revokeInvite(i.id)); if (created?.id === i.id) setCreated(null); })}>Withdraw</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamCard({ api, team, teams, projects, onCreateProject, notify, onView }) {
  const [registering, setRegistering] = useState(false);
  return (
    <article className="provider-card teams-card teams-team" aria-label={`Team ${team.name}`}>
      <header className="provider-card-head">
        <div><h2>{team.name}</h2><small>{team.isOwner ? 'You own this team' : 'Member'} · {team.members.length} {team.members.length === 1 ? 'person' : 'people'}</small></div>
      </header>
      <div className="teams-section">
        <h3>Members</h3>
        <ul className="teams-list">
          {team.members.map((m) => <li key={m.userId}><span>{m.email}{m.isYou ? ' (you)' : ''}</span><small>{m.role === 'owner' ? 'Owner' : 'Member'}</small></li>)}
        </ul>
      </div>
      {team.isOwner && <Invites api={api} team={team} notify={notify} onView={onView}/>}
      <div className="teams-section">
        <h3>Shared projects</h3>
        {team.projects.length === 0 && <p className="provider-line">{team.isOwner ? 'No repository is shared yet. Register one from a project on this computer.' : 'The owner has not shared a repository yet.'}</p>}
        <ul className="teams-projects">
          {team.projects.map((p) => <SharedProject key={p.id} api={api} project={p} teams={teams} projects={projects} onCreateProject={onCreateProject} notify={notify} onView={onView}/>)}
        </ul>
        {team.isOwner && (registering
          ? <RegisterProject api={api} team={team} teams={teams} projects={projects} notify={notify} onView={onView} onDone={() => setRegistering(false)}/>
          : <div className="setup-actions"><button type="button" className="button" onClick={() => setRegistering(true)}>Register a repository</button></div>)}
      </div>
    </article>
  );
}

// The Teams view lives in App (it also drives the Team Bridge in the tree); this page shows it.
export function TeamsPage({ view, onView: setView, onBack, notify, projects, onCreateProject }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.teams : null;
  const [loading, setLoading] = useState(false);
  const onView = (v) => { if (v && typeof v === 'object' && v.status) setView(v); };
  const refresh = async () => {
    if (!api) return;
    setLoading(true);
    try { onView(await api.status(true)); } catch (error) { notify?.(errorText(error)); } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const [signingOut, runSignOut] = useAction(notify);
  return (
    <section className="accounts-page teams-page" aria-label="Teams">
      <div className="accounts-heading">
        <div>
          <div className="eyebrow">TEAMS</div>
          <h1>Teams<span className="account-heading-dot">.</span></h1>
          <p>Work on one GitHub repository together. Each person keeps their own checkout and branch on their own computer; the team shares the repository and who is in it. Solo projects work without Teams.</p>
        </div>
        <div className="accounts-actions">
          {api && view?.status === 'signed_in' && <button className="button" disabled={loading} onClick={refresh}>{loading ? 'Loading…' : 'Refresh'}</button>}
          {api && view?.status === 'signed_in' && <button className="button" disabled={signingOut} onClick={() => runSignOut(async () => onView(await api.signOut()))}>Sign out</button>}
          <button className="button" onClick={onBack}>Back</button>
        </div>
      </div>
      {!api ? (
        <div className="simulated-notice" role="note"><strong>Preview</strong><h2>Teams works in the installed app.</h2></div>
      ) : !view ? (
        <p className="provider-line">Loading…</p>
      ) : view.status === 'unconfigured' ? (
        <div className="provider-card teams-card">
          <h2>Teams is not set up on this computer</h2>
          {view.configProblem ? <div className="setup-error" role="alert"><span>{view.configProblem}</span></div> : <p className="provider-line">This build has no Teams server. The rest of 0rqestra works as usual.</p>}
          <p className="provider-line">To set it up, put the Supabase project URL and publishable key in <code>teams-config.json</code> in the app's data folder, or set ORQESTRA_SUPABASE_URL and ORQESTRA_SUPABASE_PUBLISHABLE_KEY. See docs/teams-setup.md.</p>
        </div>
      ) : (
        <>
          <p className="provider-line teams-who">{signInTitle(view)}{view.status === 'signed_in' && !view.rememberSession ? ' · this computer cannot store the session securely, so you sign in again after a restart' : ''}</p>
          {view.loadProblem && <div className="setup-error" role="alert"><span>{view.loadProblem}</span></div>}
          {view.status !== 'signed_in' ? (
            <SignIn api={api} view={view} notify={notify} onView={onView}/>
          ) : (
            <>
              <div className="teams-grid">
                {view.teams.map((t) => <TeamCard key={t.id} api={api} team={t} teams={view.teams} projects={projects} onCreateProject={onCreateProject} notify={notify} onView={onView}/>)}
              </div>
              <StartTeam api={api} notify={notify} onView={onView}/>
            </>
          )}
        </>
      )}
    </section>
  );
}
