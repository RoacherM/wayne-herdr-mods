// The PWA's own link.js + e2e.js on nsh's QuickJS: pair with dev/fake-desktop.mjs through the
// local relay, list terminals, open one, type into it and see the echo. probe/link.json holds the
// pairing link (written by the shell before the run).
import "../src/shim";
import { expect, test } from "nsh/test";
import { boxKeysFromSecret, decodePairLink, newBoxKeys, unb64 } from "../../shared/e2e.js";
import { Link } from "../../app/src/link.js";
import cfg from "./link.json";

const until = async (what: string, fn: () => unknown, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};

test("pair, list, open, type — on QuickJS", async () => {
  const offer = decodePairLink(cfg.link);
  const keys = newBoxKeys();
  const t0 = Date.now();
  const link = new Link({ relay: offer.r, desktopId: offer.i, desktopKey: offer.k, deviceKeys: keys, pair: { token: offer.t, name: "nsh probe" } });
  const events: any[] = [];
  let sas = "";
  link.addEventListener("confirm", (e: any) => { sas = e.detail.sas; });
  link.addEventListener("ev", (e: any) => events.push(e.detail));
  await until("ready", () => link.status === "ready", 20000);
  console.log(`paired in ${Date.now() - t0} ms, sas ${sas}, mac ${link.info?.name}`);
  const list: any = await link.rpc("terminals.list");
  console.log(`terminals: ${list.terminals.length}, spaces: ${list.layout.map((s: any) => s.name).join(", ")}`);
  expect(list.terminals.length).toBeGreaterThan(0);
  const shell = list.terminals.find((t: any) => t.program === "zsh") ?? list.terminals[0];
  const opened: any = await link.rpc("term.open", { address: shell.address });
  let out = "";
  const pump = () => {
    let n = 0;
    for (const e of events.splice(0)) if (e.ev === "out" && e.s === opened.s) { const b = unb64(e.d); out += new TextDecoder().decode(b); n += b.length; }
    if (n) link.notify("term.ack", { s: opened.s, n });
  };
  await until("first paint", () => { pump(); return out.length > 0; });
  link.notify("term.input", { s: opened.s, d: "echo NSH_$((6*7))\r" });
  await until("echo", () => { pump(); return out.includes("NSH_42"); });
  console.log(`round trip ok, ${out.length} chars received, ${opened.cols}x${opened.rows}`);
  // Reconnect with the same device key (resume, no pairing).
  link.close();
  const again = new Link({ relay: offer.r, desktopId: offer.i, desktopKey: offer.k, deviceKeys: boxKeysFromSecret(keys.secretKey) });
  await until("resume ready", () => again.status === "ready", 20000);
  expect(again.info.paired).toBe(false);
  again.close();
});
