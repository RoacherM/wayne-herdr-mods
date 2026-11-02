import { effect, mount, signal, Text, View } from "nsh";

const out = signal("waiting");
const ws = new WebSocket("wss://herdr-relay.sir-housir.workers.dev/v1/client/AAAAAAAAAAAAAAAAAAAAAA");
const t = setTimeout(() => out.set("timeout"), 10000);
ws.onmessage = (m) => { clearTimeout(t); out.set(`message ${JSON.stringify(m.data)}`); ws.close(); };
ws.onerror = (e: any) => { clearTimeout(t); out.set(`error ${e?.message ?? e?.type}`); };
ws.onclose = (e: any) => { clearTimeout(t); if (out() === "waiting") out.set(`close ${e.code} ${e.reason}`); };
effect(() => console.log(`WSS PROBE: ${out()}`));
mount(() => <View><Text>{out()}</Text></View>);
