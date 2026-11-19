// The Team Bridge in the tree (Teams phase 2): Your Manager ↔ Team Bridge ↔ each teammate's
// Manager, for a project linked to a shared team project. These nodes are drawn next to the tree,
// never saved into it: a teammate's Manager is read-only here and cannot be edited or run from
// this computer. Solo projects do not show any of this.
import React from 'react';
import { BRIEF_STATUS_TEXT, NODE_H, NODE_W, STATUS_TEXT, ago, bridgeLayout, briefsNotice, unsyncedBriefs, bridgeSummary, displayName, memberStatus, repoName } from './teams-ui.mjs';

// The boxes the tree's "fit" should include, in tree coordinates.
export function overlayBoxes(graph, linked, view) {
  if (!linked) return [];
  const manager = graph.nodes.find((n) => n.role === 'Manager');
  const teammates = linked.team.members.filter((m) => m.userId !== view?.userId);
  const layout = bridgeLayout(manager, teammates.length);
  return layout ? [layout.bridge, ...layout.teammates] : [];
}

function edgePath(ax, ay, bx, by) {
  const mid = (ax + bx) / 2;
  return `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}`;
}

export function TeamOverlay({ graph, linked, view, onOpen, managerAt, Icon }) {
  if (!linked) return null;
  const original = graph.nodes.find((n) => n.role === 'Manager');
  if (!original) return null;
  const manager = managerAt ? managerAt(original) : original;
  const teammates = linked.team.members.filter((m) => m.userId !== view.userId);
  const layout = bridgeLayout(manager, teammates.length);
  const { bridge } = layout;
  const midY = (n) => n.y + NODE_H / 2;
  const open = (e) => { e.stopPropagation(); onOpen(); };
  return (
    <>
      <svg className="edges team-edges" width="5000" height="4000" aria-hidden="true">
        <path className="edge-line team-edge" d={edgePath(manager.x + NODE_W, midY(manager), bridge.x, midY(bridge))}/>
        {layout.teammates.map((t, i) => <path key={i} className="edge-line team-edge" d={edgePath(bridge.x + NODE_W, midY(bridge), t.x, midY(t))}/>)}
      </svg>
      <div className="agent-node team-node team-bridge-node" style={{ left: bridge.x, top: bridge.y }} role="button" tabIndex={0} aria-label={`Team Bridge for ${linked.team.name}. Open project context.`}
        onPointerDown={(e) => e.stopPropagation()} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(e); }}>
        <div className="node-heading"><span className="node-avatar team-bridge-avatar"><Icon name="link" size={19}/></span><div><span className="node-role">Team Bridge</span><strong>{linked.team.name}</strong></div></div>
        <div className="node-model">github.com/{repoName(linked.project.repo)}{linked.project.briefs?.length ? ` · ${linked.project.briefs.length} active` : ''}</div>
        <div className="node-bottom"><span><span className={`status-dot team-dot-${view.presence?.[linked.project.id]?.connection || 'connecting'}`}/>{bridgeSummary(view, linked.team, linked.project)}</span><span className="node-bottom-actions"><span>Open</span></span></div>
      </div>
      {teammates.map((m, i) => {
        const status = memberStatus(view, linked.project.id, m.userId);
        const at = layout.teammates[i];
        return (
          <div key={m.userId} className="agent-node team-node team-remote-node" style={{ left: at.x, top: at.y }} role="button" tabIndex={0} aria-label={`${displayName(m.name)}'s Manager, read-only, ${STATUS_TEXT[status]}`}
            onPointerDown={(e) => e.stopPropagation()} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(e); }}>
            <div className="node-heading"><span className="node-avatar"><Icon name="tree" size={19}/></span><div><span className="node-role">Manager · read-only</span><strong>{displayName(m.name)}’s Manager</strong></div></div>
            <div className="node-model">@{m.name}</div>
            <div className="node-bottom"><span><span className={`status-dot team-dot-${status}`}/>{STATUS_TEXT[status]}</span><span className="node-bottom-actions"><span>On their computer</span></span></div>
          </div>
        );
      })}
    </>
  );
}

export function BridgePanel({ linked, view, onClose, Icon }) {
  const { team, project } = linked;
  const presence = view.presence?.[project.id];
  const nameOf = (userId) => displayName(team.members.find((m) => m.userId === userId)?.name);
  const notice = briefsNotice(view, project.id);
  const unsynced = unsyncedBriefs(view, project.id);
  return (
    <aside className="task-drawer team-bridge-panel" aria-label={`Team Bridge for ${team.name}`}>
      <div className="task-drawer-top"><div><span className="eyebrow">TEAM BRIDGE</span><h2>{team.name}</h2></div><button className="icon-button" title="Close Team Bridge" aria-label="Close Team Bridge" onClick={onClose}><Icon name="close"/></button></div>
      <div className="task-drawer-scroll team-bridge-body">
        <section>
          <h3>Shared repository</h3>
          <p><strong>{project.name}</strong><br/><span className="team-muted">github.com/{repoName(project.repo)}</span></p>
          {project.link?.branch && <p className="team-muted">Your checkout is on branch {project.link.branch}.</p>}
        </section>
        <section>
          <h3>People</h3>
          {presence && presence.connection !== 'live' && <p className="team-muted" role="status">{presence.connection === 'unavailable' ? (presence.problem || 'Status unavailable.') : STATUS_TEXT[presence.connection]}</p>}
          <ul className="team-people">
            {team.members.map((m) => {
              const status = memberStatus(view, project.id, m.userId);
              return <li key={m.userId}><span className={`status-dot team-dot-${status}`}/><span>@{m.name}{m.userId === view.userId ? ' (you)' : ''}</span><small>{STATUS_TEXT[status]}</small></li>;
            })}
          </ul>
          <p className="team-muted">Online means their 0rqestra is open, signed in and they have used their computer in the last 10 minutes. Going offline never changes their work.</p>
        </section>
        <section>
          <h3>Reserved files</h3>
          {project.reservations?.length
            ? <ul className="team-briefs">{project.reservations.map((r) => (
                <li key={r.id}>
                  <div className="team-brief-head"><strong>{r.task || 'Team run'}</strong><span className="team-brief-status">until {new Date(r.expiresAt).toLocaleTimeString()}</span></div>
                  <small>{r.name || nameOf(r.userId)}{r.userId === view.userId ? ' (you)' : ''}{r.branch ? ` · branch ${r.branch}` : ''}</small>
                  <small className="team-brief-paths" title={r.paths.join('\n')}>{r.paths.slice(0, 5).join(', ')}{r.paths.length > 5 ? ` and ${r.paths.length - 5} more` : ''}</small>
                </li>
              ))}</ul>
            : <p className="team-muted">No files are reserved right now.</p>}
          <p className="team-muted">A team run reserves the files it will write before it starts; a run that overlaps them waits. This covers writes made through 0rqestra's team runs only: edits you make by hand or with other tools are not coordinated.</p>
        </section>
        <section>
          <h3>Active work</h3>
          {notice && <p className="team-muted team-stale" role="status">{notice}</p>}
          {unsynced.length > 0 && (
            <div className="team-sync-problem" role="alert">
              {unsynced.map((b) => <p key={b.runId}><strong>Your brief “{b.title}” ({BRIEF_STATUS_TEXT[b.status] || b.status}) {b.sync === 'failed' ? 'has not synced' : 'is being sent'}.</strong> {b.sync === 'failed' ? `It is sent again automatically when the connection works.${b.error ? ` (${b.error})` : ''}` : ''}{b.outcome && ['completed', 'stopped', 'failed'].includes(b.status) ? ` Outcome: ${b.outcome}` : ''}</p>)}
            </div>
          )}
          {project.briefs?.length
            ? <ul className="team-briefs">{project.briefs.map((b) => (
                <li key={b.id}>
                  <div className="team-brief-head"><strong>{b.title}</strong><span className={`team-brief-status team-brief-${b.status}`}>{BRIEF_STATUS_TEXT[b.status] || b.status}</span></div>
                  <small>{b.authorName || nameOf(b.authorId)}{b.authorId === view.userId ? ' (you)' : ''}{b.branch ? ` · branch ${b.branch}` : ''} · updated {ago(b.updatedAt)}</small>
                  {b.paths?.length > 0 && <small className="team-brief-paths" title={b.paths.join('\n')}>{b.paths.slice(0, 4).join(', ')}{b.paths.length > 4 ? ` and ${b.paths.length - 4} more` : ''}</small>}
                </li>
              ))}</ul>
            : <p className="team-muted">Nobody is running approved work in this project right now. When a teammate starts a team run, its brief shows here.</p>}
        </section>
      </div>
    </aside>
  );
}

// An informational Teams message in the Manager chat (catch-up or teammate status). It is not sent
// to the model as conversation and has no actions: it never starts any work.
export function TeamInfoMessage({ m, Icon }) {
  return (
    <div className="message message-manager team-info-message" role="note">
      <div className="message-author"><span className="mini-avatar green"><Icon name="tree" size={14}/></span>Manager<span>{m.infoType === 'catch-up' ? 'Team catch-up' : 'Team status'}</span></div>
      <div className="message-body team-info-body">{m.text}</div>
    </div>
  );
}

// "What is [name] working on?" for each teammate, above the message box of a linked project.
// Shown whether the teammate is online or not.
export function TeamAskBar({ linked, view, busy, onAsk }) {
  const teammates = linked.team.members.filter((m) => m.userId !== view.userId);
  if (!teammates.length) return null;
  return (
    <div className="team-ask-bar" aria-label="Ask about teammates">
      {teammates.map((m) => (
        <button key={m.userId} type="button" className="team-ask-chip" disabled={busy} onClick={() => onAsk(m)}>
          <span className={`status-dot team-dot-${memberStatus(view, linked.project.id, m.userId)}`}/>What is {displayName(m.name)} working on?
        </button>
      ))}
    </div>
  );
}
