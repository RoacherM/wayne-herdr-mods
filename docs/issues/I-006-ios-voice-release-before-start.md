---
id: I-006
title: 原生 App 按住说话：voice.start 回来前松手，会录满 60 秒再输入
status: verifying
priority: P1
subsystem: DESIGN.md「语音输入（已实现）」
repo: self
---

## 现象（2026-11-09 读代码确认，未实测）
`ios/App.tsx` `startVoice` 在 `await host.call("voice.start")` 之后才 `voiceState.set("rec")`。这段时间里 `onPressUp` 看到的是 `""`，什么都不做。`voice.start` 回来后进入录音，手指早已离开，直到 60 秒上限才停，并把听到的字放进输入行。第一次用时 iOS 弹麦克风权限，这段时间有几秒。网页版用 `held` 处理了这个情况。
同类：录音开始前卸载页面不发 `voice.cancel`；开始中再按一次会建两套计时器。

## 修法
把录音做成显式状态 `"" | "starting" | "rec" | "busy"`（可仿 `app/src/term-session.js` 写成纯函数，两端共用），松手、卸载在 `starting` 时都记下来，`voice.start` 回来后马上 `voice.cancel`。

## verify
- 纯函数单测：`press → release → started` → 效果是 `voice.cancel`，不进入 `rec`。旧行为（直接进 `rec`）失败。
- `dev/voice-smoke.mjs` 仍通过。
