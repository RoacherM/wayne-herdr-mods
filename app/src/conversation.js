/**
 * A coding agent's conversation, read from its transcript on the Mac (host/transcripts.js) and
 * scrolled natively on the phone: no wheel steps, no redraws to wait for.
 *
 *   - opens on the newest page and follows new items while you are at the bottom;
 *   - reading further up holds your place; near the top, the page before loads above it (the
 *     text you read does not move);
 *   - a tool's output comes as its own item later on: it fills that tool's card.
 *
 *   - while the agent works or asks, the bottom of its screen shows under the list (`live`): the
 *     transcript only has what is finished, the screen has the reply being written and the spinner.
 *
 * Items: { k: 'user' | 'assistant' | 'tool' | 'result' | 'note', seq, … } (see transcripts.js).
 */
import { Marked } from 'marked';

const OLDER_PX = 800;  // this close to the top: load the page before
const STICK_PX = 40;   // this close to the bottom: follow new items

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The agent's Markdown, never its HTML: a transcript is text, and this page holds the pairing keys.
const md = new Marked({
  gfm: true, breaks: true,
  renderer: {
    html: (token) => escapeHtml(token.raw ?? token.text ?? ''),
    link(token) { const href = /^(https?:|mailto:)/i.test(token.href) ? token.href : '#'; return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${this.parser.parseInline(token.tokens)}</a>`; },
    image: (token) => `<span class="md-img">[图片 ${escapeHtml(token.text || '')}]</span>`,
  },
});
const markdown = (text) => { try { return md.parse(text ?? '', { async: false }); } catch { return escapeHtml(text); } };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class ConversationView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.el  the scrolling element
   * @param {(m: string, p: object) => Promise<any>} o.rpc
   * @param {string} o.address
   */
  constructor({ el: root, rpc, address }) {
    Object.assign(this, { root, rpc, address });
    this.c = null;
    this.first = 0;        // byte offset of the oldest line loaded (the next page ends there)
    this.hasMore = false;
    this.loading = false;
    this.tools = new Map(); // tool id → card
    this.results = new Map(); // tool id → result that came before its card was loaded
    this.pending = [];      // what was just sent, until the transcript has it
    this.root.replaceChildren();
    this.top = el('div', 'conv-top');
    this.list = el('div', 'conv-list');
    this.tail = el('div', 'conv-tail');
    this.liveEl = el('pre', 'conv-live');
    this.liveEl.hidden = true;
    this.live = '';
    this.busy = false;
    this.root.append(this.top, this.list, this.liveEl, this.tail);
    this.onScroll = () => { if (this.root.scrollTop < OLDER_PX) this.older(); };
    this.root.addEventListener('scroll', this.onScroll, { passive: true });
  }

  /** Open (or open again after a reconnect). Throws when the agent has no transcript. */
  async open() {
    const r = await this.rpc('conv.open', { address: this.address });
    if (this.closed) { this.rpc('conv.close', { c: r.c }).catch(() => {}); return; }
    this.c = r.c;
    this.kind = r.kind;
    this.reset(r);
  }

  reset({ items, first, hasMore }) {
    this.list.replaceChildren();
    this.tools.clear();
    this.results.clear();
    this.first = first ?? 0;
    this.hasMore = hasMore;
    this.add(items, 'end');
    this.showTop();
    this.bottom();
    // A short first page leaves no room to scroll: fill the screen from older pages.
    requestAnimationFrame(() => this.onScroll());
  }

  /** A `conv` event: new items at the end, or a new session from the start. */
  onEvent(msg) {
    if (msg.c !== this.c) return;
    if (msg.reset) { this.reset(msg); return; }
    const stick = this.atBottom();
    this.add(msg.items, 'end');
    if (msg.live !== undefined) { this.live = msg.live; this.showLive(); }
    if (stick) this.bottom();
  }

  async older() {
    if (!this.hasMore || this.loading || this.c === null) return;
    this.loading = true;
    this.showTop();
    try {
      const r = await this.rpc('conv.older', { c: this.c, before: this.first });
      const before = this.root.scrollHeight, top = this.root.scrollTop;
      this.first = r.first ?? 0;
      this.hasMore = r.hasMore;
      this.add(r.items, 'start');
      // Keep what is on screen where it was: the page went in above it.
      this.root.scrollTop = top + (this.root.scrollHeight - before);
    } catch {
      this.hasMore = false; // closed, or the session changed: a reset comes with the next event
    } finally {
      this.loading = false;
      this.showTop();
    }
    if (this.root.scrollTop < OLDER_PX) requestAnimationFrame(() => this.onScroll());
  }

  /** What was just sent: shown at once, until the transcript has it. */
  sent(text) {
    const node = this.userNode({ text, images: 0 });
    node.classList.add('pending');
    this.list.append(node);
    this.pending.push({ text: text.trim(), node, at: Date.now() });
    this.bottom();
  }

  /** The agent's state from the terminal list: a line at the bottom while it works or asks. */
  state(t) {
    const blocked = t?.state === 'blocked';
    const working = t?.state === 'working';
    const stick = this.atBottom();
    this.busy = blocked || working;
    this.showLive();
    this.tail.className = `conv-tail ${blocked ? 'ask' : working ? 'busy' : ''}`;
    this.tail.textContent = blocked ? (t.msg || '终端在问你') : working ? (t.msg || '工作中…') : '';
    if (stick) this.bottom();
  }

  /** The screen's bottom, only while the agent works or asks (idle, it repeats the last reply). */
  showLive() {
    this.liveEl.hidden = !(this.busy && this.live);
    if (this.liveEl.textContent !== this.live) this.liveEl.textContent = this.live;
  }

  close() {
    this.closed = true;
    this.root.removeEventListener('scroll', this.onScroll);
    if (this.c !== null) this.rpc('conv.close', { c: this.c }).catch(() => {});
    this.c = null;
  }

  // ---- inside

  atBottom() { return this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight <= STICK_PX; }
  bottom() { this.root.scrollTop = this.root.scrollHeight; }

  showTop() {
    this.top.textContent = this.loading ? '加载更早的消息…' : this.hasMore ? '' : (this.list.childElementCount ? '已经是最早的消息' : '还没有消息');
  }

  add(items, where) {
    const frag = document.createDocumentFragment();
    const later = []; // results whose card is in this batch
    for (const item of items ?? []) {
      if (item.k === 'result') { later.push(item); continue; }
      const node = this.node(item);
      if (node) frag.append(node);
    }
    if (where === 'start') this.list.prepend(frag); else this.list.append(frag);
    for (const r of later) this.result(r);
    // Results that came before their card (a page loaded later holds the card).
    for (const [id, r] of this.results) if (this.tools.has(id)) { this.results.delete(id); this.result(r); }
  }

  node(item) {
    switch (item.k) {
      case 'user': {
        // The transcript has what was just sent: the stand-in goes.
        const i = this.pending.findIndex((p) => p.text === item.text.trim() || Date.now() - p.at > 15_000);
        if (i >= 0) { for (const p of this.pending.splice(0, i + 1)) p.node.remove(); }
        return this.userNode(item);
      }
      case 'assistant': {
        const n = el('div', 'msg assistant md');
        n.innerHTML = markdown(item.text);
        return n;
      }
      case 'tool': {
        const card = el('details', 'tool');
        const sum = el('summary');
        sum.append(el('span', 'tool-verb', item.name), el('span', 'tool-sum', item.sum || ''));
        card.append(sum);
        if (item.id) this.tools.set(item.id, card);
        return card;
      }
      case 'note': return el('div', 'msg note', item.text);
      default: return null;
    }
  }

  userNode(item) {
    const n = el('div', 'msg user');
    const bubble = el('div', 'bubble', item.text || '');
    if (item.images) bubble.append(el('span', 'muted', `${item.text ? ' ' : ''}[${item.images} 张图片]`));
    n.append(bubble);
    return n;
  }

  result(r) {
    const card = this.tools.get(r.id);
    if (!card) { this.results.set(r.id, r); if (this.results.size > 500) this.results.delete(this.results.keys().next().value); return; }
    card.classList.toggle('err', r.error);
    card.querySelector('.tool-out')?.remove();
    if (r.out) card.append(el('pre', 'tool-out', r.out));
  }
}
