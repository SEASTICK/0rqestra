// New project → From GitHub: your repositories through GitHub's official `gh` tool (main/github/github.ts).
// Sign in to gh once in the browser; then pick a repository, choose where to put it, and it is cloned and set up
// for the team like any folder (FolderSetup). 0rqestra never sees a password or a token.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { filterRepos, when } from './github-repos.mjs';

const errorText = (e) => String(e?.message || e || 'That did not work.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export function GithubSetup({ project, Icon, onClose, onCloned }) {
  const api = window.orqestra?.access?.github;
  const [status, setStatus] = useState(null);
  const [repos, setRepos] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const load = async () => {
    try { const s = await api.status(); if (live.current) setStatus(s); return s; } catch (e) { if (live.current) setError(errorText(e)); return null; }
  };
  useEffect(() => { if (api) void load(); }, []);
  useEffect(() => {
    if (!status?.signedIn || repos) return;
    api.repos().then((r) => { if (live.current) setRepos(r); }).catch((e) => { if (live.current) setError(errorText(e)); });
  }, [status?.signedIn]);
  // After the terminal was opened: check again every few seconds until the step has had its effect.
  useEffect(() => {
    if (!waiting) return undefined;
    const id = setInterval(async () => {
      const s = await load();
      if (s && (s.signedIn || (waiting === 'install' && s.installed && !s.signedIn))) { setWaiting(false); }
    }, 3000);
    return () => clearInterval(id);
  }, [waiting]);
  const shown = useMemo(() => filterRepos(repos, query), [repos, query]);
  const terminal = async (kind) => {
    setError(null);
    try { const opened = await api.openTerminal(kind); if (opened) setWaiting(kind); else setError('0rqestra could not open a terminal window here. Run the command below yourself; this window checks again by itself.'); if (!opened) setWaiting(kind); } catch (e) { setError(errorText(e)); }
  };
  const clone = async (repo) => {
    setBusy(repo.fullName); setError(null);
    try {
      const info = await api.clone(project.id, repo.fullName);
      if (info) onCloned(info);
    } catch (e) { setError(errorText(e)); } finally { if (live.current) setBusy(null); }
  };
  if (!api) return <div><h2 id="dialog-title">From GitHub</h2><p className="dialog-description">This works in the installed app.</p></div>;
  return <div className="github-setup">
    <div className="dialog-heading"><span className="dialog-icon"><Icon name="code" size={21}/></span><button className="icon-button" type="button" aria-label="Close GitHub" onClick={onClose}><Icon name="close"/></button></div>
    <h2 id="dialog-title">From GitHub</h2>
    <p className="dialog-description">Pick one of your repositories. It is cloned to a folder you choose, and the team can then read the code and propose changes that you review. 0rqestra uses GitHub’s own tool, <code>gh</code>: it never sees your password or token.</p>
    {!status && !error && <p className="agent-muted">Looking for GitHub CLI…</p>}
    {status && !status.installed && <div className="github-step">
      <strong>Install GitHub CLI</strong>
      <small>{status.problem} It is GitHub’s official tool and free. Install it once.</small>
      <div className="setup-actions">
        <button type="button" className="button primary-button" onClick={() => terminal('install')} disabled={waiting === 'install'}>{waiting === 'install' ? 'Waiting for the install…' : 'Install in a terminal'}</button>
        <button type="button" className="button" onClick={load}>Check again</button>
      </div>
      <code className="github-command">{status.commands.install}</code>
    </div>}
    {status && status.installed && !status.signedIn && <div className="github-step">
      <strong>Sign in to GitHub</strong>
      <small>A terminal opens with GitHub’s own sign-in. Choose GitHub.com, HTTPS and Login with a web browser, and say yes to authenticating git. This also lets 0rqestra push later with your sign-in.</small>
      <div className="setup-actions">
        <button type="button" className="button primary-button" onClick={() => terminal('signIn')} disabled={waiting === 'signIn'}>{waiting === 'signIn' ? 'Waiting for the sign-in…' : 'Sign in to GitHub'}</button>
        <button type="button" className="button" onClick={load}>Check again</button>
      </div>
      <code className="github-command">{status.commands.signIn}</code>
    </div>}
    {status?.signedIn && <>
      <div className="github-account"><Icon name="check" size={14}/> Signed in{status.account ? ` as ${status.account}` : ''}</div>
      <input className="github-search" type="search" placeholder="Search repositories" aria-label="Search repositories" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus/>
      {!repos && !error && <p className="agent-muted">Loading your repositories…</p>}
      {repos && <ul className="github-list" role="listbox" aria-label="Your repositories">
        {shown.length === 0 && <li className="agent-muted github-empty">{repos.length ? 'No repository matches.' : 'No repositories found for this account.'}</li>}
        {shown.map((r) => <li key={r.fullName}><button type="button" role="option" aria-selected="false" disabled={Boolean(busy)} onClick={() => clone(r)} title={r.description || r.fullName}>
          <span className="github-repo"><strong>{r.fullName}</strong>{r.private && <em>Private</em>}{r.fork && <em>Fork</em>}<small>{[r.description, when(r.pushedAt) && `updated ${when(r.pushedAt)}`].filter(Boolean).join(' · ')}</small></span>
          <span className="github-go">{busy === r.fullName ? 'Cloning…' : 'Use ›'}</span>
        </button></li>)}
      </ul>}
    </>}
    {error && <div className="setup-error" role="alert"><span>{error}</span></div>}
    <div className="dialog-footer"><button className="button" type="button" onClick={onClose}>Cancel</button>{status?.signedIn && <button className="button" type="button" disabled={Boolean(busy)} onClick={() => { setRepos(null); api.repos(true).then(setRepos).catch((e) => setError(errorText(e))); }}>Refresh list</button>}</div>
  </div>;
}
