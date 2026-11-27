// Every list sheet reaches its last row, on a real platform (design review + regression for the
// 2026-11-27 bug: half-height sheets cut off the bottom rows and could not scroll to them).
//   npm run relay:dev; node dev/fake-desktop.mjs; node dev/many-spaces.mjs <its data dir>
//   cd ios && nsh test probe/sheets-scroll.test.tsx --target ios   → /tmp/shots/*.png
import { expect, open, test } from "nsh/test";
import cfg from "./link.json";

const LAST_SPACE = "story-forge-agent";

test("list sheets reach their last row", async () => {
  const app = await open("../App.tsx", { network: "live" });
  await app.waitFor("id:pair-link", { timeout: 15000 });
  await app.paste("id:pair-link", { text: cfg.link });
  await app.submit("id:pair-link");
  await app.waitFor("id:new-term", { timeout: 20000 });
  await app.wait(1500);
  await app.screenshot("/tmp/shots/home.png");
  for (let i = 0; i < 4; i++) await app.scroll("id:home-search-input", 700);
  await app.wait(600);
  await app.screenshot("/tmp/shots/home-end.png");

  await app.press("id:new-term");
  await app.wait(900);
  await app.screenshot("/tmp/shots/new-term-open.png");
  for (let i = 0; i < 3; i++) await app.drag("id:add-x1", { y: -400 });
  await app.wait(800);
  await app.screenshot("/tmp/shots/new-term-end.png");
  await app.back();
  await app.wait(700);

  await app.press("id:filter-space");
  await app.wait(900);
  await app.screenshot("/tmp/shots/spaces-open.png");
  for (let i = 0; i < 3; i++) await app.drag("id:space-x1", { y: -400 });
  await app.wait(800);
  await app.screenshot("/tmp/shots/spaces-end.png");
  await app.press("id:space-x11");
  await app.wait(900);
  expect(app.shows("text:选择工作区")).toBe(false);
  await app.screenshot("/tmp/shots/home-filtered.png");

  await app.press("id:settings");
  await app.wait(800);
  await app.screenshot("/tmp/shots/settings.png");
  await app.press("id:settings-appearance");
  await app.wait(700);
  await app.press("id:appearance-light");
  await app.wait(900);
  await app.screenshot("/tmp/shots/settings-light.png");
  await app.press("id:tab-sessions");
  await app.wait(800);
  await app.screenshot("/tmp/shots/home-light.png");
  await app.press("id:settings");
  await app.press("id:settings-appearance");
  await app.wait(700);
  await app.press("id:appearance-dark");
  await app.wait(500);
}, 180000);
