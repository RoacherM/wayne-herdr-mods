import { expect, test } from "nsh/test";

test("globals the PWA code relies on", async () => {
  const names = ["WebSocket", "TextEncoder", "TextDecoder", "btoa", "atob", "crypto", "EventTarget", "CustomEvent", "Event", "setTimeout", "setInterval", "queueMicrotask", "URLSearchParams", "performance", "document", "window", "navigator"];
  const have: Record<string, string> = {};
  for (const n of names) have[n] = typeof (globalThis as any)[n];
  have["crypto.subtle.digest"] = typeof (globalThis as any).crypto?.subtle?.digest;
  have["crypto.getRandomValues"] = typeof (globalThis as any).crypto?.getRandomValues;
  console.log(JSON.stringify(have, null, 1));
  expect(have.WebSocket).toBe("function");
});
