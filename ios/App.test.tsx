// The whole app, headless, against dev/fake-desktop.mjs on the local relay (live network):
// pair with a link, see the Herdr spaces, open a shell, send a message, go back, forget.
//   npm run relay:dev; node dev/fake-desktop.mjs  → writes the link into probe/link.json
import { expect, open, test } from "nsh/test";
import cfg from "./probe/link.json";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

test("pair, list, open a terminal, send, forget", async () => {
  const app = await open("./App.tsx", { network: "live" });
  await app.waitFor("text:herdr 远程");
  await app.paste("id:pair-link", { text: cfg.link });
  await app.press("role:button[配对]");
  // fake-desktop approves by itself; the home screen shows the spaces.
  await app.waitFor("text:herdr-relay", { timeout: 20000 });
  await app.waitFor("text:已连接");
  await app.wait(500);
  await app.screenshot("shots/1-home.png").catch(() => {}); // headless draws nothing
  expect(app.texts()).toContain("site");
  expect(app.storage()["herdr-relay"]).toContain("deviceSecret");
  const shellRow = app.texts().includes("zsh") ? "text:zsh" : "text:claude";
  await app.press(`${shellRow} >> nth=0`);
  await app.waitFor("id:composer");
  await app.wait(2500);
  await app.screenshot("shots/2-term.png").catch(() => {}); // headless draws nothing
  await app.press("id:kbd-toggle");
  await app.type("id:composer", "echo FROM_NSH_APP");
  await app.press("id:send");
  await app.waitUntil(() => app.value("id:composer") === "", { timeout: 10000 });
  await app.wait(1500);
  await app.screenshot("shots/3-sent.png").catch(() => {}); // headless draws nothing
  // An image: picked → uploaded in chunks → a file beside the terminal → its path pasted into the line.
  app.onPick(() => [{ name: "截图 1.png", type: "image/png", data: PNG }]);
  await app.press("id:pick");
  await app.waitUntil(() => app.picks().length === 1 && !app.texts().some((t) => t.startsWith("上传图片")), { timeout: 15000 });
  expect(app.picks()[0].maxDimension).toBe(2048);
  expect(app.texts().join(" ")).not.toContain("图片没发出去");
  await app.back();
  await app.wait(1000); // let the pop animation finish
  await app.waitFor("id:settings");
  await app.press("id:settings");
  await app.wait(800);
  expect(app.texts()).toContain("配对另一台电脑");
  await app.screenshot("shots/4-settings.png").catch(() => {});
  await app.press("role:button[取消当前电脑配对]");
  await app.waitFor("id:pair-link", { timeout: 10000 });
  expect(app.storage()["herdr-relay"] ?? null).toBe(null);
}, 60000);
