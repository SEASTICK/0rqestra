// The parts of the real chat that are shown: the choice of tool, model and effort under the
// message box, and a reply from a real model while it is written and after.
import React, { useEffect, useRef, useState } from 'react';
import { Working } from './Activity.jsx';
import { Markdown } from './Markdown.jsx';
import { parseRemember } from './live-chat.mjs';
import { answersFor, FAILURE_HELP, parsePlan, parsePlanRequest, parseQuestion, readyProviders, usageLine, visibleText } from './live-chat.mjs';

// Who answers, as a menu like the model menus of Claude and ChatGPT: Auto or one tool, then the level
// (Auto or one model) and, where the model has it, the effort. Opens upward from the message box.
const TOOL_INFO = {
  auto: 'Picks Claude or ChatGPT and the level for each message',
  claude: 'Writing, explaining, studying, planning and design',
  codex: 'Code, bugs and technical questions',
};
const MODEL_INFO = { default: 'What your plan uses by default', opus: 'Most capable, for hard problems', sonnet: 'Smart and fast, for everyday work', haiku: 'Fastest, for quick answers' };
const modelInfo = (m) => MODEL_INFO[m.id] || (/mini|nano|lite|fast/i.test(m.id) ? 'Fast and light' : m.isDefault ? 'Default for your plan' : '');

export function ChatTargetPicker({ target, statuses, onChange, onAccounts }) {
  const ready = readyProviders(statuses);
  const current = ready.find((s) => s.provider === target.provider);
  const model = current?.models.find((m) => m.id === target.model);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key); };
  }, [open]);
  const set = (patch) => onChange({ provider: target.provider, model: target.model, effort: target.effort, ...patch });
  if (ready.length === 0) return <span className="chat-target"><button type="button" className="chat-connect" onClick={onAccounts}>Connect Claude Code or Codex</button></span>;
  const auto = target.provider === 'auto';
  const label = auto ? 'Auto' : [current?.name || 'Choose', model && target.model !== 'auto' ? model.label : 'Auto level', target.effort].filter(Boolean).join(' · ');
  const Check = ({ on }) => <span className="picker-check" aria-hidden="true">{on ? '✓' : ''}</span>;
  return (
    <span className="chat-target" ref={box}>
      <button type="button" className={`picker-button ${open ? 'is-open' : ''}`} aria-label="Who answers" aria-haspopup="menu" aria-expanded={open} title={auto ? TOOL_INFO.auto : undefined} onClick={() => setOpen(!open)}>
        <span>{label}</span><span className="picker-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && <div className="picker-menu" role="menu" aria-label="Who answers">
        <button type="button" role="menuitemradio" aria-checked={auto} onClick={() => { set({ provider: 'auto', model: 'auto', effort: null }); setOpen(false); }}>
          <span className="picker-text"><strong>Auto</strong><small>{TOOL_INFO.auto}</small></span><Check on={auto} />
        </button>
        {ready.map((t) => <button type="button" role="menuitemradio" key={t.provider} aria-checked={target.provider === t.provider} onClick={() => set({ provider: t.provider, model: 'auto', effort: null })}>
          <span className="picker-text"><strong>{t.name}</strong><small>{TOOL_INFO[t.provider] || ''}</small></span><Check on={target.provider === t.provider} />
        </button>)}
        {current && current.models.length > 0 && <>
          <div className="picker-line" />
          <div className="picker-head">{current.name} level</div>
          <button type="button" role="menuitemradio" aria-checked={target.model === 'auto'} onClick={() => { set({ model: 'auto', effort: null }); setOpen(false); }}>
            <span className="picker-text"><strong>Auto</strong><small>Light for quick questions, stronger for work</small></span><Check on={target.model === 'auto'} />
          </button>
          {current.models.map((m) => <button type="button" role="menuitemradio" key={m.id} aria-checked={target.model === m.id} onClick={() => { set({ model: m.id, effort: null }); if (!m.efforts.length) setOpen(false); }}>
            <span className="picker-text"><strong>{m.label}</strong>{modelInfo(m) && <small>{modelInfo(m)}</small>}</span><Check on={target.model === m.id} />
          </button>)}
        </>}
        {model && model.efforts.length > 0 && <div className="picker-effort" role="group" aria-label="Effort">
          <span>Effort</span>
          <button type="button" className={!target.effort ? 'is-on' : ''} onClick={() => set({ effort: null })}>Default</button>
          {model.efforts.map((e) => <button type="button" key={e} className={target.effort === e ? 'is-on' : ''} onClick={() => set({ effort: e })}>{e}</button>)}
        </div>}
      </div>}
    </span>
  );
}

export function AssistantMessage({ m, Icon, onAccounts, onAnswer, busy, renderPlan, renderPlanRequest, onRetry, who = 'Manager' }) {
  // "Auto" shows which model it chose once the tool says so.
  const modelName = m.model && m.model !== 'default' && m.model !== 'auto' ? m.model : null;
  const label = m.routed
    ? `Auto → ${[m.providerName, modelName].filter(Boolean).join(' · ')}`
    : [m.providerName, m.auto ? `Auto${modelName ? ` → ${modelName}` : ''}` : modelName, m.effort].filter(Boolean).join(' · ');
  const usage = m.status === 'done' ? usageLine(m) : '';
  // Facts saved to project memory are not part of the reply's text.
  const remembered = m.status === 'done' ? parseRemember(m.text) : { text: m.text, facts: [] };
  const source = remembered.text;
  const asked = m.status === 'done' ? parseQuestion(source) : { body: visibleText(source), question: null, questions: [] };
  const planned = m.status === 'done' && !asked.question ? parsePlan(source) : { body: asked.body, plan: null };
  const requested = m.status === 'done' && !asked.question && !planned.plan ? parsePlanRequest(source) : { body: planned.body, brief: null };
  const body = requested.brief ? requested.body : planned.plan ? planned.body : asked.body;
  // Teams answers (m.readOnly) are informational: no plan, plan request or question in them is offered.
  const question = m.readOnly ? null : asked.question;
  const questions = question ? asked.questions : [];
  const plan = m.readOnly ? null : planned.plan;
  const brief = m.readOnly ? null : requested.brief;
  return (
    <div className={`message message-manager message-live message-${m.status}`}>
      <div className="message-body md-body">
        <Markdown text={body} />
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
      {remembered.facts.length > 0 && <div className="memory-saved"><Icon name="spark" size={13}/> Saved to project memory: {remembered.facts.join(' · ')}</div>}
      {m.status !== 'streaming' && <MessageActions text={body} usage={usage} label={[who, label].filter(Boolean).join(' · ')} onRetry={onRetry} Icon={Icon} />}
      {m.status === 'streaming' && <div className="message-who">{[who, label].filter(Boolean).join(' · ')}</div>}
    </div>
  );
}

// Under a reply, like Claude and ChatGPT: copy the answer, try it again, and who answered with which model.
export function MessageActions({ text, usage, label, onRetry, Icon, onEdit }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const api = window.orqestra?.chat?.copy;
    (api ? api(text) : navigator.clipboard?.writeText(text) || Promise.reject()).then(done).catch(() => {});
  };
  return <div className="message-actions">
    {text && <button type="button" className="action-button" title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Copied' : 'Copy'} onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={15} /></button>}
    {onEdit && <button type="button" className="action-button" title="Edit: put this message back in the box" aria-label="Edit" onClick={onEdit}><Icon name="edit" size={15} /></button>}
    {onRetry && <button type="button" className="action-button" title="Retry: ask again for a new answer" aria-label="Retry" onClick={onRetry}><Icon name="retry" size={15} /></button>}
    {label && <span className="message-who" title={usage || undefined}>{label}</span>}
  </div>;
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
