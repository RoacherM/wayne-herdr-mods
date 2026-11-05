---
id: I-004
title: iOS 原生客户端（nsh + libghostty-vt）方案
status: needs-decision
priority: P2
subsystem: DESIGN.md
repo: self
---

## 方案概述（原 docs/ade.md 第 2 步 & DESIGN.md「原生 App（nsh）」）
PWA 闪烁与宽字符问题已在浏览器内通过 `resize_notifications`、同步输出（DEC 2026）与 `@xterm/addon-unicode-graphemes` 解决（坏帧 0/23）。`ios/` 下保留了 `nsh` 第 0 步原型。若未来做完整原生 App，外围页面用 `nsh`（或 SwiftUI），终端视图在 Swift 宿主内用 `libghostty-vt` + Metal 绘制，协议层直连 `herdr-core` 分帧流。

## 启动条件
仅当以下任一条件出现时启动：
1. 真机 iPhone 上 xterm.js 在 200+ 列大终端下掉帧明显；
2. 必须依赖 PWA 无法提供的能力（原生 APNs 推送、锁屏后台连续录音）。
