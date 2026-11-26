import React, { useEffect, useState } from 'react';

// Review changes, from a finished run's card in Manager chat: what that run changed (and only that
// run), what was checked, and where the changes would land; then apply the files the user chooses.
// The main process scopes the review to the run, checks everything again when applying, and never
// writes a file whose local copy changed since the diff was shown.

const errorText = (e) => String(e?.message || e || 'That did not work.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const api = () => (typeof window !== 'undefined' ? window.orqestra?.access : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Per run in a project: { pending, current } files waiting to be applied. Refreshed whenever the
// main process says a run's changes changed (delivered, applied, undone).
export function useRunChanges(projectId) {
  const [byRun, setByRun] = useState({});
  useEffect(() => {
    const a = api();
    if (!a?.pendingByRun || !projectId) return undefined;
    let live = true;
    const load = () => a.pendingByRun(projectId).then((v) => { if (live) setByRun(v || {}); }).catch(() => {});
    void load();
    const off = a.subscribe?.((event) => { if (event?.projectId === projectId) void load(); });
    return () => { live = false; off?.(); };
  }, [projectId]);
  return byRun;
}

const VERIFY_LABEL = { reviewed: 'Reviewed', unverified: 'Not reviewed', blocked: 'Blocked' };

function FileRow({ file, task, chosen, onToggle, outcome }) {
  const eligible = file.status === 'ready';
  return (
    <li className={`access-diff review-file is-${file.status}`}>
      <label>
        <input type="checkbox" disabled={!eligible} checked={eligible && chosen} onChange={(e) => onToggle(e.target.checked)} aria-label={`Apply ${file.path}`}/>
        <strong>{file.path}</strong>
        <span className={`review-verify verify-${file.verification.state}`} title={file.verification.note}>{VERIFY_LABEL[file.verification.state]}</span>
        <small>{file.isNew ? 'new file' : 'changed'} · by {file.agent}{task ? ` · ${task.title}` : ''}</small>
      </label>
      <small className="review-note">{file.verification.note}</small>
      {outcome?.kind === 'applied' && <div className="review-outcome is-applied" role="status">Applied to your folder.</div>}
      {outcome?.kind === 'conflict' && <div className="setup-error" role="alert"><span>Conflict with a local edit: {outcome.reason}</span></div>}
      {outcome?.kind === 'blocked' && <div className="setup-error" role="alert"><span>Skipped: {outcome.reason}</span></div>}
      {!outcome && file.status === 'replaced' && <div className="setup-error" role="alert"><span>Replaced: {file.reason}</span></div>}
      {!outcome && file.status === 'blocked' && <div className="setup-error" role="alert"><span>Blocked: {file.reason}</span></div>}
      {file.status === 'same' && <small className="agent-muted">Already the same in the destination folder.</small>}
      {file.diff && <pre className="access-diff-text">{file.diff}</pre>}
    </li>
  );
}

export function RunReview({ projectId, runId, run, Icon, notify, onClose, onOpenAccess }) {
  const [review, setReview] = useState(null);
  const [folderId, setFolderId] = useState('');
  const [chosen, setChosen] = useState(new Set());
  const [result, setResult] = useState(null);
  const [stale, setStale] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = async (folder = folderId, keepResult = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api().reviewRun(projectId, runId, folder || undefined);
      setReview(r);
      setFolderId(r.destination?.id || '');
      setStale(null);
      if (!keepResult) setResult(null);
      // Files a reviewer approved start selected; the user opts in to files nobody reviewed.
      setChosen(new Set(r.files.filter((f) => f.status === 'ready' && f.verification.state === 'reviewed').map((f) => f.path)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (api()?.reviewRun) void load(''); }, [projectId, runId]);
  if (!api()?.reviewRun) return <div><h2 id="dialog-title">Review changes</h2><p className="dialog-description">Reviewing changes works in the installed app.</p></div>;

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api().applyRun(projectId, runId, review.previewId, [...chosen]);
      setResult(r);
      const skipped = r.conflicts.length + r.blocked.length;
      notify?.(r.applied.length ? `Applied ${plural(r.applied.length, 'file')}${skipped ? `, skipped ${skipped}` : ''}. Commit ${r.applied.length === 1 ? 'it' : 'them'} when you are ready.` : 'Nothing was applied.');
      if (r.stale) setStale(r.stale);
      else await load(folderId, true);
    } catch (e) {
      setError(errorText(e));
      setStale('This review is no longer valid. Refresh it.');
    } finally {
      setBusy(false);
    }
  };
  const outcomeOf = (path) => {
    if (!result) return null;
    const key = path.toLowerCase();
    if (result.applied.some((p) => p.toLowerCase() === key)) return { kind: 'applied' };
    const c = result.conflicts.find((x) => x.path.toLowerCase() === key);
    if (c) return { kind: 'conflict', reason: c.reason };
    const b = result.blocked.find((x) => x.path.toLowerCase() === key);
    return b ? { kind: 'blocked', reason: b.reason } : null;
  };
  const files = review?.files || [];
  const eligible = files.filter((f) => f.status === 'ready');
  const taskOf = (id) => run?.tasks?.find((t) => t.id === id);
  const writable = (review?.folders || []).filter((f) => f.write);
  const dest = review?.destination;
  return (
    <div className="access-page run-review">
      <div className="dialog-heading"><span className="dialog-icon">{Icon ? <Icon name="code" size={21}/> : null}</span><button className="icon-button" type="button" aria-label="Close review" onClick={onClose}>{Icon ? <Icon name="close"/> : '×'}</button></div>
      <h2 id="dialog-title">Review changes</h2>
      <p className="dialog-description">{run?.goal ? <><strong>{run.goal}</strong><br/></> : null}Only this run’s changes are shown. Nothing is written until you apply, and what you apply stays in your working tree for you to commit.</p>
      {error && <div className="setup-error" role="alert"><span>{error}</span></div>}
      {!review ? <p className="agent-muted">{busy ? 'Loading…' : ''}</p> : <>
        <section className="access-section review-destination">
          <h3>Where the changes land</h3>
          {dest ? <p className="provider-line">
            <span className="setup-path">{dest.path}</span>
            {dest.isCheckout && <span className="review-tag">Linked checkout</span>}
            {review.branch ? <span className="review-tag">Branch {review.branch}</span> : <span className="review-tag">No Git branch</span>}
            {!dest.write && <span className="review-tag is-warn">Read only</span>}
          </p> : <p className="agent-muted">No folder on this computer is granted to this project yet.</p>}
          {writable.length > 1 && <label className="review-folder">Apply to <select value={folderId} disabled={busy} onChange={(e) => { setFolderId(e.target.value); void load(e.target.value); }}>{writable.map((f) => <option key={f.id} value={f.id}>{f.path}{f.isCheckout ? ' (linked checkout)' : ''}</option>)}</select></label>}
          {review.needsAccess && <div className="review-access" role="alert">
            <span>{review.checkout && !review.checkout.granted
              ? `This computer’s checkout (${review.checkout.path}) is not granted to this project yet. Grant it and allow changes there, then come back here.`
              : dest ? `Agents may not change ${dest.path} yet. Allow changes there, then come back here.` : 'Grant a folder and allow changes there, then come back here.'}</span>
            {onOpenAccess && <button type="button" className="button" onClick={onOpenAccess}>Open Computer access</button>}
          </div>}
        </section>
        <section className="access-section">
          <h3>Checks the app ran</h3>
          {review.checks.length ? <ul className="cap-list review-checks">{review.checks.map((c, i) => <li key={`${c.at}-${i}`}><span><strong>{c.label}</strong><small><code>{c.command}</code> in <span className="setup-path">{c.cwd}</span> · asked by {c.agent} · {new Date(c.at).toLocaleTimeString()}</small></span><span className={`review-verify ${c.passed ? 'verify-reviewed' : 'verify-blocked'}`}>{c.ended ? c.ended : c.passed ? 'Passed' : `Failed (exit ${c.exitCode})`}</span></li>)}</ul>
            : <p className="agent-muted">No approved check ran during this run, so there are no test results. Results an agent mentions in its notes are its own report.</p>}
        </section>
        <section className="access-section">
          <h3>{files.length ? `Files (${files.length})` : 'Files'}</h3>
          {stale && <div className="review-stale" role="alert"><span>This review is out of date. {stale}</span><button type="button" className="button" disabled={busy} onClick={() => load(folderId, true)}>Refresh review</button></div>}
          {!files.length ? <p className="agent-muted">Nothing from this run is waiting to be applied.</p> : <ul className="access-diff-list">
            {files.map((f) => <FileRow key={f.path} file={f} task={taskOf(f.taskId)} chosen={chosen.has(f.path)} outcome={outcomeOf(f.path)} onToggle={(on) => { const next = new Set(chosen); if (on) next.add(f.path); else next.delete(f.path); setChosen(next); }}/>)}
          </ul>}
        </section>
        {result && <div className="access-result review-result" role="status">
          <p>{result.applied.length ? `Applied ${plural(result.applied.length, 'file')}: ${result.applied.join(', ')}. ${result.applied.length === 1 ? 'It is' : 'They are'} in your working tree, not committed.` : 'Nothing was applied.'}</p>
          {[...result.conflicts.map((c) => ({ ...c, kind: 'Conflict' })), ...result.blocked.map((c) => ({ ...c, kind: 'Skipped' }))].map((c) => <p key={`${c.kind}-${c.path}`} className="review-skip">{c.kind}, {c.path}: {c.reason}</p>)}
          <p className="agent-muted">{result.remaining.pending ? `${plural(result.remaining.pending, 'file')} from this run still waiting${result.remaining.current < result.remaining.pending ? ` (${result.remaining.pending - result.remaining.current} replaced by a later run)` : ''}.` : 'Nothing from this run is waiting any more.'}</p>
        </div>}
      </>}
      <div className="setup-actions review-actions">
        <button type="button" className="button primary-button" disabled={busy || !review || Boolean(stale) || review.needsAccess || ![...chosen].some((p) => eligible.some((f) => f.path === p))} onClick={apply}>Apply selected changes{chosen.size ? ` (${[...chosen].filter((p) => eligible.some((f) => f.path === p)).length})` : ''}</button>
        <button type="button" className="button" disabled={busy} onClick={() => load(folderId, Boolean(result))}>Refresh</button>
        <button type="button" className="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
