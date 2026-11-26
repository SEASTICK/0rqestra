import { describe, expect, it } from 'vitest';
import { applyTeamEvent, logLine, newTeamRun } from './live-chat.mjs';

// The run card's state when a task stops with a reason and when the user retries it.
const plan = { goal: 'A page', tasks: [
  { id: 't1', title: 'Page', role: 'Builder', deliverables: ['index.html'] },
  { id: 't2', title: 'Style', role: 'Builder', deliverables: ['style.css'] },
  { id: 't3', title: 'Notes', role: 'Builder', deliverables: ['notes.md'] },
] };

describe('run recovery in the window', () => {
  it('keeps a task reason, and a retry reopens only the retried tasks', () => {
    let run = newTeamRun('r1', plan, 1000);
    run = applyTeamEvent(run, { type: 'task', taskId: 't3', status: 'done', agentId: 'b1', attempt: 1 }, 2000);
    run = applyTeamEvent(run, { type: 'task', taskId: 't1', status: 'failed', agentId: 'b1', attempt: 3, note: 'Not approved.', reason: { kind: 'review_rejected', title: 'Vera did not approve.', detail: 'Add a heading', findings: ['Add a heading'] } }, 3000);
    run = applyTeamEvent(run, { type: 'task', taskId: 't2', status: 'blocked', agentId: null, attempt: 0, reason: { kind: 'dependency', title: 'Waiting for Page.', detail: '', after: ['t1'] } }, 3000);
    run = applyTeamEvent(run, { type: 'run-finished', status: 'failed', summary: '1 of 3 tasks finished.', files: [], calls: 4, usage: null }, 4000);
    expect(run.tasks[0].reason.findings).toEqual(['Add a heading']);
    expect(run.endedAt).toBe(4000);
    run = applyTeamEvent(run, { type: 'run-resumed', taskIds: ['t1', 't2'] }, 5000);
    expect(run.status).toBe('running');
    expect(run.endedAt).toBeNull();
    expect(run.tasks.map((t) => [t.id, t.status, t.reason ?? null])).toEqual([['t1', 'waiting', null], ['t2', 'waiting', null], ['t3', 'done', null]]);
    expect(logLine(run.log.at(-1), run, () => 'x').text).toBe('You retried “Page”; “Style” waits for it');
    // A new status clears the old reason.
    run = applyTeamEvent(run, { type: 'task', taskId: 't1', status: 'working', agentId: 'b1', attempt: 1 }, 6000);
    expect(run.tasks[0].reason).toBeNull();
  });
});
