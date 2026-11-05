---
id: I-003
title: Mac 之间通过加密隧道同步 Herdr 工作区（wayne-herdr-mods via）
status: needs-decision
priority: P2
subsystem: DESIGN.md
repo: self
---

## 方案概述（原 docs/ade.md 第 1 步）
`Herdr.app` 原生支持多机工作区（`hc machine add --name X --via '<命令>'`）。可在 `wayne-herdr-mods` 增加 `via` 子命令与设备角色区分（`phone` 走现有 RPC 白名单；`machine` 需在 Mac A 上额外确认授权后转发 `herdr-core` 分帧协议，且宿主直接连本机 `herdr-core` socket，不执行 `via` 传入的尾随 shell 字符串）。

## 启动条件
当需要在第二台 Mac 的 `Herdr.app` 侧栏直接挂载并操作本机工作区时再启动。历史完整草案可通过 `git log -S "多设备 ADE 方案" -p` 查阅。
