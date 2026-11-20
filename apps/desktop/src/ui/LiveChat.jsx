// The parts of the real chat that are shown: the choice of tool, model and effort under the
// message box, and a reply from a real model while it is written and after.
import React, { useState } from 'react';
import { Working } from './Activity.jsx';
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
        {m.status === 'streaming' && body && <span className="live-caret" aria-hidden="true"/>}
      </div>
      {m.status === 'streaming' && <Working label={m.text ? 'Writing' : 'Thinking'} since={m.startedAt} className="reply-working" />}
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

// Questions from the Manager, one at a time like Lovable: a click on an option answers it and shows the
// next question; the last answer sends them all as one message. "Write your own" takes free text, and
// "Let the Manager decide" leaves that choice to the Manager. Back goes to the previous question.
export function QuestionCard({ questions, onAnswer, disabled }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(() => questions.map(() => null));
  const [own, setOwn] = useState('');
  const q = questions[step];
  const total = questions.length;
  const answer = (choice) => {
    if (disabled) return;
    const next = answers.map((a, i) => (i === step ? choice : a));
    setAnswers(next);
    setOwn('');
    if (step + 1 < total) setStep(step + 1);
    else onAnswer(next);
  };
  const back = () => { if (step > 0) { setStep(step - 1); const prev = answers[step - 1]; setOwn(prev?.kind === 'own' ? prev.text : ''); } };
  const picked = answers[step];
  return (
    <div className="question-card question-steps" role="group" aria-label={q.question}>
      {total > 1 && <div className="question-progress">
        <span>Question {step + 1} of {total}</span>
        <span className="question-dots" aria-hidden="true">{questions.map((_, i) => <i key={i} className={i < step ? 'is-done' : i === step ? 'is-current' : ''} />)}</span>
      </div>}
      <div className="question-title" key={`t${step}`}>{q.question}</div>
      <div className="question-options question-step" key={`o${step}`}>
        {q.options.map((o, i) => (
          <button type="button" key={i} disabled={disabled} className={`question-option ${picked?.kind === 'option' && picked.index === i ? 'is-selected' : ''} ${i === q.recommended ? 'is-pick' : ''}`} onClick={() => answer({ kind: 'option', index: i, label: o.label })}>
            <span className="question-text">
              <strong>{o.label}{i === q.recommended && <em className="question-pick">Manager's pick</em>}</strong>
              {o.description && <small>{o.description}</small>}
            </span>
            <span className="question-go" aria-hidden="true">→</span>
          </button>
        ))}
        <form className="question-option question-own" onSubmit={(e) => { e.preventDefault(); if (own.trim()) answer({ kind: 'own', text: own, label: own.trim() }); }}>
          <input className="question-own-input" type="text" maxLength={2000} placeholder="Write your own…" aria-label="Write your own answer" value={own} onChange={(e) => setOwn(e.target.value)} disabled={disabled}/>
          <button type="submit" className="shell-button primary" disabled={disabled || !own.trim()}>{step + 1 < total ? 'Next' : 'Send'}</button>
        </form>
      </div>
      <div className="question-actions">
        {step > 0 && <button type="button" className="shell-button question-back" disabled={disabled} onClick={back}>Back</button>}
        <button type="button" className="shell-button" disabled={disabled} onClick={() => answer({ kind: 'skip', label: 'Skipped' })}>{total > 1 ? 'Let the Manager decide' : 'Skip'}</button>
      </div>
    </div>
  );
}
