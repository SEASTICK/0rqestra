// Import chat: choose where the chats come from (Claude, ChatGPT, or a file from 0rqestra), pick the data export
// once, then look through the chats with a search over titles and over the words in the chats, and import the
// ones you want. Claude and ChatGPT only hand out a person's chats as a data export, so the file is the way in; the
// zip they email is opened as it is (main/chat-library.ts).
import React, { useEffect, useRef, useState } from 'react';

const errorText = (e) => String(e?.message || e || 'That did not work.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const day = (ms) => (ms ? new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '');

const SOURCES = [
  { id: 'Claude', name: 'Claude', how: ['Open claude.ai → your name → Settings → Privacy → Export data.', 'Claude emails you a link; download the zip.', 'Choose that zip here. You do not need to unpack it.'] },
  { id: 'ChatGPT', name: 'ChatGPT', how: ['Open chatgpt.com → your picture → Settings → Data controls → Export data.', 'ChatGPT emails you a link; download the zip.', 'Choose that zip here. You do not need to unpack it.'] },
];

export function ImportChats({ Icon, onClose, onImport, onFile }) {
  const api = window.orqestra?.chat?.library;
  const [source, setSource] = useState(null);
  const [lib, setLib] = useState(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const file = useRef(null);
  const token = useRef(null);
  useEffect(() => () => { if (token.current) api?.close(token.current).catch(() => {}); }, []);
  useEffect(() => {
    if (!lib) return undefined;
    if (!query.trim()) { setHits(null); return undefined; }
    let live = true;
    const t = setTimeout(() => { api.search(lib.token, query).then((r) => { if (live) setHits(r); }).catch((e) => { if (live) setError(errorText(e)); }); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [query, lib]);
  const open = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.open();
      if (!r) return;
      if (token.current) api.close(token.current).catch(() => {});
      token.current = r.token;
      setLib(r); setChosen(new Set()); setQuery(''); setHits(null);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const rows = hits || lib?.items || [];
  const toggle = (id) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const all = rows.length > 0 && rows.every((r) => chosen.has(r.id));
  const importNow = async () => {
    setBusy(true); setError(null);
    try {
      const picked = await api.pick(lib.token, [...chosen]);
      onImport(picked);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  if (!api) return <div><h2 id="dialog-title">Import chat</h2><p className="dialog-description">This works in the installed app.</p></div>;
  const mismatch = lib && source && SOURCES.some((s) => s.id === source) && lib.source !== source;
  return <div className="import-chats">
    <div className="dialog-heading"><span className="dialog-icon"><Icon name="upload" size={21}/></span><button className="icon-button" type="button" aria-label="Close import" onClick={onClose}><Icon name="close"/></button></div>
    <h2 id="dialog-title">Import chat</h2>
    {!lib && <>
      <p className="dialog-description">Bring a chat from another AI into 0rqestra and continue it here. Where is it from?</p>
      <div className="import-sources" role="radiogroup" aria-label="Where the chats come from">
        {SOURCES.map((s) => <button key={s.id} type="button" role="radio" aria-checked={source === s.id} className={source === s.id ? 'is-on' : ''} onClick={() => setSource(s.id)}><strong>{s.name}</strong><small>From your data export</small></button>)}
        <button type="button" role="radio" aria-checked={source === 'file'} className={source === 'file' ? 'is-on' : ''} onClick={() => setSource('file')}><strong>A file</strong><small>A chat saved from 0rqestra (.md)</small></button>
      </div>
      {SOURCES.filter((s) => s.id === source).map((s) => <div key={s.id} className="import-how">
        <strong>How to get your chats from {s.name}</strong>
        <ol>{s.how.map((t) => <li key={t}>{t}</li>)}</ol>
        <small>{s.name} gives out chats only as a data export. 0rqestra does not log in to {s.name} for you, so no password or token is needed.</small>
        <div className="setup-actions"><button type="button" className="button primary-button" disabled={busy} onClick={open}>{busy ? 'Reading the file…' : `Choose the ${s.name} zip`}</button></div>
      </div>)}
      {source === 'file' && <div className="import-how">
        <strong>A chat from 0rqestra</strong>
        <small>Choose a .md file made with “Export this chat”, or any Markdown with “## You” and “## Assistant” headings.</small>
        <div className="setup-actions"><button type="button" className="button primary-button" onClick={() => file.current?.click()}>Choose the file</button></div>
        <input ref={file} type="file" hidden accept=".md,.markdown,.txt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }}/>
      </div>}
    </>}
    {lib && <>
      <p className="dialog-description">{lib.items.length} {lib.items.length === 1 ? 'chat' : 'chats'} from {lib.source}. Search by name or by words in the chat, then choose the ones to import.</p>
      {mismatch && <div className="import-note" role="note">This file is from {lib.source}, not {source}. It works the same.</div>}
      <input className="github-search" type="search" placeholder="Search chats" aria-label="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus/>
      <div className="import-bar">
        <label><input type="checkbox" checked={all} onChange={() => setChosen((s) => { const n = new Set(s); for (const r of rows) { if (all) n.delete(r.id); else n.add(r.id); } return n; })}/> {query.trim() ? 'Select all found' : 'Select all'}</label>
        <small>{hits ? `${hits.length}${hits.length >= 200 ? '+' : ''} found` : `${lib.items.length} chats`}</small>
      </div>
      <ul className="import-list" aria-label="Chats">
        {rows.length === 0 && <li className="agent-muted github-empty">{hits ? 'No chat has those words.' : 'No chats.'}</li>}
        {rows.slice(0, 300).map((r) => <li key={r.id}><label className={chosen.has(r.id) ? 'is-on' : ''}>
          <input type="checkbox" checked={chosen.has(r.id)} onChange={() => toggle(r.id)} aria-label={r.title}/>
          <span className="import-row"><strong>{r.title}</strong><small>{[day(r.at), `${r.count} messages`].filter(Boolean).join(' · ')}</small><em>{r.snippet || r.preview}</em></span>
        </label></li>)}
        {rows.length > 300 && <li className="agent-muted github-empty">Showing the first 300. Search to narrow it down.</li>}
      </ul>
    </>}
    {error && <div className="setup-error" role="alert"><span>{error}</span></div>}
    <div className="dialog-footer">
      <button className="button" type="button" onClick={onClose}>Cancel</button>
      {lib && <button className="button" type="button" disabled={busy} onClick={open}>Choose another file</button>}
      {lib && <button className="button primary-button" type="button" disabled={busy || chosen.size === 0} onClick={importNow}>{chosen.size ? `Import ${chosen.size} ${chosen.size === 1 ? 'chat' : 'chats'}` : 'Choose chats to import'}</button>}
    </div>
  </div>;
}
