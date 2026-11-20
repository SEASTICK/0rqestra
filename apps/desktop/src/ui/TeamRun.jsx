// The Manager's plan, and the team working on it, as cards in the chat.
import React from 'react';
import { ActivityLog, Working } from './Activity.jsx';
import { directReply, elapsed, planTools, runUsage, textParts, TOOL_LABEL } from './live-chat.mjs';

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
      {planTools(assignments).length > 1 && <div className="plan-together"><span className="tool-chip tool-claude">Claude</span><span className="tool-chip tool-codex">ChatGPT</span><span>work together on this plan — the Manager chose who does what.</span></div>}
      {plan.products?.length > 0 && <div className="plan-products"><span>Products</span>{plan.products.map((p) => <span key={p.id} className="plan-product"><strong>{p.name}</strong>{p.folder ? <code>{p.folder}/</code> : null}</span>)}</div>}
      <ol className="plan-tasks">
        {assignments.map((t) => (
          <li key={t.id} className="plan-task">
            <div className="plan-task-main">
              <strong>{t.title}</strong>
              <span className={`plan-agent ${t.agent ? '' : 'is-missing'}`}>{t.role} · {t.agent ? t.agent.name : 'no working agent'}{t.agent?.tool && <span className={`tool-chip tool-${t.agent.tool}`}>{TOOL_LABEL[t.agent.tool] || t.agent.tool}{t.runsOn ? ` · ${t.runsOn}` : ''}</span>}</span>
            </div>
            {t.chosen && t.why && <div className="plan-why">Why {t.agent.name}: {t.why}</div>}
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

// Tokens per agent and for the whole run, including planning (Stage 3).
function UsageDetails({ run }) {
  const u = runUsage(run);
  if (!u || !u.calls) return null;
  return (
    <details className="team-usage">
      <summary>Usage: {u.total} · {u.calls} call{u.calls === 1 ? '' : 's'}{u.retries ? ` · ${u.retries} retr${u.retries === 1 ? 'y' : 'ies'}` : ''}{u.contextRequests ? ` · ${u.contextRequests} context request${u.contextRequests === 1 ? '' : 's'}` : ''}</summary>
      <ul>
        {u.rows.map((r) => <li key={r.label}><span>{r.label}</span><small>{r.calls} call{r.calls === 1 ? '' : 's'}{r.kinds ? ` (${r.kinds})` : ''} · {r.text}</small></li>)}
      </ul>
      {u.partial && <p className="team-usage-note">Partial: some calls did not report their tokens, so the totals leave them out.</p>}
    </details>
  );
}

export function TeamRunCard({ run, nameOf, onStop, onOpenFolder, onReplan, onPreview, onUndo, toolOf = () => null }) {
  const running = run.status === 'running';
  const tokens = run.usage && (run.usage.inputTokens || run.usage.outputTokens) ? ` · ${run.usage.inputTokens} in · ${run.usage.outputTokens} out tokens` : '';
  return (
    <div className={`team-card team-${run.status}`} role="status" aria-live="polite">
      <div className="team-head">
        {running
          ? <Working label={run.direct ? `${run.direct.name} is working` : RUN_LABEL.running} since={run.startedAt} className="team-working" />
          : <><span className="team-dot"/><strong>{RUN_LABEL[run.status] || run.status}</strong>{run.startedAt && run.endedAt ? <span className="team-took">in {elapsed(run.endedAt - run.startedAt)}</span> : null}</>}
        <span className="team-goal">{run.goal}</span>
      </div>
      {run.direct && <DirectReply run={run} nameOf={nameOf} />}
      <ul className="team-tasks">
        {run.tasks.map((t) => (
          <li key={t.id} className={`team-task task-${t.status}`}>
            <span className={`team-chip chip-${t.status}`}>{STATUS_LABEL[t.status] || t.status}</span>
            <div className="team-task-main">
              <strong>{t.title}</strong>
              <span>{t.role}{t.agentId || t.plannedAgentId ? ` · ${nameOf(t.agentId || t.plannedAgentId)}` : ''}{toolOf(t.agentId || t.plannedAgentId) && <span className={`tool-chip tool-${toolOf(t.agentId || t.plannedAgentId)}`}>{TOOL_LABEL[toolOf(t.agentId || t.plannedAgentId)]}</span>}{t.attempt > 1 ? ` · attempt ${t.attempt}` : ''}</span>
              {t.note && <small>{t.note}</small>}
              {t.brief?.summary && <small className="team-brief">{t.brief.summary}{t.brief.unresolved?.length ? ` · Open: ${t.brief.unresolved.slice(0, 2).join('; ')}` : ''}</small>}
              {t.review && !t.review.approved && t.review.problems.length > 0 && <small className="team-problems">Review: {t.review.problems.slice(0, 3).join(' · ')}</small>}
              {t.files.length > 0 && <div className="plan-files">{t.files.map((f) => <code key={f.path}>{f.path}</code>)}</div>}
            </div>
          </li>
        ))}
      </ul>
      <ActivityLog run={run} nameOf={nameOf} />
      {run.summary && <p className="team-summary">{run.summary}</p>}
      <UsageDetails run={run}/>

      {run.undone && <p className="team-undone">Changes undone · {[...run.undone.restored, ...run.undone.removed].length === 1 ? '1 file back as it was' : `${[...run.undone.restored, ...run.undone.removed].length} files back as they were`} before this run{run.undone.removed.length ? ` (${run.undone.removed.join(', ')} removed)` : ''}.</p>}
      <div className="team-foot">
        <span>{run.calls ? `${run.calls} agent request${run.calls === 1 ? '' : 's'}${tokens}` : running ? 'Starting…' : ''}</span>
        <span className="team-actions">
          {running && <button type="button" className="shell-button" onClick={onStop}>Stop</button>}
          {run.status === 'failed' && onReplan && <button type="button" className="shell-button primary" onClick={onReplan}>Ask the Manager to fix it</button>}
          {onUndo && !running && !run.undone ? <button type="button" className="shell-button" title="Put the files back as they were before this run" onClick={onUndo}>Undo changes</button> : null}
          {onPreview ? <button type="button" className="shell-button primary" onClick={onPreview}>Open preview</button> : null}
          {run.files.length > 0 || run.tasks.some((t) => t.files.length) ? <button type="button" className="shell-button" onClick={onOpenFolder}>Open project folder</button> : null}
        </span>
      </div>
    </div>
  );
}

// A request the user gave one agent directly: who answered, and what it said (files as one line each).
function DirectReply({ run }) {
  const reply = directReply(run);
  if (!reply) return null;
  return <div className="direct-reply"><span className="direct-who">{run.direct.name}</span>
    {textParts(reply).map((p, i) => p.type === 'text' ? <p key={i}>{p.text}</p> : p.type === 'file' ? <div key={i} className="agent-file"><code>{p.path}</code><span>{p.lines} {p.lines === 1 ? 'line' : 'lines'}</span></div> : null)}
  </div>;
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
        <Working label={planning?.plannerName ? `${planning.plannerName} is planning` : 'Waiting for the Planner'} since={planning?.startedAt} className="plan-working" />
        <strong>{brief.length > 220 ? `${brief.slice(0, 220)}…` : brief}</strong>
      </div>
      <div className="plan-actions">{planning?.status === 'running' && <button type="button" className="shell-button" onClick={onStop}>Stop</button>}</div>
    </div>
  );
}
