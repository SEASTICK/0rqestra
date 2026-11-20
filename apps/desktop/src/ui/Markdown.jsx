// Draws chat Markdown (markdown.mjs) as React elements, like Claude's chat: readable text, real lists and
// tables, and code in its own block with a Copy button. Text is only ever text here: no HTML is parsed.
import React, { useState } from 'react';
import { parseBlocks, safeLink } from './markdown.mjs';

function Inline({ parts }) {
  return parts.map((p, i) => {
    switch (p.t) {
      case 'bold': return <strong key={i}><Inline parts={p.c} /></strong>;
      case 'italic': return <em key={i}><Inline parts={p.c} /></em>;
      case 'strike': return <del key={i}><Inline parts={p.c} /></del>;
      case 'code': return <code key={i} className="md-inline-code">{p.v}</code>;
      case 'math': return <span key={i} className="md-math">{p.v}</span>;
      case 'link': {
        const href = safeLink(p.href);
        return href
          ? <a key={i} href={href} className="md-link" title={href} onClick={(e) => { e.preventDefault(); window.orqestra?.chat?.openLink?.(href); }}><Inline parts={p.c} /></a>
          : <span key={i}><Inline parts={p.c} /></span>;
      }
      default: return <React.Fragment key={i}>{p.v}</React.Fragment>;
    }
  });
}

function CodeBlock({ lang, text, closed }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const api = window.orqestra?.chat?.copy;
    if (api) api(text).then(done).catch(() => {});
    else navigator.clipboard?.writeText(text).then(done).catch(() => {});
  };
  return <div className="md-code">
    <div className="md-code-head"><span>{lang || 'code'}</span>{closed !== false && <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}</div>
    <pre><code>{text}</code></pre>
  </div>;
}

function Blocks({ blocks }) {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'heading': { const Tag = `h${Math.min(b.level + 1, 6)}`; return <Tag key={i} className={`md-h md-h${b.level}`}><Inline parts={b.inline} /></Tag>; }
      case 'paragraph': return <p key={i}><Inline parts={b.inline} /></p>;
      case 'code': return <CodeBlock key={i} {...b} />;
      case 'math': return <div key={i} className="md-math-block">{b.text}</div>;
      case 'rule': return <hr key={i} />;
      case 'quote': return <blockquote key={i}><Blocks blocks={b.blocks} /></blockquote>;
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        return <Tag key={i} start={b.ordered && b.start !== 1 ? b.start : undefined}>{b.items.map((item, j) => <li key={j}><Blocks blocks={item} /></li>)}</Tag>;
      }
      case 'table': return <div key={i} className="md-table-wrap"><table>
        <thead><tr>{b.head.map((c, j) => <th key={j}><Inline parts={c} /></th>)}</tr></thead>
        <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline parts={c} /></td>)}</tr>)}</tbody>
      </table></div>;
      default: return null;
    }
  });
}

export function Markdown({ text }) {
  return <div className="md"><Blocks blocks={parseBlocks(text)} /></div>;
}
