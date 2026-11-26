import React, { useEffect, useState } from 'react';
import { checklist } from './onboarding.mjs';

// "Get started" at the top of a new project's chat (onboarding.mjs decides each step from real state).
// The folder step uses Computer access's own folder picker; everything else is handed to App, which
// opens the existing screens: AI accounts, team setup, agent settings, the composer, Review changes.

const errorText = (e) => String(e?.message || e || 'That did not work.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const MARK = { done: '✓', warn: '!', blocked: '–', active: '…', todo: '' };

export function GetStarted({ project, graph, providers, runChanges, Icon, notify, onAction, onDismiss }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.access : null;
  const [access, setAccess] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return undefined;
    let live = true;
    const load = () => api.view(project.id).then((v) => { if (live) setAccess(v); }).catch(() => {});
    void load();
    const off = api.subscribe?.((e) => { if (e?.projectId === project.id) void load(); });
    // Back from another window or app (the folder picker, a provider's sign-in): read it again.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { live = false; off?.(); window.removeEventListener('focus', onFocus); };
  }, [project.id]);
  const { steps, next, complete } = checklist({ project, graph, providers, access, runChanges });
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const run = async (action) => {
    if (action.kind === 'pick-folder') {
      if (!api) { notify?.('Choosing a folder works in the installed app.'); return; }
      setBusy(true);
      try { const v = await api.addFolder(project.id); if (v?.folders) setAccess(v); } catch (e) { notify?.(errorText(e)); } finally { setBusy(false); }
      return;
    }
    onAction(action);
  };
  return (
    <section className={`get-started ${complete ? 'is-complete' : ''}`} aria-label="Get started">
      <div className="get-started-head">
        <div><span className="plan-eyebrow">GET STARTED</span><strong>{complete ? 'You are set up. Your first task passed review.' : 'From here to your first finished task'}</strong></div>
        <span className="get-started-count">{doneCount} of {steps.length}</span>
        <button type="button" className="icon-button" aria-label="Hide the Get started checklist" title="Hide (reopen it from the project's ⋯ menu)" onClick={onDismiss}>{Icon ? <Icon name="close" size={15}/> : '×'}</button>
      </div>
      <ol className="get-started-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={`gs-step gs-${s.status} ${next === s.id ? 'gs-next' : ''}`}>
            <span className="gs-mark" aria-hidden="true">{MARK[s.status] || i + 1}</span>
            <div className="gs-body">
              <div className="gs-title"><strong>{s.title}</strong>{s.optional && <small>Optional if you only chat with the Manager</small>}{next === s.id && <span className="gs-badge">Next</span>}</div>
              <p className="gs-detail" title={s.detail}>{s.detail}</p>
              {(s.action || s.alt) && <div className="gs-actions">
                {s.action && <button type="button" className={`shell-button ${next === s.id ? 'primary' : ''}`} disabled={busy} onClick={() => run(s.action)}>{s.action.label}</button>}
                {s.alt && <button type="button" className="shell-button" disabled={busy} onClick={() => run(s.alt)}>{s.alt.label}</button>}
              </div>}
            </div>
          </li>
        ))}
      </ol>
      {complete && <div className="gs-actions gs-finish"><button type="button" className="shell-button" onClick={onDismiss}>Hide checklist</button></div>}
    </section>
  );
}

// Scrolls the chat to a plan waiting for Start, or to a run's card (the checklist's "Show" actions).
export function scrollToCard(action, goal) {
  if (typeof document === 'undefined') return;
  const el = action.kind === 'scroll'
    ? [...document.querySelectorAll('.plan-card')].filter((c) => !c.querySelector('.plan-started')).at(-1)
    : [...document.querySelectorAll('.team-card')].find((c) => c.querySelector('.team-goal')?.textContent === goal);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
