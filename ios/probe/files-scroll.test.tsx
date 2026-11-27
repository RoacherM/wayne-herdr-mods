// The Files sheet with many folders, on a real platform: can it scroll to the last row?
//   npm run relay:dev; node dev/fake-desktop.mjs   (its shell terminal sits in $HOME: ~30 folders)
//   cd ios && nsh test probe/files-scroll.test.tsx --target ios   → /tmp/shots/files-*.png
import { open, test } from "nsh/test";
import cfg from "./link.json";

test("files sheet scrolls to the end", async () => {
  const app = await open("../App.tsx", { network: "live" });
  await app.waitFor("id:pair-link", { timeout: 15000 });
  await app.paste("id:pair-link", { text: cfg.link });
  await app.submit("id:pair-link");
  await app.waitFor("text:herdr-relay · byronwayne", { timeout: 20000 });
  await app.wait(1200);
  await app.screenshot("/tmp/shots/home.png");
  await app.press("id:new-term");
  await app.wait(900);
  await app.screenshot("/tmp/shots/new-term.png");
  await app.back();
  await app.wait(600);
  await app.press("text:herdr-relay · byronwayne");
  await app.waitFor("id:composer", { timeout: 15000 });
  await app.wait(1500);
  await app.screenshot("/tmp/shots/term.png");
  await app.press("label:文件");
  await app.waitFor("id:files-search", { timeout: 10000 });
  await app.wait(1500);
  await app.screenshot("/tmp/shots/files-top.png");
  for (let i = 0; i < 25; i++) await app.scroll("id:files-list", 800);
  await app.wait(800);
  await app.screenshot("/tmp/shots/files-end.png");
  console.log("TEXTS", JSON.stringify(app.texts().slice(-12)));
}, 120000);
