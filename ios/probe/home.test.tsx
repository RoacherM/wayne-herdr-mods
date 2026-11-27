// The home inbox, headless, against dev/fake-desktop.mjs (DESIGN.md「原生 App 首页（收件箱）（2026-11-27）」): terminals are
// grouped by what they need from you, in that order; a blocked one says what it waits for; search
// narrows across groups; the list sheets are only as tall as their rows.
//   npm run relay:dev; node dev/fake-desktop.mjs; node dev/many-spaces.mjs <its data dir>
//   cd ios && nsh test probe/home.test.tsx
import { expect, open, test } from "nsh/test";
import cfg from "./link.json";

test("inbox groups by what each terminal needs", async () => {
  const app = await open("../App.tsx", { network: "live" });
  await app.waitFor("id:pair-link", { timeout: 15000 });
  await app.paste("id:pair-link", { text: cfg.link });
  await app.submit("id:pair-link");
  await app.waitFor("text:需要你", { timeout: 20000 });
  await app.wait(500);

  const t = app.texts();
  const at = (s: string) => t.indexOf(s);
  // Groups in order: needs you → done → idle (fake-desktop has no working terminal left by now).
  expect(at("需要你")).toBeGreaterThan(-1);
  expect(at("完成")).toBeGreaterThan(at("需要你"));
  expect(at("空闲")).toBeGreaterThan(at("完成"));
  // A blocked permission prompt says so; codex's finished message sits under 完成.
  expect(t).toContain("等你确认");
  expect(at("测试全部通过")).toBeGreaterThan(at("完成"));
  expect(at("测试全部通过")).toBeLessThan(at("空闲"));
  // The address is not shown as a time.
  expect(t.some((s) => /^t(?=[0-9a-z]*[0-9])[0-9a-z]{2,4}$/.test(s))).toBe(false);

  await app.type("id:home-search-input", "approve");
  await app.wait(300);
  expect(app.texts()).toContain("Approve plan");
  expect(app.texts()).not.toContain("测试全部通过");
  expect(app.texts()).not.toContain("空闲");
  await app.clear("id:home-search-input");
  await app.type("id:home-search-input", "zzzz-nothing");
  await app.wait(300);
  expect(app.texts()).toContain("没有匹配的终端");
}, 60000);
