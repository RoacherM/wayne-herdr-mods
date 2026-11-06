// Prints the probe's numbers (one RESULT line) and takes a picture of the window: does a window
// capture include the web views? Run: nsh test App.test.tsx --target macos
import { open, test } from "nsh/test";

test("probe", async () => {
  const app = await open("./App.tsx", { network: "live" });
  await app.waitFor("text:done", { timeout: 90000 });
  console.log(app.texts().find((t) => t.startsWith("RESULT")));
  await app.screenshot("shots/window.png").catch((e) => console.log("screenshot failed", String(e)));
}, 120000);
