// The parts of the real chat that are shown: the choice of tool, model and effort under the
// message box, and a reply from a real model while it is written and after.
import React from 'react';
import { FAILURE_HELP, readyProviders, usageLine } from './live-chat.mjs';

export function ChatTargetPicker({ target, statuses, onChange, onAccounts }) {
  const ready = readyProviders(statuses);
  const current = ready.find((s) => s.provider === target.provider);
  const model = current?.models.find((m) => m.id === target.model);
  const set = (patch) => onChange({ provider: target.provider, model: target.model, effort: target.effort, ...patch });
  return (
    <span className="chat-target">
      <select aria-label="Who answers" className="chat-select" value={target.provider} onChange={(e) => set({ provider: e.target.value, model: null, effort: null })}>
        <option value="demo">Demo (no model)</option>
        {ready.map((s) => <option key={s.provider} value={s.provider}>{s.name}</option>)}
      </select>
      {current && current.models.length > 0 && (
        <select aria-label="Model" className="chat-select" value={target.model ?? ''} onChange={(e) => set({ model: e.target.value, effort: null })}>
          {current.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      )}
      {model && model.efforts.length > 0 && (
        <select aria-label="Effort" className="chat-select" value={target.effort ?? ''} onChange={(e) => set({ effort: e.target.value || null })}>
          <option value="">Default effort</option>
          {model.efforts.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      )}
      {ready.length === 0 && <button type="button" className="chat-connect" onClick={onAccounts}>Connect Claude Code or Codex</button>}
    </span>
  );
}

export function AssistantMessage({ m, Icon, onAccounts }) {
  const label = [m.providerName, m.model && m.model !== 'default' ? m.model : null, m.effort].filter(Boolean).join(' · ');
  const usage = m.status === 'done' ? usageLine(m) : '';
  return (
    <div className={`message message-manager message-live message-${m.status}`}>
      <div className="message-author"><span className="mini-avatar green"><Icon name="tree" size={14}/></span>Manager<span>{label}</span></div>
      <div className="message-body">
        {m.text}
        {m.status === 'streaming' && <span className="live-caret" aria-hidden="true"/>}
        {m.status === 'streaming' && !m.text && <span className="live-waiting">Writing…</span>}
      </div>
      {m.status === 'stopped' && <div className="live-note">Stopped.</div>}
      {m.status === 'failed' && (
        <div className="live-note live-error" role="alert">
          <strong>{m.error || 'The reply failed.'}</strong> {FAILURE_HELP[m.reason] || ''}
          {['not_installed', 'not_signed_in', 'not_subscription'].includes(m.reason) && <button type="button" className="chat-connect" onClick={onAccounts}>Open AI accounts</button>}
        </div>
      )}
      {usage && <div className="live-note">{usage}</div>}
    </div>
  );
}
