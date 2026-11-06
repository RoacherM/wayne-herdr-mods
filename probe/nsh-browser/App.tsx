// probe/nsh-browser: can an nsh app be the browser agents drive (DESIGN.md「内置浏览器：nsh 探针」)?
// The app stands in for the host bridge: it asks two web views (a local test page, then Wikipedia)
// to run scripts, two ways (ref.postMessage → page listener; ref.injectJavaScript), and times it.
// Run: nsh test App.test.tsx --target macos (a real WKWebView window; network on).
import { mount, signal, Text, View, WebView, type WebViewRef } from "nsh";
import { ASK, HELPER, PAGE } from "./page";

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void };

function channel() {
  const waiting = new Map<number, Waiter>(), ready: string[] = [];
  let next = 1, web!: WebViewRef;
  return {
    ref: (r: WebViewRef) => { web = r; },
    ready,
    onMessage(data: string) {
      const m = JSON.parse(data);
      if (m.ready) { ready.push(m.ready); return; }
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.ok) w.resolve(m.value); else w.reject(new Error(m.error));
    },
    ask(script: string, how: "post" | "inject" = "post", ms = 10000): Promise<any> {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout ${how}`)); }, ms);
        waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        const msg = JSON.stringify({ id, script });
        if (how === "post") web.postMessage(msg); else web.injectJavaScript(`window.__nshRun(${msg})`);
      });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms: number, what: string) {
  const end = performance.now() + ms;
  while (!ok()) { if (performance.now() > end) throw new Error(`waited ${ms} ms for ${what}`); await sleep(50); }
}
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const q = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); return { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1) }; };

async function rtt(c: ReturnType<typeof channel>, how: "post" | "inject", n = 50) {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await c.ask("1", how); xs.push(performance.now() - t); }
  return stats(xs);
}

async function attempt<T>(f: () => Promise<T>) { try { return await f(); } catch (e) { return { error: String((e as Error).message ?? e) }; } }

function App() {
  const status = signal("starting"), result = signal("");
  const local = channel(), wiki = channel();
  const urls: string[] = [];
  setTimeout(async () => {
    const out: Record<string, unknown> = {};
    out.localReady = await attempt(() => until(() => local.ready.length > 0, 15000, "local page"));
    status.set("local rtt");
    out.rttPost = await attempt(() => rtt(local, "post"));
    out.rttInject = await attempt(() => rtt(local, "inject"));
    for (const k of ["clickMethod", "clickEvents", "typeSetter", "typeExec", "editableExec"] as const) out[k] = await attempt(() => local.ask(ASK[k]));
    out.big = await attempt(async () => { const t = performance.now(); const v = await local.ask(ASK.big); return { chars: v.length, ms: Math.round(performance.now() - t) }; });
    status.set("wikipedia");
    out.wikiReady = await attempt(() => until(() => wiki.ready.length > 0, 30000, "wikipedia"));
    out.wikiSnapshot = await attempt(async () => { const t = performance.now(); const v = await wiki.ask(ASK.snapshot, "inject"); return { ...v, roundTripMs: Math.round(performance.now() - t) }; });
    out.wikiType = await attempt(() => wiki.ask(ASK.wikiSearch, "inject"));
    const before = wiki.ready.length;
    out.wikiSubmit = await attempt(() => wiki.ask(ASK.wikiSubmit, "inject"));
    out.wikiAfter = await attempt(async () => { await until(() => wiki.ready.length > before, 20000, "the search result page"); return { url: wiki.ready.at(-1), snapshot: await wiki.ask(ASK.snapshot, "inject") }; });
    out.navigations = urls;
    result.set("RESULT " + JSON.stringify(out));
    status.set("done");
  }, 0);
  return (
    <View style={{ flex: 1, gap: 6, padding: 8 }}>
      <Text testID="status">{status()}</Text>
      <WebView ref={local.ref} html={PAGE} injectedJavaScriptBeforeContentLoaded={HELPER} style={{ height: 160 }} onMessage={(e) => local.onMessage(e.data)} />
      <WebView ref={wiki.ref} src="https://www.wikipedia.org/" injectedJavaScriptBeforeContentLoaded={HELPER} style={{ flex: 1 }}
        onMessage={(e) => wiki.onMessage(e.data)} onNavigationStateChange={(n) => { if (!n.loading && urls.at(-1) !== n.url) urls.push(n.url); }} />
      <Text testID="result" style={{ numberOfLines: 2 }}>{result()}</Text>
    </View>
  );
}

mount(App);
