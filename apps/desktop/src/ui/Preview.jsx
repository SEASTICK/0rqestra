import React, { useState } from 'react';
import { previewUrl, problemLine } from './live-chat.mjs';

// A product the team builds, as a node in the tree and as a live preview beside the chat. The page runs
// in a frame on its own origin (orqestra-preview://), with no access to the app, the network or keys.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals';

const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null);
const problemCount = (n) => `${n} ${n === 1 ? 'problem' : 'problems'}`;

export function ProductNode({ product, host, version, selected, dragging, Icon, onOpen, onPointerDown, onPointerMove, onPointerUp }) {
  const url = previewUrl(host, product, version);
  const problems = product.problems?.length || 0;
  const empty = !product.files.length;
  return <div className={`agent-node product-node ${product.building ? 'product-building' : ''} ${problems ? 'product-has-problems' : ''} ${dragging ? 'product-dragging' : ''} ${selected ? 'node-selected' : ''}`} style={{ left: product.x, top: product.y }} role="button" tabIndex={0} aria-label={`Open the preview of ${product.name}${problems ? `, ${problemCount(problems)}` : ''}`} title="Click to preview · drag to move" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
    {product.building && <span className="working-halo" />}
    <span className="node-port top-port" />
    <div className="node-heading"><span className="node-avatar product-avatar"><Icon name="globe" size={18} /></span><div><span className="node-role">Product · Web</span><strong>{product.name}</strong></div></div>
    <div className={`product-thumb ${empty ? 'product-thumb-empty' : ''}`} aria-hidden="true">{empty ? <span>{product.building ? 'The team is writing the first files' : 'No files yet'}</span> : url && <iframe src={url} title="" tabIndex={-1} sandbox={SANDBOX} referrerPolicy="no-referrer" loading="lazy" />}</div>
    <div className="node-bottom">{problems > 0 && !product.building
      ? <span className="product-problems"><span className="status-dot" />{problemCount(problems)}</span>
      : <span><span className={`status-dot ${product.building ? 'status-dot-live' : ''}`} />{product.building ? 'Building' : empty ? 'Planned' : `${product.files.length} ${product.files.length === 1 ? 'file' : 'files'}`}</span>}
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

export function ProductPreview({ product, host, version, nameOf, Icon, onTree, onClose, onOpenFolder, onFix, onClearProblems }) {
  const [device, setDevice] = useState('desktop');
  const [reloads, setReloads] = useState(0);
  if (!product) {
    return <section className="tree-panel preview-panel" aria-label="Preview"><div className="panel-header"><div className="tree-panel-title"><Icon name="globe" size={17} /><strong>Preview</strong></div><div className="inline-actions"><button className="icon-button" title="Close preview" aria-label="Close preview" onClick={onClose}><Icon name="close" size={16} /></button></div></div>
      <div className="preview-empty"><Icon name="globe" size={22} /><strong>This product is gone.</strong><p>Its files are no longer in the project folder.</p><button className="shell-button" onClick={onTree}>Back to the team tree</button></div></section>;
  }
  const url = previewUrl(host, product, `${version}-${reloads}`);
  // A reload starts the page over, so the problems it showed are checked again.
  const reload = () => { onClearProblems?.(); setReloads((n) => n + 1); };
  return <section className="tree-panel preview-panel" aria-label={`Preview of ${product.name}`}>
    <div className="panel-header">
      <div className="tree-panel-title"><Icon name="globe" size={17} /><strong>{product.name}</strong><span className={`count-label ${product.building ? 'preview-live' : ''}`}>{product.building ? 'Building · updates live' : product.entry}</span></div>
      <div className="inline-actions">
        <div className="preview-devices" role="group" aria-label="Preview size">
          <button className={`icon-button ${device === 'desktop' ? 'is-active' : ''}`} title="Desktop size" aria-label="Desktop size" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}><Icon name="desktop" size={15} /></button>
          <button className={`icon-button ${device === 'phone' ? 'is-active' : ''}`} title="Phone size" aria-label="Phone size" aria-pressed={device === 'phone'} onClick={() => setDevice('phone')}><Icon name="phone" size={15} /></button>
        </div>
        <button className="icon-button" title="Reload" aria-label="Reload the preview" onClick={reload}><Icon name="refresh" size={15} /></button>
        <button className="icon-button" title="Open project folder" aria-label="Open project folder" onClick={onOpenFolder}><Icon name="folder" size={15} /></button>
        <button className="icon-button" title="Back to the team tree" aria-label="Back to the team tree" onClick={onTree}><Icon name="tree" size={15} /></button>
        <button className="icon-button" title="Close preview" aria-label="Close preview" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
    </div>
    <div className={`preview-stage preview-${device}`}>
      {product.files.length
        ? <iframe key={url} className="preview-frame" src={url} title={`Preview of ${product.name}`} sandbox={SANDBOX} referrerPolicy="no-referrer" />
        : <div className="preview-empty"><Icon name="globe" size={22} /><strong>{product.building ? 'The team is building this.' : 'Nothing to show yet.'}</strong><p>{product.building ? 'The preview appears here as soon as the first files are written, and updates while the team works.' : `The plan names this product, but ${product.entry} has not been written.`}</p></div>}
    </div>
    <ProblemsBar problems={product.problems || []} building={product.building} onFix={onFix} onDismiss={onClearProblems} />
    <div className="tree-footer"><span><span className="status-dot" />{product.agents.length ? `Built by ${product.agents.map(nameOf).join(', ')}` : 'Files in the project folder'}</span><span>Runs isolated · no internet · no keys</span></div>
  </section>;
}
