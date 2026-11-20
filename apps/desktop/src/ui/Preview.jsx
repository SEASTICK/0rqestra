import React, { useEffect, useRef, useState } from 'react';
import { pickedLabel, previewUrl, problemLine, readPicked } from './live-chat.mjs';

// A product the team builds, as a node in the tree and as a live preview beside the chat. The page runs
// in a frame on its own origin (orqestra-preview://), with no access to the app, the network or keys.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals';

const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null);
const problemCount = (n) => `${n} ${n === 1 ? 'problem' : 'problems'}`;

const APP_LABEL = { stopped: 'Not running', preparing: 'Preparing', installing: 'Installing', starting: 'Starting', running: 'Running', failed: 'Did not start' };
// The address the preview shows: a page from the project's files, or a running app through its own host.
export function productUrl(product, host, version) {
  if (product.kind === 'app') return product.app?.status?.state === 'running' ? `orqestra-preview://${product.app.host}/?v=${version}` : null;
  return previewUrl(host, product, version);
}

export function ProductNode({ product, host, version, selected, dragging, Icon, onOpen, onPointerDown, onPointerMove, onPointerUp }) {
  const url = productUrl(product, host, version);
  const appState = product.kind === 'app' ? product.app?.status?.state || 'stopped' : null;
  const problems = product.problems?.length || 0;
  const empty = !product.files.length;
  return <div className={`agent-node product-node ${product.building ? 'product-building' : ''} ${problems ? 'product-has-problems' : ''} ${dragging ? 'product-dragging' : ''} ${selected ? 'node-selected' : ''}`} style={{ left: product.x, top: product.y }} role="button" tabIndex={0} aria-label={`Open the preview of ${product.name}${problems ? `, ${problemCount(problems)}` : ''}`} title="Click to preview · drag to move" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
    {product.building && <span className="working-halo" />}
    <span className="node-port top-port" />
    <div className="node-heading"><span className="node-avatar product-avatar"><Icon name="globe" size={18} /></span><div><span className="node-role">Product · {product.kind === 'app' ? 'App' : 'Web'}</span><strong>{product.name}</strong></div></div>
    <div className={`product-thumb ${empty || (appState && !url) ? 'product-thumb-empty' : ''}`} aria-hidden="true">{empty ? <span>{product.building ? 'The team is writing the first files' : 'No files yet'}</span> : appState && !url ? <span>App · {APP_LABEL[appState]}{appState === 'stopped' ? ' — open to start' : '…'}</span> : url && <iframe src={url} title="" tabIndex={-1} sandbox={SANDBOX} referrerPolicy="no-referrer" loading="lazy" />}</div>
    <div className="node-bottom">{problems > 0 && !product.building
      ? <span className="product-problems"><span className="status-dot" />{problemCount(problems)}</span>
      : <span><span className={`status-dot ${product.building || appState === 'running' ? 'status-dot-live' : ''}`} />{product.building ? 'Building' : empty ? 'Planned' : appState && appState !== 'stopped' ? APP_LABEL[appState] : `${product.files.length} ${product.files.length === 1 ? 'file' : 'files'}`}</span>}
      <span>{product.building ? 'Live' : timeOf(product.updatedAt) && `Updated ${timeOf(product.updatedAt)}`}</span></div>
  </div>;
}

function ProblemsBar({ problems, building, onFix, onDismiss }) {
  const [open, setOpen] = useState(false);
  if (!problems.length) return null;
  return <div className={`preview-problems ${open ? 'is-open' : ''}`} role="status">
    <div className="preview-problems-head">
      <button type="button" className="preview-problems-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><span className="problem-dot" />{problemCount(problems.length)} in this page<span className="preview-problems-chevron">{open ? '▾' : '▸'}</span></button>
      <span className="preview-problems-actions">
        <button type="button" className="shell-button" onClick={onDismiss}>Dismiss</button>
        <button type="button" className="shell-button primary" disabled={building} title={building ? 'Wait until the team has finished' : undefined} onClick={onFix}>Ask the Manager to fix</button>
      </span>
    </div>
    {open && <ul className="preview-problems-list">{problems.map((p, i) => <li key={i}>{problemLine(p)}</li>)}</ul>}
  </div>;
}

// After a part was selected: what should change about it. Sent to the Manager as one message.
function EditBar({ picked, busy, onSend, onCancel }) {
  const [request, setRequest] = useState('');
  const send = () => { if (request.trim() && !busy) onSend(request); };
  return <form className="preview-edit" onSubmit={(e) => { e.preventDefault(); send(); }}>
    <div className="preview-edit-target"><span>Selected</span><code>{pickedLabel(picked)}</code></div>
    <div className="preview-edit-row">
      <input autoFocus type="text" maxLength={2000} aria-label="What should change?" placeholder="What should change? For example: make it bigger and blue" value={request} onChange={(e) => setRequest(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}/>
      <button type="button" className="shell-button" onClick={onCancel}>Cancel</button>
      <button type="submit" className="shell-button primary" disabled={busy || !request.trim()}>Ask the Manager</button>
    </div>
  </form>;
}

// An app (package.json) runs in a locked container (main/sandbox). Before it runs: what that means and a
// Start button; while it starts: each step and the log; when it runs: the app itself, through the preview.
function AppStage({ product, onStart, checkDocker, Icon }) {
  const status = product.app?.status || { state: 'stopped', message: null, log: [] };
  const [docker, setDocker] = useState(null);
  useEffect(() => { let live = true; checkDocker?.().then((d) => { if (live) setDocker(d); }).catch(() => {}); return () => { live = false; }; }, [status.state]);
  const busy = ['preparing', 'installing', 'starting'].includes(status.state);
  const blocked = docker && docker.state !== 'ready';
  return <div className="app-stage">
    <div className="app-stage-card">
      <Icon name="code" size={22} />
      <strong>{busy ? APP_LABEL[status.state] + '…' : status.state === 'failed' ? 'The app did not start' : 'Run this app'}</strong>
      {busy ? <p>{status.message}</p> : status.state === 'failed' ? <p className="app-error">{status.message}</p>
        : <p>It runs in a locked Docker container on this computer: a copy of its files only, no keys, no access to your other files, limited memory and processor, and it stops after an hour. Like any app you run, its server can reach the internet.</p>}
      {blocked && !busy && <p className="app-error">{docker.message}{docker.state === 'not_installed' ? ' (docker.com → Docker Desktop, then open it once.)' : ''}</p>}
      {!busy && <button type="button" className="shell-button primary" disabled={Boolean(blocked)} onClick={onStart}>{status.state === 'failed' ? 'Try again' : 'Start app'}</button>}
    </div>
    {status.log?.length > 0 && <pre className="app-log" aria-label="App log">{status.log.slice(-40).join('\n')}</pre>}
  </div>;
}

export function ProductPreview({ product, host, version, nameOf, Icon, onTree, onClose, onOpenFolder, onFix, onClearProblems, onEdit, busy, onStartApp, onStopApp, checkDocker }) {
  const [showLog, setShowLog] = useState(false);
  const [device, setDevice] = useState('desktop');
  const [reloads, setReloads] = useState(0);
  // Select: the page's own script (main/preview/picker.ts) outlines what the mouse is over and reports a click.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState(null);
  const frame = useRef(null);
  const frameHost = product?.kind === 'app' ? product.app?.host : host;
  const tell = (on) => { try { frame.current?.contentWindow?.postMessage({ type: 'orqestra-pick', on }, `orqestra-preview://${frameHost}`); } catch { /* the page is gone */ } };
  useEffect(() => {
    const onMessage = (e) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const next = readPicked(e.data);
      if (next) { setPicked(next); setPicking(false); tell(false); }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [host]);
  useEffect(() => { tell(picking); }, [picking]);
  if (!product) {
    return <section className="tree-panel preview-panel" aria-label="Preview"><div className="panel-header"><div className="tree-panel-title"><Icon name="globe" size={17} /><strong>Preview</strong></div><div className="inline-actions"><button className="icon-button" title="Close preview" aria-label="Close preview" onClick={onClose}><Icon name="close" size={16} /></button></div></div>
      <div className="preview-empty"><Icon name="globe" size={22} /><strong>This product is gone.</strong><p>Its files are no longer in the project folder.</p><button className="shell-button" onClick={onTree}>Back to the team tree</button></div></section>;
  }
  const url = productUrl(product, host, `${version}-${reloads}`);
  const isApp = product.kind === 'app';
  const appState = isApp ? product.app?.status?.state || 'stopped' : null;
  // A reload starts the page over, so the problems it showed are checked again.
  const reload = () => { onClearProblems?.(); setReloads((n) => n + 1); };
  return <section className="tree-panel preview-panel" aria-label={`Preview of ${product.name}`}>
    <div className="panel-header">
      <div className="tree-panel-title"><Icon name="globe" size={17} /><strong>{product.name}</strong><span className={`count-label ${product.building || appState === 'running' ? 'preview-live' : ''}`}>{isApp ? `App · ${APP_LABEL[appState]}` : product.building ? 'Building · updates live' : product.entry}</span></div>
      <div className="inline-actions">
        <div className="preview-devices" role="group" aria-label="Preview size">
          <button className={`icon-button ${device === 'desktop' ? 'is-active' : ''}`} title="Desktop size" aria-label="Desktop size" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}><Icon name="desktop" size={15} /></button>
          <button className={`icon-button ${device === 'phone' ? 'is-active' : ''}`} title="Phone size" aria-label="Phone size" aria-pressed={device === 'phone'} onClick={() => setDevice('phone')}><Icon name="phone" size={15} /></button>
        </div>
        {isApp && appState === 'running' && <button className={`preview-select ${showLog ? 'is-active' : ''}`} title="Show what the app prints" aria-pressed={showLog} onClick={() => setShowLog(!showLog)}>Log</button>}
        {isApp && ['running', 'preparing', 'installing', 'starting'].includes(appState) && <button className="preview-select" title="Stop the app and remove its container" onClick={onStopApp}>Stop app</button>}
        <button className={`preview-select ${picking ? 'is-active' : ''}`} title="Click a part of the page to change it" aria-pressed={picking} disabled={!url} onClick={() => { setPicked(null); setPicking(!picking); }}><Icon name="cursor" size={14} />{picking ? 'Click a part…' : 'Select'}</button>
        <button className="icon-button" title="Reload" aria-label="Reload the preview" onClick={reload}><Icon name="refresh" size={15} /></button>
        <button className="icon-button" title="Open project folder" aria-label="Open project folder" onClick={onOpenFolder}><Icon name="folder" size={15} /></button>
        <button className="icon-button" title="Back to the team tree" aria-label="Back to the team tree" onClick={onTree}><Icon name="tree" size={15} /></button>
        <button className="icon-button" title="Close preview" aria-label="Close preview" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
    </div>
    <div className={`preview-stage preview-${device}`}>
      {isApp && !url
        ? <AppStage product={product} onStart={onStartApp} checkDocker={checkDocker} Icon={Icon} />
        : product.files.length
        ? <iframe key={url} ref={frame} className="preview-frame" src={url} title={`Preview of ${product.name}`} sandbox={SANDBOX} referrerPolicy="no-referrer" onLoad={() => tell(picking)} />
        : <div className="preview-empty"><Icon name="globe" size={22} /><strong>{product.building ? 'The team is building this.' : 'Nothing to show yet.'}</strong><p>{product.building ? 'The preview appears here as soon as the first files are written, and updates while the team works.' : `The plan names this product, but ${product.entry} has not been written.`}</p></div>}
    </div>
    {isApp && appState === 'running' && showLog && <pre className="app-log app-log-running" aria-label="App log">{(product.app.status.log || []).slice(-60).join('\n') || 'No output yet.'}</pre>}
    {picked && <EditBar key={picked.path + picked.text} picked={picked} busy={busy} onCancel={() => setPicked(null)} onSend={(request) => { onEdit?.(picked, request); setPicked(null); }} />}
    <ProblemsBar problems={product.problems || []} building={product.building} onFix={onFix} onDismiss={onClearProblems} />
    <div className="tree-footer"><span><span className="status-dot" />{product.agents.length ? `Built by ${product.agents.map(nameOf).join(', ')}` : 'Files in the project folder'}</span><span>{isApp ? 'Locked container · no keys · your files untouched' : 'Runs isolated · no internet · no keys'}</span></div>
  </section>;
}
