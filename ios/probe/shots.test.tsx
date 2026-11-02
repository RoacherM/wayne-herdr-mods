// Screens on a real platform, for design review:  nsh test probe/shots.test.tsx --target ios
import { open, test } from "nsh/test";
import cfg from "./link.json";

test("screens", async () => {
  const app = await open("../App.tsx", { network: "live" });
  await app.waitFor("text:herdr 远程");
  await app.screenshot("/tmp/shots/a-pair.png");
  await app.paste("id:pair-link", { text: cfg.link });
  await app.press("role:button[配对]");
  await app.waitFor("text:已连接", { timeout: 20000 });
  await app.wait(1500);
  await app.screenshot("/tmp/shots/b-home.png");
  await app.press("text:claude >> nth=0");
  await app.waitFor("id:composer");
  await app.wait(3000);
  await app.screenshot("/tmp/shots/c-term.png");
  await app.back();
  await app.wait(1000);
  await app.press("id:settings");
  await app.wait(1000);
  await app.screenshot("/tmp/shots/d-settings.png");
  await app.press("role:button[取消配对]");
  await app.waitFor("id:pair-link", { timeout: 10000 });
}, 90000);
