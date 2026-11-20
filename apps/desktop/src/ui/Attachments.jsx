// Files and images in the chat: the + button, drop and paste, the chips above the message box, and the
// attachments shown in a sent message. The bytes go to the main process, which checks and keeps them
// (main/attachments.ts); the window keeps only a small picture of each image.
import React, { useRef } from 'react';

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

export function AttachButton({ disabled, onFiles, Icon }) {
  const input = useRef(null);
  return <>
    <button type="button" className="attach-button" title="Add files or photos" aria-label="Add files or photos" disabled={disabled} onClick={() => input.current?.click()}><Icon name="plus" size={17} /></button>
    <input ref={input} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.js,.ts,.jsx,.tsx,.py,.html,.css,.sql,.yaml,.yml,.xml,.txt" onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) onFiles(files); }} />
  </>;
}

function Chip({ a, onRemove, Icon }) {
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
