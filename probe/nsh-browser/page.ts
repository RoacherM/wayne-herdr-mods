// The probe's two pieces of page script.
// HELPER goes into every page before its own scripts (injectedJavaScriptBeforeContentLoaded): it runs
// a script the app sends and posts the result back, as dsh's client half does with executeJavaScript.
// PAGE is a local test page that records what each kind of scripted input looks like to a page.
export const HELPER = `(() => {
  if (window.__nshRun) return;
  window.__nshRun = ({ id, script }) => {
    Promise.resolve().then(() => (0, eval)(script)).then(
      (value) => window.nsh.postMessage(JSON.stringify({ id, ok: true, value })),
      (err) => window.nsh.postMessage(JSON.stringify({ id, ok: false, error: String(err) })));
  };
  window.addEventListener('message', (e) => { try { window.__nshRun(JSON.parse(e.data)); } catch {} });
  const ready = () => window.nsh.postMessage(JSON.stringify({ ready: location.href }));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();`;

export const PAGE = `<!doctype html><meta name="viewport" content="width=device-width">
<button id="b">Click me</button>
<input id="i" placeholder="type here">
<div id="ce" contenteditable="true" style="border:1px solid #888;min-height:2em"></div>
<script>
  const log = [];
  const rec = (kind) => (e) => log.push({ kind, type: e.type, trusted: e.isTrusted, value: e.target.value ?? e.target.textContent });
  const b = document.getElementById('b'), i = document.getElementById('i'), ce = document.getElementById('ce');
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) b.addEventListener(t, rec('button'));
  for (const t of ['keydown', 'beforeinput', 'input', 'change']) i.addEventListener(t, rec('input'));
  for (const t of ['beforeinput', 'input']) ce.addEventListener(t, rec('editable'));
  window.__log = log;
</script>`;

// What the app asks the pages: each a script whose last value comes back.
export const ASK = {
  clickMethod: `window.__log.length = 0; document.getElementById('b').click(); window.__log.splice(0)`,
  clickEvents: `const el = document.getElementById('b'), r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o)); window.__log.splice(0)`,
  typeSetter: `const el = document.getElementById('i'); el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'setter');
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); window.__log.splice(0)`,
  typeExec: `const el = document.getElementById('i'); el.value = ''; el.focus(); const done = document.execCommand('insertText', false, 'exec'); ({ done, log: window.__log.splice(0) })`,
  editableExec: `const el = document.getElementById('ce'); el.focus(); const done = document.execCommand('insertText', false, '富文本 exec'); ({ done, log: window.__log.splice(0) })`,
  big: `'x'.repeat(200000)`,
  snapshot: `(() => { const t0 = performance.now();
    const els = [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick],[contenteditable=true]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const lines = els.map((e, n) => '[' + n + ']<' + e.tagName.toLowerCase() + '>' + String(e.getAttribute('aria-label') || e.innerText || e.value || '').trim().slice(0, 40));
    const text = document.body.innerText;
    return { url: location.href, title: document.title, interactive: els.length, textChars: text.length, chars: lines.join('\\n').length + text.length, ms: Math.round(performance.now() - t0) }; })()`,
  wikiSearch: `const el = document.querySelector('#searchInput'); el.focus(); const done = document.execCommand('insertText', false, 'WebKit');
    ({ done, value: el.value, button: !!document.querySelector('button[type=submit]') })`,
  wikiSubmit: `document.querySelector('button[type=submit]').click(); 'clicked'`,
};
