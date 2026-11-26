// The Manager's plan, and the team working on it, as cards in the chat.
import React, { useEffect, useState } from 'react';
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
      {planTools(assignments).length > 1 && <div className="plan-together">{[...new Set(assignments.map((x) => x.agent?.tool).filter(Boolean))].map((t) => <span key={t} className={`tool-chip tool-${t}`}>{TOOL_LABEL[t] || t}</span>)}<span>work together on this plan — the Manager chose who does what.</span></div>}
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
        {missing.length > 0 && <span className="plan-warning">Set an agent on Claude Code, Codex or Gemini for: {missing.join(', ')}</span>}
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

const TOOL_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };

// Why a failed or blocked task stopped (main/team/recovery.ts). Runs saved before reasons existed
// get one from the task's note, so they still show what the app saw and offer the Manager's help.
export function taskReason(t) {
  if (t.reason) return t.reason;
  if (!['failed', 'blocked'].includes(t.status)) return null;
  if (t.note === 'An earlier task it needs did not finish.') return { kind: 'dependency', title: 'Waiting for an earlier task to pass. Retry that task first.', detail: t.note };
  if (t.review && !t.review.approved && t.review.problems?.length) return { kind: 'review_rejected', title: 'The reviewer did not approve the work.', detail: t.review.problems.join(' '), findings: t.review.problems };
  return { kind: 'unknown', title: t.note || 'The task did not finish, and the app recorded no reason.', detail: t.note || 'No details were recorded.' };
}

// What helps next for each reason, and whether Retry needs something first. `recovery` comes from App:
// providerReady(tool), onSignIn(tool), onRecheck(), onConfigure(agentId, role), onRetry(taskId) → result,
// onTellManager(text), onAccess(), busy (a retry is being checked or started).
function TaskRecovery({ run, task, reason, nameOf, recovery, onReplan }) {
  const [open, setOpen] = useState(null);
  const [check, setCheck] = useState(null);
  const [pending, setPending] = useState(false);
  const shown = check?.reason || reason;
  const kind = shown.kind;
  // A signed-out tool: check it again now, so "ready" is never based on an earlier status.
  useEffect(() => { if (kind === 'signed_out') recovery?.onRecheck?.(); }, [kind]);
  const providerReady = shown.provider ? recovery?.providerReady?.(shown.provider) : true;
  const canRetry = Boolean(recovery?.onRetry) && kind !== 'dependency' && run.status !== 'running' && !recovery?.busy && !pending && !(kind === 'signed_out' && !providerReady);
  const retry = async () => {
    if (!canRetry) return;
    setPending(true);
    setCheck(null);
    try {
      const r = await recovery.onRetry(task.id);
      if (r && r.ok === false) setCheck({ reason: r.reason || { kind: 'unknown', title: r.message || 'The retry did not start.', detail: r.message || '' } });
    } catch (e) {
      setCheck({ error: String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    } finally {
      setPending(false);
    }
  };
  const tool = shown.provider ? TOOL_NAME[shown.provider] || shown.provider : null;
  const button = (label, onClick, primary = false, disabled = false) => <button type="button" className={`shell-button ${primary ? 'primary' : ''}`} disabled={disabled} onClick={onClick}>{label}</button>;
  const retryLabel = pending ? 'Checking…' : kind === 'review_rejected' ? 'Retry task' : 'Retry';
  const computerNeed = (shown.needs || []).some((n) => /computer access|read access|granted folder|approved check/i.test(n)) || /computer access|read access/i.test(shown.detail || '');
  return (
    <div className={`task-recovery reason-${kind}`} role="group" aria-label={`What happened to ${task.title}`}>
      <p className="recovery-title">{check?.reason && check.reason !== reason ? <strong>Not retried: </strong> : null}{shown.title}</p>
      {kind === 'signed_out' && <p className="recovery-line">{providerReady ? `${tool} is ready now. Retry to continue.` : `Sign in to ${tool}, then come back here.`}</p>}
      {kind === 'needs_context' && shown.needs?.length > 0 && <div className="recovery-needs"><span>What is needed from you or the Manager:</span><ul>{shown.needs.map((n) => <li key={n}>{n}</li>)}</ul></div>}
      {kind === 'dependency' && <p className="recovery-line">Nothing to do here: it runs once {shown.after?.length ? shown.after.map((id) => `“${run.tasks.find((x) => x.id === id)?.title || id}”`).join(', ') : 'the tasks before it'} pass{shown.after?.length === 1 ? 'es' : ''}.</p>}
      {open === 'conflict' && kind === 'reservation' && <div className="recovery-panel">
        {shown.conflicts?.length ? <ul>{shown.conflicts.map((c, i) => <li key={`${c.name}-${i}`}><strong>{c.name}</strong> is working on “{c.task || 'a team run'}”{c.branch ? ` on branch ${c.branch}` : ''}.<br/><small>Their reservation: {[...new Set(c.overlaps.map((o) => o.theirs))].join(', ')} · overlaps your {[...new Set(c.overlaps.map((o) => o.yours))].join(', ')}</small></li>)}</ul>
          : <p>No teammate details were reported. {shown.detail}</p>}
        <p className="recovery-line">Retry checks the reservation again and starts only when it is free. To work on other files instead, ask the Manager to change the plan.</p>
      </div>}
      {open === 'findings' && kind === 'review_rejected' && <div className="recovery-panel">
        <p><strong>{shown.reviewer || 'The reviewer'}</strong> asked for:</p>
        <ul>{(shown.findings || []).map((f) => <li key={f}>{f}</li>)}</ul>
        <p className="recovery-line">Retry task sends these findings and the last version to {shown.agentName || 'the agent'}, and the result is reviewed again.</p>
      </div>}
      {check?.error && <div className="setup-error" role="alert"><span>{check.error}</span></div>}
      <div className="recovery-actions">
        {kind === 'signed_out' && !providerReady && recovery?.onSignIn && button(`Sign in to ${tool}`, () => recovery.onSignIn(shown.provider), true)}
        {kind === 'signed_out' && recovery?.onRecheck && button('Check again', () => recovery.onRecheck())}
        {kind === 'usage_limit' && recovery?.onSignIn && button('See usage', () => recovery.onSignIn(shown.provider))}
        {['agent_missing', 'model_unavailable'].includes(kind) && recovery?.onConfigure && button(shown.agentId ? `Configure ${shown.agentName || nameOf?.(shown.agentId) || 'agent'}` : 'Configure agent', () => recovery.onConfigure(shown.agentId || null, shown.role || task.role), true)}
        {kind === 'reservation' && button(open === 'conflict' ? 'Hide conflict' : 'View conflict', () => setOpen(open === 'conflict' ? null : 'conflict'), true)}
        {kind === 'review_rejected' && button(open === 'findings' ? 'Hide findings' : 'See findings', () => setOpen(open === 'findings' ? null : 'findings'), true)}
        {kind === 'needs_context' && recovery?.onTellManager && button('Answer the Manager', () => recovery.onTellManager(`For the task “${task.title}”: ${(shown.needs || []).join(' ')}\n\nHere is what you need: `), true)}
        {kind === 'needs_context' && computerNeed && recovery?.onAccess && button('Open Computer access', () => recovery.onAccess())}
        {kind !== 'dependency' && recovery?.onRetry && button(retryLabel, retry, false, !canRetry)}
        {['unknown', 'reservation', 'needs_context', 'limit'].includes(kind) && onReplan && button(kind === 'unknown' ? 'Ask the Manager to fix it' : 'Ask the Manager to change the plan', onReplan)}
      </div>
      {(shown.detail || check?.error) && <details className="recovery-details"><summary>Technical details</summary><pre>{[shown.detail, shown.agentName ? `Agent: ${shown.agentName}` : '', shown.model ? `Model: ${shown.model}` : '', shown.provider ? `Tool: ${tool}` : ''].filter(Boolean).join('\n')}</pre></details>}
    </div>
  );
}

// `changes` is { pending, current } for this run (main/access): files it delivered that wait to be
// applied, and how many of them this run's review could still apply.
export function TeamRunCard({ run, nameOf, onStop, onOpenFolder, onReplan, onPreview, onUndo, onReview, changes, recovery, toolOf = () => null }) {
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
              {(t.skills || []).filter((s) => s.loaded.length || s.refused.length).map((s) => <small key={`${s.agentId}-${s.kind}`} className="team-skills">
                {s.kind === 'review' ? 'Review' : 'Work'} · {nameOf(s.agentId)}: {s.loaded.length ? `skills loaded: ${s.loaded.map((x) => x.name).join(', ')}` : 'no skills loaded'}{s.refused.length ? ` · not available to this agent: ${s.refused.join(', ')}` : ''}
              </small>)}
              {t.brief?.summary && <small className="team-brief">{t.brief.summary}{t.brief.unresolved?.length ? ` · Open: ${t.brief.unresolved.slice(0, 2).join('; ')}` : ''}</small>}
              {t.review && !t.review.approved && t.review.problems.length > 0 && <small className="team-problems">Review: {t.review.problems.slice(0, 3).join(' · ')}</small>}
              {t.files.length > 0 && <div className="plan-files">{t.files.map((f) => <code key={f.path}>{f.path}</code>)}</div>}
              {!running && taskReason(t) && <TaskRecovery key={`${t.id}-${run.retriedAt || 0}`} run={run} task={t} reason={taskReason(t)} nameOf={nameOf} recovery={recovery} onReplan={onReplan}/>}
            </div>
          </li>
        ))}
      </ul>
      <ActivityLog run={run} nameOf={nameOf} />
      {run.summary && <p className="team-summary">{run.summary}</p>}
      <UsageDetails run={run}/>

      {!running && changes?.pending > 0 && <p className="team-pending">{changes.current > 0
        ? `${changes.current === 1 ? '1 file' : `${changes.current} files`} from this run ${changes.current === 1 ? 'waits' : 'wait'} to be applied to your folder.${changes.pending > changes.current ? ` ${changes.pending - changes.current} replaced by a later run.` : ''}`
        : `A later run changed ${changes.pending === 1 ? 'this run’s file' : 'all of this run’s files'} again, so there is nothing left to apply from this card.`}</p>}
      {run.undone && <p className="team-undone">Changes undone · {[...run.undone.restored, ...run.undone.removed].length === 1 ? '1 file back as it was' : `${[...run.undone.restored, ...run.undone.removed].length} files back as they were`} before this run{run.undone.removed.length ? ` (${run.undone.removed.join(', ')} removed)` : ''}.</p>}
      <div className="team-foot">
        <span>{run.calls ? `${run.calls} agent request${run.calls === 1 ? '' : 's'}${tokens}` : running ? 'Starting…' : ''}</span>
        <span className="team-actions">
          {running && <button type="button" className="shell-button" onClick={onStop}>Stop</button>}
          {run.status === 'failed' && onReplan && <button type="button" className="shell-button primary" onClick={onReplan}>Ask the Manager to fix it</button>}
          {onUndo && !running && !run.undone ? <button type="button" className="shell-button" title="Put the files back as they were before this run" onClick={onUndo}>Undo changes</button> : null}
          {onReview && !running && changes?.pending > 0 ? <button type="button" className="shell-button primary" onClick={onReview}>Review changes</button> : null}
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
