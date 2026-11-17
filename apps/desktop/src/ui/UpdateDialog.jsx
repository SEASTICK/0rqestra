// App updates in the window: version, release notes, download progress, errors, and the
// "Restart now" / "Later" choice. The main process (main/update/index.ts) does all checking,
// downloading, signature verification, and installing; this page only shows its state and passes
// the user's answer back. Background network errors are never shown here: the main process only
// sends a notice when the user asked (check, restart) or when installing was refused.
import React, { useEffect, useRef, useState } from 'react';

const api = () => window.orqestra?.updates;

export function useUpdates() {
  const [state, setState] = useState({ enabled: false, snapshot: null, notice: null, prompt: false });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const updates = api();
    if (!updates) return undefined;
    let live = true;
    const apply = (message) => {
      if (!live || !message) return;
      setState((current) => ({
        enabled: message.enabled ?? current.enabled,
        snapshot: message.snapshot ?? current.snapshot,
        // A new notice replaces the old one; a plain state message keeps it.
        notice: message.notice ?? (message.open ? null : current.notice),
        prompt: message.prompt ?? (message.notice || message.open ? false : current.prompt),
      }));
      if (message.open || message.prompt) setOpen(true);
    };
    updates.subscribe(apply).then(apply).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const check = () => {
    api()?.check().catch(() => undefined);
  };
  const respond = (choice) => {
    setState((current) => ({ ...current, prompt: false, notice: null }));
    if (choice === 'later') setOpen(false);
    api()?.respond(choice).catch(() => undefined);
  };
  const close = () => {
    if (state.prompt) respond('later');
    else setOpen(false);
  };
  return { ...state, open, check, respond, close };
}

export function UpdateDialog({ updates, Icon }) {
  const { open, snapshot, notice, prompt } = updates;
  const [showNotes, setShowNotes] = useState(false);
  const safe = useRef(null);
  const status = snapshot?.status;
  const installing = status === 'installing';
  const downloading = status === 'downloading' || status === 'checking';
  const ready = status === 'ready';
  useEffect(() => {
    if (open) safe.current?.focus();
  }, [open, status, notice]);
  useEffect(() => {
    if (!open || installing) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') updates.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, installing, updates]);
  if (!open) return null;

  const percent = typeof snapshot?.progress === 'number' ? Math.round(snapshot.progress * 100) : null;
  const version = snapshot?.version;
  let title = 'Updates';
  let body = '';
  if (notice) {
    title = notice.kind === 'error' ? 'Update not installed' : 'Updates';
    body = notice.message;
  } else if (installing) {
    title = `Installing v${version}`;
    body = 'Your projects are saved. 0rqestra closes, installs the update, and starts again.';
  } else if (ready && version) {
    title = `A new version is available: v${version}`;
    body = `You are running v${snapshot.currentVersion}. The update is downloaded and verified. 0rqestra restarts when you install it.`;
  } else if (status === 'downloading') {
    title = version ? `Downloading v${version}` : 'Downloading the update';
    body = 'The update downloads in the background. You can keep working.';
  } else {
    title = 'Checking for updates';
    body = 'Looking for a newer version…';
  }

  return (
    <div className="modal-scrim update-scrim" role="presentation">
      <div className="modal update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <div className="dialog-heading">
          <span className="dialog-icon"><Icon name={notice?.kind === 'error' ? 'close' : 'arrow'} size={21} /></span>
          {!installing && <button className="icon-button" aria-label="Close updates" onClick={updates.close}><Icon name="close" /></button>}
        </div>
        <h2 id="update-title">{title}</h2>
        <p className="dialog-description">{body}</p>
        {notice?.detail ? <p className="update-detail">{notice.detail}</p> : null}
        {!notice && (downloading || installing) && (
          <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <i style={{ width: percent !== null ? `${percent}%` : '35%' }} className={percent === null ? 'update-progress-unknown' : ''} />
            {percent !== null && <span>{percent}%</span>}
          </div>
        )}
        {!notice && ready && version && showNotes && (
          <div className="update-notes">{snapshot.notes ? <pre>{snapshot.notes}</pre> : <p>No notes for this version.</p>}</div>
        )}
        <div className="dialog-footer">
          {notice ? (
            <>
              {notice.kind === 'error' && <button className="button" onClick={updates.check}>Try again</button>}
              <button className="button primary-button" ref={safe} onClick={updates.close}>Close</button>
            </>
          ) : ready && version ? (
            <>
              <button className="button update-notes-toggle" aria-expanded={showNotes} onClick={() => setShowNotes((value) => !value)}>What's new?</button>
              <button className="button" ref={safe} onClick={() => updates.respond('later')}>Later</button>
              <button className="button primary-button" disabled={!prompt} onClick={() => updates.respond('restart')}>Restart now</button>
            </>
          ) : (
            <button className="button" ref={safe} disabled={installing} onClick={updates.close}>{installing ? 'Installing…' : 'Hide'}</button>
          )}
        </div>
      </div>
    </div>
  );
}
