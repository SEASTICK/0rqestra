// What an agent runs on, in the agent editor: the tool (Demo, Claude Code or Codex), its model and
// effort, and a button that sends one short real request to try the choice.
import React, { useEffect, useRef, useState } from 'react';
import { FAILURE_HELP, isTerminal, testState, usageLine } from './live-chat.mjs';

export function AgentRunsOn({ run, onChange, tools }) {
  const status = tools.find((t) => t.provider === run.provider);
  const model = status?.models.find((m) => m.id === run.model);
  const set = (patch) => onChange({ ...run, ...patch });
  return (
    <>
      <label>Runs on
        <select value={run.provider} onChange={(e) => {
          const next = tools.find((t) => t.provider === e.target.value);
          const first = next?.models.find((m) => m.isDefault) || next?.models[0];
          onChange({ provider: e.target.value, model: first ? first.id : null, effort: null });
        }}>
          <option value="demo">Demo (no model)</option>
          {tools.map((t) => <option key={t.provider} value={t.provider}>{t.name}</option>)}
        </select>
        {tools.length === 0 && <small>Connect Claude Code or Codex under AI accounts to run an agent on a real model.</small>}
      </label>
      {status && (
        <div className="field-row">
          <label>Model
            <select value={run.model ?? ''} onChange={(e) => set({ model: e.target.value, effort: null })}>
              {status.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label>Effort
            <select value={run.effort ?? ''} disabled={!model || model.efforts.length === 0} onChange={(e) => set({ effort: e.target.value || null })}>
              <option value="">{model && model.efforts.length ? 'Default' : 'Not available'}</option>
              {(model?.efforts || []).map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
        </div>
      )}
    </>
  );
}

export function TryAgent({ run, onTest }) {
  const [state, setState] = useState(null);
  const handle = useRef(null);
  useEffect(() => () => { handle.current?.stop(); }, []);
  useEffect(() => { setState(null); }, [run.provider, run.model, run.effort]);
  const start = () => {
    handle.current?.stop();
    setState({ status: 'running', text: '', model: null, error: null, reason: null, usage: null, limits: [] });
    handle.current = onTest({ provider: run.provider, model: run.model, effort: run.effort }, (event) => {
      setState((current) => (current ? testState(current, event) : current));
      if (isTerminal(event)) handle.current = null;
    });
    if (!handle.current) setState({ status: 'failed', text: '', error: 'Trying an agent works in the installed app.', reason: 'provider_error' });
  };
  const running = state?.status === 'running';
  return (
    <div className="agent-try">
      <div className="agent-try-head">
        <span><strong>Try this agent</strong><small>Sends one short request to the chosen model and shows the answer. It uses a little of your plan.</small></span>
        {running
          ? <button type="button" className="button" onClick={() => handle.current?.stop()}>Stop</button>
          : <button type="button" className="button" onClick={start}>Try</button>}
      </div>
      {state && (
        <div className={`agent-try-result is-${state.status}`} role="status" aria-live="polite">
          {state.text || (running ? 'Waiting for the answer…' : '')}
          {state.status === 'failed' && <div className="live-error"><strong>{state.error}</strong> {FAILURE_HELP[state.reason] || ''}</div>}
          {state.status === 'stopped' && <div className="live-note">Stopped.</div>}
          {state.status === 'done' && <div className="live-note">{[state.model, usageLine(state)].filter(Boolean).join(' · ')}</div>}
        </div>
      )}
    </div>
  );
}
