// "Backup agents" in an agent's settings: other agents with the same role that continue its task when
// its provider's usage limit is reached, in priority order, and whether 0rqestra switches on its own
// or asks first. Only the backups chosen here are ever used for this agent.
import React from 'react';
import { accountWarnings, backupCandidates, moveBackup, orderedBackups } from './backup-ui.mjs';

export function BackupAgents({ node, role, graph, statuses, value, onChange }) {
  const candidates = backupCandidates(graph, { ...node, role }, statuses);
  const chosen = orderedBackups(value.backups, candidates);
  const others = candidates.filter((c) => !chosen.some((x) => x.id === c.id));
  const warnings = accountWarnings({ ...node, role }, chosen);
  const set = (backups) => onChange({ ...value, backups });
  if (!candidates.length) {
    return <fieldset className="backup-agents"><legend>Backup agents</legend><p className="backup-muted">Add another {role || 'agent'} on a tool to use as a backup when {node.name}’s provider reaches its usage limit.</p></fieldset>;
  }
  return (
    <fieldset className="backup-agents">
      <legend>Backup agents</legend>
      <p className="backup-muted">When {node.name}’s provider reaches its usage limit, the first available backup continues the task from its last checkpoint.</p>
      {chosen.length > 0 && <ol className="backup-list" aria-label={`Backups for ${node.name}, in priority order`}>
        {chosen.map((b, i) => (
          <li key={b.id}>
            <span className="backup-rank" aria-hidden="true">{i + 1}</span>
            <span className="backup-who"><strong>{b.name}</strong><small>{b.toolName} · {b.model}</small></span>
            <span className={`backup-ready ${b.ready ? 'is-ready' : 'is-not'}`}>{b.ready ? 'Ready' : 'Not ready'}</span>
            <span className="backup-move">
              <button type="button" className="icon-button" aria-label={`Move ${b.name} up`} disabled={i === 0} onClick={() => set(moveBackup(value.backups, b.id, -1))}>↑</button>
              <button type="button" className="icon-button" aria-label={`Move ${b.name} down`} disabled={i === chosen.length - 1} onClick={() => set(moveBackup(value.backups, b.id, 1))}>↓</button>
              <button type="button" className="icon-button" aria-label={`Remove ${b.name} as a backup`} onClick={() => set(value.backups.filter((x) => x !== b.id))}>×</button>
            </span>
          </li>
        ))}
      </ol>}
      {others.length > 0 && <label className="backup-add">Add a backup
        <select value="" onChange={(e) => { if (e.target.value) set([...chosen.map((c) => c.id), e.target.value]); }}>
          <option value="">Choose an agent…</option>
          {others.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.toolName} · {c.model}{c.ready ? '' : ' (not ready)'}</option>)}
        </select>
      </label>}
      {warnings.map((w) => <p key={w} className="backup-warning" role="note">{w}</p>)}
      {chosen.length > 0 && <div className="backup-mode" role="radiogroup" aria-label="When the usage limit is reached">
        <label><input type="radio" name="backup-mode" checked={value.mode !== 'ask'} onChange={() => onChange({ ...value, mode: 'auto' })}/> Switch automatically</label>
        <label><input type="radio" name="backup-mode" checked={value.mode === 'ask'} onChange={() => onChange({ ...value, mode: 'ask' })}/> Ask me first</label>
      </div>}
    </fieldset>
  );
}
