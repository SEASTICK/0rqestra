// What one agent in the tree is doing: what it writes right now (as it writes), its earlier answers,
// the files it wrote, and its reviews. Opens when the agent is clicked in the tree.
import React, { useEffect, useRef, useState } from 'react';
import { Working } from './Activity.jsx';
import { CapabilitiesTab } from './Capabilities.jsx';
import { agentWork, elapsed, textParts } from './live-chat.mjs';

const STATE_LABEL = { working: 'Working', reviewing: 'Reviewing', planning: 'Planning', queued: 'Waiting for its turn', completed: 'Done', blocked: 'Blocked', interrupted: 'Stopped', idle: 'Idle' };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Answer({ text, live = false, Icon }) {
  const parts = textParts(text);
  if (!parts.length) return <p className="agent-text agent-muted">{live ? 'Waiting for the first words…' : 'No text.'}</p>;
  return <div className="agent-answer">{parts.map((p, i) => p.type === 'text'
    ? <p key={i} className="agent-text">{p.text}</p>
    : p.type === 'file'
      ? <div key={i} className="agent-file"><Icon name="code" size={14} /><code>{p.path}</code><span>{p.lines} {p.lines === 1 ? 'line' : 'lines'}{p.done ? '' : ' · writing…'}</span></div>
      : <div key={i} className={`agent-verdict ${p.approved ? 'is-ok' : 'is-changes'}`}><strong>{p.approved ? 'Approved' : 'Changes needed'}</strong>{p.problems.length > 0 && <ul>{p.problems.map((x, j) => <li key={j}>{x}</li>)}</ul>}</div>)}</div>;
}

function Earlier({ item, open: startOpen, Icon }) {
  const [open, setOpen] = useState(startOpen);
  return <li className={`agent-earlier ${item.failed ? 'is-failed' : ''}`}>
    <button type="button" className="agent-earlier-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="agent-earlier-title">{item.kind === 'review' ? 'Reviewed' : 'Worked on'} “{item.taskTitle}”{item.attempt > 1 ? ` · attempt ${item.attempt}` : ''}</span>
      <span className="agent-earlier-meta">{item.startedAt ? `${elapsed(item.at - item.startedAt)} · ` : ''}{clock(item.at)} {open ? '▾' : '▸'}</span>
    </button>
    {item.failed && <p className="agent-failed">{item.failed}</p>}
    {open && <Answer text={item.text} Icon={Icon} />}
  </li>;
}

// Ask this agent directly: no Manager and no plan to approve. It reads the project and changes what is
// needed (another agent reviews it), or only answers a question.
function AskAgent({ node, canAsk, busy, onAsk }) {
  const [text, setText] = useState('');
  const send = () => { if (text.trim() && canAsk && !busy && onAsk(text)) setText(''); };
  return <form className="agent-ask" onSubmit={(e) => { e.preventDefault(); send(); }}>
    <textarea rows={2} maxLength={4000} aria-label={`Ask ${node.name} directly`} disabled={!canAsk} placeholder={canAsk ? `Ask ${node.name} directly… for example: make the heading bigger` : 'Set this agent to Claude Code, Codex or Gemini to ask it directly.'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
    <div className="agent-ask-foot"><small>{busy ? 'The team is working; ask when it is done.' : 'Goes straight to this agent. Changed files are reviewed.'}</small><button type="submit" className="shell-button primary" disabled={!canAsk || busy || !text.trim()}>Send</button></div>
  </form>;
}

export function AgentPanel({ node, state, messages, Icon, onClose, onConfigure, onAsk, canAsk = false, busy = false, graph, projectId, notify, onPatchNode, onPatchProjectSkills }) {
  const [tab, setTab] = useState('activity');
  const work = agentWork(messages, node.id);
  const scroller = useRef(null);
  const liveText = work.live?.text;
  // Follow the text while the agent writes, like a terminal.
  useEffect(() => { if (liveText && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [liveText]);
  const active = ['working', 'reviewing', 'planning'].includes(state);
  const runtime = node.agent ? [node.agent.tool === 'claude' ? 'Claude Code' : node.agent.tool === 'codex' ? 'Codex' : node.agent.tool === 'gemini' ? 'Gemini' : node.agent.tool, node.agent.model, node.agent.effort].filter(Boolean).join(' · ') : 'No tool yet';
  return <aside className="agent-panel" aria-label={`What ${node.name} is doing`} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
    <div className="agent-panel-head">
      <div className="agent-panel-who">
        <span className="node-role">{node.role}</span>
        <strong>{node.name}</strong>
        <small>{runtime}</small>
      </div>
      <div className="inline-actions">
        <button className="icon-button" title={`Configure ${node.name}`} aria-label={`Configure ${node.name}`} onClick={onConfigure}><Icon name="settings" size={15} /></button>
        <button className="icon-button" title="Close" aria-label="Close the agent panel" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
    </div>
    <div className="agent-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'is-on' : ''} onClick={() => setTab('activity')}>Activity</button>
      <button type="button" role="tab" aria-selected={tab === 'capabilities'} className={tab === 'capabilities' ? 'is-on' : ''} onClick={() => setTab('capabilities')}>Capabilities</button>
    </div>
    {tab === 'capabilities' ? <div className="agent-panel-body"><CapabilitiesTab node={node} graph={graph} projectId={projectId} Icon={Icon} notify={notify} onPatchNode={onPatchNode} onPatchProjectSkills={onPatchProjectSkills} /></div> : <>
    <div className="agent-panel-body" ref={scroller}>
      <section className="agent-now">
        <h4>Now</h4>
        {work.live
          ? <><Working label={`${work.live.kind === 'review' ? 'Reviewing' : 'Writing'} “${work.live.taskTitle}”`} since={work.live.startedAt} /><Answer text={work.live.text} live Icon={Icon} /></>
          : active
            ? <Working label={STATE_LABEL[state]} />
            : <p className="agent-muted">{STATE_LABEL[state] || 'Idle'}{state === 'queued' ? '' : ' — not working on anything right now.'}</p>}
      </section>
      {work.files.length > 0 && <section>
        <h4>Files it wrote</h4>
        <div className="plan-files">{work.files.map((f) => <code key={f.path}>{f.path}</code>)}</div>
      </section>}
      <section>
        <h4>Earlier</h4>
        {work.history.length
          ? <ol className="agent-earlier-list">{work.history.map((item, i) => <Earlier key={`${item.taskId}-${item.kind}-${item.attempt}-${item.at}`} item={item} open={i === 0} Icon={Icon} />)}</ol>
          : <p className="agent-muted">Nothing yet. When the team works, what {node.name} writes shows here.</p>}
      </section>
    </div>
    {onAsk && <AskAgent node={node} canAsk={canAsk} busy={busy} onAsk={onAsk} />}
    </>}
  </aside>;
}
