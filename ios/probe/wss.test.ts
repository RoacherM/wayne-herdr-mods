// Does the app's WebSocket reach the real relay over TLS (wss://)? Runs inside an app opened with
// the live network (a test file itself has no network stack).
import { expect, open, test } from "nsh/test";

test("wss to the real relay", async () => {
  const app = await open("./WssProbe.tsx", { network: "live" });
  await app.waitFor("text:/^(message|error|close|timeout)/", { timeout: 15000 });
  const line = app.texts().find((t) => /^(message|error|close|timeout)/.test(t)) ?? "";
  console.log(line);
  expect(line.startsWith("message")).toBe(true);
});
