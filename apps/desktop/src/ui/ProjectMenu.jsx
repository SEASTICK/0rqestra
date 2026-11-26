import React, { useEffect, useRef, useState } from 'react';

// The ⋯ menu on a project in the sidebar: rename, open its folder, computer access, and removing it
// from 0rqestra. Each removal is explained in a dialog first (ProjectActionDialog), because the words
// "remove" and "unlink" alone do not say what stays.

export function ProjectMenu({ project, link, Icon, onAction }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open]);
  const pick = (kind) => () => { setOpen(false); onAction(kind); };
  return (
    <div className="project-menu" ref={ref}>
      <button type="button" className="icon-button project-menu-button" aria-label={`More for ${project.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="profile-menu project-menu-list" role="menu" aria-label={`${project.name} menu`}>
          <button type="button" role="menuitem" onClick={pick('rename')}><Icon name="settings" size={14}/> Rename</button>
          <button type="button" role="menuitem" onClick={pick('open')}><Icon name="folder" size={14}/> Open folder</button>
          <button type="button" role="menuitem" onClick={pick('access')}><Icon name="link" size={14}/> Computer access</button>
          <button type="button" role="menuitem" onClick={pick('onboarding')}><Icon name="spark" size={14}/> Get started</button>
          <div className="project-menu-line" role="separator"/>
          {link && <button type="button" role="menuitem" onClick={pick('unlink')}>Unlink checkout from this computer</button>}
          {link?.team.isOwner && <button type="button" role="menuitem" className="danger-button" onClick={pick('remove-team')}>Remove from team…</button>}
          <button type="button" role="menuitem" className="danger-button" onClick={pick('remove')}>Remove from 0rqestra…</button>
        </div>
      )}
    </div>
  );
}

const TEXT = {
  remove: {
    title: (p) => `Remove “${p.name}” from 0rqestra?`,
    gone: ['The project in the sidebar, with its conversations and team tree', 'Its link to a checkout on this computer, and its computer access'],
    kept: ['The project folder and every file in it', 'The Git working tree, including changes not yet committed', 'The GitHub repository', 'Your agents and their skills: you can add them to another project'],
    button: 'Remove from 0rqestra',
  },
  unlink: {
    title: (p) => `Unlink your checkout of “${p.name}”?`,
    gone: ['The link between this computer’s checkout and the shared project'],
    kept: ['The checkout folder, its files and Git changes', 'The shared project: your teammates still see it, and you stay in the team', 'This project in your sidebar; you can link a checkout again from Teams'],
    button: 'Unlink checkout',
  },
  'remove-team': {
    title: (p, link) => `Remove “${link?.project.name || p.name}” from ${link?.team.name || 'the team'}?`,
    gone: ['The shared project, for every member of the team', 'Its shared briefs and file reservations', 'Every member’s link to it'],
    kept: ['Every member’s checkout, with its files and Git changes', 'The GitHub repository', 'This project in your sidebar, as a project of your own'],
    button: 'Remove from team',
  },
};

// The dialog for a removal: what goes, what stays, and a running team stopped first.
export function ProjectActionDialog({ kind, project, link, running, Icon, onStop, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const t = TEXT[kind];
  const act = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(e?.message || 'That did not work.'); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!running) void act(onConfirm); }}>
      <div className="dialog-heading"><span className="dialog-icon"><Icon name="folder" size={21}/></span><button className="icon-button" type="button" aria-label="Close" onClick={onClose}><Icon name="close"/></button></div>
      <h2 id="dialog-title">{t.title(project, link)}</h2>
      <div className="removal-lists">
        <div><strong>Removed</strong><ul>{t.gone.map((x) => <li key={x}>{x}</li>)}</ul></div>
        <div><strong>Kept</strong><ul>{t.kept.map((x) => <li key={x}>{x}</li>)}</ul></div>
      </div>
      {link?.project.link?.path && kind !== 'remove-team' && <p className="dialog-description">Checkout on this computer: <span className="setup-path">{link.project.link.path}</span></p>}
      {running && (
        <div className="team-setup-banner" role="alert">
          <span><strong>The team is working in this project.</strong> Stop the run first. Its file reservations are released when it stops.</span>
          <button type="button" className="shell-button primary" disabled={stopping} onClick={() => { setStopping(true); void act(onStop); }}>{stopping ? 'Stopping…' : 'Stop the run'}</button>
        </div>
      )}
      {error && <div className="setup-error" role="alert"><span>{error}</span></div>}
      <div className="dialog-footer">
        <button className="button" type="button" onClick={onClose}>Cancel</button>
        <button className="button primary-button danger-fill" type="submit" disabled={busy || running}>{t.button}</button>
      </div>
    </form>
  );
}

export function RenameProjectForm({ project, Icon, onSave, onClose }) {
  const [name, setName] = useState(project.name);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
      <div className="dialog-heading"><span className="dialog-icon"><Icon name="settings" size={21}/></span><button className="icon-button" type="button" aria-label="Close" onClick={onClose}><Icon name="close"/></button></div>
      <h2 id="dialog-title">Rename project</h2>
      <p className="dialog-description">Only the name in 0rqestra changes. The folder and the repository keep their names.</p>
      <div className="form-fields"><label>Project name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} required/></label></div>
      <div className="dialog-footer"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary-button" type="submit" disabled={!name.trim() || name.trim() === project.name}>Rename</button></div>
    </form>
  );
}
