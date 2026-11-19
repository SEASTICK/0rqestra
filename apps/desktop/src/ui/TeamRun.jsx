// The Manager's plan, and the team working on it, as cards in the chat.
import React from 'react';

const STATUS_LABEL = {
  waiting: 'Waiting', working: 'Working', waiting_context: 'Waiting for context', reviewing: 'In review', done: 'Done', unverified: 'Done, not reviewed',
  failed: 'Failed', blocked: 'Blocked', stopped: 'Stopped',
};
const RUN_LABEL = { running: 'The team is working', done: 'Finished', failed: 'Did not finish', stopped: 'Stopped' };

export function PlanCard({ plan, assignments, startedRunId, busy, onStart, onTree, plannedBy, summary }) {
  const missing = [...new Set(assignments.filter((t) => !t.agent).map((t) => t.role))];
  return (
    <div className="plan-card" role="group" aria-label="Plan">
      <div className="plan-head"><span className="plan-eyebrow">{plannedBy ? `PLAN BY ${plannedBy.toUpperCase()}` : 'PLAN'}</span><strong>{plan.goal}</strong>{summary && <small className="plan-summary">{summary}</small>}</div>
      <ol className="plan-tasks">
        {assignments.map((t) => (
          <li key={t.id} className="plan-task">
            <div className="plan-task-main">
              <strong>{t.title}</strong>
              <span className={`plan-agent ${t.agent ? '' : 'is-missing'}`}>{t.role} · {t.agent ? t.agent.name : 'no working agent'}</span>
            </div>
            <div className="plan-task-goal">{t.goal}</div>
            <div className="plan-files">{t.deliverables.map((d) => <code key={d}>{d}</code>)}{t.dependsOn.length > 0 && <span>after {t.dependsOn.join(', ')}</span>}</div>
          </li>
        ))}
      </ol>
      <div className="plan-actions">
        {missing.length > 0 && <span className="plan-warning">Set an agent on Claude Code or Codex for: {missing.join(', ')}</span>}
        {missing.length > 0 && <button type="button" className="shell-button" onClick={onTree}>Open team tree</button>}
        {startedRunId
          ? <span className="plan-started">Started — the team's progress is below.</span>
          : <button type="button" className="shell-button primary" disabled={busy || missing.length > 0} onClick={onStart}>Start</button>}
      </div>
    </div>
  );
}

export function TeamRunCard({ run, nameOf, onStop, onOpenFolder, onReplan, onPreview }) {
  const running = run.status === 'running';
  const tokens = run.usage && (run.usage.inputTokens || run.usage.outputTokens) ? ` · ${run.usage.inputTokens} in · ${run.usage.outputTokens} out tokens` : '';
  return (
    <div className={`team-card team-${run.status}`} role="status" aria-live="polite">
      <div className="team-head">
        <span className={`team-dot ${running ? 'is-live' : ''}`}/>
        <strong>{RUN_LABEL[run.status] || run.status}</strong>
        <span className="team-goal">{run.goal}</span>
      </div>
      <ul className="team-tasks">
        {run.tasks.map((t) => (
          <li key={t.id} className={`team-task task-${t.status}`}>
            <span className={`team-chip chip-${t.status}`}>{STATUS_LABEL[t.status] || t.status}</span>
            <div className="team-task-main">
              <strong>{t.title}</strong>
              <span>{t.role}{t.agentId || t.plannedAgentId ? ` · ${nameOf(t.agentId || t.plannedAgentId)}` : ''}{t.attempt > 1 ? ` · attempt ${t.attempt}` : ''}</span>
              {t.note && <small>{t.note}</small>}
              {t.brief?.summary && <small className="team-brief">{t.brief.summary}{t.brief.unresolved?.length ? ` · Open: ${t.brief.unresolved.slice(0, 2).join('; ')}` : ''}</small>}
              {t.review && !t.review.approved && t.review.problems.length > 0 && <small className="team-problems">Review: {t.review.problems.slice(0, 3).join(' · ')}</small>}
              {t.files.length > 0 && <div className="plan-files">{t.files.map((f) => <code key={f.path}>{f.path}</code>)}</div>}
            </div>
          </li>
        ))}
      </ul>
      {run.summary && <p className="team-summary">{run.summary}</p>}
      <div className="team-foot">
        <span>{run.calls ? `${run.calls} agent request${run.calls === 1 ? '' : 's'}${tokens}` : running ? 'Starting…' : ''}</span>
        <span className="team-actions">
          {running && <button type="button" className="shell-button" onClick={onStop}>Stop</button>}
          {run.status === 'failed' && onReplan && <button type="button" className="shell-button primary" onClick={onReplan}>Ask the Manager to fix it</button>}
          {onPreview ? <button type="button" className="shell-button primary" onClick={onPreview}>Open preview</button> : null}
          {run.files.length > 0 || run.tasks.some((t) => t.files.length) ? <button type="button" className="shell-button" onClick={onOpenFolder}>Open project folder</button> : null}
        </span>
      </div>
    </div>
  );
}

// While the Planner turns the Manager's brief into a plan, and when that did not work.
export function PlannerCard({ planning, brief, onStop, onRetry }) {
  if (planning?.status === 'failed') {
    return (
      <div className="plan-card planner-card" role="alert">
        <div className="plan-head"><span className="plan-eyebrow">PLANNER</span><strong>No plan this time</strong><small className="plan-summary">{planning.error}</small></div>
        <div className="plan-actions"><button type="button" className="shell-button primary" onClick={onRetry}>Ask the Planner again</button></div>
      </div>
    );
  }
  return (
    <div className="plan-card planner-card" role="status" aria-live="polite">
      <div className="plan-head">
        <span className="plan-eyebrow"><span className="team-dot is-live"/> {planning?.plannerName ? `${planning.plannerName.toUpperCase()} IS PLANNING` : 'WAITING FOR THE PLANNER'}</span>
        <strong>{brief.length > 220 ? `${brief.slice(0, 220)}…` : brief}</strong>
      </div>
      <div className="plan-actions">{planning?.status === 'running' && <button type="button" className="shell-button" onClick={onStop}>Stop</button>}</div>
    </div>
  );
}
