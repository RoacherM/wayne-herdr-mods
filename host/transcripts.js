/**
 * Local coding-agent session discovery & communication topology parsers (DESIGN.md「观测面板」).
 *
 * Anchored on herdr-core's terminal PID / cwd / app, resolves the live session on disk across
 * Antigravity (agy), Claude Code, Codex, Epi / Pi, Factory Droid, Devin, Dim, Grok, and Amp,
 * extracting main-agent model / state / activity plus subagent `spawn`, `message`, and `return`.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const FERNET_RE = /^gAAAAAB[A-Za-z0-9_-]{20,}$/;
const HC_RUN_RE = /(?:^|[;&|\n]\s*|\benv\s+[^\n]*?\s)hc\s+run\b(?!\s+--help)/;
const HC_SEND_AGENT_RE = /\bhc\s+send\s+--if\s+\S+\s+(t[0-9a-z]+)\s+["']?([^\n"']+)/;
const CLI_EXEC_RE = /(?:^|[;&|\n]\s*|\bnohup\s+|\benv\s+[^\n]*?\s)(?:(claude|agy|epi|pi|devin|amp|grok|dim)\s+(?:-[^\n|;&]*?\s+)?(?:-p|--print|--prompt|-x|--execute)\b|(codex|droid)\s+(?:exec|-q)\b)/;

export function cleanText(raw, max = 500) {
  const s = String(raw ?? '').trim();
  if (!s || FERNET_RE.test(s)) return '';
  const flat = s.replace(/\r\n/g, '\n').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function oneLine(raw, max = 90) {
  const s = cleanText(raw, max * 3);
  if (!s) return '';
  const line = s.split('\n').map((x) => x.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const shortModel = (m) => (m ? String(m).replace(/^custom:/, '').split('/').pop().replace(/^auto-claude-/, '') : null);

function parseMs(ts, fallback = 0) {
  const n = typeof ts === 'number' ? ts : Date.parse(ts ?? '');
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonObj(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function parseJsonLines(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

function xmlTag(s, tag) {
  const m = String(s ?? '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

function openSqliteRo(dbPath) {
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = nodeRequire('node:sqlite');
    return new DatabaseSync(dbPath, { open: true, readOnly: true });
  } catch {
    return null;
  }
}

function extractCliModel(cmd, desc) {
  const hit = /--model[= ]([\w./-]+)/.exec(cmd) || /with\s+([A-Za-z0-9._-]+)/i.exec(desc);
  return hit ? hit[1].toLowerCase() : null;
}

function detectCliWorker(cmd, desc) {
  const model = extractCliModel(cmd, desc);
  const send = HC_SEND_AGENT_RE.exec(cmd);
  if (send) return { via: 'hc', model, terminal: send[1], prompt: send[2] };
  if (HC_RUN_RE.test(cmd)) return { via: 'hc', model, terminal: null, prompt: cmd };
  const cli = CLI_EXEC_RE.exec(cmd);
  return { via: cli ? (cli[1] || cli[2]).toLowerCase() : null, model, terminal: null, prompt: cmd };
}

function makeCtx(sessionId = null, model = null) {
  return { sessionId, model: shortModel(model), state: null, activity: null, agents: [], byKey: new Map(), events: [], seq: 0 };
}

function packCtx(ctx) {
  ctx.events.sort((a, b) => a.at - b.at);
  return { sessionId: ctx.sessionId, model: ctx.model, state: ctx.state, activity: ctx.activity, agents: ctx.agents, events: ctx.events };
}

function setActivity(ctx, raw, state = null) {
  const txt = cleanText(raw, 240);
  if (txt) ctx.activity = txt;
  if (state) ctx.state = state;
}

function registerAliases(ctx, agent, aliases = []) {
  for (const k of [agent.id, agent.name, ...aliases]) {
    if (k) ctx.byKey.set(String(k), agent);
  }
}

function buildAgentRecord(info) {
  const via = info.via || 'agent';
  return {
    id: info.id,
    agentId: info.agentId ?? null,
    name: info.name || via,
    via,
    model: shortModel(info.model),
    terminal: info.terminal ?? null,
    parentAgent: info.parentAgent ?? null,
    state: info.state || 'working',
    activity: cleanText(info.activity, 240) || null,
    msg: cleanText(info.msg, 240) || null,
    start: info.start ?? 0,
    end: info.end ?? null,
    prompt: cleanText(info.prompt, 600) || null,
    reply: cleanText(info.reply, 600) || null,
  };
}

function addAgent(ctx, info) {
  const key = info.id ? String(info.id) : '';
  if (key && ctx.byKey.has(key)) {
    const existing = ctx.byKey.get(key);
    registerAliases(ctx, existing, info.aliases);
    return existing;
  }
  const agent = buildAgentRecord(info);
  ctx.agents.push(agent);
  registerAliases(ctx, agent, info.aliases);
  return agent;
}

function upgradeFinishedAgent(ctx, a, { reply, status, at } = {}) {
  const clean = cleanText(reply, 600);
  if (clean) a.reply = clean;
  if (status) a.state = status;
  if (at) a.end = at;
  a.activity = null;
  const ret = ctx.events.findLast((e) => e.kind === 'return' && e.from === a.id);
  if (!ret) return;
  if (status) ret.status = status;
  if (at) ret.at = at;
  if (clean) {
    ret.summary = oneLine(clean, 88);
    ret.detail = clean;
  }
}

function emitSpawn(ctx, sub, at, from = 'main') {
  const ev = {
    kind: 'spawn', id: `sp-${++ctx.seq}`, at,
    from: from || 'main', to: sub.id,
    title: sub.name, detail: sub.prompt, via: sub.via, model: sub.model,
  };
  ctx.events.push(ev);
  return ev;
}

function emitMessage(ctx, from, to, body, at, summaryText = '') {
  ctx.events.push({
    kind: 'message', id: `msg-${++ctx.seq}`, at,
    from: from || 'main', to,
    summary: oneLine(summaryText || body, 88),
    detail: cleanText(body, 600),
  });
}

function findAgent(ctx, ref) {
  if (!ref) return null;
  const s = String(ref);
  return ctx.byKey.get(s) || ctx.byKey.get(s.replace(/^\/root\//, '')) || null;
}

function resolveAgentId(ctx, ref) {
  if (!ref) return 'main';
  const hit = findAgent(ctx, ref);
  return hit ? hit.id : String(ref).replace(/^\/root\//, '');
}

function finishAgent(ctx, ref, { at, status = 'done', reply = '', to = 'main' }) {
  const a = findAgent(ctx, ref);
  if (!a || a.end) return;
  a.end = at || a.start;
  a.state = status;
  a.activity = null;
  if (reply) a.reply = cleanText(reply, 600);
  ctx.events.push({
    kind: 'return', id: `ret-${++ctx.seq}`, at: a.end,
    from: a.id, to: a.parentAgent || to, status,
    summary: oneLine(a.reply || '', 88), detail: a.reply,
  });
}

// ------------------------------------------------ Claude Code & Factory Droid --

function claudeTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (!content.every((b) => b.type === 'text' || b.type === 'image')) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
}

function isInternalUserText(s) {
  return /^<(?:system-reminder|command-|local-command)/.test(s.trim());
}

function handleClaudeTeammate(ctx, raw, at) {
  const m = /^<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/.exec(raw.trim());
  if (!m) return false;
  const who = (/teammate_id="([^"]+)"/.exec(m[1]) || [])[1] || 'teammate';
  const sum = (/summary="([^"]+)"/.exec(m[1]) || [])[1] || '';
  emitMessage(ctx, resolveAgentId(ctx, who), 'main', m[2], at, sum);
  return true;
}

function isShellTool(name) {
  return name === 'Bash' || name === 'Execute';
}

function claudeWorkerName(desc, terminal, via) {
  const raw = desc || (terminal ? `Pane ${terminal}` : via);
  return oneLine(raw.replace(/^Run (AGY )?/i, ''), 60);
}

function spawnClaudeWorker(ctx, b, inp, at) {
  if (b.id && ctx.byKey.has(String(b.id))) return;
  const isAgent = b.name === 'Agent' || b.name === 'Task' || b.name === 'Workflow';
  const cmd = String(inp.command || '');
  const desc = String(inp.description || inp.name || '');
  const cli = isShellTool(b.name) ? detectCliWorker(cmd, desc) : { via: null, model: null, terminal: null, prompt: '' };
  if (!isAgent && !cli.via) return;
  const via = isAgent ? (inp.subagent_type || b.name) : cli.via;
  const sub = addAgent(ctx, {
    id: b.id, name: claudeWorkerName(desc, cli.terminal, via), via,
    model: inp.model || cli.model, terminal: cli.terminal,
    start: at, prompt: inp.prompt || cli.prompt || cmd, aliases: [inp.name, inp.subagent_type, cli.terminal],
  });
  emitSpawn(ctx, sub, at, 'main');
}

function claudeToolLabel(b) {
  const inp = b.input || {};
  if (inp.summary || inp.description) return inp.summary || inp.description;
  const fp = inp.file_path || inp.path;
  return fp ? `${b.name} ${basename(String(fp))}` : b.name;
}

function handleClaudeToolUse(ctx, b, at) {
  const inp = b.input || {};
  setActivity(ctx, claudeToolLabel(b), 'working');
  if (b.name === 'SendMessage') {
    const body = inp.message || inp.content || '';
    emitMessage(ctx, 'main', resolveAgentId(ctx, inp.to || inp.recipient || 'teammate'), body, at, inp.summary);
    return;
  }
  if (b.name === 'TaskStop') {
    finishAgent(ctx, inp.task_id || inp.shell_id, { at, status: 'stopped', reply: '' });
    return;
  }
  spawnClaudeWorker(ctx, b, inp, at);
}

function extractAsyncId(res) {
  if (!res) return null;
  return res.agentId || res.backgroundTaskId || res.taskId || null;
}

function bindHcTerminal(sub, text) {
  const hcAddr = (/\b(t[0-9a-z]+)\b/.exec(text) || [])[1];
  if (hcAddr && sub.via === 'hc') sub.terminal = hcAddr;
}

function handleClaudeToolResult(ctx, l, b, at) {
  const sub = ctx.byKey.get(b.tool_use_id);
  if (!sub) return;
  const text = claudeTextOf(b.content);
  bindHcTerminal(sub, text);
  const asyncId = extractAsyncId(l.toolUseResult);
  if (asyncId) {
    if (l.toolUseResult?.agentId) sub.agentId = String(l.toolUseResult.agentId);
    ctx.byKey.set(String(asyncId), sub);
    return;
  }
  if (!/Async agent launched|running in background/i.test(text)) {
    finishAgent(ctx, sub.id, { at, status: b.is_error ? 'failed' : 'done', reply: text });
  }
}

const CLAUDE_BOILERPLATE_RE = /^Agent\s+"[\s\S]*"\s+(?:finished|completed|failed|stopped)\s*$/i;

function isClaudeBoilerplate(s) {
  return CLAUDE_BOILERPLATE_RE.test(String(s || '').trim());
}

function scanClaudeSubContent(content) {
  let reply = '', activity = '';
  for (const b of content) {
    if (b.type === 'tool_use') activity = claudeToolLabel(b) || activity;
    else if (b.type === 'text' && b.text?.trim()) reply = b.text.trim();
  }
  return { reply, activity };
}

function scanClaudeSubItems(items, startAt) {
  let lastAt = startAt, reply = '', activity = '';
  for (const item of items) {
    lastAt = parseMs(item.timestamp, lastAt);
    const content = item.type === 'assistant' ? item.message?.content : null;
    if (!Array.isArray(content)) continue;
    const step = scanClaudeSubContent(content);
    if (step.reply) reply = step.reply;
    if (step.activity) activity = step.activity;
  }
  return { lastAt, reply, activity };
}

function resolveClaudeSub(ctx, aid, meta) {
  return ctx.byKey.get(aid) || (meta?.toolUseId ? ctx.byKey.get(meta.toolUseId) : null);
}

function applyClaudeSubFiles(ctx, subFiles) {
  for (const [aid, info] of Object.entries(subFiles || {})) {
    const sub = resolveClaudeSub(ctx, aid, info.meta);
    if (!sub) continue;
    sub.agentId = sub.agentId || aid;
    if (info.meta?.model && info.meta.model !== 'inherit' && !sub.model) sub.model = shortModel(info.meta.model);
    const { lastAt, reply, activity } = scanClaudeSubItems(parseJsonLines(info.jsonl), sub.start);
    if (info.done && !sub.end) {
      finishAgent(ctx, sub.id, { at: lastAt, status: 'done', reply });
    } else if (sub.end && reply && (!sub.reply || isClaudeBoilerplate(sub.reply))) {
      upgradeFinishedAgent(ctx, sub, { reply });
    } else if (!sub.end) {
      sub.activity = cleanText(activity, 240) || sub.activity;
    }
  }
}

function applyClaudeNotification(ctx, raw, at) {
  const ref = xmlTag(raw, 'task-id') || xmlTag(raw, 'tool-use-id');
  const st = xmlTag(raw, 'status');
  const status = (st === 'failed' || st === 'error') ? 'failed' : (st === 'killed' || st === 'stopped') ? 'stopped' : 'done';
  const sum = xmlTag(raw, 'summary');
  const reply = xmlTag(raw, 'result') || (isClaudeBoilerplate(sum) ? '' : sum);
  finishAgent(ctx, ref, { at, status, reply });
}

function stepClaudeBlocks(ctx, l, blocks, at, isAssistant) {
  for (const b of blocks) {
    if (b.type === 'tool_use') handleClaudeToolUse(ctx, b, at);
    else if (b.type === 'tool_result') handleClaudeToolResult(ctx, l, b, at);
    else if (isAssistant && b.type === 'text' && b.text?.trim()) setActivity(ctx, b.text, 'done');
  }
}

function stepClaudeUserLine(ctx, l, at, notes) {
  if (l.message?.hookEventName) return;
  const c = l.message?.content;
  if (typeof c === 'string' && /<task-notification>/.test(c)) { notes.push({ raw: c, at }); return; }
  if (typeof c === 'string' && handleClaudeTeammate(ctx, c, at)) return;
  if (typeof c === 'string') { if (!isInternalUserText(c)) setActivity(ctx, c, 'working'); return; }
  if (!Array.isArray(c)) return;
  const txt = claudeTextOf(c);
  if (txt && !isInternalUserText(txt)) setActivity(ctx, txt, 'working');
  stepClaudeBlocks(ctx, l, c, at, false);
}

function claudeRoleOf(l) {
  if (l.type === 'user' || l.type === 'assistant') return l.type;
  return l.message ? l.message.role : null;
}

function syncClaudeMeta(ctx, l) {
  if (!ctx.sessionId) ctx.sessionId = l.sessionId || (l.type === 'session_start' ? l.id : null);
  const m = l.message ? l.message.model : null;
  if (m && m !== '<synthetic>') ctx.model = shortModel(m);
}

const CLAUDE_STEP_TYPES = new Set(['user', 'assistant', 'queue-operation', 'agent_turn_outcome', 'message']);

function stepClaudeRecord(ctx, l, notes) {
  syncClaudeMeta(ctx, l);
  if (!CLAUDE_STEP_TYPES.has(l.type)) return;
  const at = parseMs(l.timestamp, ctx.seq);
  if (l.type === 'agent_turn_outcome') { ctx.state = 'done'; return; }
  if (l.type === 'queue-operation' && /<task-notification>/.test(l.content || '')) { notes.push({ raw: l.content, at }); return; }
  const role = claudeRoleOf(l);
  if (role === 'user') { stepClaudeUserLine(ctx, l, at, notes); return; }
  const content = l.message ? l.message.content : null;
  if (Array.isArray(content)) stepClaudeBlocks(ctx, l, content, at, role === 'assistant');
}

export function parseClaudeSession(text, subFiles = {}, sessionId = null, defaultModel = null) {
  const ctx = makeCtx(sessionId, defaultModel);
  const notes = [];
  for (const l of parseJsonLines(text)) stepClaudeRecord(ctx, l, notes);
  for (const n of notes) applyClaudeNotification(ctx, n.raw, n.at);
  applyClaudeSubFiles(ctx, subFiles);
  return packCtx(ctx);
}

// ------------------------------------------------------------------ Antigravity --

const AGY_TRUNC_RE = /\n?<truncated \d+ bytes>$/;

function unescapeTruncatedJsonStr(val) {
  let head = val.replace(AGY_TRUNC_RE, '');
  const tailSlashes = (/(\\+)$/.exec(head) || ['', ''])[1];
  if (tailSlashes.length % 2 === 1) head = head.slice(0, -1);
  try {
    return JSON.parse(`${head}"`);
  } catch {
    return head.slice(1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function parseMaybeJson(val) {
  if (typeof val !== 'string') return val;
  if (val.startsWith('"') && AGY_TRUNC_RE.test(val)) return unescapeTruncatedJsonStr(val);
  if (!/^["[{]/.test(val) && val !== 'true' && val !== 'false' && !/^-?\d+$/.test(val)) return val;
  try { return JSON.parse(val); } catch { return val; }
}

function unwrapAgyArgs(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) out[k] = parseMaybeJson(v);
  return out;
}

function agyToolLabel(name, args) {
  if (args.toolSummary || args.Role) return args.toolSummary || args.Role;
  return args.Path ? `${name} ${basename(String(args.Path))}` : name;
}

function spawnSwarmWorker(ctx, baseName, brief, model, parentAgent, at) {
  const id = `swarm:${baseName}`;
  if (ctx.byKey.has(id)) return ctx.byKey.get(id);
  const sub = addAgent(ctx, {
    id, name: baseName, via: 'swarm', model,
    parentAgent, start: at, prompt: brief, aliases: [baseName],
  });
  emitSpawn(ctx, sub, at, parentAgent);
  return sub;
}

function handleAgySwarm(ctx, args, at, parentAgent) {
  if (args.action === 'kill' && args.name) {
    finishAgent(ctx, args.name, { at, status: 'stopped', reply: '' });
    return;
  }
  if (args.action !== 'add') return;
  const base = args.name || 'worker';
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : null;
  if (tasks) {
    tasks.forEach((tk, i) => spawnSwarmWorker(ctx, tasks.length > 1 ? `${base}-${i + 1}` : base, `${args.brief || ''}\nTask: ${tk}`.trim(), args.model, parentAgent, at));
    return;
  }
  const count = Math.max(1, Number(args.n) || 1);
  for (let i = 0; i < count; i++) {
    spawnSwarmWorker(ctx, count > 1 ? `${base}-${i + 1}` : base, args.brief || '', args.model, parentAgent, at);
  }
}

function invokeAgySubagent(ctx, args, at, pendingInvokes, parentAgent) {
  const via = args.TypeName || 'subagent';
  const sub = addAgent(ctx, {
    id: `agy-sub-${ctx.seq + 1}`, name: args.Role || via, via,
    model: args.Model === 'inherit' ? null : args.Model,
    parentAgent, start: at, prompt: args.Prompt,
  });
  pendingInvokes.push({ sub, ev: emitSpawn(ctx, sub, at, parentAgent) });
}

function killAgySubagents(ctx, args, at) {
  const ids = args.Action === 'kill_all' ? ctx.agents.map((a) => a.id) : (args.ConversationIds || []);
  for (const id of ids) finishAgent(ctx, id, { at, status: 'stopped', reply: '' });
}

function spawnAgyCommandWorker(ctx, args, at, parentAgent) {
  const cmd = String(args.CommandLine || '');
  const desc = String(args.toolSummary || '');
  const cli = detectCliWorker(cmd, desc);
  if (!cli.via) return null;
  if (cli.terminal && ctx.byKey.has(cli.terminal)) {
    emitMessage(ctx, parentAgent, ctx.byKey.get(cli.terminal).id, cli.prompt, at);
    return null;
  }
  const sub = addAgent(ctx, {
    id: cli.terminal ? `hc:${cli.terminal}` : `cmd-${ctx.seq + 1}`,
    name: desc || (cli.terminal ? `Pane ${cli.terminal}` : cli.via),
    via: cli.via, model: cli.model, terminal: cli.terminal,
    parentAgent, start: at, prompt: cli.prompt || cmd, aliases: [cli.terminal],
  });
  emitSpawn(ctx, sub, at, parentAgent);
  return sub;
}

function handleAgyCall(ctx, tc, at, state, parentAgent) {
  const args = unwrapAgyArgs(tc.args || tc.arguments);
  let cmdSub = null;
  if (tc.name === 'invoke_subagent') invokeAgySubagent(ctx, args, at, state.invokes, parentAgent);
  else if (tc.name === 'swarm') handleAgySwarm(ctx, args, at, parentAgent);
  else if (tc.name === 'send_message') emitMessage(ctx, parentAgent, resolveAgentId(ctx, args.Recipient), args.Message, at);
  else if (tc.name === 'run_command') cmdSub = spawnAgyCommandWorker(ctx, args, at, parentAgent);
  else if (tc.name === 'manage_subagents' && (args.Action === 'kill' || args.Action === 'kill_all')) killAgySubagents(ctx, args, at);
  state.results.push(cmdSub);
}

function unwrapAgyReply(raw) {
  const code = /Command exited with code (\d+)/.exec(raw);
  const status = code && code[1] !== '0' ? 'failed' : 'done';
  const idx = raw.indexOf('Command output:\n');
  const body = idx >= 0 ? raw.slice(idx + 16) : raw;
  return { status, reply: body.replace(/\nLog: file:\/\/\/[^\n]+$/m, '').trim() };
}

function settleAgyGeneric(ctx, content, at, state) {
  const cmdSub = state.results.length ? state.results.shift() : null;
  if (cmdSub) {
    const bgTask = /background task with task id:\s*(\S+)/.exec(content);
    if (bgTask) ctx.byKey.set(bgTask[1], cmdSub);
    else finishAgent(ctx, cmdSub.id, { at, ...unwrapAgyReply(content) });
    return;
  }
  if (!state.invokes.length || content.includes('active subagent(s):')) return;
  const cid = (/"conversationId":\s*"([^"]+)"/.exec(content) || [])[1];
  if (!cid) return;
  const { sub, ev } = state.invokes.shift();
  sub.id = cid;
  ev.to = cid;
  ctx.byKey.set(cid, sub);
}

function handleAgySystemMsg(ctx, raw, at) {
  const m = /\[Message\]\s+timestamp=\S+\s+sender=(\S+)(?:\s+priority=\S+)?\s+content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/.exec(raw);
  if (!m) return;
  const [, sender, body] = m;
  const sub = ctx.byKey.get(sender);
  if (!sub) return;
  if (!sub.end) finishAgent(ctx, sender, { at, ...unwrapAgyReply(body) });
  else emitMessage(ctx, sub.id, sub.parentAgent || 'main', body, at);
}

function stepAgyPlanner(ctx, l, at, state) {
  const calls = l.tool_calls || [];
  for (const tc of calls) handleAgyCall(ctx, tc, at, state, null);
  if (calls.length) {
    const last = calls.at(-1);
    setActivity(ctx, agyToolLabel(last.name, unwrapAgyArgs(last.args || last.arguments)), 'working');
    return;
  }
  if (typeof l.content === 'string' && l.content.trim()) setActivity(ctx, l.content, 'done');
}

function stepAgyLine(ctx, l, state) {
  const at = parseMs(l.created_at, ctx.seq);
  if (l.type === 'USER_INPUT') { setActivity(ctx, xmlTag(l.content, 'USER_REQUEST') || l.content, 'working'); return; }
  if (l.type === 'PLANNER_RESPONSE') { stepAgyPlanner(ctx, l, at, state); return; }
  for (const tc of l.tool_calls || []) handleAgyCall(ctx, tc, at, state, null);
  if (l.type === 'GENERIC' && typeof l.content === 'string') settleAgyGeneric(ctx, l.content, at, state);
  if (l.type === 'SYSTEM_MESSAGE' && typeof l.content === 'string') handleAgySystemMsg(ctx, l.content, at);
}

const SWARM_IDLE_TOOLS = new Set(['swarm_wait', 'post_message']);

function extractAgyWorkerActivity(text) {
  let act = '';
  for (const l of parseJsonLines(text)) {
    const calls = l.tool_calls || [];
    for (const tc of calls) {
      if (SWARM_IDLE_TOOLS.has(tc.name)) continue;
      const label = agyToolLabel(tc.name, unwrapAgyArgs(tc.args || tc.arguments));
      if (label) act = label;
    }
  }
  return act;
}

function swarmRefId(ctx, name, at) {
  if (!name || name === 'coordinator' || name === 'all') return 'main';
  return spawnSwarmWorker(ctx, name, '', null, null, at).id;
}

function setSwarmPrompt(ctx, sub, rawBrief) {
  const clean = cleanText(rawBrief, 600);
  if (!clean) return;
  sub.prompt = clean;
  const sp = ctx.events.find((e) => e.kind === 'spawn' && e.to === sub.id);
  if (sp) sp.detail = clean;
}

function stepSwarmBrief(ctx, row, at, assignedSeq) {
  const m = /^@([A-Za-z0-9_-]+)\s*([\s\S]*)/.exec(String(row.text || ''));
  if (!m) return;
  const sub = spawnSwarmWorker(ctx, m[1], m[2], null, null, at);
  setSwarmPrompt(ctx, sub, m[2]);
  assignedSeq.set(m[1], row.seq || 0);
}

function recordSwarmMentions(raw, sender, seq, assignedSeq) {
  for (const hit of raw.matchAll(/@([A-Za-z0-9_-]+)\b/g)) {
    if (hit[1] !== 'coordinator' && hit[1] !== sender) assignedSeq.set(hit[1], seq);
  }
}

function stepSwarmPost(ctx, row, at, doneByWorker, assignedSeq) {
  const raw = String(row.text || '').trim();
  if (!raw) return;
  const sender = row.agent || 'coordinator';
  const fromId = swarmRefId(ctx, sender, at);
  const leadHit = /^@([A-Za-z0-9_-]+)\b/.exec(raw);
  const toId = swarmRefId(ctx, leadHit ? leadHit[1] : '', at);
  const doneHit = sender !== 'coordinator' ? /^(?:@[A-Za-z0-9_-]+\s+)*\[done\]\s*([\s\S]*)/i.exec(raw) : null;
  if (doneHit) {
    const body = doneHit[1].trim();
    doneByWorker.set(sender, { at, reply: body, seq: row.seq || 0 });
    if (toId !== 'main') emitMessage(ctx, fromId, toId, body, at);
    return;
  }
  emitMessage(ctx, fromId, toId, raw.replace(/^@[A-Za-z0-9_-]+\s+/, ''), at);
  recordSwarmMentions(raw, sender, row.seq || 0, assignedSeq);
}

function reconcileSwarmMember(ctx, sub, m, doneInfo, reassigned, workerTranscripts) {
  const applied = m ? (m.applied_model || m.desired_model || m.model) : null;
  if (applied) sub.model = shortModel(applied);
  if (doneInfo && !reassigned) {
    if (!sub.end) finishAgent(ctx, sub.id, { at: doneInfo.at, status: 'done', reply: doneInfo.reply });
    else upgradeFinishedAgent(ctx, sub, { at: doneInfo.at, status: 'done', reply: doneInfo.reply });
    return;
  }
  if (m && (m.killed || m.phase === 'KILLED')) {
    if (!sub.end) finishAgent(ctx, sub.id, { at: sub.start, status: 'stopped', reply: '' });
    return;
  }
  if (m) {
    sub.end = null;
    sub.state = m.wake_mode === 'working' ? 'working' : 'waiting';
  }
  const wt = sub.state === 'working' ? workerTranscripts?.[sub.name] : '';
  sub.activity = wt ? (cleanText(extractAgyWorkerActivity(wt), 240) || null) : null;
}

function settleSwarmMonitor(ctx, doneByWorker) {
  const mon = ctx.agents.find((a) => a.via === 'swarm' && a.name === 'monitor' && !a.end && a.state !== 'working');
  if (!mon || doneByWorker.has('monitor') || ctx.state !== 'done') return;
  const others = ctx.agents.filter((a) => a !== mon);
  if (!others.length || !others.every((a) => Boolean(a.end))) return;
  const at = Math.max(mon.start, ...others.map((a) => a.end || 0));
  finishAgent(ctx, mon.id, { at, status: 'stopped', reply: '' });
}

function ensureSwarmRoster(ctx, members) {
  for (const [name, m] of Object.entries(members)) {
    if (name === 'coordinator' || m.role === 'coordinator') continue;
    const sub = spawnSwarmWorker(ctx, name, m.brief || '', m.applied_model || m.model, null, 0);
    if (m.brief) setSwarmPrompt(ctx, sub, m.brief);
  }
}

function applyAgySwarm(ctx, swarm) {
  if (!swarm) return;
  const members = swarm.members || {};
  if (!ctx.model && members.coordinator) ctx.model = shortModel(members.coordinator.applied_model || members.coordinator.model);
  const doneByWorker = new Map(), assignedSeq = new Map();
  const rows = parseJsonLines(swarm.board || '').sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const row of rows) {
    const at = parseMs(row.time, ctx.seq);
    if (row.kind === 'brief') stepSwarmBrief(ctx, row, at, assignedSeq);
    else stepSwarmPost(ctx, row, at, doneByWorker, assignedSeq);
  }
  ensureSwarmRoster(ctx, members);
  for (const sub of ctx.agents) {
    if (sub.via !== 'swarm') continue;
    const doneInfo = doneByWorker.get(sub.name);
    const reassigned = (assignedSeq.get(sub.name) || 0) > (doneInfo ? doneInfo.seq : 0);
    reconcileSwarmMember(ctx, sub, members[sub.name], doneInfo, reassigned, swarm.workerTranscripts);
  }
  settleSwarmMonitor(ctx, doneByWorker);
}

export function parseAgySession(text, { sessionId = null, model = null, childTranscripts = {}, swarm = null } = {}) {
  const ctx = makeCtx(sessionId, model);
  const state = { invokes: [], results: [] };
  for (const l of parseJsonLines(text)) stepAgyLine(ctx, l, state);
  for (const [cid, childText] of Object.entries(childTranscripts)) {
    if (!ctx.byKey.has(cid)) continue;
    const childState = { invokes: [], results: [] };
    for (const l of parseJsonLines(childText)) {
      const at = parseMs(l.created_at, ctx.seq);
      for (const tc of l.tool_calls || []) handleAgyCall(ctx, tc, at, childState, cid);
    }
  }
  applyAgySwarm(ctx, swarm);
  return packCtx(ctx);
}

// ------------------------------------------------------------------ Codex --------

function codexAgentName(args) {
  return args.task_name || args.nickname || args.agent_type || 'subagent';
}

function spawnCodexAgent(ctx, p, args, at) {
  const name = codexAgentName(args);
  const prompt = cleanText(args.message || args.prompt, 600) || null;
  const sub = addAgent(ctx, {
    id: `cx:${name}`, name, via: args.agent_type || 'codex', model: args.model,
    start: at, prompt, aliases: [name, `/root/${name}`, p.call_id],
  });
  emitSpawn(ctx, sub, at, 'main');
}

function sendCodexMsg(ctx, args, at) {
  const target = args.target || args.id || 'subagent';
  const body = cleanText(args.message || args.input, 600);
  emitMessage(ctx, 'main', resolveAgentId(ctx, target), body, at);
}

function handleCodexCollab(ctx, p, at) {
  const args = parseJsonObj(p.arguments);
  if (p.name === 'spawn_agent') return spawnCodexAgent(ctx, p, args, at);
  if (p.name === 'close_agent') return finishAgent(ctx, args.target || args.id, { at, status: 'done', reply: '' });
  if (p.name === 'send_message' || p.name === 'send_input') sendCodexMsg(ctx, args, at);
}

function codexMessageText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((c) => c.text || '').filter(Boolean).join(' ').trim();
}

function handleCodexAgentMessage(ctx, p, at) {
  const raw = codexMessageText(p.content);
  const hit = /^Message Type:\s*(\S+)[\s\S]*?\nPayload:\n?([\s\S]*)$/.exec(raw);
  const msgKind = hit ? hit[1] : 'MESSAGE';
  const body = cleanText(hit ? hit[2] : raw, 600);
  const fromId = resolveAgentId(ctx, p.author);
  const toId = (!p.recipient || p.recipient === '/root') ? 'main' : resolveAgentId(ctx, p.recipient);
  if (msgKind !== 'FINAL_ANSWER') { emitMessage(ctx, fromId, toId, body, at); return; }
  const sub = findAgent(ctx, p.author);
  if (sub && sub.end) upgradeFinishedAgent(ctx, sub, { reply: body });
  else finishAgent(ctx, p.author, { at, status: 'done', reply: body });
}

function handleCodexEventMsg(ctx, p, at) {
  if (p.type === 'thread_settings_applied') {
    ctx.model = shortModel(p.thread_settings?.model) || ctx.model;
    return;
  }
  const item = p.item?.type === 'SubAgentActivity' ? p.item : (p.type === 'SubAgentActivity' ? p : null);
  if (item && item.kind === 'completed') {
    finishAgent(ctx, item.agent_path, { at: p.completed_at_ms || at, status: 'done', reply: '' });
  }
}

function stepCodexResponse(ctx, p, at) {
  if (p.type === 'function_call') {
    if (p.namespace === 'collaboration') handleCodexCollab(ctx, p, at);
    setActivity(ctx, p.name, 'working');
    return;
  }
  if (p.type === 'agent_message') { handleCodexAgentMessage(ctx, p, at); return; }
  if (p.type !== 'message') return;
  const txt = codexMessageText(p.content);
  if (!txt || txt.startsWith('# AGENTS.md')) return;
  setActivity(ctx, txt, p.role === 'user' ? 'working' : 'done');
}

export function parseCodexSession(text) {
  const ctx = makeCtx();
  for (const l of parseJsonLines(text)) {
    const at = parseMs(l.timestamp, ctx.seq);
    const p = l.payload || {};
    if (l.type === 'session_meta') { ctx.sessionId = ctx.sessionId || p.session_id || p.id || null; continue; }
    if (l.type === 'turn_context' && p.model) { ctx.model = shortModel(p.model); continue; }
    if (l.type === 'event_msg') { handleCodexEventMsg(ctx, p, at); continue; }
    if (l.type === 'response_item') stepCodexResponse(ctx, p, at);
  }
  return packCtx(ctx);
}

// ------------------------------------------------------------------ Pi / Epi -----

function isPiSubCall(tc) {
  return tc.type === 'toolCall' && (tc.name === 'subagent' || tc.name === 'task');
}

function piWorkerName(a) {
  return a.agent || a.role || a.name || 'worker';
}

function spawnPiTool(ctx, tc, at) {
  const a = tc.arguments || {};
  const name = piWorkerName(a);
  const sub = addAgent(ctx, { id: tc.id || `pi:${name}`, name, via: name, start: at, prompt: a.task || a.prompt, aliases: [name] });
  emitSpawn(ctx, sub, at, 'main');
}

function piTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((x) => x.type === 'text').map((x) => x.text).join(' ').trim();
}

function stepPiPart(ctx, tc, at) {
  if (isPiSubCall(tc)) spawnPiTool(ctx, tc, at);
  if (tc.type === 'toolCall') setActivity(ctx, (tc.arguments && tc.arguments.task) || tc.name, 'working');
  else if (tc.type === 'text' && tc.text && tc.text.trim()) setActivity(ctx, tc.text, 'done');
}

function handlePiAssistant(ctx, content, at) {
  for (const tc of content) stepPiPart(ctx, tc, at);
}

function handlePiToolResult(ctx, m, at) {
  const sub = m.toolCallId ? findAgent(ctx, m.toolCallId) : null;
  if (!sub) return;
  const txt = (m.details && m.details.result) || piTextOf(m.content);
  if (/^Async:/i.test(txt.trim()) || (m.details && m.details.status === 'running')) return;
  const failed = Boolean(m.isError || (m.details && m.details.status === 'failed'));
  finishAgent(ctx, sub.id, { at, status: failed ? 'failed' : 'done', reply: txt });
}

function stepPiMessage(ctx, m, at) {
  if (m.role === 'user') { setActivity(ctx, piTextOf(m.content), 'working'); return; }
  if (m.role === 'toolResult') { handlePiToolResult(ctx, m, at); return; }
  if (m.role === 'assistant' && Array.isArray(m.content)) handlePiAssistant(ctx, m.content, at);
}

export function parsePiSession(text) {
  const ctx = makeCtx();
  for (const l of parseJsonLines(text)) {
    const at = parseMs(l.timestamp, ctx.seq);
    if (l.type === 'session') { ctx.sessionId = ctx.sessionId || l.id || null; continue; }
    if (l.type === 'model_change') { ctx.model = shortModel(l.modelId) || ctx.model; continue; }
    if (l.type === 'custom_message' && l.customType === 'subagent-notify') {
      const who = (/\*\*([^*]+)\*\*/.exec(l.content || '') || [])[1] || 'worker';
      finishAgent(ctx, who, { at, status: 'done', reply: l.content });
      continue;
    }
    if (l.type === 'message' && l.message) stepPiMessage(ctx, l.message, at);
  }
  return packCtx(ctx);
}

// ------------------------------------------------------------------ Devin --------

function devinMsgText(msg) {
  if (typeof msg === 'string') return msg;
  if (!Array.isArray(msg)) return '';
  return msg.map((b) => b.text || '').filter(Boolean).join(' ').trim();
}

function handleDevinSubNotif(ctx, raw, at) {
  const body = xmlTag(raw, 'subagent_completion_notification');
  if (!body) return false;
  const who = (/agent_id=([^\s\]]+)/.exec(body) || [])[1] || 'sidekick';
  const reply = body.replace(/^\[[^\]]*\]\s*/, '').trim();
  finishAgent(ctx, who, { at, status: 'done', reply });
  return true;
}

function handleDevinSidekick(ctx, args, at) {
  const msg = args.message || args.prompt || '';
  const existing = findAgent(ctx, 'sidekick');
  if (existing) {
    existing.end = null;
    existing.state = 'working';
    emitMessage(ctx, 'main', existing.id, msg, at);
    return;
  }
  const sub = addAgent(ctx, { id: 'sidekick', name: 'sidekick', via: 'sidekick', start: at, prompt: msg });
  emitSpawn(ctx, sub, at, 'main');
}

function spawnDevinSubagent(ctx, tc, args, at) {
  const via = args.subagent_type || args.profile || 'subagent';
  const prompt = args.prompt || args.task || args.message;
  const sub = addAgent(ctx, { id: tc.tool_call_id || `dv-${ctx.seq + 1}`, name: via, via, start: at, prompt });
  emitSpawn(ctx, sub, at, 'main');
}

function spawnDevinExec(ctx, tc, args, at) {
  const cli = detectCliWorker(String(args.command || ''), '');
  if (!cli.via) return;
  const sub = addAgent(ctx, { id: tc.tool_call_id || `dv-${ctx.seq + 1}`, name: cli.via, ...cli, start: at });
  emitSpawn(ctx, sub, at, 'main');
}

function devinCallLabel(fn, args) {
  const fp = args.file_path || args.path;
  return fp ? `${fn} ${basename(String(fp))}` : fn;
}

const DEVIN_CALL_HANDLERS = {
  sidekick: (ctx, _tc, args, at) => handleDevinSidekick(ctx, args, at),
  run_subagent: (ctx, tc, args, at) => spawnDevinSubagent(ctx, tc, args, at),
  exec: (ctx, tc, args, at) => spawnDevinExec(ctx, tc, args, at),
};

function handleDevinToolCall(ctx, tc, at) {
  const fn = tc.function_name || tc.name || 'tool';
  const args = tc.arguments || {};
  setActivity(ctx, devinCallLabel(fn, args), 'working');
  const h = DEVIN_CALL_HANDLERS[fn];
  if (h) h(ctx, tc, args, at);
}

function stepDevinItem(ctx, st) {
  const at = parseMs(st.timestamp, ctx.seq);
  if (st.source === 'user') {
    const txt = devinMsgText(st.message);
    if (!handleDevinSubNotif(ctx, txt, at)) setActivity(ctx, txt, 'working');
    return;
  }
  if (st.source !== 'agent') return;
  if (st.model_name) ctx.model = shortModel(st.model_name);
  const calls = st.tool_calls || [];
  for (const tc of calls) handleDevinToolCall(ctx, tc, at);
  if (calls.length) {
    if (!st.observation && calls.at(-1).function_name === 'ask_user_question') ctx.state = 'blocked';
    return;
  }
  const txt = devinMsgText(st.message);
  if (txt) setActivity(ctx, txt, 'done');
}

export function parseDevinSession(text, sessionId = null) {
  const doc = parseJsonObj(text);
  const ctx = makeCtx(doc.session_id || sessionId, doc.agent?.model_name);
  for (const st of doc.steps || []) stepDevinItem(ctx, st);
  return packCtx(ctx);
}

// ------------------------------------------------------------------ Grok ---------

function stepGrokChat(ctx, l) {
  const txt = piTextOf(l.content);
  if (l.type === 'user') {
    const q = xmlTag(txt, 'user_query');
    if (q) setActivity(ctx, q);
  } else if (l.type === 'assistant' && txt) {
    setActivity(ctx, txt);
  }
}

const GROK_STATES = {
  turn_started: 'working',
  tool_started: 'working',
  permission_requested: 'blocked',
  permission_resolved: 'working',
  turn_ended: 'done',
};

function stepGrokEvent(ctx, e) {
  if (e.model_id) ctx.model = shortModel(e.model_id);
  if (e.type === 'tool_started' && e.tool_name) ctx.activity = e.tool_name;
  const st = GROK_STATES[e.type];
  if (st) ctx.state = st;
}

export function parseGrokSession(summaryJson, eventsJsonl = '', chatJsonl = '', sessionId = null) {
  const sum = parseJsonObj(summaryJson);
  const ctx = makeCtx(sum.info?.id || sessionId, sum.current_model_id);
  for (const l of parseJsonLines(chatJsonl)) stepGrokChat(ctx, l);
  for (const e of parseJsonLines(eventsJsonl)) stepGrokEvent(ctx, e);
  return packCtx(ctx);
}

// ------------------------------------------------------------------ Discovery ----

function parsePsOutput(out) {
  return out.split('\n').map((l) => l.trim().split(/\s+/, 3)).filter((p) => p.length >= 3).map(([pid, ppid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), comm }));
}

function defaultListProcs() {
  try {
    return parsePsOutput(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return []; }
}

function defaultListProcsAsync() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 1500, maxBuffer: 8 << 20 }, (_err, stdout) => {
      resolve(stdout ? parsePsOutput(stdout) : []);
    });
  });
}

function stepLsofLine(byPid, cur, line) {
  if (line.startsWith('p')) return Number(line.slice(1));
  if (line.startsWith('n') && cur) (byPid[cur] ??= []).push(line.slice(1));
  return cur;
}

function parseLsofOutput(out) {
  const byPid = {};
  let cur = 0;
  for (const line of out.split('\n')) cur = stepLsofLine(byPid, cur, line);
  return byPid;
}

export function defaultListOpenFiles(pids) {
  if (!pids.length) return {};
  try {
    const res = spawnSync('/usr/sbin/lsof', ['-Fn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    return res.stdout ? parseLsofOutput(res.stdout) : {};
  } catch { return {}; }
}

export function defaultListOpenFilesAsync(pids) {
  if (!pids.length) return Promise.resolve({});
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-Fn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2500, maxBuffer: 16 << 20 }, (_err, stdout) => {
      resolve(stdout ? parseLsofOutput(stdout) : {});
    });
  });
}

function descendants(rootPid, procs) {
  if (!rootPid) return [];
  const children = new Map();
  for (const p of procs) {
    const arr = children.get(p.ppid) || [];
    arr.push(p.pid);
    children.set(p.ppid, arr);
  }
  const out = [], queue = [rootPid];
  while (queue.length && out.length < 32) {
    const cur = queue.shift();
    out.push(cur);
    for (const kid of children.get(cur) || []) queue.push(kid);
  }
  return out;
}

const JSONL_ROOTS = [
  ['/.claude/projects/', 'claude'],
  ['/.factory/sessions/', 'droid'],
  ['/.codex/sessions/', 'codex'],
  ['/.epi/pi/sessions/', 'pi'],
  ['/.pi/agent/sessions/', 'pi'],
];

function agyTranscriptPath(homeDir, id) {
  return join(homeDir, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

function isAgySubagentConv(homeDir, convId) {
  const brainRoot = join(homeDir, '.gemini', 'antigravity-cli', 'brain');
  if (!existsSync(brainRoot)) return false;
  for (const d of readdirSync(brainRoot)) {
    if (d === convId) continue;
    if (existsSync(join(brainRoot, d, '.system_generated', 'subagents', `${convId}.json`))) return true;
  }
  return false;
}

function matchAgyPresence(paths, homeDir) {
  for (const p of paths) {
    const m = /\/antigravity-cli\/presence\/([0-9a-f-]{36})\.lock$/.exec(p);
    if (!m) continue;
    const id = m[1];
    const file = agyTranscriptPath(homeDir, id);
    if (existsSync(file) || existsSync(join(homeDir, '.gemini', 'antigravity-cli', 'brain', id))) {
      return { kind: 'agy', file, id };
    }
  }
  return null;
}

function matchSpecialOpenPath(p, homeDir) {
  const agy = /\/antigravity-cli\/(?:conversations\/([0-9a-f-]{36})\.db$|brain\/([0-9a-f-]{36})(?:\/|$))/.exec(p);
  if (agy) {
    const id = agy[1] || agy[2];
    if (isAgySubagentConv(homeDir, id)) return null;
    const file = agyTranscriptPath(homeDir, id);
    return existsSync(file) ? { kind: 'agy', file, id } : null;
  }
  const grok = /(\/\.grok\/sessions\/[^/]+\/([^/]+))\//.exec(p);
  if (grok) {
    const dir = join(homeDir, grok[1]);
    const file = join(dir, 'summary.json');
    return existsSync(file) ? { kind: 'grok', file, dir, id: grok[2] } : null;
  }
  if (p.includes('/.local/share/devin/cli/transcripts/') && p.endsWith('.json') && existsSync(p)) {
    return { kind: 'devin', file: p, id: basename(p, '.json') };
  }
  return null;
}

function matchSinglePath(p, homeDir) {
  const special = matchSpecialOpenPath(p, homeDir);
  if (special) return special;
  if (!p.endsWith('.jsonl') || p.includes('/subagents/')) return null;
  for (const [needle, kind] of JSONL_ROOTS) {
    if (p.includes(needle) && existsSync(p)) return { kind, file: p, id: basename(p, '.jsonl') };
  }
  return null;
}

function matchOpenPath(paths, homeDir) {
  const pres = matchAgyPresence(paths, homeDir);
  if (pres) return pres;
  let best = null, bestMs = -1;
  for (const p of paths) {
    const hit = matchSinglePath(p, homeDir);
    if (!hit) continue;
    let ms = 0;
    try { ms = statSync(hit.file).mtimeMs; } catch {}
    if (!best || ms > bestMs) { best = hit; bestMs = ms; }
  }
  return best;
}

function newestEntry(dir, pred, minMtime = 0) {
  if (!existsSync(dir)) return null;
  let best = null, bestMs = minMtime;
  for (const name of readdirSync(dir)) {
    if (!pred(name)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs >= bestMs) { best = full; bestMs = st.mtimeMs; }
    } catch {}
  }
  return best;
}

const newestJsonl = (dir, minMtime = 0) => newestEntry(dir, (n) => n.endsWith('.jsonl'), minMtime);

function matchClaudePidSession(pids, homeDir) {
  for (const pid of pids) {
    const sf = join(homeDir, '.claude', 'sessions', `${pid}.json`);
    if (!existsSync(sf)) continue;
    const meta = parseJsonObj(readFileSync(sf, 'utf8'));
    const slug = String(meta.cwd || '').replace(/[^A-Za-z0-9]/g, '-');
    const file = join(homeDir, '.claude', 'projects', slug, `${meta.sessionId}.jsonl`);
    if (meta.sessionId && slug && existsSync(file)) return { kind: 'claude', file, id: meta.sessionId };
  }
  return null;
}

function matchDevinLockSession(pids, homeDir) {
  const lockDir = join(homeDir, '.local', 'share', 'devin', 'cli', 'session_locks');
  if (!pids.length || !existsSync(lockDir)) return null;
  const pidSet = new Set(pids);
  for (const f of readdirSync(lockDir)) {
    if (!f.endsWith('.lock')) continue;
    const lockPid = Number(String(readFileSync(join(lockDir, f), 'utf8')).trim());
    if (!pidSet.has(lockPid)) continue;
    const id = f.slice(0, -5);
    const file = join(homeDir, '.local', 'share', 'devin', 'cli', 'transcripts', `${id}.json`);
    if (existsSync(file)) return { kind: 'devin', file, id };
  }
  return null;
}

function fallbackPiOrEpi(key, cwd, homeDir, minMtime) {
  const slug = `--${cwd.replace(/^\/+/, '').replace(/\//g, '-')}--`;
  const dirs = key === 'epi'
    ? [join(homeDir, '.epi', 'pi', 'sessions', slug), join(homeDir, '.pi', 'agent', 'sessions', slug)]
    : [join(homeDir, '.pi', 'agent', 'sessions', slug), join(homeDir, '.epi', 'pi', 'sessions', slug)];
  for (const d of dirs) {
    const file = newestJsonl(d, minMtime);
    if (file) return { kind: 'pi', file, id: basename(file, '.jsonl') };
  }
  return null;
}

function fallbackGrokByCwd(cwd, homeDir, minMtime) {
  const root = join(homeDir, '.grok', 'sessions', encodeURIComponent(cwd));
  const subDir = newestEntry(root, (n) => !n.startsWith('.'), minMtime);
  if (!subDir) return null;
  const file = join(subDir, 'summary.json');
  return existsSync(file) ? { kind: 'grok', file, dir: subDir, id: basename(subDir) } : null;
}

function newestSlugJsonl(homeDir, parts, cwd, kind, minMtime) {
  const file = newestJsonl(join(homeDir, ...parts, cwd.replace(/[^A-Za-z0-9]/g, '-')), minMtime);
  return file ? { kind, file, id: basename(file, '.jsonl') } : null;
}

function existingHit(file, kind, extra = {}) {
  return existsSync(file) ? { kind, file, id: kind, ...extra } : null;
}

const CWD_FALLBACKS = {
  claude: (cwd, homeDir, minMtime) => newestSlugJsonl(homeDir, ['.claude', 'projects'], cwd, 'claude', minMtime),
  'claude-code': (cwd, homeDir, minMtime) => newestSlugJsonl(homeDir, ['.claude', 'projects'], cwd, 'claude', minMtime),
  droid: (cwd, homeDir, minMtime) => newestSlugJsonl(homeDir, ['.factory', 'sessions'], cwd, 'droid', minMtime),
  epi: (cwd, homeDir, minMtime) => fallbackPiOrEpi('epi', cwd, homeDir, minMtime),
  pi: (cwd, homeDir, minMtime) => fallbackPiOrEpi('pi', cwd, homeDir, minMtime),
  grok: (cwd, homeDir, minMtime) => fallbackGrokByCwd(cwd, homeDir, minMtime),
  'grok-build': (cwd, homeDir, minMtime) => fallbackGrokByCwd(cwd, homeDir, minMtime),
  devin: (_cwd, homeDir) => existingHit(join(homeDir, '.config', 'devin', 'config.json'), 'devin_cfg'),
  amp: (cwd, homeDir) => existingHit(join(homeDir, '.local', 'share', 'amp', 'session.json'), 'amp', { cwd }),
};

function fallbackByCwd(app, cwd, treePids, homeDir, minMtime = 0) {
  const key = String(app || '').toLowerCase();
  if (key === 'dim' || key === 'dimcode') {
    return existingHit(join(homeDir, '.dimcode', 'v2', 'dimcode.sqlite'), 'dim', { cwd, pids: treePids });
  }
  const fn = cwd ? CWD_FALLBACKS[key] : null;
  return fn ? fn(cwd, homeDir, minMtime) : null;
}

function statSig(p) {
  if (!existsSync(p)) return null;
  try {
    const st = statSync(p);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

function isClaudeSubDone(meta, st) {
  if (meta && typeof meta.finished === 'boolean') return meta.finished;
  if (meta && (meta.toolUseId || meta.spawnDepth != null)) return false;
  return Date.now() - st.mtimeMs > 4000;
}

function statClaudeSubs(file) {
  const subDir = join(file.slice(0, -6), 'subagents');
  if (!existsSync(subDir)) return { sig: '', items: [] };
  const names = readdirSync(subDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')).sort();
  const items = [], sigParts = [];
  const now = Date.now();
  for (const f of names) {
    const aid = f.slice(6, -6);
    const jf = join(subDir, f), st = statSync(jf);
    const mf = join(subDir, `agent-${aid}.meta.json`);
    const mst = existsSync(mf) ? statSync(mf) : null;
    const staleBit = !mst && now - st.mtimeMs > 4000 ? 1 : 0;
    sigParts.push(`${aid}:${st.size}:${Math.floor(st.mtimeMs)}:${mst ? mst.size : 0}:${mst ? Math.floor(mst.mtimeMs) : 0}:${staleBit}`);
    items.push({ aid, jf, st, mf, mst });
  }
  return { sig: sigParts.join(','), items };
}

function readClaudeBundle(file, defaultModel = null) {
  const id = basename(file, '.jsonl');
  const text = readFileSync(file, 'utf8');
  const { sig, items } = statClaudeSubs(file);
  if (!items.length) return { sig: '', parsed: parseClaudeSession(text, {}, id, defaultModel) };
  const subFiles = {};
  for (const { aid, jf, st, mf, mst } of items) {
    const meta = mst ? parseJsonObj(readFileSync(mf, 'utf8')) : null;
    subFiles[aid] = { meta, jsonl: readFileSync(jf, 'utf8'), done: isClaudeSubDone(meta, st) };
  }
  return { sig, parsed: parseClaudeSession(text, subFiles, id, defaultModel) };
}

function droidSig(file) {
  return `${statSig(`${file.slice(0, -6)}.settings.json`) ?? ''}|${statClaudeSubs(file).sig}`;
}

function readDroidBundle(file) {
  const sf = `${file.slice(0, -6)}.settings.json`;
  const settings = existsSync(sf) ? parseJsonObj(readFileSync(sf, 'utf8')) : {};
  const claude = readClaudeBundle(file, settings.model || null);
  return { sig: `${statSig(sf) ?? ''}|${claude.sig}`, parsed: claude.parsed };
}

function decodeProtoField21(buf) {
  for (let i = buf.length - 4; i >= Math.max(0, buf.length - 160); i--) {
    if (buf[i] !== 0xaa || buf[i + 1] !== 0x01) continue;
    const len = buf[i + 2];
    if (len <= 2 || len >= 64 || i + 3 + len > buf.length) continue;
    const s = buf.subarray(i + 3, i + 3 + len).toString('utf8');
    if (/^[\x20-\x7e]+$/.test(s)) return s;
  }
  return null;
}

function readAgyDbModel(dbPath) {
  const db = openSqliteRo(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get();
    return row?.data ? decodeProtoField21(Buffer.from(row.data)) : null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

function readAgyModel(id, homeDir) {
  const base = join(homeDir, '.gemini', 'antigravity-cli');
  const dbHit = readAgyDbModel(join(base, 'conversations', `${id}.db`));
  if (dbHit) return dbHit;
  const sf = join(base, 'settings.json');
  return existsSync(sf) ? parseJsonObj(readFileSync(sf, 'utf8')).model || null : null;
}

function agyPaths(id, homeDir) {
  const base = join(homeDir, '.gemini', 'antigravity-cli');
  const swarmDir = join(base, 'brain', id, '.system_generated', 'swarm');
  return {
    dbPath: join(base, 'conversations', `${id}.db`),
    settingsPath: join(base, 'settings.json'),
    swarmDir,
    membersFile: join(swarmDir, 'members.json'),
    boardFile: join(swarmDir, 'board.jsonl'),
  };
}

function buildAgySig(paths, childIds, smSig, sbSig, swarmWorkers, homeDir) {
  const parts = [`db:${statSig(paths.dbPath) ?? ''}`, `cfg:${statSig(paths.settingsPath) ?? ''}`];
  for (const cid of childIds) {
    const cs = statSig(agyTranscriptPath(homeDir, cid));
    if (cs) parts.push(`${cid}:${cs}`);
  }
  if (smSig) parts.push(`sm:${smSig}`);
  if (sbSig) parts.push(`sb:${sbSig}`);
  for (const [name, cid] of swarmWorkers) {
    const ws = statSig(agyTranscriptPath(homeDir, cid));
    if (ws) parts.push(`sw:${name}:${ws}`);
  }
  return parts.join(',');
}

function agyFastSig(hit, baseSig, prev, homeDir) {
  if (!prev || prev.baseSig !== baseSig || !prev.meta) return null;
  const paths = agyPaths(hit.id, homeDir);
  const smSig = statSig(paths.membersFile) ?? '';
  if (smSig !== prev.meta.smSig) return null;
  const sbSig = statSig(paths.boardFile) ?? '';
  return buildAgySig(paths, prev.meta.childIds, smSig, sbSig, prev.meta.swarmWorkers, homeDir);
}

function readAgySwarmBundle(paths, homeDir) {
  if (!existsSync(paths.swarmDir)) return { swarm: null, smSig: '', sbSig: '', swarmWorkers: [] };
  const smSig = statSig(paths.membersFile) ?? '';
  const sbSig = statSig(paths.boardFile) ?? '';
  const members = smSig ? (parseJsonObj(readFileSync(paths.membersFile, 'utf8')).members || {}) : {};
  const board = sbSig ? readFileSync(paths.boardFile, 'utf8') : '';
  const workerTranscripts = {}, swarmWorkers = [];
  for (const [name, m] of Object.entries(members)) {
    if (name === 'coordinator' || m.role === 'coordinator' || !m.conversation_id) continue;
    swarmWorkers.push([name, m.conversation_id]);
    const wf = agyTranscriptPath(homeDir, m.conversation_id);
    if (existsSync(wf)) workerTranscripts[name] = readFileSync(wf, 'utf8');
  }
  return { swarm: { members, board, workerTranscripts }, smSig, sbSig, swarmWorkers };
}

function readAgyBundle(file, id, homeDir) {
  const text = readFileSync(file, 'utf8');
  const paths = agyPaths(id, homeDir);
  const childIds = [...text.matchAll(/"conversationId":\s*"([0-9a-f-]{36})"/g)].map((m) => m[1]).slice(0, 12);
  const childTranscripts = {};
  for (const cid of childIds) {
    const cf = agyTranscriptPath(homeDir, cid);
    if (existsSync(cf)) childTranscripts[cid] = readFileSync(cf, 'utf8');
  }
  const { swarm, smSig, sbSig, swarmWorkers } = readAgySwarmBundle(paths, homeDir);
  const model = readAgyModel(id, homeDir);
  const sig = buildAgySig(paths, childIds, smSig, sbSig, swarmWorkers, homeDir);
  return {
    sig,
    meta: { childIds, smSig, swarmWorkers },
    parsed: parseAgySession(text, { sessionId: id, model, childTranscripts, swarm }),
  };
}

function grokSig(hit) {
  const dir = hit.dir || dirname(hit.file);
  return `${statSig(join(dir, 'events.jsonl')) ?? ''}:${statSig(join(dir, 'chat_history.jsonl')) ?? ''}`;
}

function readGrokBundle(hit) {
  const dir = hit.dir || dirname(hit.file);
  const ef = join(dir, 'events.jsonl'), cf = join(dir, 'chat_history.jsonl');
  const sum = readFileSync(hit.file, 'utf8');
  const ev = existsSync(ef) ? readFileSync(ef, 'utf8') : '';
  const ch = existsSync(cf) ? readFileSync(cf, 'utf8') : '';
  return { sig: grokSig(hit), parsed: parseGrokSession(sum, ev, ch, hit.id) };
}

function findDimRow(db, pids, cwd) {
  for (const pid of pids || []) {
    const hit = db.prepare('SELECT sessionId, title, status FROM sessions WHERE heldBy LIKE ? ORDER BY updatedAt DESC LIMIT 1').get(`cli-${pid}@%`);
    if (hit) return hit;
  }
  return cwd ? db.prepare('SELECT sessionId, title, status FROM sessions WHERE cwd = ? ORDER BY updatedAt DESC LIMIT 1').get(cwd) : null;
}

function applyDimRelations(db, ctx, sid) {
  const rows = db.prepare(`
    SELECT s.sessionId, s.title, s.status, s.createdAt, s.updatedAt
    FROM session_relations r JOIN sessions s ON s.sessionId = r.targetSessionId
    WHERE r.sourceSessionId = ?
  `).all(sid);
  for (const r of rows) {
    const at = parseMs(r.createdAt, ctx.seq);
    const sub = addAgent(ctx, { id: r.sessionId, name: r.title || r.sessionId, via: 'dim', start: at });
    emitSpawn(ctx, sub, at, 'main');
    if (r.status && r.status !== 'active') finishAgent(ctx, sub.id, { at: parseMs(r.updatedAt, at), status: r.status === 'failed' ? 'failed' : 'done' });
  }
}

function parsePartsText(raw) {
  try { return piTextOf(JSON.parse(raw || '[]')); } catch { return ''; }
}

function applyDimLastMsg(ctx, sess, lastMsg) {
  if (!lastMsg) { setActivity(ctx, sess.title, 'idle'); return; }
  setActivity(ctx, parsePartsText(lastMsg.parts) || sess.title, lastMsg.role === 'user' ? 'working' : 'done');
}

function dimSig(hit) {
  return `${statSig(`${hit.file}-wal`) ?? ''}:${statSig(`${hit.file}-shm`) ?? ''}:${hit.cwd || ''}:${(hit.pids || []).join(',')}`;
}

function queryDimSession(db, hit) {
  const sess = findDimRow(db, hit.pids, hit.cwd);
  if (!sess) return { sig: dimSig(hit), parsed: packCtx(makeCtx()) };
  const st = db.prepare('SELECT selectedModelId FROM session_states WHERE sessionId = ?').get(sess.sessionId);
  const lastMsg = db.prepare('SELECT rowid, role, parts FROM messages WHERE sessionId = ? ORDER BY rowid DESC LIMIT 1').get(sess.sessionId);
  const ctx = makeCtx(sess.sessionId, st ? st.selectedModelId : null);
  applyDimLastMsg(ctx, sess, lastMsg);
  applyDimRelations(db, ctx, sess.sessionId);
  return { sig: dimSig(hit), parsed: packCtx(ctx) };
}

function readDimBundle(hit) {
  const db = openSqliteRo(hit.file);
  if (!db) return { sig: dimSig(hit), parsed: packCtx(makeCtx()) };
  try { return queryDimSession(db, hit); }
  catch { return { sig: dimSig(hit), parsed: packCtx(makeCtx()) }; }
  finally { try { db.close(); } catch {} }
}

function ampSig(hit, homeDir) {
  return `${hit.cwd || ''}:${statSig(join(homeDir, '.local', 'share', 'amp', 'history.jsonl')) ?? ''}`;
}

function readAmpBundle(hit, homeDir) {
  const sess = parseJsonObj(readFileSync(hit.file, 'utf8'));
  const ctx = makeCtx('amp', sess.externalAgentModel || sess.pluginAgentModeKey);
  const hf = join(homeDir, '.local', 'share', 'amp', 'history.jsonl');
  if (existsSync(hf) && statSync(hf).size > 0) {
    const matched = parseJsonLines(readFileSync(hf, 'utf8')).filter((x) => !hit.cwd || x.cwd === hit.cwd);
    if (matched.length) setActivity(ctx, matched.at(-1).text);
  }
  return { sig: ampSig(hit, homeDir), parsed: packCtx(ctx) };
}

function resolveOpenHit(treePids, procSnap, listOpenFiles, homeDir) {
  if (!treePids.length) return null;
  const pidHit = matchClaudePidSession(treePids, homeDir) || matchDevinLockSession(treePids, homeDir);
  if (pidHit) return pidHit;
  const missing = treePids.filter((p) => !procSnap.openByPid.has(p));
  if (missing.length) {
    const opened = listOpenFiles(missing);
    for (const p of missing) procSnap.openByPid.set(p, opened[p] || []);
  }
  return matchOpenPath(treePids.flatMap((p) => procSnap.openByPid.get(p) || []), homeDir);
}

const BUNDLE_READERS = {
  claude: (hit) => readClaudeBundle(hit.file),
  droid: (hit) => readDroidBundle(hit.file),
  agy: (hit, homeDir) => readAgyBundle(hit.file, hit.id, homeDir),
  grok: (hit) => readGrokBundle(hit),
  dim: (hit) => readDimBundle(hit),
  amp: (hit, homeDir) => readAmpBundle(hit, homeDir),
  devin_cfg: (hit) => ({ sig: '', parsed: packCtx(makeCtx('devin', parseJsonObj(readFileSync(hit.file, 'utf8')).agent?.model)) }),
};

const BUNDLE_SIGS = {
  claude: (hit) => statClaudeSubs(hit.file).sig,
  droid: (hit) => droidSig(hit.file),
  agy: (hit, baseSig, prev, homeDir) => agyFastSig(hit, baseSig, prev, homeDir),
  grok: (hit) => grokSig(hit),
  dim: (hit) => dimSig(hit),
  amp: (hit, _baseSig, _prev, homeDir) => ampSig(hit, homeDir),
  devin_cfg: () => '',
};

const RAW_PARSERS = {
  codex: (raw) => parseCodexSession(raw),
  pi: (raw) => parsePiSession(raw),
  devin: (raw, id) => parseDevinSession(raw, id),
};

function parseHitBundle(hit, baseSig, prev, homeDir) {
  const bundleFn = BUNDLE_READERS[hit.kind];
  if (bundleFn) {
    const fastSub = BUNDLE_SIGS[hit.kind]?.(hit, baseSig, prev, homeDir);
    if (fastSub !== null && fastSub !== undefined) {
      const fastFull = `${baseSig}|${fastSub}`;
      if (prev && prev.fullSig === fastFull) return { fullSig: fastFull, meta: prev.meta ?? null, result: prev.result };
    }
    const bundle = bundleFn(hit, homeDir);
    const fullSig = `${baseSig}|${bundle.sig}`;
    if (prev && prev.fullSig === fullSig) return { fullSig, meta: bundle.meta ?? prev.meta ?? null, result: prev.result };
    return { fullSig, meta: bundle.meta ?? null, result: bundle.parsed };
  }
  if (prev && prev.baseSig === baseSig) return { fullSig: baseSig, meta: null, result: prev.result };
  const raw = readFileSync(hit.file, 'utf8');
  const result = RAW_PARSERS[hit.kind](raw, hit.id);
  result.sessionId = result.sessionId || hit.id;
  return { fullSig: baseSig, meta: null, result };
}

function termBindKey(term) {
  return `${term.pid || 0}|${term.app || ''}|${term.cwd || ''}`;
}

function isFreshBound(prev, key, now) {
  return Boolean(prev) && prev.key === key && now - prev.checkedAt < 4000;
}

function refreshProcSnap(state, now, listProcs) {
  if (now - state.procSnap.at > 2500) {
    state.procSnap = { at: now, procs: listProcs(), openByPid: new Map() };
  }
}

async function refreshProcSnapAsync(state, now, listProcsAsync) {
  if (now - state.procSnap.at > 2500) {
    const procs = await listProcsAsync();
    state.procSnap = { at: now, procs, openByPid: new Map() };
  }
}

function staleTermsOf(state, terms, now) {
  return terms.filter((term) => !isFreshBound(state.bound.get(term.address), termBindKey(term), now));
}

function planBatchBind(state, stale, homeDir) {
  const entries = [];
  const missingPids = new Set();
  for (const term of stale) {
    const key = termBindKey(term);
    const treePids = descendants(term.pid, state.procSnap.procs);
    const fastHit = treePids.length
      ? (matchClaudePidSession(treePids, homeDir) || matchDevinLockSession(treePids, homeDir))
      : null;
    if (!fastHit) {
      for (const p of treePids) if (!state.procSnap.openByPid.has(p)) missingPids.add(p);
    }
    entries.push({ term, key, treePids, fastHit });
  }
  return { entries, missingPids: [...missingPids] };
}

function recordOpenFiles(openByPid, pids, opened) {
  for (const p of pids) openByPid.set(p, opened[p] || []);
}

function finishBatchBind(state, entries, now, homeDir) {
  for (const { term, key, treePids, fastHit } of entries) {
    const minMtime = Number(term.since) > 0 ? Number(term.since) - 5000 : 0;
    const hit = fastHit
      || (treePids.length ? matchOpenPath(treePids.flatMap((p) => state.procSnap.openByPid.get(p) || []), homeDir) : null)
      || fallbackByCwd(term.app, term.cwd, treePids, homeDir, minMtime);
    state.bound.set(term.address, { key, hit, checkedAt: now });
  }
}

function resolveTermHit(state, term, now, deps) {
  const key = termBindKey(term);
  const prev = state.bound.get(term.address);
  if (isFreshBound(prev, key, now)) return prev.hit;
  refreshProcSnap(state, now, deps.listProcs);
  const treePids = descendants(term.pid, state.procSnap.procs);
  const minMtime = Number(term.since) > 0 ? Number(term.since) - 5000 : 0;
  const hit = resolveOpenHit(treePids, state.procSnap, deps.listOpenFiles, deps.homeDir)
    || fallbackByCwd(term.app, term.cwd, treePids, deps.homeDir, minMtime);
  state.bound.set(term.address, { key, hit, checkedAt: now });
  return hit;
}

function cacheKeyOf(hit) {
  return `${hit.file}|${hit.cwd || ''}`;
}

function readHitCached(cache, hit, homeDir) {
  if (!hit || !existsSync(hit.file)) return null;
  try {
    const st = statSync(hit.file);
    const baseSig = `${st.size}:${Math.floor(st.mtimeMs)}`;
    const ck = cacheKeyOf(hit);
    const next = parseHitBundle(hit, baseSig, cache.get(ck), homeDir);
    cache.set(ck, { baseSig, fullSig: next.fullSig, meta: next.meta, result: next.result });
    return next.result;
  } catch {
    return null;
  }
}

/** Cached, incremental session reader keyed by herdr-core terminal facts. */
export function createSessionReader({
  homeDir = homedir(),
  listProcs = defaultListProcs,
  listOpenFiles = defaultListOpenFiles,
  listProcsAsync = defaultListProcsAsync,
  listOpenFilesAsync = defaultListOpenFilesAsync,
} = {}) {
  const state = { procSnap: { at: -Infinity, procs: [], openByPid: new Map() }, bound: new Map(), cache: new Map(), inflight: null };
  const deps = { homeDir, listProcs, listOpenFiles, listProcsAsync, listOpenFilesAsync };

  function prepare(terms, now = Date.now()) {
    const stale = staleTermsOf(state, terms, now);
    if (!stale.length) return;
    refreshProcSnap(state, now, deps.listProcs);
    const { entries, missingPids } = planBatchBind(state, stale, homeDir);
    if (missingPids.length) recordOpenFiles(state.procSnap.openByPid, missingPids, deps.listOpenFiles(missingPids));
    finishBatchBind(state, entries, now, homeDir);
  }

  function prepareAsync(terms, now = Date.now()) {
    const stale = staleTermsOf(state, terms, now);
    if (!stale.length) return Promise.resolve();
    if (state.inflight) return state.inflight;
    state.inflight = (async () => {
      await refreshProcSnapAsync(state, now, deps.listProcsAsync);
      const { entries, missingPids } = planBatchBind(state, stale, homeDir);
      if (missingPids.length) recordOpenFiles(state.procSnap.openByPid, missingPids, await deps.listOpenFilesAsync(missingPids));
      finishBatchBind(state, entries, now, homeDir);
    })().finally(() => { state.inflight = null; });
    return state.inflight;
  }

  return {
    read(term, now = Date.now()) {
      return readHitCached(state.cache, resolveTermHit(state, term, now, deps), homeDir);
    },
    readBound(term) {
      const prev = state.bound.get(term.address);
      return prev ? readHitCached(state.cache, prev.hit, homeDir) : null;
    },
    needsPrepare(terms, now = Date.now()) {
      return staleTermsOf(state, terms, now).length > 0;
    },
    prepare,
    prepareAsync,
  };
}
