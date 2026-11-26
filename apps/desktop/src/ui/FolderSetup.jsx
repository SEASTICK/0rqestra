// "Work in a folder": the few steps that let the team improve an app that already exists, such as
// 0rqestra itself. Choose the folder; the agents may read it and propose changes, each reviewed before it
// reaches the folder; the folder's own checks (tests, lint) can be approved in one go. Everything is
// granted through Computer access, where it can be changed or revoked later.
import React, { useState } from 'react';

const errorText = (e) => String(e?.message || e || 'That did not work.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function FolderSetup({ project, Icon, notify, onClose, onDone, initial = null }) {
  const api = window.orqestra?.access;
  // `initial`: a folder that is already chosen (just cloned from GitHub).
  const [info, setInfo] = useState(initial);
  const [checks, setChecks] = useState(() => new Set((initial?.checks || []).map((c) => c.command)));
  const [allow, setAllow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const agents = (project.graph?.nodes || []).filter((n) => n.role !== 'Manager' && n.agentKey);
  const choose = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.setupFolder(project.id);
      if (r) { setInfo(r); setChecks(new Set(r.checks.map((c) => c.command))); }
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const done = async () => {
    setBusy(true); setError(null);
    try {
      const chosen = info.checks.filter((c) => checks.has(c.command));
      for (const c of chosen) await api.addCommand(project.id, { label: c.label, command: c.command, folderId: info.folderId, cwd: c.cwd });
      if (!allow) await api.setFolderWrite(project.id, info.folderId, false);
      for (const n of agents) await api.setAgent(project.id, n.agentKey, { read: true, write: allow, commands: chosen.length > 0 });
      notify?.(`Ready. The team can now read ${info.folder}${allow ? ' and propose changes you review' : ''}.`);
      onDone?.(info);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  if (!api) return <div><h2 id="dialog-title">Work in a folder</h2><p className="dialog-description">This works in the installed app.</p></div>;
  const name = info ? info.folder.split(/[\\/]/).filter(Boolean).pop() : null;
  return <div className="folder-setup">
    <div className="dialog-heading"><span className="dialog-icon"><Icon name="folder" size={21}/></span><button className="icon-button" type="button" aria-label="Close folder setup" onClick={onClose}><Icon name="close"/></button></div>
    <h2 id="dialog-title">Work in a folder</h2>
    <p className="dialog-description">{initial ? `${initial.repo || 'The repository'} is ready on this computer${initial.reused ? ' (it was already there)' : ''}.` : 'Choose the folder of an app you already have, for example your checkout of 0rqestra.'} The team reads the code and proposes changes; you see each change as a diff and decide what reaches the folder. Then you can commit and push.</p>
    {!info ? <div className="folder-step">
      <button type="button" className="button primary-button" disabled={busy} onClick={choose}><Icon name="folder" size={15}/> {busy ? 'Choosing…' : 'Choose folder'}</button>
    </div> : <>
      <div className="folder-chosen">
        <Icon name="folder" size={18}/>
        <span><strong>{name}</strong><small className="setup-path">{info.folder}</small></span>
        <span className="git-branch">{info.git?.repo ? (info.git.branch ? `git · ${info.git.branch}` : 'git') : 'not a git repository'}</span>
      </div>
      <label className="folder-option"><input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)}/><span><strong>Let the team propose changes</strong><small>Each change waits for you as a diff under Computer access; nothing is written until you apply it.</small></span></label>
      {info.checks.length > 0 && <div className="folder-checks">
        <strong>Checks the team may run</strong>
        <small>Found in the folder. The agents may run only these, in the folder itself: they test the code as it is there, so a change is tested after you apply it.</small>
        {info.checks.map((c) => <label key={c.command} className="folder-option"><input type="checkbox" checked={checks.has(c.command)} onChange={(e) => { const next = new Set(checks); if (e.target.checked) next.add(c.command); else next.delete(c.command); setChecks(next); }}/><span><strong>{c.label}</strong><code>{c.command}</code></span></label>)}
      </div>}
      <p className="agent-muted">{agents.length ? `${agents.map((n) => n.name).join(', ')} get this access in this project. You can change or revoke it under the project’s ⋯ → Computer access.` : 'This project has no agents yet. Create the team, then give them access under the project’s ⋯ → Computer access.'}</p>
    </>}
    {error && <div className="setup-error" role="alert"><span>{error}</span></div>}
    <div className="dialog-footer"><button className="button" type="button" onClick={onClose}>{info ? 'Later' : 'Cancel'}</button>{info && <button className="button primary-button" type="button" disabled={busy} onClick={done}>{busy ? 'Setting up…' : 'Start working'}</button>}</div>
  </div>;
}
