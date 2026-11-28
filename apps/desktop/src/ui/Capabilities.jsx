// An agent's Capabilities tab: what this agent can use, and adding to it from here. Two sections,
// Skills and Connectors, each with one clear "Add" action that opens a searchable picker.
// Skills installed on the agent follow it to every project (they are saved against its permanent key
// in the app's data, main/capabilities); a project can add skills for all its agents, and each agent
// can switch those off. The only connector with a working, per-agent integration is "Project
// folders" (the agent's Computer access in this project, main/access); the others are shown as
// unavailable with the reason, and provider setup commands stay under Advanced.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessToggles } from './ComputerAccess.jsx';
import { accessText, connectorCatalog, folderTest, providerOf, searchConnectors, searchSkills, skillRows } from './capabilities-ui.mjs';

const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const STATE_TONE = { ready: 'good', on: 'good', needs_setup: 'warn', off: 'muted', missing: 'warn', unavailable: 'muted' };

function Status({ tone, children }) {
  return <span className={`cap-status cap-status-${tone}`}><i aria-hidden="true"/>{children}</span>;
}

// Arrow keys move through a list of options; Enter picks; Escape closes.
function useListKeys(count, onPick, onClose) {
  const [active, setActive] = useState(0);
  useEffect(() => { if (active >= count) setActive(Math.max(0, count - 1)); }, [count]);
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(count - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && count) { e.preventDefault(); onPick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  return { active, setActive, onKeyDown };
}

// "Add skill": imported skills on this computer, searchable, or import a new one. Then a short
// preview and one action: "Add to <agent>".
function SkillPicker({ api, node, library, installed, busy, run, onAdded, onClose }) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(null);
  const [dragging, setDragging] = useState(false);
  const results = useMemo(() => searchSkills(library, query, installed), [library, query, installed]);
  const keys = useListKeys(results.length, (i) => results[i] && !results[i].alreadyOn && setChosen({ kind: 'library', skill: results[i] }), onClose);
  const stage = (p) => { if (p) setChosen({ kind: 'import', preview: p }); };
  const dropped = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = [...(e.dataTransfer?.files || [])][0];
    if (!file) return;
    if (!/\.md$/i.test(file.name)) { void run(async () => { throw new Error('Drop a SKILL.md file, or choose a skill folder.'); }); return; }
    void run(async () => stage(await api.previewText(file.name, await file.text())));
  };
  const add = () => run(async () => {
    if (chosen.kind === 'library') onAdded(await api.assign(chosen.skill.id, node.agentKey, node.name), chosen.skill.name);
    else { const r = await api.install(chosen.preview.selectionId, node.agentKey, node.name); onAdded(r.installed, r.record.name); }
  });
  if (chosen) {
    const p = chosen.kind === 'library' ? { name: chosen.skill.name, description: chosen.skill.description, meta: 'Imported on this computer', excerpt: '' } : { name: chosen.preview.name, description: chosen.preview.description, meta: `From ${chosen.preview.source} · ${chosen.preview.files.length} ${chosen.preview.files.length === 1 ? 'file' : 'files'}${chosen.preview.existingId ? ' · updates the copy already on this computer' : ''}`, excerpt: chosen.preview.excerpt || '(no instructions)' };
    return <div className="cap-picker" role="dialog" aria-label={`Preview of ${p.name}`} onKeyDown={(e) => { if (e.key === 'Escape') setChosen(null); }}>
      <div className="cap-picker-head"><strong>{p.name}</strong><button type="button" className="provider-text-link" onClick={() => setChosen(null)}>Back</button></div>
      {p.description && <p className="cap-picker-text">{p.description}</p>}
      <small className="cap-muted">{p.meta}</small>
      {p.excerpt && <pre className="cap-excerpt">{p.excerpt}</pre>}
      <div className="cap-actions"><button type="button" className="cap-primary" autoFocus disabled={busy} onClick={add}>Add to {node.name}</button><button type="button" className="cap-secondary" onClick={onClose}>Cancel</button></div>
    </div>;
  }
  return <div className={`cap-picker ${dragging ? 'is-over' : ''}`} role="dialog" aria-label={`Add a skill to ${node.name}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={dropped}>
    <div className="cap-picker-head"><strong>Add a skill to {node.name}</strong><button type="button" className="provider-text-link" onClick={onClose}>Close</button></div>
    <input className="cap-search" type="search" aria-label="Search skills" placeholder="Search skills on this computer" value={query} autoFocus
      aria-controls="cap-skill-options" aria-activedescendant={results[keys.active] ? `cap-skill-${results[keys.active].id}` : undefined}
      onChange={(e) => { setQuery(e.target.value); keys.setActive(0); }} onKeyDown={keys.onKeyDown}/>
    {results.length ? <ul className="cap-options" id="cap-skill-options" role="listbox" aria-label="Skills">
      {results.map((s, i) => <li key={s.id} id={`cap-skill-${s.id}`} role="option" aria-selected={i === keys.active} aria-disabled={s.alreadyOn}
        className={`${i === keys.active ? 'is-active' : ''} ${s.alreadyOn ? 'is-disabled' : ''}`}
        onMouseEnter={() => keys.setActive(i)} onClick={() => !s.alreadyOn && setChosen({ kind: 'library', skill: s })}>
        <span><strong>{s.name}</strong><small>{s.description}</small></span>
        {s.alreadyOn && <small className="cap-muted">Already on {node.name}</small>}
      </li>)}
    </ul> : <p className="cap-muted">{library.length ? 'No skill matches.' : 'No skills are imported on this computer yet.'}</p>}
    <div className="cap-import">
      <span>Import skill: drop a SKILL.md here, or</span>
      <button type="button" className="cap-secondary" disabled={busy} onClick={() => run(async () => stage(await api.chooseSkill('file')))}>Choose SKILL.md</button>
      <button type="button" className="cap-secondary" disabled={busy} onClick={() => run(async () => stage(await api.chooseSkill('folder')))}>Choose skill folder</button>
    </div>
  </div>;
}

// "Add connector": every connector with its state and next action; choosing a ready one shows what
// the agent will be allowed to use before it is added.
function ConnectorPicker({ node, catalog, busy, onNext, onAttach, onClose }) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(null);
  const results = searchConnectors(catalog, query);
  const keys = useListKeys(results.length, (i) => setChosen(results[i]?.id || null), onClose);
  const entry = chosen ? catalog.find((c) => c.id === chosen) : null;
  const [allow, setAllow] = useState(null);
  if (entry) {
    const access = allow || entry.defaultAccess || { read: true, write: false, commands: false };
    return <div className="cap-picker" role="dialog" aria-label={entry.name} onKeyDown={(e) => { if (e.key === 'Escape') setChosen(null); }}>
      <div className="cap-picker-head"><strong>{entry.name}</strong><button type="button" className="provider-text-link" onClick={() => { setChosen(null); setAllow(null); }}>Back</button></div>
      <Status tone={STATE_TONE[entry.state]}>{entry.stateText}</Status>
      <p className="cap-picker-text">{entry.description}</p>
      {entry.why && <p className="cap-muted">{entry.why}</p>}
      {entry.state === 'ready' && entry.id === 'folders' && <>
        <dl className="cap-grant">
          <dt>Account</dt><dd>{entry.account}</dd>
          <dt>Resources</dt><dd>{entry.resources.map((r) => <span key={r.label} className="cap-resource" title={r.label}>{r.label}{r.ok ? '' : ' (not found)'}</span>)}</dd>
          <dt>Actions</dt><dd><AccessToggles name={node.name} access={access} busy={busy} onChange={setAllow}/></dd>
        </dl>
        <div className="cap-actions"><button type="button" className="cap-primary" autoFocus disabled={busy || !access.read} onClick={() => onAttach(access)}>{entry.attached ? `Save for ${node.name}` : `Add to ${node.name}`}</button><button type="button" className="cap-secondary" onClick={onClose}>Cancel</button></div>
      </>}
      {entry.state !== 'ready' && entry.next && <div className="cap-actions"><button type="button" className="cap-secondary" onClick={() => onNext(entry.next.action)}>{entry.next.label}</button></div>}
    </div>;
  }
  return <div className="cap-picker" role="dialog" aria-label={`Add a connector to ${node.name}`}>
    <div className="cap-picker-head"><strong>Add a connector to {node.name}</strong><button type="button" className="provider-text-link" onClick={onClose}>Close</button></div>
    <input className="cap-search" type="search" aria-label="Search connectors" placeholder="Search connectors" value={query} autoFocus
      aria-controls="cap-connector-options" aria-activedescendant={results[keys.active] ? `cap-conn-${results[keys.active].id}` : undefined}
      onChange={(e) => { setQuery(e.target.value); keys.setActive(0); }} onKeyDown={keys.onKeyDown}/>
    <ul className="cap-options" id="cap-connector-options" role="listbox" aria-label="Connectors">
      {results.map((c, i) => <li key={c.id} id={`cap-conn-${c.id}`} role="option" aria-selected={i === keys.active} className={`${i === keys.active ? 'is-active' : ''} ${c.state === 'unavailable' ? 'is-unavailable' : ''}`}
        onMouseEnter={() => keys.setActive(i)} onClick={() => setChosen(c.id)}>
        <span><strong>{c.name}</strong><small>{c.attached ? `On ${node.name}: ${c.actions}` : c.state === 'ready' ? 'Existing connection you can reuse' : c.why}</small></span>
        <Status tone={STATE_TONE[c.state]}>{c.attached ? 'Added' : c.stateText}</Status>
      </li>)}
    </ul>
    {!results.length && <p className="cap-muted">No connector matches.</p>}
  </div>;
}

export function CapabilitiesTab({ node, graph, projectId, Icon, notify, onPatchNode, onPatchProjectSkills, onConfigure, onOpenAccess }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.capabilities : null;
  const accessApi = typeof window !== 'undefined' ? window.orqestra?.access : null;
  const [library, setLibrary] = useState([]);
  const [installed, setInstalled] = useState([]);
  const [access, setAccess] = useState(null);
  const [github, setGithub] = useState(null);
  const [picker, setPicker] = useState(null);
  const [managing, setManaging] = useState(false);
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const advanced = useRef(null);
  const key = node.agentKey;
  const provider = providerOf(node);
  const loadSkills = () => api?.skills(key).then((r) => { setLibrary(r.skills); setInstalled(r.installed); }).catch((e) => notify?.(errorText(e)));
  useEffect(() => { void loadSkills(); }, [key]);
  useEffect(() => {
    if (!accessApi || !projectId) return undefined;
    let live = true;
    const load = () => accessApi.view(projectId).then((v) => { if (live) setAccess(v); }).catch(() => {});
    void load();
    const off = accessApi.subscribe?.((event) => { if (event?.projectId === projectId) void load(); });
    return () => { live = false; off?.(); };
  }, [projectId]);
  // GitHub's account status only when the connector list is opened (it asks the gh tool).
  useEffect(() => { if (picker === 'connector' && accessApi?.github && !github) accessApi.github.status().then(setGithub).catch(() => setGithub({ signedIn: false })); }, [picker]);
  const run = async (fn) => { setBusy(true); try { return await fn(); } catch (e) { notify?.(errorText(e)); return undefined; } finally { setBusy(false); } };

  if (!api) return <p className="agent-muted">Capabilities work in the installed app.</p>;
  if (!key) return <p className="agent-muted">Save this agent first; then you can add skills and connectors to it.</p>;

  const rows = skillRows(library, installed, graph?.skills || [], node.skillsOff);
  const off = new Set(node.skillsOff || []);
  const projectSkills = graph?.skills || [];
  const notInProject = library.filter((s) => !projectSkills.includes(s.id));
  const catalog = connectorCatalog({ node, access, github, projectName: graph?.name });
  const folders = catalog[0];
  const setFolderAccess = (next, message) => run(async () => { const v = await accessApi.setAgent(projectId, key, next); if (v?.folders) setAccess(v); setTest(null); notify?.(message); return true; });
  const next = (action) => {
    if (action === 'configure') onConfigure?.();
    else if (action === 'connect_folder') onOpenAccess?.();
    else if (action === 'github_sign_in') void run(() => accessApi.github.openTerminal('signIn'));
    else if (action === 'advanced') { setPicker(null); if (advanced.current) { advanced.current.open = true; advanced.current.scrollIntoView?.({ block: 'nearest' }); } }
  };

  return <div className="cap-tab">
    <div className="cap-who" aria-live="polite">
      <span className="cap-avatar" aria-hidden="true">{(node.name || '?').trim()[0]?.toUpperCase()}</span>
      <span><strong>{node.name}</strong><small>{node.role}{provider ? ` · ${provider.name}` : ' · no AI tool yet'}</small></span>
    </div>

    <section className="cap-section" aria-labelledby="cap-skills-title">
      <div className="cap-section-head">
        <h4 id="cap-skills-title">Skills <span className="cap-count">{rows.length}</span></h4>
        <button type="button" className="cap-primary" aria-expanded={picker === 'skill'} onClick={() => setPicker(picker === 'skill' ? null : 'skill')}><Icon name="plus" size={14}/> Add skill</button>
      </div>
      {picker === 'skill' && <SkillPicker api={api} node={node} library={library} installed={installed} busy={busy} run={run} onClose={() => setPicker(null)}
        onAdded={(list, name) => { setInstalled(list); setPicker(null); void loadSkills(); notify?.(`${name} is installed on ${node.name}.`); }}/>}
      <ul className="cap-rows" aria-label={`Skills of ${node.name}`}>
        {rows.map((r) => <li key={`${r.source}-${r.id}`} className={`cap-row ${r.status === 'off' ? 'is-off' : ''}`}>
          <span className="cap-row-main"><strong>{r.name}</strong><small>{r.sourceText}{r.description ? ` · ${r.description}` : ''}</small></span>
          <Status tone={STATE_TONE[r.status]}>{r.statusText}</Status>
          {r.source === 'agent'
            ? <button type="button" className="cap-link" disabled={busy} onClick={() => run(async () => { setInstalled(await api.unassign(r.id, key)); notify?.(`Removed from ${node.name}. Other agents keep it.`); })}>Remove</button>
            : <button type="button" className="cap-link" onClick={() => onPatchNode({ skillsOff: off.has(r.id) ? [...off].filter((x) => x !== r.id) : [...off, r.id] })}>{off.has(r.id) ? 'Turn on' : 'Turn off'}<span className="cap-sr"> for {node.name}</span></button>}
        </li>)}
        {!rows.length && <li className="cap-empty">No skills yet. Skills installed on {node.name} follow it to every project.</li>}
      </ul>
      <details className="cap-project">
        <summary>Skills for every agent in this project</summary>
        <p className="cap-muted">Added to all agents here as “From this project”. Each agent can turn them off.</p>
        <ul className="cap-rows">{projectSkills.map((id) => <li key={id} className="cap-row"><span className="cap-row-main"><strong>{library.find((s) => s.id === id)?.name || id}</strong></span><button type="button" className="cap-link" onClick={() => onPatchProjectSkills(projectSkills.filter((x) => x !== id))}>Remove from project</button></li>)}</ul>
        {notInProject.length > 0 && <select aria-label="Add a skill to this project" value="" onChange={(e) => { if (e.target.value) onPatchProjectSkills([...projectSkills, e.target.value]); }}>
          <option value="">Add a skill to this project…</option>
          {notInProject.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>}
      </details>
    </section>

    <section className="cap-section" aria-labelledby="cap-connectors-title">
      <div className="cap-section-head">
        <h4 id="cap-connectors-title">Connectors <span className="cap-count">{folders.attached ? 1 : 0}</span></h4>
        <button type="button" className="cap-primary" aria-expanded={picker === 'connector'} disabled={!accessApi} onClick={() => setPicker(picker === 'connector' ? null : 'connector')}><Icon name="plus" size={14}/> Add connector</button>
      </div>
      {picker === 'connector' && <ConnectorPicker node={node} catalog={catalog} busy={busy} onNext={next} onClose={() => setPicker(null)}
        onAttach={async (allow) => { if (await setFolderAccess(allow, `${node.name} can use the project folders: ${accessText(allow)}.`)) setPicker(null); }}/>}
      <ul className="cap-rows" aria-label={`Connectors of ${node.name}`}>
        {folders.attached && <li className="cap-row cap-row-wide">
          <span className="cap-row-main"><strong>Project folders</strong><small>{folders.actions} · {folders.resources.map((r) => r.label).join(', ') || 'no folder'}</small></span>
          <Status tone={STATE_TONE[folders.state]}>{folders.stateText}</Status>
          <span className="cap-row-actions">
            <button type="button" className="cap-link" aria-expanded={managing} onClick={() => setManaging(!managing)}>Manage</button>
            <button type="button" className="cap-link" onClick={() => run(async () => { const v = await accessApi.view(projectId); setAccess(v); setTest(folderTest(v, key)); })}>Test</button>
            <button type="button" className="cap-link cap-danger" disabled={busy} onClick={() => setFolderAccess({ read: false, write: false, commands: false }, `${node.name} no longer has access to the project folders.`)}>Remove</button>
          </span>
          {managing && <div className="cap-row-extra"><AccessToggles name={node.name} access={access?.agents?.[key] || folders.defaultAccess} busy={busy} onChange={(v) => setFolderAccess(v, `Saved for ${node.name}: ${accessText(v)}.`)}/></div>}
          {test && <p className={`cap-row-extra cap-test ${test.ok ? 'is-ok' : 'is-bad'}`} role="status">{test.ok ? 'Connection works. ' : 'Problem: '}{test.text}</p>}
        </li>}
        {!folders.attached && <li className="cap-empty">No connectors on {node.name}. Add one to let it read the project’s folders.</li>}
      </ul>
    </section>

    <details className="cap-advanced" ref={advanced}>
      <summary>Advanced</summary>
      <p className="cap-muted">A terminal in this project’s folder, for {provider?.name || 'a tool'}’s own setup commands (for example MCP servers). You type every command yourself. Installs made there apply to {provider?.name || 'the tool'} on this computer (all agents that use it), not only {node.name}.</p>
      <button type="button" className="cap-secondary" disabled={busy} onClick={() => run(async () => { await api.openTerminal(projectId, `${provider?.name || 'Tool'} setup for ${node.name}`); notify?.('Setup terminal opened in the project folder.'); })}>Open setup terminal</button>
    </details>
  </div>;
}
