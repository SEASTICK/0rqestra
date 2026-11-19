// The parts of the real chat that are shown: the choice of tool, model and effort under the
// message box, and a reply from a real model while it is written and after.
import React, { useState } from 'react';
import { answersFor, FAILURE_HELP, parsePlan, parsePlanRequest, parseQuestion, readyProviders, usageLine, visibleText } from './live-chat.mjs';

export function ChatTargetPicker({ target, statuses, onChange, onAccounts }) {
  const ready = readyProviders(statuses);
  const current = ready.find((s) => s.provider === target.provider);
  const model = current?.models.find((m) => m.id === target.model);
  const set = (patch) => onChange({ provider: target.provider, model: target.model, effort: target.effort, ...patch });
  return (
    <span className="chat-target">
      <select aria-label="Who answers" className="chat-select" value={target.provider} onChange={(e) => set({ provider: e.target.value, model: null, effort: null })}>
        {(!current || ready.length === 0) && <option value="none">{ready.length ? 'Choose a tool…' : 'No tool connected'}</option>}
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

export function AssistantMessage({ m, Icon, onAccounts, onAnswer, busy, renderPlan, renderPlanRequest }) {
  const label = [m.providerName, m.model && m.model !== 'default' ? m.model : null, m.effort].filter(Boolean).join(' · ');
  const usage = m.status === 'done' ? usageLine(m) : '';
  const asked = m.status === 'done' ? parseQuestion(m.text) : { body: visibleText(m.text), question: null, questions: [] };
  const planned = m.status === 'done' && !asked.question ? parsePlan(m.text) : { body: asked.body, plan: null };
  const requested = m.status === 'done' && !asked.question && !planned.plan ? parsePlanRequest(m.text) : { body: planned.body, brief: null };
  const body = requested.brief ? requested.body : planned.plan ? planned.body : asked.body;
  // Teams answers (m.readOnly) are informational: no plan, plan request or question in them is offered.
  const question = m.readOnly ? null : asked.question;
  const questions = question ? asked.questions : [];
  const plan = m.readOnly ? null : planned.plan;
  const brief = m.readOnly ? null : requested.brief;
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
      {brief && renderPlanRequest && renderPlanRequest(brief, m)}
      {question && !m.answered && <QuestionCard questions={questions} disabled={busy} onAnswer={(choices) => onAnswer(m.id, answersFor(questions, choices), answeredSummary(questions, choices))}/>}
      {question && m.answered && <div className="question-answered-list">{(m.answered.items || [{ question: question.question, answer: m.answered.kind === 'skip' ? 'Skipped — the Manager decides' : m.answered.label }]).map((item, i) => <div key={i} className="question-answered"><span>{item.question}</span><strong>{item.answer}</strong></div>)}</div>}
      {usage && <div className="live-note">{usage}</div>}
    </div>
  );
}

// What the chat shows after the questions were answered (kept on the message as `answered`).
function answeredSummary(questions, choices) {
  const answer = (c) => (c.kind === 'skip' ? 'Skipped — the Manager decides' : c.label);
  return { kind: choices.every((c) => c.kind === 'skip') ? 'skip' : 'answers', label: answer(choices[0]), items: questions.map((q, i) => ({ question: q.question, answer: answer(choices[i]) })) };
}

function QuestionBlock({ q, index, total, value, onChange }) {
  const name = `question-${index}`;
  return (
    <fieldset className="question-block">
      <legend className="question-title">{total > 1 && <span className="question-number">{index + 1}/{total}</span>}{q.question}</legend>
      <div className="question-options" role="radiogroup">
        {q.options.map((o, i) => (
          <label key={i} className={`question-option ${value.choice === i ? 'is-selected' : ''}`}>
            <input type="radio" name={name} checked={value.choice === i} onChange={() => onChange({ ...value, choice: i })}/>
            <span className="question-text">
              <strong>{o.label}{i === q.recommended && <em className="question-pick">Manager's pick</em>}</strong>
              {o.description && <small>{o.description}</small>}
            </span>
          </label>
        ))}
        <label className={`question-option question-own ${value.choice === 'own' ? 'is-selected' : ''}`}>
          <input type="radio" name={name} checked={value.choice === 'own'} onChange={() => onChange({ ...value, choice: 'own' })}/>
          <input className="question-own-input" type="text" maxLength={2000} placeholder="Write your own…" value={value.own}
            onFocus={() => onChange({ ...value, choice: 'own' })} onChange={(e) => onChange({ choice: 'own', own: e.target.value })}/>
        </label>
        {total > 1 && <label className={`question-option question-decide ${value.choice === 'skip' ? 'is-selected' : ''}`}>
          <input type="radio" name={name} checked={value.choice === 'skip'} onChange={() => onChange({ ...value, choice: 'skip' })}/>
          <span className="question-text"><strong>Let the Manager decide</strong></span>
        </label>}
      </div>
    </fieldset>
  );
}

// Questions from the Manager, like a short form: each has the Manager's pick preselected, "Write your
// own" takes free text, and skipping leaves the choice to the Manager. The answers become one message.
export function QuestionCard({ questions, onAnswer, disabled }) {
  const [values, setValues] = useState(() => questions.map((q) => ({ choice: q.recommended ?? 0, own: '' })));
  const ready = values.every((v) => v.choice !== 'own' || v.own.trim().length > 0);
  const choices = () => values.map((v, i) => (v.choice === 'skip'
    ? { kind: 'skip', label: 'Skipped' }
    : v.choice === 'own' ? { kind: 'own', text: v.own, label: v.own.trim() } : { kind: 'option', index: v.choice, label: questions[i].options[v.choice].label }));
  const submit = () => { if (!disabled && ready) onAnswer(choices()); };
  return (
    <form className={`question-card ${questions.length > 1 ? 'question-form' : ''}`} aria-label={questions.length > 1 ? 'Questions from the Manager' : questions[0].question}
      onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {questions.length > 1 && <div className="question-intro">A few questions before the team starts</div>}
      {questions.map((q, i) => <QuestionBlock key={i} q={q} index={i} total={questions.length} value={values[i]} onChange={(v) => setValues((all) => all.map((x, j) => (j === i ? v : x)))}/>)}
      <div className="question-actions">
        <button type="button" className="shell-button" disabled={disabled} onClick={() => onAnswer(questions.map(() => ({ kind: 'skip', label: 'Skipped' })))}>{questions.length > 1 ? 'Skip all' : 'Skip'}</button>
        <button type="submit" className="shell-button primary" disabled={disabled || !ready}>{questions.length > 1 ? 'Send answers' : 'Submit'}</button>
      </div>
    </form>
  );
}
