// What is going on right now: a working animation with the time it has taken (like Claude's), the
// team's activity, step by step, and how much of each subscription is left.
import React, { useEffect, useState } from 'react';
import { elapsed, logLine, usageRows } from './live-chat.mjs';

function useNow(active, every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [active, every]);
  return now;
}

export function Working({ label, since, done = false, className = '' }) {
  const now = useNow(!done);
  return <span className={`working-line ${done ? 'is-done' : ''} ${className}`} role="status">
    {!done && <span className="working-spark" aria-hidden="true" />}
    <span className="working-label">{label}</span>
    {since ? <span className="working-time">{elapsed(now - since)}</span> : null}
  </span>;
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ActivityLog({ run, nameOf }) {
  const running = run.status === 'running';
  const [open, setOpen] = useState(false);
  const lines = (run.log || []).map((entry) => ({ entry, line: logLine(entry, run, nameOf) })).filter((x) => x.line);
  if (!lines.length) return null;
  const shown = open ? lines : running ? lines.slice(-4) : [];
  return <div className={`activity-log ${running ? 'is-running' : ''}`}>
    <button type="button" className="activity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>Activity</span><span className="activity-count">{lines.length} {lines.length === 1 ? 'step' : 'steps'}</span><span className="activity-chevron">{open ? '▾' : '▸'}</span>
    </button>
    {shown.length > 0 && <ol className="activity-lines">
      {shown.map(({ entry, line }, i) => <li key={`${entry.at}-${i}`} className={`activity-line kind-${line.kind}`}>
        <span className="activity-mark" aria-hidden="true" />
        <span className="activity-text">{line.text}</span>
        <time className="activity-time" dateTime={new Date(entry.at).toISOString()}>{clock(entry.at)}</time>
      </li>)}
    </ol>}
  </div>;
}

const resetText = (ms) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `resets ${sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
};

// True when a window of a tool has 10 % or less left (a dot on the profile button says so).
export const lowUsage = (statuses) => usageRows(statuses).some((r) => r.windows.some((w) => w.left <= 10));

// The sidebar card: what is left of the 5-hour and weekly windows of Claude and ChatGPT.
export function UsagePanel({ statuses, onAccounts, onCheck, Icon }) {
  const rows = usageRows(statuses);
  const [checking, setChecking] = useState(false);
  const check = () => { if (checking) return; setChecking(true); onCheck(() => setChecking(false)); };
  return <div className="connection-card usage-card">
    <div className="usage-head"><span className="connection-icon"><Icon name="link" size={15} /></span><strong>Usage left</strong></div>
    {rows.length === 0 && <p>Connect Claude Code, Codex or Gemini to see how much of your subscription is left.</p>}
    {rows.map((row) => <div key={row.provider} className="usage-tool">
      <div className="usage-tool-name"><span>{row.name}</span>{row.at && <small title="Claude Code reports this during a reply">as of {new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}</div>
      {row.windows.length === 0
        ? <small className="usage-unknown">{row.provider === 'claude' ? 'Not known yet. Claude reports it when it answers.' : row.provider === 'gemini' ? 'Not reported yet. Gemini shows it after you sign in with your Google account.' : 'Not reported yet'}</small>
        : row.windows.map((w) => <div key={w.name} className={`usage-window ${w.left <= 10 ? 'is-low' : w.left <= 30 ? 'is-warn' : ''}`} title={w.resets ? resetText(w.resets) : undefined}>
          <span className="usage-window-name">{w.name}</span>
          <i className="usage-bar"><b style={{ width: `${w.left}%` }} /></i>
          <span className="usage-left">{w.left}%</span>
        </div>)}
      {row.provider === 'claude' && onCheck && <button type="button" className="usage-check" disabled={checking} onClick={check} title="Sends one tiny message to Claude to read how much is left. It uses a very small part of your plan.">{checking ? 'Checking…' : 'Check now'}</button>}
    </div>)}
    <button onClick={onAccounts}>Manage accounts <Icon name="chevron" size={12} /></button>
  </div>;
}
