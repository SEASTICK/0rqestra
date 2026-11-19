// "Select" in the preview: a small script the preview adds to each page it serves. It does nothing until
// the app's window asks for it; then hovering outlines an element and a click tells the window which
// element it was (tag, a short CSS path, its text and the start of its HTML). It cannot reach the app:
// the page is on another origin, and it only posts a message to the window around it.

export const PICKER_PATH = "__orqestra/picker.js";

export const PICKER_SCRIPT = `(() => {
  if (window.parent === window || window.__orqestraPicker) return;
  window.__orqestraPicker = true;
  let on = false;
  const box = document.createElement('div');
  box.setAttribute('data-orqestra-picker', '');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2f6bff;background:rgba(47,107,255,.10);border-radius:4px;display:none;box-sizing:border-box';
  const mount = () => { if (!box.isConnected && document.body) document.body.appendChild(box); };
  const part = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    const cls = [...el.classList].slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return s;
  };
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      parts.unshift(part(n));
      if (n.id || n.tagName === 'BODY') break;
    }
    return parts.join(' > ');
  };
  const show = (el) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== 'orqestra-pick') return;
    on = Boolean(e.data.on);
    mount();
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) box.style.display = 'none';
  });
  document.addEventListener('mouseover', (e) => { if (on && e.target instanceof Element && e.target !== box) show(e.target); }, true);
  document.addEventListener('click', (e) => {
    if (!on || !(e.target instanceof Element)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    show(el);
    window.parent.postMessage({
      type: 'orqestra-picked',
      tag: el.tagName.toLowerCase(),
      path: path(el),
      text: (el.innerText || el.textContent || '').trim().slice(0, 200),
      html: el.outerHTML.slice(0, 600),
    }, '*');
  }, true);
})();
`;

// Adds the script to an HTML page, at the end of the body (or of the page).
export function withPicker(html: string): string {
  const tag = `<script src="/${PICKER_PATH}"></script>`;
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at >= 0 ? `${html.slice(0, at)}${tag}${html.slice(at)}` : `${html}${tag}`;
}
