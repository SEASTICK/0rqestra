// What the Manager remembers about a project (live-chat.mjs addMemory): facts and decisions it saved with
// <orqestra-remember>, which the user can read, remove or add to. They go with every message.
import React, { useState } from 'react';
import { MAX_MEMORY } from './live-chat.mjs';

export function MemoryDialog({ memory, onChange, onClose, Icon }) {
  const [text, setText] = useState('');
  const add = () => {
    const fact = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!fact) return;
    if (!memory.some((m) => m.text.toLowerCase() === fact.toLowerCase())) onChange([...memory, { id: `m${Date.now().toString(36)}`, text: fact, at: Date.now() }].slice(-MAX_MEMORY));
    setText('');
  };
  return <div className="memory-dialog">
    <div className="dialog-heading"><span className="dialog-icon"><Icon name="spark" size={20} /></span><button className="icon-button" type="button" aria-label="Close memory" onClick={onClose}><Icon name="close" /></button></div>
    <h2 id="dialog-title">Project memory</h2>
    <p className="dialog-description">What the Manager remembers about this project. It is sent with every message, so the Manager keeps to it. The Manager adds facts when you tell it something that should last; you can add and remove them here.</p>
    {memory.length === 0
      ? <p className="memory-empty">Nothing yet. Tell the Manager a decision or a preference (“the app should be in Swedish”), or add one below.</p>
      : <ul className="memory-list">{memory.map((m) => <li key={m.id}><span>{m.text}</span><button type="button" aria-label={`Forget: ${m.text}`} title="Forget this" onClick={() => onChange(memory.filter((x) => x.id !== m.id))}>×</button></li>)}</ul>}
    <form className="memory-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <input type="text" maxLength={300} aria-label="Something to remember" placeholder="Something the Manager should remember…" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="shell-button primary" disabled={!text.trim() || memory.length >= MAX_MEMORY}>Add</button>
    </form>
    <small className="memory-count">{memory.length} of {MAX_MEMORY}</small>
  </div>;
}
