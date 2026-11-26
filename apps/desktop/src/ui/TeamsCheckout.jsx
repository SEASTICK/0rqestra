// Choosing a GitHub checkout and the 0rqestra project it belongs to, for a shared project. Used by
// the Teams page and by Friends ("Start a project together"). Paths are shown, never sent back: the
// main process keeps each chosen folder under an id.
import React, { useState } from 'react';
import { errorText, projectChoices, repoName, selectionMatches } from './teams-ui.mjs';

function useAction(notify) {
  const [pending, setPending] = useState(false);
  const run = async (fn) => {
    setPending(true);
    try { return await fn(); } catch (error) { notify?.(errorText(error)); return undefined; } finally { setPending(false); }
  };
  return [pending, run];
}

export function CheckoutPicker({ api, notify, selection, onSelection }) {
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

export function ProjectSelect({ choices, value, onChange, newName }) {
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

export function LinkCheckout({ api, project, teams, projects, onCreateProject, notify, onView, onDone }) {
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
