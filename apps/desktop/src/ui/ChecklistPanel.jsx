// The shared Project Checklist of a shared project: what the team agreed needs doing, who has which
// item, and how far it is. Items live on the 0rqestra server against the shared project, so every
// member sees the same list whatever folder or branch they use. Every change goes through the main
// process (main/teams); the server checks membership and records who changed what, and when.
import React, { useState } from 'react';
import { CHECKLIST_STATUS_TEXT, ago, checklistItems, checklistProgress, checklistRunState, claimText, displayName, errorText } from './teams-ui.mjs';

function ItemForm({ members, initial, onSave, onCancel, saveLabel }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [assigneeId, setAssigneeId] = useState(initial?.assigneeId || '');
  const [pending, setPending] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || pending) return;
    setPending(true);
    try { await onSave({ title, notes, assigneeId: assigneeId || null }); } finally { setPending(false); }
  };
  return (
    <form className="checklist-form" onSubmit={submit}>
      <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="What needs doing?" required/>
      <textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} rows={2} placeholder="Notes (optional)"/>
      <label className="checklist-assignee">Assignee
        <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Unassigned</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{displayName(m.name)}{m.isYou ? ' (you)' : ''}</option>)}
        </select>
      </label>
      <div className="checklist-form-actions">
        <button type="submit" className="button primary-button" disabled={pending || !title.trim()}>{saveLabel}</button>
        {onCancel && <button type="button" className="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function ChecklistItem({ item, me, members, nameOf, runs, act, onPlan }) {
  const [editing, setEditing] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState('');
  const [linking, setLinking] = useState(false);
  const api = window.orqestra.teams.checklist;
  const run = checklistRunState(item, runs);
  const owner = item.assigneeId ? nameOf(item.assigneeId) : null;
  if (editing) {
    return (
      <li className="checklist-item is-editing">
        <ItemForm members={members} initial={item} saveLabel="Save" onCancel={() => setEditing(false)} onSave={async (v) => { if (await act(() => api.update(item.id, v))) setEditing(false); }}/>
      </li>
    );
  }
  return (
    <li className={`checklist-item checklist-${item.status}`}>
      <div className="checklist-item-head">
        <button type="button" className="checklist-check" aria-label={item.status === 'done' ? `Reopen ${item.title}` : `Mark ${item.title} done`} title={item.status === 'done' ? 'Reopen' : 'Mark done'}
          onClick={() => act(() => api.setStatus(item.id, item.status === 'done' ? 'todo' : 'done'))}>{item.status === 'done' ? '✓' : ''}</button>
        <div className="checklist-item-main">
          <strong>{item.title}</strong>
          <small>
            <span className={`checklist-status checklist-status-${item.status}`}>{CHECKLIST_STATUS_TEXT[item.status]}</span>
            {' · '}{owner ? (item.assigneeId === me ? 'You' : owner) : 'Unassigned'}
            {' · '}updated {ago(item.updatedAt)}{item.updatedBy ? ` by ${item.updatedBy === me ? 'you' : nameOf(item.updatedBy)}` : ''}
          </small>
          {item.notes && <p className="checklist-notes">{item.notes}</p>}
          {item.status === 'blocked' && item.blockedReason && <p className="checklist-blocked">Needs: {item.blockedReason}</p>}
          {run && (
            <p className="checklist-run">Run: {run.label}{run.outcome ? ` · ${run.outcome}` : ''}
              {run.finished && item.status !== 'done' && <button type="button" className="button primary-button checklist-mark-done" onClick={() => act(() => api.setStatus(item.id, 'done'))}>Mark done</button>}
            </p>
          )}
        </div>
      </div>
      {blocking ? (
        <form className="checklist-inline" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api.setStatus(item.id, 'blocked', reason))) { setBlocking(false); setReason(''); } }}>
          <input aria-label="What do you need?" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="What do you need to continue?" required autoFocus/>
          <button type="submit" className="button" disabled={!reason.trim()}>Mark blocked</button>
          <button type="button" className="button" onClick={() => setBlocking(false)}>Cancel</button>
        </form>
      ) : linking ? (
        <div className="checklist-inline">
          <select aria-label="Run to link" defaultValue={item.runId || ''} onChange={async (e) => { if (await act(() => api.linkRun(item.id, e.target.value || null))) setLinking(false); }}>
            <option value="">No run</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.goal || r.id}</option>)}
          </select>
          <button type="button" className="button" onClick={() => setLinking(false)}>Cancel</button>
        </div>
      ) : (
        <div className="checklist-actions">
          {!item.assigneeId && !item.archived && <button type="button" className="provider-text-link" onClick={() => act(() => api.claim(item.id), true)}>Claim</button>}
          {item.status !== 'in_progress' && item.status !== 'done' && <button type="button" className="provider-text-link" onClick={() => act(() => api.setStatus(item.id, 'in_progress'))}>Start</button>}
          {item.status !== 'blocked' && item.status !== 'done' && <button type="button" className="provider-text-link" onClick={() => setBlocking(true)}>Blocked…</button>}
          {item.status === 'blocked' && <button type="button" className="provider-text-link" onClick={() => act(() => api.setStatus(item.id, 'in_progress'))}>Unblock</button>}
          {item.status === 'done' && <button type="button" className="provider-text-link" onClick={() => act(() => api.setStatus(item.id, 'todo'))}>Reopen</button>}
          <button type="button" className="provider-text-link" onClick={() => onPlan(item)}>Plan with Manager</button>
          <button type="button" className="provider-text-link" onClick={() => setLinking(true)} disabled={!runs.length} title={runs.length ? 'Link one of your team runs in this project' : 'No team runs in this project on this computer yet'}>{item.runId ? 'Change run' : 'Link run'}</button>
          <button type="button" className="provider-text-link" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="provider-text-link" onClick={() => act(() => api.archive(item.id, !item.archived))}>{item.archived ? 'Restore' : 'Archive'}</button>
        </div>
      )}
    </li>
  );
}

export function ChecklistPanel({ linked, view, runs = [], onView, onClose, onPlan, notify, Icon }) {
  const { team, project } = linked;
  const [mine, setMine] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const state = view.checklist?.[project.id];
  const progress = checklistProgress(view, project.id);
  const items = checklistItems(view, project.id, { mine, archived: showArchived });
  const nameOf = (userId) => displayName(team.members.find((m) => m.userId === userId)?.name) || 'a former member';
  const api = window.orqestra?.teams?.checklist;
  // Runs one action; a claim result names who got the item when someone else was first.
  const act = async (fn, claim = false) => {
    try {
      const r = await fn();
      if (claim && r?.view) { onView(r.view); if (r.outcome !== 'claimed') notify?.(claimText(r, nameOf)); return true; }
      if (r?.status) onView(r);
      return true;
    } catch (error) {
      notify?.(errorText(error));
      return false;
    }
  };
  return (
    <aside className="task-drawer checklist-panel" aria-label={`Checklist for ${project.name}`}>
      <div className="task-drawer-top">
        <div><span className="eyebrow">CHECKLIST</span><h2>{project.name}</h2><span className="team-muted">{progress.done} of {progress.total} done · shared with {team.name}</span></div>
        <button className="icon-button" title="Close checklist" aria-label="Close checklist" onClick={onClose}><Icon name="close"/></button>
      </div>
      <div className="task-drawer-scroll checklist-body">
        {state?.problem && <div className={state.needsUpdate ? 'simulated-notice' : 'setup-error'} role="alert"><span>{state.problem}</span></div>}
        <div className="checklist-toolbar">
          <div className="checklist-filters" role="group" aria-label="Filter">
            <button type="button" className={`checklist-filter ${!mine ? 'is-active' : ''}`} aria-pressed={!mine} onClick={() => setMine(false)}>All</button>
            <button type="button" className={`checklist-filter ${mine ? 'is-active' : ''}`} aria-pressed={mine} onClick={() => setMine(true)}>My tasks</button>
            <button type="button" className={`checklist-filter ${showArchived ? 'is-active' : ''}`} aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>Archived</button>
          </div>
          {!adding && !showArchived && api && <button type="button" className="button primary-button" onClick={() => setAdding(true)}>Add item</button>}
        </div>
        {adding && api && <ItemForm members={team.members} saveLabel="Add" onCancel={() => setAdding(false)} onSave={async (v) => { if (await act(() => api.add(project.id, v))) setAdding(false); }}/>}
        {!api ? <p className="team-muted">The checklist works in the installed app.</p>
          : items.length === 0 ? <p className="team-muted">{showArchived ? 'Nothing archived.' : mine ? 'No items are assigned to you.' : 'No items yet. Add what the team needs to do.'}</p>
          : <ul className="checklist-list">{items.map((i) => <ChecklistItem key={i.id} item={i} me={view.userId} members={team.members} nameOf={nameOf} runs={runs} act={act} onPlan={onPlan}/>)}</ul>}
        <p className="team-muted checklist-foot">Status is set by people: a finished run offers “Mark done”, and you decide. Everyone in {team.name} sees changes live.</p>
      </div>
    </aside>
  );
}
