// Files and images in the chat: the + button, drop and paste, the chips above the message box, and the
// attachments shown in a sent message. The bytes go to the main process, which checks and keeps them
// (main/attachments.ts); the window keeps only a small picture of each image.
import React, { useEffect, useRef, useState } from 'react';

export const MAX_ATTACHMENTS = 6;
const size = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} kB` : `${n} B`);

async function thumbnail(file) {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  } catch {
    return null;
  }
}

// Hands each file to the main process; returns what was kept and the errors for the rest.
export async function attachFiles(files, room) {
  const api = window.orqestra?.chat?.attach;
  const kept = [];
  const errors = [];
  if (!api) return { kept, errors: ['Attaching files works in the installed app.'] };
  for (const file of [...files].slice(0, Math.max(0, room))) {
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const meta = await api({ name: file.name || 'pasted image', data });
      kept.push({ ...meta, thumb: meta.kind === 'image' ? await thumbnail(file) : null });
    } catch (error) {
      errors.push(`${file.name || 'File'}: ${String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    }
  }
  if (files.length > room) errors.push(`At most ${MAX_ATTACHMENTS} files per message.`);
  return { kept, errors };
}

// Paste, like Claude: pictures and files on the clipboard become attachments, and a long text becomes a
// "Pasted text" file instead of filling the message box. When the browser part cannot see what was copied
// (files copied in Explorer or Finder, some screenshots), the main process reads the clipboard itself.
export const LONG_PASTE = 4000;
const fileItems = (data) => {
  const files = [...(data?.files || [])];
  if (files.length) return files;
  return [...(data?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
};

export async function pasteText(text, room) {
  const api = window.orqestra?.chat?.attach;
  if (!api || room <= 0) return { kept: [], errors: room <= 0 ? [`At most ${MAX_ATTACHMENTS} files per message.`] : ['Attaching files works in the installed app.'] };
  try {
    const meta = await api({ name: 'Pasted text.txt', data: new TextEncoder().encode(text) });
    return { kept: [{ ...meta, pasted: true, preview: text.slice(0, 240) }], errors: [] };
  } catch (error) {
    return { kept: [], errors: [String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')] };
  }
}

// Handles one paste event. Returns true when it took the paste (the caller then does nothing more).
export function handlePaste(event, room, onResult) {
  const data = event.clipboardData;
  const files = fileItems(data);
  const text = data?.getData('text/plain') || '';
  if (files.length) { event.preventDefault(); void attachFiles(files, room).then(onResult); return true; }
  if (text.length > LONG_PASTE) { event.preventDefault(); void pasteText(text, room).then(onResult); return true; }
  const types = [...(data?.types || [])];
  if (!text && (types.length === 0 || types.includes('Files') || types.some((t) => t.startsWith('image/')))) {
    const api = window.orqestra?.chat?.paste;
    if (!api) return false;
    event.preventDefault();
    void api().then((r) => onResult({ kept: (r?.kept || []).slice(0, Math.max(0, room)), errors: r?.errors || [] }), (e) => onResult({ kept: [], errors: [String(e?.message || e)] }));
    return true;
  }
  return false;
}

// A picture shown big, over the window. The full image is read from the main process by its id.
export function Lightbox({ item, onClose }) {
  const [src, setSrc] = useState(item?.thumb || null);
  useEffect(() => {
    let live = true;
    window.orqestra?.chat?.attachmentImage?.(item.id).then((url) => { if (live && url) setSrc(url); }).catch(() => {});
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { live = false; window.removeEventListener('keydown', key); };
  }, [item?.id]);
  return <div className="lightbox" role="dialog" aria-label={item.name} onClick={onClose}>
    {src ? <img src={src} alt={item.name} onClick={(e) => e.stopPropagation()} /> : <p>No picture to show.</p>}
    <div className="lightbox-bar"><span>{item.name}</span><button type="button" aria-label="Close the picture" onClick={onClose}>×</button></div>
  </div>;
}

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.js,.ts,.jsx,.tsx,.py,.html,.css,.sql,.yaml,.yml,.xml,.txt';

// The + in the message box opens a small menu, like Claude's: add files or photos (also Ctrl+U), add one of
// the project's own files, start a new chat, or open the project's memory.
export function AttachMenu({ disabled, onFiles, onProjectFile, projectId, onNewChat, onMemory, Icon }) {
  const input = useRef(null);
  const box = useRef(null);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(null);
  useEffect(() => {
    const key = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u' && !disabled) { e.preventDefault(); setOpen(false); input.current?.click(); }
      if (e.key === 'Escape') { setOpen(false); setFiles(null); }
    };
    const away = (e) => { if (box.current && !box.current.contains(e.target)) { setOpen(false); setFiles(null); } };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', away);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', away); };
  }, [disabled]);
  const showProjectFiles = async () => {
    try { setFiles(await window.orqestra?.chat?.projectFiles?.(projectId) || []); } catch { setFiles([]); }
  };
  const choose = (fn) => { setOpen(false); setFiles(null); fn?.(); };
  return <span className="attach-menu-wrap" ref={box}>
    <button type="button" className={`attach-button ${open ? 'is-open' : ''}`} title="Add files and more" aria-label="Add files and more" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { setOpen(!open); setFiles(null); }}><Icon name="plus" size={17} /></button>
    <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => { const picked = [...(e.target.files || [])]; e.target.value = ''; if (picked.length) onFiles(picked); }} />
    {open && <div className="attach-menu" role="menu">
      {files === null ? <>
        <button type="button" role="menuitem" onClick={() => choose(() => input.current?.click())}><Icon name="clip" size={16} /><span>Add files or photos</span><kbd>Ctrl+U</kbd></button>
        {projectId && <button type="button" role="menuitem" onClick={showProjectFiles}><Icon name="folder" size={16} /><span>Add a file from this project</span><span className="attach-menu-more">›</span></button>}
        <div className="attach-menu-line" />
        {onNewChat && <button type="button" role="menuitem" onClick={() => choose(onNewChat)}><Icon name="chat" size={16} /><span>New chat</span></button>}
        {onMemory && <button type="button" role="menuitem" onClick={() => choose(onMemory)}><Icon name="spark" size={16} /><span>Project memory</span></button>}
      </> : <>
        <button type="button" role="menuitem" className="attach-menu-back" onClick={() => setFiles(null)}>‹ <span>Files in this project</span></button>
        <div className="attach-menu-files">
          {files.length === 0 && <p>No files yet. The team writes them here.</p>}
          {files.map((f) => <button type="button" role="menuitem" key={f} title={f} onClick={() => choose(() => onProjectFile(f))}><Icon name="code" size={14} /><span>{f}</span></button>)}
        </div>
      </>}
    </div>}
  </span>;
}

// Kept for places that only add files.
export function AttachButton(props) {
  return <AttachMenu {...props} />;
}

function Chip({ a, onRemove, Icon }) {
  const [big, setBig] = useState(false);
  if (a.pasted) return <span className="attach-chip attach-pasted" title={`${a.name} · ${size(a.size)}`}>
    <span className="attach-pasted-text">{a.preview}</span>
    <span className="attach-pasted-label">Pasted</span>
    {onRemove && <button type="button" aria-label={`Remove ${a.name}`} onClick={onRemove}>×</button>}
  </span>;
  if (a.kind === 'image' && a.thumb) return <span className="attach-chip attach-image" title={`${a.name} · ${size(a.size)}`}>
    <button type="button" className="attach-image-open" aria-label={`Show ${a.name}`} onClick={() => setBig(true)}><img src={a.thumb} alt="" /></button>
    {onRemove && <button type="button" className="attach-remove" aria-label={`Remove ${a.name}`} onClick={onRemove}>×</button>}
    {big && <Lightbox item={a} onClose={() => setBig(false)} />}
  </span>;
  return <span className={`attach-chip kind-${a.kind}`} title={`${a.name} · ${size(a.size)}`}>
    {a.thumb ? <img src={a.thumb} alt="" /> : <span className="attach-icon"><Icon name={a.kind === 'pdf' ? 'folder' : 'code'} size={15} /></span>}
    <span className="attach-text"><strong>{a.name}</strong><small>{a.kind === 'pdf' ? 'PDF' : a.kind === 'image' ? 'Image' : 'Text'} · {size(a.size)}</small></span>
    {onRemove && <button type="button" aria-label={`Remove ${a.name}`} onClick={onRemove}>×</button>}
  </span>;
}

export function PendingAttachments({ items, onRemove, Icon }) {
  if (!items.length) return null;
  return <div className="attach-pending">{items.map((a) => <Chip key={a.id} a={a} Icon={Icon} onRemove={() => onRemove(a.id)} />)}</div>;
}

export function SentAttachments({ items, Icon }) {
  if (!items?.length) return null;
  return <div className="attach-sent">{items.map((a, i) => <Chip key={i} a={a} Icon={Icon} />)}</div>;
}
