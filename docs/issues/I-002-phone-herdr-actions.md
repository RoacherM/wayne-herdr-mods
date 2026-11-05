---
id: I-002
title: 手机端对齐 Herdr.app 的写操作白名单范围拍板
status: needs-decision
priority: P1
subsystem: DESIGN.md
repo: self
files:
  - host/phones.js
  - app/src/main.js
---

## 背景
手机端已实现工作区/标签分组、Agent 图标与 `working / done / idle` 状态同步、以及在工作区新建登录 shell 标签页（`term.new {space}`，走 `herdr-core terminal.run` 避免 `tab.new` 抢 Mac 焦点）。以下扩权操作涉及宿主白名单（`host/phones.js`），需先拍板再实现：

## 需拍板问题
1. **新建标签时直接启动指定 Agent 并带首句任务**：
   - 选项 A（推荐）：宿主通过 `herdr.caps` 下发本机 PATH 上可用的 `claude` / `codex` / `epi`，手机「+」菜单可选 Agent 并附第一句任务（宿主用 `terminal.run` 的 `argv` 启动，严禁手机任意传 `argv`）。
   - 选项 B：保持现状，只开登录 shell。
2. **手机关闭标签页 / 结束终端（`tab.close` / `terminal.kill`）**：
   - 选项 A（推荐）：放行，但手机端每次必须弹窗二次确认，宿主日志记录写操作。
   - 选项 B：不放行，防止手机误触关掉 Mac 正在跑的任务。
3. **手机修改 Mac 的 Herdr 设置**：
   - 选项 A（推荐）：仅放行 `sounds.enabled`（Mac 提示音开关），其余只读。
   - 选项 B：完全只读。
