---
id: I-005
title: Core.release() 对没注册的通道不发 CLOSE，viewer 留在 herdr-core 里
status: ready
priority: P1
subsystem: DESIGN.md「多个窗口怎么同步」「重印整段对话」
repo: self
---

## 现象（2026-11-09 读代码确认，未实测）
`host/hc.js` `release()` 在通道不在 `channels` 里时直接返回，不发 CLOSE。三处依赖它关掉刚 attach、还没 `on()` 的通道：
- `host/phones.js` 打开流时流已停（`link.idle`、同一地址再开、`term.close` 和 attach 交错）；
- 打字 viewer attach 途中流被停（`same.stop('moved')`）：留下一个手机尺寸的非 observe viewer，可能一直占着尺寸；
- 重印后重新 attach 途中流被停。
另外：已释放通道的迟到帧进 `core.early`，永不删除。

## 修法
`hc.js` 记一个 `released` 集合：`release()` 除非 core 先关了，否则总发 CLOSE，并删 `early[channel]`；`frame()` 丢掉已释放通道的帧。顺带：`Core.call` 加可选超时（打开流、打字 viewer、重印重连三处的悬挂都源于它）。

## verify
- 新测试（假 core socket）：attach 返回前停流 → 收到 CLOSE 帧、`early` 里没有这个通道。旧代码上失败。
- `npm test` 全过；`dev/layout-smoke.mjs` 与 `dev/flicker-smoke.mjs` 仍 ALL PASS。
