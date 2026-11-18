// The parts of the real chat that are shown: the choice of tool, model and effort under the
// message box, and a reply from a real model while it is written and after.
import React, { useState } from 'react';
import { answerFor, FAILURE_HELP, parsePlan, parseQuestion, readyProviders, usageLine, visibleText } from './live-chat.mjs';

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

export function AssistantMessage({ m, Icon, onAccounts, onAnswer, busy, renderPlan }) {
  const label = [m.providerName, m.model && m.model !== 'default' ? m.model : null, m.effort].filter(Boolean).join(' · ');
  const usage = m.status === 'done' ? usageLine(m) : '';
  const asked = m.status === 'done' ? parseQuestion(m.text) : { body: visibleText(m.text), question: null };
  const planned = m.status === 'done' && !asked.question ? parsePlan(m.text) : { body: asked.body, plan: null };
  const body = planned.plan ? planned.body : asked.body;
  // Teams answers (m.readOnly) are informational: any plan or question in them is never offered.
  const question = m.readOnly ? null : asked.question;
  const plan = m.readOnly ? null : planned.plan;
  return (
    <div className={`message message-manager message-live message-${m.status}`}>
      <div className="message-author"><span className="mini-avatar green"><Icon name="tree" size={14}/></span>Manager<span>{label}</span></div>
      <div className="message-body">
        {body}
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
      {m.status === 'failed' && m.fallback && <div className="message-body team-fallback">{m.fallback}</div>}
      {plan && renderPlan && renderPlan(plan, m)}
      {question && !m.answered && <QuestionCard q={question} disabled={busy} onAnswer={(choice) => onAnswer(m.id, answerFor(question, choice), choice)}/>}
      {question && m.answered && <div className="question-answered"><span>{question.question}</span><strong>{m.answered.kind === 'skip' ? 'Skipped — the Manager decides' : m.answered.label}</strong></div>}
      {usage && <div className="live-note">{usage}</div>}
    </div>
  );
}

// A question from the Manager with its options, like a form: the Manager's pick is preselected,
// "Write your own" takes free text, Skip lets the Manager decide. The answer becomes the next message.
export function QuestionCard({ q, onAnswer, disabled }) {
  const [choice, setChoice] = useState(q.recommended ?? 0);
  const [own, setOwn] = useState('');
  const canSubmit = !disabled && (choice !== 'own' || own.trim().length > 0);
  const submit = () => {
    if (!canSubmit) return;
    onAnswer(choice === 'own' ? { kind: 'own', text: own, label: own.trim() } : { kind: 'option', index: choice, label: q.options[choice].label });
  };
  return (
    <div className="question-card" role="group" aria-label={q.question}>
      <div className="question-title">{q.question}</div>
      <div className="question-options" role="radiogroup">
        {q.options.map((o, i) => (
          <label key={i} className={`question-option ${choice === i ? 'is-selected' : ''}`}>
            <input type="radio" name="question" checked={choice === i} onChange={() => setChoice(i)}/>
            <span className="question-text">
              <strong>{o.label}{i === q.recommended && <em className="question-pick">Manager's pick</em>}</strong>
              {o.description && <small>{o.description}</small>}
            </span>
          </label>
        ))}
        <label className={`question-option question-own ${choice === 'own' ? 'is-selected' : ''}`}>
          <input type="radio" name="question" checked={choice === 'own'} onChange={() => setChoice('own')}/>
          <input className="question-own-input" type="text" maxLength={2000} placeholder="Write your own…" value={own}
            onFocus={() => setChoice('own')} onChange={(e) => { setOwn(e.target.value); setChoice('own'); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}/>
        </label>
      </div>
      <div className="question-actions">
        <button type="button" className="shell-button" disabled={disabled} onClick={() => onAnswer({ kind: 'skip', label: 'Skipped' })}>Skip</button>
        <button type="button" className="shell-button primary" disabled={!canSubmit} onClick={submit}>Submit</button>
      </div>
    </div>
  );
}
