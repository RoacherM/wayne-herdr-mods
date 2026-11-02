// Real Claude Code in the fake desktop's shell: a picked image must land as [Image #1], not a path.
import { expect, open, test } from "nsh/test";
import cfg from "./link.json";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

test("image → [Image #1] in Claude Code", async () => {
  const app = await open("../App.tsx", { network: "live" });
  await app.waitFor("text:herdr 远程");
  await app.paste("id:pair-link", { text: cfg.link });
  await app.press("role:button[配对]");
  await app.waitFor("text:已连接", { timeout: 20000 });
  await app.press("text:zsh >> nth=0");
  await app.waitFor("id:composer");
  await app.wait(1500);
  await app.type("id:composer", "mkdir -p /tmp/slash-probe && cd /tmp/slash-probe && claude");
  await app.press("id:send");
  await app.wait(12000); // Claude Code starts
  app.onPick(() => [{ name: "shot.png", type: "image/png", data: PNG }]);
  await app.press("id:pick");
  await app.waitFor("id:drop-0");
  await app.type("id:composer", "只回答这张图的尺寸");
  await app.press("id:send");
  await app.waitUntil(() => app.value("id:composer") === "", { timeout: 20000 });
}, 90000);
