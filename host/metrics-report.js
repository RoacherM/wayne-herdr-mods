/**
 * The report page for the experience records: one self-contained HTML file (no network), made
 * from summarize() in metrics.js. `wayne-herdr-mods metrics` writes it for the real phones;
 * dev/bench.mjs writes one for the simulated runs.
 *
 * Colors: direct is series 1 (blue), relay series 2 (orange), checked with the dataviz validator
 * on both surfaces. Every line also carries a text label, so color is never the only cue.
 */

const CSS = `
:root { color-scheme: light dark;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,.10); --direct: #2a78d6; --relay: #eb6834; --bar: #2a78d6; }
@media (prefers-color-scheme: dark) { :root {
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,.10); --direct: #3987e5; --relay: #d95926; --bar: #3987e5; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 32px 0 10px; }
.sub { color: var(--ink2); margin: 0; } .muted { color: var(--muted); }
.bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 16px 0 0; }
select { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--ring); background: var(--surface); color: var(--ink); }
.legend { display: flex; gap: 14px; color: var(--ink2); }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin-top: 16px; }
.tile, .card { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 12px 14px; }
.tile .k { color: var(--ink2); font-size: 12px; } .tile .v { font-size: 24px; font-weight: 600; margin: 2px 0; font-variant-numeric: tabular-nums; }
.tile .row { display: flex; justify-content: space-between; color: var(--ink2); font-size: 12px; font-variant-numeric: tabular-nums; }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 10px; }
.card h3 { font-size: 13px; margin: 0; } .card p { margin: 2px 0 6px; color: var(--muted); font-size: 12px; }
.plot { position: relative; } svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { fill: var(--muted); font-size: 11px; } svg .lab { fill: var(--ink2); font-size: 11px; }
.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--ring); border-radius: 8px;
  padding: 6px 8px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.12); white-space: nowrap; display: none; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; overflow: hidden; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); font-size: 12.5px; }
th { color: var(--ink2); font-weight: 500; } td.n { text-align: right; } th.n { text-align: right; }
.keys { display: grid; grid-template-columns: max-content 1fr max-content; gap: 4px 10px; align-items: center; }
.keys .b { height: 10px; background: var(--bar); border-radius: 0 4px 4px 0; min-width: 2px; }
.scroll { max-height: 420px; overflow: auto; border-radius: 10px; }
@media (max-width: 640px) { .d { display: none; } }
.empty { color: var(--muted); padding: 24px; text-align: center; }
`;

// Runs in the page. DATA = { title, generated, groups, measures, note }.
const SCRIPT = String.raw`
const $ = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k === 'class' ? e.className = v : e.setAttribute(k, v); for (const k of kids) e.append(k); return e; };
const NS = 'http://www.w3.org/2000/svg';
const S = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const VIA = [['direct', '直连'], ['relay', '中继']];
const fmt = (v) => v === null || v === undefined ? '—' : v >= 10000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms';
const pct = (v) => v === null || v === undefined ? '—' : (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
const label = Object.fromEntries(DATA.measures.map(([k, l, d, u]) => [k, { l, d, u: u ?? 'ms' }]));
const fmtK = (key, v) => label[key].u === 'ms' ? fmt(v) : v === null || v === undefined ? '—' : Math.round(v) + ' ' + label[key].u;
const OPS = { open: '打开终端', back: '返回', paste: '粘贴', voice: '语音', image: '图片' };
const opName = (n) => n.startsWith('key:') ? '键 ' + (n.slice(4) === '?' ? '（其他）' : n.slice(4)) : OPS[n] ?? n;
const srcName = (s) => s === 'phone' ? '真实手机' : s.startsWith('sim:') ? '模拟：' + s.slice(4) : s;

document.getElementById('title').textContent = DATA.title;
const names = Object.keys(DATA.groups).sort((a, b) => (a === 'phone' ? -1 : b === 'phone' ? 1 : a.localeCompare(b)));
const pick = document.getElementById('pick');
for (const n of names) pick.append($('option', { value: n }, srcName(n) + '（' + DATA.groups[n].n + ' 条）'));
pick.hidden = names.length < 2;
pick.onchange = () => show(pick.value);
if (names.length) show(names[0]); else document.getElementById('body').append($('div', { class: 'empty' }, '还没有记录。在手机上用一会儿，再运行这个命令。'));

function show(name) {
  const g = DATA.groups[name];
  const body = document.getElementById('body');
  body.replaceChildren();
  const span = new Date(g.from).toLocaleString() + ' – ' + new Date(g.to).toLocaleString();
  document.getElementById('sub').textContent = srcName(name) + ' · ' + span + (g.device ? ' · ' + g.device : '') + (g.ver ? ' · 版本 ' + g.ver : '') + ' · 生成于 ' + new Date(DATA.generated).toLocaleString();

  // ---- headline tiles: the median for each path, with the slow tail under it
  const tiles = $('div', { class: 'tiles' });
  for (const key of ['echo.paint', 'scroll.lag', 'open.ms', 'resume.paint', 'rtt.ms']) {
    const m = g.measures[key].all;
    const main = m.direct.n ? m.direct : m.relay;
    const t = $('div', { class: 'tile' }, $('div', { class: 'k' }, label[key].l), $('div', { class: 'v' }, fmt(main.p50)));
    for (const [via, vl] of VIA) t.append($('div', { class: 'row' }, $('span', {}, $('span', { class: 'sw', style: 'background:var(--' + via + ')' }), vl), $('span', {}, m[via].n ? m[via].p50 + ' / ' + fmt(m[via].p95) + ' · ' + m[via].n + ' 次' : '没有')));
    tiles.append(t);
  }
  const drops = g.drops.reduce((s, d) => s + d.n, 0);
  tiles.append($('div', { class: 'tile' }, $('div', { class: 'k' }, '直连占比 / 掉线'), $('div', { class: 'v' }, pct(g.direct)), $('div', { class: 'row' }, $('span', {}, '连接中断'), $('span', {}, drops + ' 次')), $('div', { class: 'row' }, $('span', {}, '滑动慢帧占比'), $('span', {}, pct(g.longShare)))));
  body.append(tiles, $('p', { class: 'sub muted', style: 'margin-top:6px;font-size:12px' }, '大数字是中位数（p50）。每行是这条路径的 p50 / p95 和次数。'));

  // ---- daily trend, one chart per measure (one axis each)
  body.append($('h2', {}, '每天的中位数'), $('div', { class: 'legend' }, ...VIA.map(([v, l]) => $('span', {}, $('span', { class: 'sw', style: 'background:var(--' + v + ')' }), l)), $('span', { class: 'muted' }, '悬停看慢的 5%（p95）和次数')));
  const charts = $('div', { class: 'charts' });
  for (const key of ['echo.paint', 'scroll.lag', 'open.ms', 'resume.paint', 'macscroll.behind', 'scroll.p95']) charts.append(chart(key, g.measures[key].daily));
  body.append(charts);

  // ---- table view of every measure
  body.append($('h2', {}, '全部数字'));
  const tb = $('table', {}, $('tr', {}, $('th', {}, '测量'), $('th', {}, '路径'), $('th', { class: 'n' }, '次数'), $('th', { class: 'n' }, '中位数 p50'), $('th', { class: 'n' }, '慢的 5% p95'), $('th', { class: 'd' }, '说明')));
  for (const [key, l, d] of DATA.measures) for (const [via, vl] of VIA) {
    const s = g.measures[key].all[via];
    if (!s.n) continue;
    tb.append($('tr', {}, $('td', {}, l), $('td', {}, vl), $('td', { class: 'n' }, String(s.n)), $('td', { class: 'n' }, fmtK(key, s.p50)), $('td', { class: 'n' }, fmtK(key, s.p95)), $('td', { class: 'muted d' }, d)));
  }
  body.append(tb);

  if (names.length > 1) {
    body.append($('h2', {}, '各来源对比（中位数 / p95）'));
    const ct = $('table', {}, $('tr', {}, $('th', {}, '测量'), ...names.map((n) => $('th', { class: 'n' }, srcName(n)))));
    for (const [key, l] of DATA.measures) {
      const cells = names.map((n) => { const a = DATA.groups[n].measures[key].all; const s = a.direct.n ? a.direct : a.relay; return $('td', { class: 'n' }, s.n ? fmtK(key, s.p50) + ' / ' + fmtK(key, s.p95) : '—'); });
      ct.append($('tr', {}, $('td', {}, l), ...cells));
    }
    body.append(ct);
  }

  // ---- what the person used
  const ops = Object.entries(g.keys).sort((a, b) => b[1] - a[1]);
  if (ops.length) {
    body.append($('h2', {}, '用了什么（按键栏、粘贴、语音、图片、打开）'));
    const max = ops[0][1];
    const k = $('div', { class: 'keys card' });
    for (const [name, n] of ops.slice(0, 24)) k.append($('span', {}, opName(name)), $('div', { class: 'b', style: 'width:' + (n / max * 100) + '%' }), $('span', { class: 'muted' }, String(n)));
    body.append(k);
  }

  // ---- the latest events
  body.append($('h2', {}, '最近的记录'));
  const rt = $('table', {}, $('tr', {}, $('th', {}, '时间'), $('th', {}, '事件'), $('th', {}, '路径'), $('th', {}, '数值')));
  for (const r of g.recent) {
    const vals = Object.entries(r).filter(([k]) => !['t', 'ev', 'via', 'dev', 'src', 'ver', 'os', 'browser', 'standalone', 'w', 'h'].includes(k)).map(([k, v]) => k + '=' + v).join('  ');
    rt.append($('tr', {}, $('td', {}, new Date(r.t).toLocaleTimeString()), $('td', {}, r.ev), $('td', {}, r.via === 'direct' ? '直连' : r.via === 'relay' ? '中继' : ''), $('td', { class: 'muted' }, vals)));
  }
  body.append($('div', { class: 'scroll' }, rt));
}

function chart(key, daily) {
  const W = 320, H = 150, L = 40, R = 40, T = 10, B = 22;
  const days = daily.direct.map((d) => d.day);
  const card = $('div', { class: 'card' }, $('h3', {}, label[key].l), $('p', {}, label[key].d));
  const vals = VIA.flatMap(([v]) => daily[v].map((d) => d.p50)).filter((x) => x !== null);
  if (!vals.length) { card.append($('div', { class: 'empty' }, '没有数据')); return card; }
  const max = niceMax(Math.max(...vals));
  const x = (i) => days.length === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (days.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = S('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': label[key].l });
  for (const f of Number.isInteger(max / 2) ? [0, 0.5, 1] : [0, 1]) {
    svg.append(S('line', { x1: L, x2: W - R, y1: y(max * f), y2: y(max * f), stroke: f ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }));
    const t = S('text', { x: L - 6, y: y(max * f) + 4, 'text-anchor': 'end' }); t.textContent = fmtK(key, max * f); svg.append(t);
  }
  for (const i of days.length > 1 ? [0, days.length - 1] : [0]) { const t = S('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }); t.textContent = days[i].slice(5); svg.append(t); }
  const ends = [];
  for (const [via, vl] of VIA) {
    const pts = daily[via].map((d, i) => d.p50 === null ? null : [x(i), y(d.p50)]);
    let path = '', pen = false;
    for (const p of pts) { if (!p) { pen = false; continue; } path += (pen ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); pen = true; }
    if (path) svg.append(S('path', { d: path, fill: 'none', stroke: 'var(--' + via + ')', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (const p of pts) if (p && (days.length < 12)) svg.append(S('circle', { cx: p[0], cy: p[1], r: 4, fill: 'var(--' + via + ')', stroke: 'var(--surface)', 'stroke-width': 2 }));
    const last = pts.map((p, i) => [p, i]).filter(([p]) => p).pop();
    if (last) ends.push({ y: last[0][1], x: last[0][0], vl });
  }
  // Direct labels at the line ends, pushed apart when they would touch.
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  for (const e of ends) { const t = S('text', { x: e.x + 7, y: e.y + 4, class: 'lab' }); t.textContent = e.vl; svg.append(t); }
  // Crosshair and tooltip.
  const cross = S('line', { y1: T, y2: H - B, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  const hit = S('rect', { x: L - 10, y: 0, width: W - L - R + 20, height: H, fill: 'transparent' });
  svg.append(hit);
  const tip = $('div', { class: 'tip' });
  const plot = $('div', { class: 'plot' }, svg, tip);
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = (ev.clientX - box.left) * W / box.width;
    let i = 0; for (let j = 0; j < days.length; j++) if (Math.abs(x(j) - px) < Math.abs(x(i) - px)) i = j;
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    tip.replaceChildren($('div', {}, days[i]), ...VIA.map(([v, vl]) => { const d = daily[v][i]; return $('div', {}, $('span', { class: 'sw', style: 'background:var(--' + v + ')' }), vl + '  ' + (d.n ? fmtK(key, d.p50) + ' · p95 ' + fmtK(key, d.p95) + ' · ' + d.n + ' 次' : '没有')); }));
    tip.style.display = 'block';
    const left = x(i) / W * box.width;
    tip.style.left = Math.min(left + 10, box.width - tip.offsetWidth) + 'px';
    tip.style.top = '0px';
  });
  hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
  card.append(plot);
  return card;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
`;

/** summary (from summarize) → the HTML page. */
export function renderReport(summary, { title = '手机体验记录', generated = Date.now() } = {}) {
  const data = JSON.stringify({ title, generated, ...summary }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<&]/g, '')}</title><style>${CSS}</style></head>
<body><main>
<h1 id="title"></h1><p class="sub" id="sub"></p>
<div class="bar"><select id="pick" aria-label="来源"></select></div>
<div id="body"></div>
</main><script>const DATA = ${data};${SCRIPT}</script></body></html>
`;
}
