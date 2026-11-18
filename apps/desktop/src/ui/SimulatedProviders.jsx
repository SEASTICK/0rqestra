// Provider screens. AI accounts moved to AccountsSetup.jsx.
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
