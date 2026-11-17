// Stage 2 stand-ins for the preview template's provider screens.
//
// The template's real provider code (ChatGPT / Claude Code sign-in, the key vault, and live
// workflow runs) is deliberately NOT part of 0rqestra's interface work: real adapters wait for
// the provider gates in docs/provider-integrations.md §4.2. These components keep the template's
// layout and navigation working while stating plainly that nothing is connected.
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

export function AccountsPage({ onBack }) {
  return (
    <section className="accounts-page" aria-label="AI accounts and connections">
      <div className="accounts-heading">
        <div>
          <div className="eyebrow">AI ACCOUNTS</div>
          <h1>AI accounts<span className="account-heading-dot">.</span></h1>
          <p>Provider connections are not part of this build.</p>
        </div>
        <button className="button" onClick={onBack}>Back</button>
      </div>
      <Notice title="Nothing is connected.">
        <p>
          0rqestra will run the official Claude Code and Codex tools that you install and sign in to
          yourself. That is not implemented yet. This screen collects no keys, passwords, or tokens,
          and 0rqestra does not know your plan, usage, or credits.
        </p>
      </Notice>
    </section>
  );
}
