// Provider screens. AI accounts shows the real state of Claude Code and Codex (main/chat-ipc.ts).
// Build & review is still a stand-in: team runs come in phase 3 (docs/backend-plan.md).
import React from 'react';

// Kept so App.jsx's (unreachable here) live-project helper still has a graph shape to build.
export function apiGraph() {
  return {
    nodes: [{ id: 'manager', name: 'Project manager', role: 'Manager', provider: '', model: '', priority: 1, x: 410, y: 65 }],
    edges: [],
  };
}

function Notice({ title, children }) {
  return (
    <div className="simulated-notice" role="note">
      <strong>Simulated — no provider connected</strong>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function LocalWorkflow({ onTree, Icon }) {
  return (
    <section className="accounts-page" aria-label="Build and review">
      <div className="accounts-heading">
        <div>
          <div className="eyebrow">BUILD &amp; REVIEW</div>
          <h1>Build &amp; review<span className="account-heading-dot">.</span></h1>
          <p>Real agent runs are not available in this build.</p>
        </div>
        <button className="button" onClick={onTree}><Icon name="tree" size={14} /> Back to worktree</button>
      </div>
      <Notice title="No real workflow can run yet.">
        <p>
          0rqestra does not start Claude Code or Codex in this build, sends no model requests, and
          uses no subscription or credits. The Manager chat and the worktree animation are
          simulations only.
        </p>
      </Notice>
    </section>
  );
}

const SETUP = {
  claude: {
    install: 'npm install -g @anthropic-ai/claude-code',
    signIn: 'claude',
    note: 'Run it once and sign in with your Claude account (Pro or Max), not with an API key.',
  },
  codex: {
    install: 'npm install -g @openai/codex',
    signIn: 'codex login',
    note: 'Choose "Sign in with ChatGPT", not an API key.',
  },
};

function statusLabel(p) {
  if (!p.installed) return ['Not installed', 'is-off'];
  if (!p.signedIn) return ['Not signed in', 'is-off'];
  if (!p.subscription) return ['Not a subscription', 'is-warn'];
  return ['Ready', 'is-ready'];
}

function ProviderCard({ p }) {
  const [label, tone] = statusLabel(p);
  const setup = SETUP[p.provider];
  return (
    <article className="provider-card">
      <header className="provider-card-head">
        <div><h2>{p.name}</h2><small>{p.version ? `Version ${p.version}` : 'Official tool from ' + (p.provider === 'claude' ? 'Anthropic' : 'OpenAI')}</small></div>
        <span className={`provider-badge ${tone}`}>{label}</span>
      </header>
      {p.subscription && <p className="provider-line">Signed in with your {p.plan ? `${p.plan} ` : ''}plan. Replies use your subscription, never pay-per-use.</p>}
      {p.limits.length > 0 && (
        <div className="provider-limits">
          {p.limits.map((l) => (
            <div key={l.label} className="provider-limit"><span>{l.label}</span><i><b style={{ width: `${Math.min(100, Math.max(0, l.usedPercent))}%` }}/></i><em>{Math.round(l.usedPercent)}% used</em></div>
          ))}
        </div>
      )}
      {p.models.length > 0 && p.subscription && <p className="provider-line">Models: {p.models.map((m) => m.label).join(', ')}</p>}
      {p.problem && <p className="provider-problem">{p.problem}</p>}
      {!p.subscription && setup && (
        <ol className="provider-steps">
          {!p.installed && <li>Install it in a terminal: <code>{setup.install}</code> (or with the provider's official installer). The copy inside a desktop app is not enough; the command must work in a terminal.</li>}
          <li>Sign in: <code>{setup.signIn}</code>. {setup.note}</li>
          <li>Choose <strong>Check again</strong> below.</li>
        </ol>
      )}
    </article>
  );
}

export function AccountsPage({ onBack, providers = [], loading = false, onRefresh }) {
  const available = typeof window !== 'undefined' && Boolean(window.orqestra?.chat);
  return (
    <section className="accounts-page" aria-label="AI accounts and connections">
      <div className="accounts-heading">
        <div>
          <div className="eyebrow">AI ACCOUNTS</div>
          <h1>AI accounts<span className="account-heading-dot">.</span></h1>
          <p>0rqestra uses the official Claude Code and Codex tools that you install and sign in to yourself. It never sees your password or tokens, and it never uses an API key.</p>
        </div>
        <div className="accounts-actions">
          {available && <button className="button" disabled={loading} onClick={onRefresh}>{loading ? 'Checking…' : 'Check again'}</button>}
          <button className="button" onClick={onBack}>Back</button>
        </div>
      </div>
      {!available ? (
        <div className="simulated-notice" role="note"><strong>Preview</strong><h2>Connections work in the installed app.</h2></div>
      ) : providers.length === 0 ? (
        <p className="provider-line">{loading ? 'Looking for Claude Code and Codex…' : 'No information yet. Choose Check again.'}</p>
      ) : (
        <div className="provider-grid">{providers.map((p) => <ProviderCard key={p.provider} p={p}/>)}</div>
      )}
    </section>
  );
}
