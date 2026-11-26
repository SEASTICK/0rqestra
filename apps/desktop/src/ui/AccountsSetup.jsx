// AI accounts: a guided setup per provider, from installing the official tool to a working Manager
// chat. The main process does every step (main/accounts/accounts-ipc.ts); this page names a provider
// and shows what comes back.
import React, { useEffect, useState } from 'react';
import { activityText, agentChoices, badgeFor, canUse, elapsed, mainAction, stateLine, steps, subtitle } from './account-setup.mjs';

const message = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function Steps({ account }) {
  return (
    <ol className="setup-steps" aria-label="Setup steps">
      {steps(account).map((s, i) => (
        <li key={s.id} className={s.done ? 'is-done' : s.current ? 'is-current' : ''}>
          <span>{s.done ? '✓' : i + 1}</span>{s.label}
        </li>
      ))}
    </ol>
  );
}

function CommandFallback({ account, kind, api, notify }) {
  const command = kind === 'install' ? account.commands.install : account.commands.signIn;
  const copy = async () => {
    try { await api.copy(account.provider, kind); notify?.('Command copied.'); } catch (error) { notify?.(message(error)); }
  };
  return (
    <details className="setup-fallback" open={Boolean(account.error) || !account.canOpenTerminal}>
      <summary>{kind === 'install' ? 'Install it yourself instead' : 'Sign in yourself instead'}</summary>
      <p>{kind === 'install'
        ? `Paste this into ${account.commands.shell === 'powershell' ? 'PowerShell' : 'a terminal'}. When it has finished, this card finds ${account.name} by itself.`
        : 'Paste this into a terminal and follow the steps. This card notices the sign-in by itself.'}</p>
      <div className="setup-command"><code>{command}</code><button type="button" className="button" onClick={copy}>Copy</button></div>
    </details>
  );
}

function UseChoices({ account, managerProvider, agents, onUseForManager, onUseForAgent }) {
  const [agent, setAgent] = useState('');
  const choices = agentChoices(agents);
  return (
    <div className="setup-use">
      {managerProvider === account.provider
        ? <span className="setup-use-current">✓ Your Manager uses {account.name}</span>
        : <button type="button" className="button" onClick={() => onUseForManager(account.provider)}>Use for the Manager</button>}
      {choices.length > 0 && (
        <span className="setup-use-agent">
          <select aria-label={`Agent to run on ${account.name}`} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Choose an agent…</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <button type="button" className="button" disabled={!agent} onClick={() => { onUseForAgent(agent, account.provider); setAgent(''); }}>Use for this agent</button>
        </span>
      )}
    </div>
  );
}

function AccountCard({ account, api, now, notify, refresh, use }) {
  const { badge, tone } = badgeFor(account);
  const action = mainAction(account);
  const [pending, setPending] = useState(false);
  const run = async (fn) => {
    setPending(true);
    try { await fn(); } catch (error) { notify?.(message(error)); } finally { setPending(false); }
  };
  const onMain = () => {
    if (action.kind === 'install') return run(() => api.install(account.provider));
    if (action.kind === 'signIn') return run(() => api.signIn(account.provider));
    if (action.kind === 'test') return run(() => api.test(account.provider));
    if (action.kind === 'cancel') return run(() => api.cancel(account.provider));
    if (action.kind === 'refresh') return run(refresh);
    return undefined;
  };
  const activity = account.activity;
  const showInstallHelp = account.setup === 'missing';
  const showSignInHelp = ['signed_out', 'api_key'].includes(account.setup) || activity?.kind === 'waiting_sign_in';
  return (
    <article className={`provider-card setup-card setup-${account.setup}`} aria-label={account.label}>
      <header className="provider-card-head">
        <div><h2>{account.label}</h2><small>{subtitle(account)}</small></div>
        <span className={`provider-badge ${tone}`}>{badge}</span>
      </header>
      <Steps account={account}/>
      <p className="provider-line setup-state">{stateLine(account)}</p>
      {activity && (
        <div className="setup-activity" role="status" aria-live="polite">
          <div className="setup-activity-head"><span className="setup-spinner" aria-hidden="true"/><span>{activityText(account)}</span><em>{elapsed(now - activity.startedAt)}</em></div>
          {activity.log.length > 0 && <pre className="setup-log">{activity.log.join('\n')}</pre>}
        </div>
      )}
      {account.error && (
        <div className="setup-error" role="alert"><strong>{account.error.message}</strong><span>{account.error.advice}</span></div>
      )}
      {account.setup === 'signed_in' && account.lastTest?.ok && account.lastTest.text && (
        <blockquote className="setup-answer">{account.lastTest.text}<small>{account.lastTest.model ? `${account.lastTest.model} · ` : ''}test answer</small></blockquote>
      )}
      {account.limits.length > 0 && account.subscription && (
        <div className="provider-limits">
          {account.limits.map((l) => (
            <div key={l.label} className="provider-limit"><span>{l.label}</span><i><b style={{ width: `${Math.min(100, Math.max(0, l.usedPercent))}%` }}/></i><em>{Math.round(l.usedPercent)}% used</em></div>
          ))}
        </div>
      )}
      <div className="setup-actions">
        <button type="button" className={`button ${action.kind === 'cancel' ? '' : 'primary-button'}`} disabled={pending || action.kind === 'busy'} onClick={onMain}>{action.label}</button>
        {showInstallHelp && !activity && account.canOpenTerminal && (
          <button type="button" className="button" disabled={pending} onClick={() => run(() => api.openTerminal(account.provider, 'install'))}>Open in terminal</button>
        )}
        {account.setup === 'failed' && !account.checkFailed && !activity && (
          <button type="button" className="button" disabled={pending} onClick={() => run(() => api.signIn(account.provider))}>Sign in again</button>
        )}
      </div>
      {showSignInHelp && account.provider === 'claude' && <p className="provider-line">In the browser, choose your Claude account (Pro, Max, Team or Enterprise), not Anthropic Console: Console is billed per use.</p>}
      {showSignInHelp && account.provider === 'gemini' && <p className="provider-line">In the screen that opens, choose Login with Google (not an API key) and your Google account, for example the one with Google AI Pro. When it says you are signed in, type /quit.</p>}
      {showSignInHelp && account.provider === 'codex' && <p className="provider-line">Choose Sign in with ChatGPT, not an API key: an API key is billed per use.</p>}
      {showInstallHelp && <CommandFallback account={account} kind="install" api={api} notify={notify}/>}
      {showSignInHelp && account.installed && <CommandFallback account={account} kind="signIn" api={api} notify={notify}/>}
      {canUse(account) && <UseChoices account={account} {...use}/>}
      {account.binaryPath && <p className="setup-path" title={account.binaryPath}>Found at {account.binaryPath}</p>}
    </article>
  );
}

export function AccountsPage({ onBack, notify, onProvidersChanged, managerProvider, agents, onUseForManager, onUseForAgent }) {
  const api = typeof window !== 'undefined' ? window.orqestra?.accounts : null;
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const update = (list) => {
    if (!Array.isArray(list)) return;
    setAccounts(list);
    onProvidersChanged?.(list);
  };
  const refresh = async () => {
    if (!api) return;
    setLoading(true);
    try { update(await api.status(true)); } catch (error) { notify?.(message(error)); } finally { setLoading(false); }
  };
  useEffect(() => {
    if (!api) return undefined;
    api.subscribe((m) => update(m?.accounts));
    void refresh();
    return undefined;
  }, []);
  const busy = accounts.some((a) => a.activity);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const use = { managerProvider, agents, onUseForManager, onUseForAgent };
  return (
    <section className="accounts-page" aria-label="AI accounts and connections">
      <div className="accounts-heading">
        <div>
          <div className="eyebrow">AI ACCOUNTS</div>
          <h1>AI accounts<span className="account-heading-dot">.</span></h1>
          <p>Connect your Claude, ChatGPT and Google (Gemini) subscriptions through the official Claude Code, Codex and Gemini CLI tools. Sign-in happens in the providers' own tools: 0rqestra never sees your password or tokens, and never uses an API key.</p>
        </div>
        <div className="accounts-actions">
          {api && <button className="button" disabled={loading} onClick={refresh}>{loading ? 'Checking…' : 'Check again'}</button>}
          <button className="button" onClick={onBack}>Back</button>
        </div>
      </div>
      {!api ? (
        <div className="simulated-notice" role="note"><strong>Preview</strong><h2>Connections work in the installed app.</h2></div>
      ) : accounts.length === 0 ? (
        <p className="provider-line">{loading ? 'Looking for Claude Code, Codex and Gemini CLI…' : 'No information yet. Choose Check again.'}</p>
      ) : (
        <div className="provider-grid">{accounts.map((a) => <AccountCard key={a.provider} account={a} api={api} now={now} notify={notify} refresh={refresh} use={use}/>)}</div>
      )}
      <p className="setup-demo">Without a connected tool your Manager does not answer, and nothing is sent anywhere. Your projects, chats and team trees are kept on this computer either way.</p>
    </section>
  );
}
