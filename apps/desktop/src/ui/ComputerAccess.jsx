import React, { useEffect, useState } from 'react';

// Project → Computer access: the folders on this computer that this project's agents may use, what
// each agent may do there, the checks they may run, and reviewing agent changes before they reach a
// real folder. Everything here stays on this computer. The main process enforces it; this page only
// shows it and asks for changes.

const errorText = (e) => String(e?.message || e || 'That did not work.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function useAccess(projectId, notify) {
  const api = typeof window !== 'undefined' ? window.orqestra?.access : null;
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return undefined;
    let live = true;
    const load = () => api.view(projectId).then((v) => { if (live) setView(v); }).catch((e) => notify?.(errorText(e)));
    void load();
    const off = api.subscribe?.((event) => { if (event?.projectId === projectId) void load(); });
    return () => { live = false; off?.(); };
  }, [projectId]);
  const run = async (fn) => {
    setBusy(true);
    try { const v = await fn(api); if (v && v.folders) setView(v); return v; } catch (e) { notify?.(errorText(e)); return null; } finally { setBusy(false); }
  };
  return { api, view, busy, run, setView };
}

const agentsOf = (project) => (project.graph?.nodes || []).filter((n) => n.role !== 'Manager' && n.agentKey);
const accessOf = (view, key) => view?.agents?.[key] || { read: false, write: false, commands: false };

export function AccessToggles({ access, busy, onChange, name }) {
  const set = (patch) => {
    const next = { ...access, ...patch };
    if (patch.read === false) { next.write = false; next.commands = false; }
    onChange(next);
  };
  return (
    <span className="access-toggles" role="group" aria-label={`Computer access for ${name}`}>
      <label><input type="checkbox" checked={access.read} disabled={busy} onChange={(e) => set({ read: e.target.checked })}/> Read</label>
      <label><input type="checkbox" checked={access.write} disabled={busy} onChange={(e) => set({ write: e.target.checked })}/> Apply reviewed changes</label>
      <label><input type="checkbox" checked={access.commands} disabled={busy} onChange={(e) => set({ commands: e.target.checked })}/> Run approved checks</label>
    </span>
  );
}

function CommandForm({ view, busy, onAdd }) {
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [folderId, setFolderId] = useState(view.folders[0]?.id || '');
  const [cwd, setCwd] = useState('');
  const folder = view.folders.find((f) => f.id === folderId);
  const where = folder ? (cwd.trim() ? `${folder.path}\\${cwd.trim().replace(/\//g, '\\')}` : folder.path) : '';
  return (
    <form className="access-command-form" onSubmit={(e) => { e.preventDefault(); void onAdd({ label, command, folderId, cwd }).then((ok) => { if (ok) { setLabel(''); setCommand(''); setCwd(''); } }); }}>
      <div className="access-command-fields">
        <label>Name<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Tests" maxLength={40} required/></label>
        <label>Command<input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm test" maxLength={300} required/></label>
        <label>Folder<select value={folderId} onChange={(e) => setFolderId(e.target.value)}>{view.folders.map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}</select></label>
        <label>Subfolder <span className="optional">Optional</span><input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="apps/web"/></label>
      </div>
      {command.trim() && folder && <p className="access-approve-line">Agents with “Run approved checks” may run <code>{command.trim()}</code> in <span className="setup-path">{where}</span>. It runs without your keys or tokens and stops after 10 minutes.</p>}
      <button type="submit" className="button primary-button" disabled={busy || !label.trim() || !command.trim() || !folder}>Approve command</button>
    </form>
  );
}

function ApplyChanges({ api, projectId, view, notify, onView }) {
  const writable = view.folders.filter((f) => f.write && f.available);
  const [folderId, setFolderId] = useState(writable[0]?.id || '');
  const [preview, setPreview] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn) => { setBusy(true); try { await fn(); } catch (e) { notify?.(errorText(e)); } finally { setBusy(false); } };
  if (!view.pending.length && !result) return <p className="agent-muted">No agent changes are waiting. Files agents deliver stay in the project workspace until you apply them here.</p>;
  const show = () => act(async () => {
    const p = await api.previewApply(projectId, folderId);
    setPreview(p);
    setResult(null);
    setChosen(new Set(p.items.filter((i) => i.status === 'ready').map((i) => i.path)));
  });
  return (
    <div className="access-apply">
      {!preview && <>
        <ul className="cap-list">{view.pending.map((f) => <li key={f.path}><span><strong>{f.path}</strong><small>From {f.agent} · task {f.taskId}</small></span></li>)}</ul>
        {writable.length ? (
          <div className="teams-inline">
            <select aria-label="Folder to apply to" value={folderId} onChange={(e) => setFolderId(e.target.value)}>{writable.map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}</select>
            <button type="button" className="button primary-button" disabled={busy || !folderId} onClick={show}>Review changes</button>
          </div>
        ) : <p className="agent-muted">To apply changes, allow changes in one of the folders above first.</p>}
      </>}
      {preview && <>
        <p className="provider-line">Changes for <span className="setup-path">{preview.folder}</span>. Nothing is written until you apply.</p>
        <ul className="access-diff-list">
          {preview.items.map((i) => <li key={i.path} className={`access-diff is-${i.status}`}>
            <label>
              <input type="checkbox" disabled={i.status !== 'ready'} checked={chosen.has(i.path)} onChange={(e) => { const next = new Set(chosen); if (e.target.checked) next.add(i.path); else next.delete(i.path); setChosen(next); }}/>
              <strong>{i.path}</strong> <small>{i.isNew ? 'new file' : 'changed'} · by {i.agent}</small>
            </label>
            {i.status === 'blocked' && <div className="setup-error" role="alert"><span>Blocked: {i.reason}</span></div>}
            {i.status === 'same' && <small className="agent-muted">Already the same on disk.</small>}
            {i.diff && <pre className="access-diff-text">{i.diff}</pre>}
          </li>)}
        </ul>
        <div className="setup-actions">
          <button type="button" className="button primary-button" disabled={busy || !chosen.size} onClick={() => act(async () => {
            const r = await api.apply(projectId, preview.previewId, [...chosen]);
            setResult(r.result); setPreview(null); onView(r.view);
            notify?.(r.result.applied.length ? `Applied ${r.result.applied.length} file${r.result.applied.length === 1 ? '' : 's'} to your folder.` : 'Nothing was applied.');
          })}>Apply {chosen.size} file{chosen.size === 1 ? '' : 's'}</button>
          <button type="button" className="button" onClick={() => setPreview(null)}>Cancel</button>
        </div>
      </>}
      {result && <div className="access-result" role="status">
        {result.applied.length > 0 && <p>Applied: {result.applied.join(', ')}</p>}
        {result.conflicts.map((c) => <div key={c.path} className="setup-error" role="alert"><span>Conflict in {c.path}: {c.reason}</span></div>)}
        {result.blocked.map((c) => <div key={c.path} className="setup-error" role="alert"><span>Not applied, {c.path}: {c.reason}</span></div>)}
      </div>}
    </div>
  );
}

// onBack: opened from a run's Review changes; returns there with the same run.
export function ComputerAccess({ project, Icon, notify, onClose, onBack }) {
  const { api, view, busy, run, setView } = useAccess(project.id, notify);
  if (!api) return <div><h2 id="dialog-title">Computer access</h2><p className="dialog-description">Computer access works in the installed app.</p></div>;
  const agents = agentsOf(project);
  const checkoutGranted = view?.checkout && view.folders.some((f) => f.path.toLowerCase() === view.checkout.toLowerCase());
  return (
    <div className="access-page">
      <div className="dialog-heading"><span className="dialog-icon"><Icon name="link" size={21}/></span><button className="icon-button" type="button" aria-label="Close computer access" onClick={onClose}><Icon name="close"/></button></div>
      <h2 id="dialog-title">Computer access · {project.name}</h2>
      <p className="dialog-description">Folders on this computer that agents in this project may read, and where they may apply changes you reviewed. Access is given per agent, stays on this computer and is never shared with your team. Nothing is allowed until you allow it.</p>
      {onBack && <div className="review-access"><span>When agents may change the folder the run’s files should land in, go back to the run’s changes.</span><button type="button" className="button primary-button" onClick={onBack}>Back to Review changes</button></div>}
      <div className="setup-actions">
        <button type="button" className="button primary-button" disabled={busy} onClick={() => run((a) => a.addFolder(project.id))}><Icon name="plus" size={14}/> Add folder</button>
        <button type="button" className="button" disabled={busy} onClick={() => run(async (a) => { await a.openProjectFolder(project.id); return null; })}><Icon name="folder" size={14}/> Open project folder</button>
        {view?.checkout && !checkoutGranted && <button type="button" className="button" disabled={busy} onClick={() => run((a) => a.addCheckout(project.id))}>Add this computer’s checkout</button>}
      </div>
      {!view ? <p className="agent-muted">Loading…</p> : <>
        <section className="access-section">
          <h3>Granted folders</h3>
          {!view.folders.length && <p className="agent-muted">No folders yet. Agents cannot read anything on this computer.</p>}
          <ul className="cap-list">
            {view.folders.map((f) => <li key={f.id} className={f.available ? '' : 'is-off'}>
              <span><strong className="setup-path" title={f.path}>{f.path}</strong><small>{f.available ? (f.write ? 'Agents with permission may read, and apply changes you reviewed' : 'Read only') : f.problem}</small></span>
              <span className="access-folder-actions">
                <label><input type="checkbox" checked={f.write} disabled={busy} onChange={(e) => run((a) => a.setFolderWrite(project.id, f.id, e.target.checked))}/> Allow changes</label>
                <button type="button" className="provider-text-link" disabled={busy} onClick={() => { if (window.confirm(`Revoke access to ${f.path}? Agents can no longer read it, checks in it are removed, and a check running there stops.`)) void run((a) => a.revokeFolder(project.id, f.id)); }}>Revoke</button>
              </span>
            </li>)}
          </ul>
        </section>
        <section className="access-section">
          <h3>Agents</h3>
          <p className="agent-muted">Skills follow an agent to every project; these permissions are for this project only. You can also set them under the agent’s Capabilities.</p>
          {!agents.length && <p className="agent-muted">This project has no agents yet.</p>}
          <ul className="cap-list access-agents">
            {agents.map((n) => <li key={n.agentKey}><span><strong>{n.name}</strong><small>{n.role}</small></span><AccessToggles name={n.name} access={accessOf(view, n.agentKey)} busy={busy} onChange={(next) => run((a) => a.setAgent(project.id, n.agentKey, next))}/></li>)}
          </ul>
          {Object.keys(view.agents).length > 0 && <button type="button" className="button danger-button" disabled={busy} onClick={() => { if (window.confirm('Revoke computer access for every agent in this project? A check that is running stops.')) void run((a) => a.revokeAgents(project.id)); }}>Revoke all agents</button>}
        </section>
        <section className="access-section">
          <h3>Approved checks</h3>
          <ul className="cap-list">
            {view.commands.map((c) => <li key={c.id}><span><strong>{c.label}</strong><small><code>{c.command}</code> in <span className="setup-path">{c.cwdPath}</span></small></span><button type="button" className="provider-text-link" disabled={busy} onClick={() => run((a) => a.removeCommand(project.id, c.id))}>Remove</button></li>)}
          </ul>
          {view.folders.length ? <details className="cap-project"><summary>Add a check (lint, typecheck, tests)</summary><CommandForm view={view} busy={busy} onAdd={async (cmd) => Boolean(await run((a) => a.addCommand(project.id, cmd)))}/></details> : <p className="agent-muted">Add a folder first.</p>}
        </section>
        <section className="access-section">
          <h3>Agent changes</h3>
          <ApplyChanges api={api} projectId={project.id} view={view} notify={notify} onView={setView}/>
        </section>
        {view.recent.length > 0 && <section className="access-section">
          <h3>Recent activity</h3>
          <ul className="access-log">{view.recent.map((e, i) => <li key={`${e.at}-${i}`} className={e.allowed ? '' : 'is-refused'}><small>{new Date(e.at).toLocaleTimeString()}</small> {e.agent} · {e.action} · <span className="setup-path">{e.target}</span> · {e.allowed ? e.detail : `refused: ${e.detail}`}</li>)}</ul>
        </section>}
      </>}
    </div>
  );
}

// The agent's own Computer access, in Agent → Capabilities.
export function AgentComputerAccess({ node, projectId, notify }) {
  const { api, view, busy, run } = useAccess(projectId, notify);
  if (!api || !node.agentKey) return null;
  const access = accessOf(view, node.agentKey);
  return (
    <section>
      <h4>Computer access in this project</h4>
      <p className="agent-muted">{view?.folders.length ? `Folders granted to this project: ${view.folders.map((f) => f.path).join(', ')}.` : 'No folders are granted to this project yet. Add one under the project’s ⋯ menu → Computer access.'} What {node.name} may do here:</p>
      <AccessToggles name={node.name} access={access} busy={busy || !view} onChange={(next) => run((a) => a.setAgent(projectId, node.agentKey, next))}/>
      {(access.read || access.write || access.commands) && <button type="button" className="provider-text-link" disabled={busy} onClick={() => run((a) => a.setAgent(projectId, node.agentKey, { read: false, write: false, commands: false }))}>Revoke {node.name}’s access</button>}
    </section>
  );
}
