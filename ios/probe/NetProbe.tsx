// Which network paths work in this host? Logs one line per check.
import { mount, Text, View } from "nsh";
import { connect } from "websocket";

const log = (m: string) => console.log(`NET PROBE: ${m}`);
const ws = (url: string) => new Promise<string>((res) => {
  const t = setTimeout(() => res("timeout 8s"), 8000);
  try {
    const s = new WebSocket(url);
    s.onopen = () => log(`${url} open`);
    s.onmessage = (m) => { clearTimeout(t); res(`message ${JSON.stringify(m.data).slice(0, 40)}`); s.close(); };
    s.onerror = (e: any) => { clearTimeout(t); res(`error ${e?.message ?? e?.type}`); };
    s.onclose = (e: any) => { clearTimeout(t); res(`close ${e.code}`); };
  } catch (e: any) { clearTimeout(t); res(`throw ${e.message}`); }
});
(async () => {
  try { const r = await fetch("https://herdr-relay.sir-housir.workers.dev/manifest.webmanifest"); log(`fetch https ${r.status}`); } catch (e: any) { log(`fetch https failed ${e.message}`); }
  log(`ws local: ${await ws("ws://127.0.0.1:8799/v1/client/AAAAAAAAAAAAAAAAAAAAAA")}`);
  try {
    const c = await connect("wss://herdr-relay.sir-housir.workers.dev/v1/client/AAAAAAAAAAAAAAAAAAAAAA");
    log(`module wss relay: read ${JSON.stringify(await c.read()).slice(0, 40)}`);
    await c.close();
  } catch (e: any) { log(`module wss relay failed: ${JSON.stringify({ code: e.code, name: e.name, message: e.message, status: e.status, keys: Object.keys(e), str: String(e) })}`); }
  log(`global wss relay: ${await ws("wss://herdr-relay.sir-housir.workers.dev/v1/client/AAAAAAAAAAAAAAAAAAAAAA")}`);
  log("done");
})();
mount(() => <View><Text>net probe</Text></View>);
