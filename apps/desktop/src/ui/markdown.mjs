// Markdown in the chat, like Claude's own chat: headings, lists, quotes, tables, code blocks and inline
// formatting. This turns text into plain data (blocks and inline parts); Markdown.jsx draws them with
// React. Nothing here produces HTML, so nothing a model writes can become markup or script in the app.

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => parseInline(c.trim().replace(/\\\|/g, '|')));
}

export function parseBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) });
    paragraph.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[2];
      const body = [];
      i += 1;
      // An unclosed fence (a reply still being written) runs to the end.
      while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(marker.length)) && lines[i].trim().replace(/[`~]/g, '') === '')) body.push(lines[i++]);
      const closed = i < lines.length;
      if (closed) i += 1;
      blocks.push({ type: 'code', lang: fence[3] || '', text: body.join('\n'), closed });
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      flush();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i += 1;
      blocks.push({ type: 'math', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); i += 1; continue; }
    const heading = HEADING.exec(line);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) }); i += 1; continue; }
    if (RULE.test(line) && !paragraph.length) { blocks.push({ type: 'rule' }); i += 1; continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      blocks.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = Boolean(ordered && !bullet);
      const indent = (bullet || ordered)[1].length;
      const items = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = ORDERED.exec(lines[i]);
        const m = isOrdered ? o : b;
        if (m && m[1].length <= indent + 1) {
          items.push({ lines: [isOrdered ? m[3] : m[2]], start: isOrdered ? Number(m[2]) : null });
          i += 1;
          continue;
        }
        // Indented lines (nested lists, continued text) belong to the item above.
        if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) { items[items.length - 1].lines.push(lines[i].replace(/^\s{2,4}/, '')); i += 1; continue; }
        if (items.length && !lines[i].trim() && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) { items[items.length - 1].lines.push(''); i += 1; continue; }
        break;
      }
      blocks.push({ type: 'list', ordered: isOrdered, start: items[0]?.start ?? 1, items: items.map((it) => parseBlocks(it.lines.join('\n'))) });
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flush();
  return blocks;
}

// Inline parts: text, **bold**, *italic*, ~~struck~~, `code`, $math$ and [links](url).
export function parseInline(text) {
  const out = [];
  const s = String(text ?? '');
  let buf = '';
  const push = (part) => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } out.push(part); };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if (s[i] === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|~$>]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if ((m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) { push({ t: 'code', v: m[2].replace(/^ (.*) $/, '$1') }); i += m[0].length; continue; }
    if ((m = /^\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/.exec(rest))) { push({ t: 'math', v: m[1] }); i += m[0].length; continue; }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) { push({ t: 'bold', c: parseInline(m[2]) }); i += m[0].length; continue; }
    if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { push({ t: 'strike', c: parseInline(m[1]) }); i += m[0].length; continue; }
    if ((m = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![*_\w])/.exec(rest)) && (s[i] === '*' || !/\w/.test(s[i - 1] ?? ''))) { push({ t: 'italic', c: parseInline(m[2]) }); i += m[0].length; continue; }
    if ((m = /^\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/.exec(rest))) { push({ t: 'link', c: parseInline(m[1]), href: m[2] }); i += m[0].length; continue; }
    if ((m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)) && !/\w/.test(s[i - 1] ?? '')) { push({ t: 'link', c: [{ t: 'text', v: m[0] }], href: m[0] }); i += m[0].length; continue; }
    buf += s[i];
    i += 1;
  }
  if (buf) out.push({ t: 'text', v: buf });
  return out;
}

// Only web addresses are opened, and only in the user's own browser (main process decides).
export function safeLink(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
