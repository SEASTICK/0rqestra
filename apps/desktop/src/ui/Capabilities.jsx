// An agent's Capabilities tab: what this agent can use, and setting it up from here. Skills
// installed on the agent follow it to every project (they are saved against its permanent key in
// the app's data, main/capabilities); a project can add skills for all its agents, and each agent
// can switch those off. Full instructions are loaded only for a task that needs the skill.
import { AgentComputerAccess } from './ComputerAccess.jsx';
import React, { useEffect, useState } from 'react';

const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function Preview({ preview, busy, onInstall, onCancel }) {
  return <div className="cap-preview" role="dialog" aria-label={`Preview of ${preview.name}`}>
    <strong>{preview.name}</strong>
    {preview.description && <p>{preview.description}</p>}
    <small>From {preview.source} · {preview.files.length} {preview.files.length === 1 ? 'file' : 'files'}{preview.existingId ? ' · updates the copy already on this computer' : ''}</small>
    <pre className="cap-excerpt">{preview.excerpt || '(no instructions)'}</pre>
    <div className="cap-actions">
      <button type="button" className="shell-button primary" disabled={busy} onClick={onInstall}>Install to this agent</button>
      <button type="button" className="shell-button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

export function CapabilitiesTab({ node, graph, projectId, Icon, notify, onPatchNode, onPatchProjectSkills }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.capabilities : null;
  const [library, setLibrary] = useState([]);
  const [installed, setInstalled] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const key = node.agentKey;
  const load = () => api?.skills(key).then((r) => { setLibrary(r.skills); setInstalled(r.installed); }).catch((e) => notify?.(errorText(e)));
  useEffect(() => { void load(); }, [key]);
  const run = async (fn) => { setBusy(true); try { await fn(); } catch (e) { notify?.(errorText(e)); } finally { setBusy(false); } };
  const byId = new Map(library.map((s) => [s.id, s]));
  const projectSkills = graph?.skills || [];
  const off = new Set(node.skillsOff || []);
  const notInstalled = library.filter((s) => !installed.includes(s.id));
  const notInProject = library.filter((s) => !projectSkills.includes(s.id));
  const real = node.agent && ['claude', 'codex', 'gemini'].includes(node.agent.tool);
  const provider = node.agent?.tool === 'claude' ? 'Claude Code' : node.agent?.tool === 'codex' ? 'Codex' : node.agent?.tool === 'gemini' ? 'Gemini' : 'No tool yet';

  if (!api) return <p className="agent-muted">Capabilities work in the installed app.</p>;
  if (!key) return <p className="agent-muted">Save this agent first; then you can install skills on it.</p>;
  const dropped = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = [...(e.dataTransfer?.files || [])][0];
    if (!file) return;
    if (!/\.md$/i.test(file.name)) { notify?.('Drop a SKILL.md file, or use “Choose skill folder” for a folder.'); return; }
    void run(async () => setPreview(await api.previewText(file.name, await file.text())));
  };

  return <div className="cap-tab">
    <section>
      <h4>Skills</h4>
      <p className="agent-muted">Skills installed on {node.name} follow it to every project. The full instructions are loaded only for a task that needs the skill.</p>
      {preview
        ? <Preview preview={preview} busy={busy} onCancel={() => setPreview(null)} onInstall={() => run(async () => {
            const r = await api.install(preview.selectionId, key, node.name);
            setInstalled(r.installed); setPreview(null); await load();
            notify?.(`${r.record.name} is installed on ${node.name}.`);
          })} />
        : <div className={`cap-drop ${dragging ? 'is-over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={dropped}>
            <Icon name="plus" size={16} />
            <span><strong>Install to this agent</strong> · drop a SKILL.md here, or</span>
            <span className="cap-actions">
              <button type="button" className="shell-button" disabled={busy} onClick={() => run(async () => { const p = await api.chooseSkill('file'); if (p) setPreview(p); })}>Choose SKILL.md</button>
              <button type="button" className="shell-button" disabled={busy} onClick={() => run(async () => { const p = await api.chooseSkill('folder'); if (p) setPreview(p); })}>Choose skill folder</button>
            </span>
          </div>}
      <ul className="cap-list" aria-label={`Skills of ${node.name}`}>
        {installed.map((id) => <li key={`i-${id}`}>
          <span><strong>{byId.get(id)?.name || id}</strong><small>{byId.get(id)?.description}</small></span>
          <span className="cap-source">Installed on this agent</span>
          <button type="button" className="provider-text-link" disabled={busy} onClick={() => run(async () => { setInstalled(await api.unassign(id, key)); notify?.(`Removed from ${node.name}. Other agents keep it.`); })}>Remove from this agent</button>
        </li>)}
        {projectSkills.filter((id) => !installed.includes(id)).map((id) => <li key={`p-${id}`} className={off.has(id) ? 'is-off' : ''}>
          <span><strong>{byId.get(id)?.name || id}</strong><small>{byId.get(id)?.description || 'Not on this computer any more.'}</small></span>
          <span className="cap-source">From this project{off.has(id) ? ' · off for this agent' : ''}</span>
          <button type="button" className="provider-text-link" onClick={() => onPatchNode({ skillsOff: off.has(id) ? [...off].filter((x) => x !== id) : [...off, id] })}>{off.has(id) ? 'Turn on for this agent' : 'Turn off for this agent'}</button>
        </li>)}
        {!installed.length && !projectSkills.length && <li className="agent-muted">No skills yet.</li>}
      </ul>
      {notInstalled.length > 0 && <label className="cap-pick">Add a skill you already imported
        <select value="" disabled={busy} onChange={(e) => { const id = e.target.value; if (id) void run(async () => { setInstalled(await api.assign(id, key, node.name)); notify?.(`${byId.get(id)?.name} is installed on ${node.name}.`); }); }}>
          <option value="">Choose a skill…</option>
          {notInstalled.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>}
      <details className="cap-project">
        <summary>Skills for every agent in this project</summary>
        <p className="agent-muted">Optional: added to all agents here, as “From this project”. Each agent can turn them off.</p>
        <ul className="cap-list">{projectSkills.map((id) => <li key={id}><span>{byId.get(id)?.name || id}</span><button type="button" className="provider-text-link" onClick={() => onPatchProjectSkills(projectSkills.filter((x) => x !== id))}>Remove from project</button></li>)}</ul>
        {notInProject.length > 0 && <select value="" onChange={(e) => { if (e.target.value) onPatchProjectSkills([...projectSkills, e.target.value]); }}>
          <option value="">Add a skill to this project…</option>
          {notInProject.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>}
      </details>
    </section>
    <AgentComputerAccess node={node} projectId={projectId} notify={notify} />
    <section>
      <h4>Plugins and connectors</h4>
      <div className="cap-actions">
        <button type="button" className="shell-button" disabled title="Not available yet">Add plugin</button>
        <button type="button" className="shell-button" disabled title="Not available yet">Add connector</button>
      </div>
      <p className="agent-muted">Not available yet. Agents in 0rqestra run {real ? provider : 'Claude Code and Codex'} without tools (no file access, commands or network), so a plugin or a connector such as GitHub could not yet be limited to this one agent. They stay off until that is verified.</p>
    </section>
    <details className="cap-advanced">
      <summary>Advanced</summary>
      <p className="agent-muted">A terminal in this project’s folder, for {provider}’s own install commands. You type every command yourself. Installs made there are for {provider} on this computer (all agents on it), not only {node.name}.</p>
      <button type="button" className="shell-button" disabled={busy} onClick={() => run(async () => { await api.openTerminal(projectId, `${provider} setup for ${node.name}`); notify?.('Setup terminal opened in the project folder.'); })}>Open setup terminal</button>
    </details>
  </div>;
}
