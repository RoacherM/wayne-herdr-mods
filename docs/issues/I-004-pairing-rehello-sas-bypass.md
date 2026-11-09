---
id: I-004
title: 配对确认中途重发 hello，宿主把新密钥加进信任表（SAS 被绕过）
status: ready
priority: P0
subsystem: DESIGN.md「安全」「电脑上的确认」
repo: self
---

## 现象（2026-11-09 读代码确认，未实测）
1. 手机在 `pairing` 阶段，宿主在 `host/phones.js` `auth` 里 `await pairing.ask(...)` 等 Mac 上点「允许」。
2. 同一个 `cid` 上来一条明文 `{"type":"hello"…}`：`stage`、`cipher` 被重置，`peer.pub` 被换成新密钥；`pairing.dropped(cid)` 没被调用，请求还在。
3. 用户核对旧的 6 位码，点允许。`peers.has(cid)` 仍为真，`addDevice({ pub: peer.pub })` 加的是**新**密钥，`ready()` 封给新会话。
4. 恶意中继能借此把自己的密钥配对进来：正是 SAS 要防的攻击。

## 修法
- `await` 之前记下 `const pub = peer.pub, cipher = peer.cipher`；之后 `if (peers.get(cid) !== peer || peer.cipher !== cipher) return`，加的是记下的 `pub`。
- 收到重发的 hello 时调用 `pairing.dropped(cid)`。
- 改的是握手与配对：按 AGENTS.md 第 6 条，交给另一个模型独立审查 `git diff`。

## verify
- 新测试（`test/e2e.test.mjs` 旁，用 `createPhones` + 假 pairing）：配对等待中重发 hello，再 `decide(true)` → 信任表里**没有**新密钥，旧连接也不 `ready`。旧代码上失败。
- `npm test` 全过。
