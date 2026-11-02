// One input box, against dev/fake-desktop.mjs on the local relay. The runner (dev/live-smoke.sh)
// reads the Mac's screens with hc whenever this prints a CHECK line.
import { expect, open, test } from "nsh/test";
import cfg from "./link.json";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const check = async (app: any, name: string) => { await app.wait(1500); console.log(`CHECK ${name}`); await app.wait(2500); };

test("typing goes into the program's own line", async () => {
  const app = await open("../App.tsx", { network: "live" });
  await app.paste("id:pair-link", { text: cfg.link });
  await app.press("role:button[配对]");
  await app.waitFor("text:已连接", { timeout: 20000 });

  // A question (the fake claude is blocked): typing waits, the answer goes first.
  await app.press("text:claude >> nth=0");
  await app.waitFor("id:composer");
  await app.wait(1500);
  await app.type("id:composer", "hello");
  expect(app.texts()).toContain("等你回答后输入：hello");
  await app.press("role:button[1]");
  await app.press("role:button[⏎]");
  await check(app, "fake-answered"); // expect "你选了 1"; then hello went in after the question
  await app.press("id:send");
  await check(app, "fake-hello"); // expect "你选了 hello"
  await app.back();
  await app.wait(1000);

  // Real Claude Code in the shell.
  await app.press("text:zsh >> nth=0");
  await app.waitFor("id:composer");
  await app.wait(1500);
  await app.type("id:composer", "cd /tmp/slash-probe && claude");
  await app.press("id:send");
  expect(app.value("id:composer")).toBe("");
  await app.wait(12000);
  await app.type("id:composer", "/he");
  await check(app, "slash-menu");
  await app.press("role:button[Esc]");
  await app.wait(500);
  await app.press("role:button[Esc]");
  await app.paste("id:composer", { text: "第一行\n第二行" });
  await check(app, "two-lines");
  await app.press("role:button[←]"); // commit: the field empties, the line stays in Claude Code
  expect(app.value("id:composer")).toBe("");
  await app.keyboard.press("backspace").catch((e: any) => console.log(`backspace: ${e.message}`));
  await check(app, "backspace-after-commit"); // expect one character fewer before the cursor
  await app.press("role:button[^C]");
  await app.wait(800);
  app.onPick(() => [{ name: "shot.png", type: "image/png", data: PNG }]);
  await app.press("id:pick");
  await app.waitUntil(() => !app.texts().some((t: string) => t.startsWith("上传图片")), { timeout: 15000 });
  await app.wait(800);
  await app.type("id:composer", "只回答这张图的尺寸");
  await check(app, "image-in-line"); // expect ❯ [Image #1] 只回答这张图的尺寸
  await app.press("id:send");
  await app.wait(15000);
  await check(app, "image-answered");
}, 150000);
