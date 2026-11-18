// The frame around the work: the profile button at the bottom left with its menu (settings,
// appearance, updates, help, about), the settings and help dialogs, and the "Updated to vX" screen
// shown once after an update has been installed. Updates themselves are run by the main process
// (main/update/index.ts); this file only shows their state and passes on "check".
import React, { useEffect, useRef, useState } from 'react';

const PATHS = {
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></>,
  refresh: <><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>,
  close: <path d="M6 6l12 12M18 6 6 18"/>,
  check: <path d="m5 12 5 5 9-10"/>,
};

export function ShellIcon({ name, size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>;
}

const THEME_LABEL = { light: 'Light', dark: 'Dark', system: 'System' };
const THEME_ICON = { light: 'sun', dark: 'moon', system: 'monitor' };

export function updateLabel(updates) {
  if (!updates.enabled) return 'Installed app only';
  const status = updates.snapshot?.status;
  if (status === 'ready') return 'Update ready';
  if (status === 'downloading') return 'Downloading…';
  if (status === 'checking') return 'Checking…';
  if (status === 'installing') return 'Installing…';
  return '';
}

function useDismiss(open, onClose, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    const onDown = (event) => { if (ref.current && !ref.current.contains(event.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open, onClose, ref]);
}

export function ProfileMenu({ name, version, updates, theme, onTheme, onSettings, onHelp, account = null, accountAvailable = false, onSignOut, onSignIn }) {
  const [open, setOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const ref = useRef(null);
  const close = () => { setOpen(false); setThemeOpen(false); };
  useDismiss(open, close, ref);
  const status = updateLabel(updates);
  const ready = updates.snapshot?.status === 'ready';
  const run = (action) => () => { close(); action(); };
  return (
    <div className="profile" ref={ref}>
      {open && (
        <div className="profile-menu" role="menu" aria-label="Profile">
          <div className="profile-menu-head">
            {account ? <><strong>{account.name}</strong><span>{account.email}</span></> : <><strong>{name}</strong><span>{accountAvailable ? 'Not signed in · local projects only' : 'Personal · on this device'}</span></>}
          </div>
          {accountAvailable && (account
            ? <button role="menuitem" className="profile-item" onClick={run(onSignOut)}><ShellIcon name="user"/> Sign out</button>
            : <button role="menuitem" className="profile-item" onClick={run(onSignIn)}><ShellIcon name="user"/> Sign in or create account</button>)}
          <button role="menuitem" className="profile-item" onClick={run(() => onSettings('general'))}><ShellIcon name="settings"/> Settings</button>
          <div className="profile-separator"/>
          <button role="menuitem" className="profile-item" aria-expanded={themeOpen} onClick={() => setThemeOpen(!themeOpen)}><ShellIcon name={THEME_ICON[theme]}/> Appearance <span className="profile-value">{THEME_LABEL[theme]} <ShellIcon name="chevron" size={13}/></span></button>
          {themeOpen && (
            <div className="profile-themes" role="group" aria-label="Appearance">
              {Object.keys(THEME_LABEL).map((value) => (
                <button key={value} className={`profile-theme ${value === theme ? 'is-active' : ''}`} aria-pressed={value === theme} onClick={() => onTheme(value)}><ShellIcon name={THEME_ICON[value]} size={14}/> {THEME_LABEL[value]}</button>
              ))}
            </div>
          )}
          <button role="menuitem" className="profile-item" disabled={!updates.enabled} title={updates.enabled ? 'Check for updates' : 'Updates work in the installed app'} onClick={run(updates.check)}><ShellIcon name="refresh"/> Check for updates {status && <span className={`profile-value ${ready ? 'is-ready' : ''}`}>{status}</span>}</button>
          <button role="menuitem" className="profile-item" onClick={run(onHelp)}><ShellIcon name="help"/> Help</button>
          <div className="profile-separator"/>
          <button role="menuitem" className="profile-item" onClick={run(() => onSettings('about'))}><ShellIcon name="info"/> About 0rqestra <span className="profile-value">{version ? `Version ${version}` : 'Preview'}</span></button>
        </div>
      )}
      <button className={`profile-button ${open ? 'is-open' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span className="profile-avatar">{((account ? account.name : name).trim()[0] || '0').toUpperCase()}{ready && <i className="profile-dot" title="Update ready"/>}</span>
        <span className="profile-text"><strong>{account ? account.name : name}</strong><span>{ready ? 'Update ready' : account ? account.email : 'Personal'}</span></span>
        <span className="profile-more" aria-hidden="true">···</span>
      </button>
    </div>
  );
}

const TABS = [['general', 'General', 'user'], ['appearance', 'Appearance', 'sun'], ['updates', 'Updates', 'refresh'], ['about', 'About', 'info']];

export function SettingsDialog({ tab, onTab, onClose, theme, onTheme, name, onName, updates, appInfo }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const version = appInfo?.appVersion || updates.snapshot?.currentVersion;
  const status = updateLabel(updates);
  return (
    <div className="shell-scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={ref}>
        <header className="settings-head"><h2 id="settings-title">Settings</h2><button className="shell-close" aria-label="Close settings" onClick={onClose}><ShellIcon name="close"/></button></header>
        <div className="settings-body">
          <nav className="settings-tabs" aria-label="Settings sections">
            {TABS.map(([id, label, icon]) => <button key={id} className={`settings-tab ${tab === id ? 'is-active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}><ShellIcon name={icon}/> {label}</button>)}
          </nav>
          <section className="settings-pane">
            {tab === 'general' && <>
              <h3>General</h3>
              <label className="settings-row"><span><strong>Workspace name</strong><small>Shown at the bottom left.</small></span><input className="settings-input" value={name} maxLength={40} onChange={(e) => onName(e.target.value)} onBlur={(e) => { if (!e.target.value.trim()) onName('My workspace'); }}/></label>
              <div className="settings-row"><span><strong>Where your work is kept</strong><small>Projects, chats and settings are saved on this device only.</small></span></div>
            </>}
            {tab === 'appearance' && <>
              <h3>Appearance</h3>
              <div className="theme-cards" role="radiogroup" aria-label="Theme">
                {Object.keys(THEME_LABEL).map((value) => (
                  <button key={value} role="radio" aria-checked={theme === value} className={`theme-card theme-card-${value} ${theme === value ? 'is-active' : ''}`} onClick={() => onTheme(value)}>
                    <span className="theme-preview"><i/><b/></span>
                    <span className="theme-name"><ShellIcon name={THEME_ICON[value]} size={14}/> {THEME_LABEL[value]}</span>
                  </button>
                ))}
              </div>
              <p className="settings-note">System follows the light or dark setting of your computer. Animations follow its "reduce motion" setting.</p>
            </>}
            {tab === 'updates' && <>
              <h3>Updates</h3>
              <div className="settings-row"><span><strong>Current version</strong><small>{version ? `0rqestra ${version}` : 'Interface preview (not the installed app)'}</small></span>{status && <span className={`settings-pill ${updates.snapshot?.status === 'ready' ? 'is-ready' : ''}`}>{status}</span>}</div>
              <div className="settings-row"><span><strong>Automatic updates</strong><small>0rqestra looks for a new version when it starts, every 30 minutes, and when you come back to the window. A new version downloads in the background and is verified before you are asked to restart.</small></span></div>
              <div className="settings-actions"><button className="shell-button primary" disabled={!updates.enabled} onClick={() => { onClose(); updates.check(); }}><ShellIcon name="refresh" size={14}/> Check for updates</button></div>
            </>}
            {tab === 'about' && <>
              <h3>About</h3>
              <div className="about-head"><img src="logo.png" alt="" width="48" height="48"/><div><strong>0rqestra</strong><small>{version ? `Version ${version}` : 'Interface preview'}</small></div></div>
              <div className="settings-row"><span><strong>Platform</strong><small>{appInfo ? `${appInfo.platform} · Electron ${appInfo.electronVersion}` : 'Browser preview'}</small></span></div>
              <div className="settings-row"><span><strong>Releases</strong><small>github.com/SEASTICK/0rqestra/releases</small></span></div>
            </>}
          </section>
        </div>
      </div>
    </div>
  );
}

export function HelpDialog({ onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="shell-scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header className="settings-head"><h2 id="help-title">Help</h2><button className="shell-close" aria-label="Close help" onClick={onClose}><ShellIcon name="close"/></button></header>
        <div className="help-body">
          <h3>Getting started</h3>
          <ul>
            <li>Talk only to the <strong>Manager</strong> in the chat. It hands the work to the agents in your tree.</li>
            <li>Open the tree to shape your team. <strong>+</strong> beside an agent adds a connected agent below it.</li>
            <li>Connect <strong>Claude Code</strong> or <strong>Codex</strong> under AI accounts, then choose it for your Manager below the message box.</li>
            <li>When the Manager proposes a plan, nothing runs until you press <strong>Start</strong>. The team's progress shows in the chat.</li>
          </ul>
          <h3>Keyboard</h3>
          <dl className="help-keys">
            <dt><kbd>Enter</kbd></dt><dd>Send a message</dd>
            <dt><kbd>Shift</kbd> + <kbd>Enter</kbd></dt><dd>New line</dd>
            <dt><kbd>Esc</kbd></dt><dd>Close a dialog or menu</dd>
          </dl>
          <h3>Updates</h3>
          <p>New versions arrive by themselves. When one is ready you are asked to restart; nothing is lost. You can also choose <strong>Check for updates</strong> in the profile menu at the bottom left.</p>
          <h3>Report a problem</h3>
          <p>github.com/SEASTICK/0rqestra/issues</p>
        </div>
      </div>
    </div>
  );
}

// Shown once after the app has been updated (the version went up since the previous start).
export function UpdateIntro({ version, previous, onDone }) {
  const [leaving, setLeaving] = useState(false);
  const reduced = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  useEffect(() => {
    const leave = () => setLeaving(true);
    const timer = window.setTimeout(leave, reduced ? 2500 : 4200);
    const onKey = (event) => { if (event.key === 'Escape' || event.key === 'Enter') leave(); };
    window.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [reduced]);
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(onDone, reduced ? 0 : 380);
    return () => window.clearTimeout(timer);
  }, [leaving, reduced, onDone]);
  return (
    <div className={`update-intro ${leaving ? 'leaving' : ''}`} role="status" aria-live="polite" onClick={() => setLeaving(true)}>
      <div className="update-intro-card">
        <svg className="update-intro-check" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" pathLength="1"/><path d="M20 33 L29 42 L45 24" pathLength="1"/></svg>
        <h1 className="update-intro-title">Updated to <span>v{version}</span></h1>
        <p className="update-intro-sub">{previous ? `From v${previous}. ` : ''}Your projects and settings are kept.</p>
        <button className="shell-button primary update-intro-button" onClick={(e) => { e.stopPropagation(); setLeaving(true); }}>Continue</button>
      </div>
    </div>
  );
}
