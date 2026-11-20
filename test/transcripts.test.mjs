// Multi-agent local session transcript parsers & PID/cwd resolver (host/transcripts.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionReader,
  defaultListOpenFilesAsync,
  parseAgySession,
  parseClaudeSession,
  parseCodexSession,
  parseDevinSession,
  parseGrokSession,
  parsePiSession,
} from '../host/transcripts.js';

const lines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

test('Claude parser extracts prompts, Agent spawns, Team SendMessage, cross-CLI background workers, and merges', () => {
  const main = lines(
    { type: 'api-request-shape', sessionId: 'c-1', timestamp: '2026-11-12T04:00:00.000Z' },
    {
      type: 'user', uuid: 'u1', timestamp: '2026-11-12T04:00:01.000Z',
      message: { role: 'user', content: '排查内存泄漏并让 reviewer 审查' },
    },
    {
      type: 'assistant', timestamp: '2026-11-12T04:00:05.000Z',
      message: {
        model: 'group/auto-claude-fable-5-2',
        role: 'assistant',
        content: [
          {
            type: 'tool_use', id: 'tu_ag1', name: 'Agent',
            input: { subagent_type: 'Explore', model: 'sonnet', description: '查 WebKit 泄漏', prompt: 'Inspect WebKit footprint in Cage.swift' },
          },
          {
            type: 'tool_use', id: 'tu_bg1', name: 'Bash',
            input: { run_in_background: true, description: 'Run AGY job with Carbon', command: 'agy --model carbon -p "audit vm"' },
          },
        ],
      },
    },
    {
      type: 'user', timestamp: '2026-11-12T04:00:06.000Z',
      toolUseResult: { agentId: 'ag_hex1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ag1', content: 'Async agent launched' }] },
    },
    {
      type: 'user', timestamp: '2026-11-12T04:00:06.500Z',
      toolUseResult: { backgroundTaskId: 'bg_task1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bg1', content: 'Command running in background' }] },
    },
    {
      type: 'assistant', timestamp: '2026-11-12T04:00:10.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_sm1', name: 'SendMessage', input: { to: 'Explore', summary: '补充看 WKURLSchemeHandler', message: 'Check WKURLSchemeHandler buffer retention too' } }],
      },
    },
    {
      type: 'user', uuid: 'u_tm', timestamp: '2026-11-12T04:00:15.000Z',
      message: { role: 'user', content: '<teammate-message teammate_id="Explore" summary="发现 8GB WebKit Malloc">WKURLSchemeHandler retains chunks</teammate-message>' },
    },
    {
      type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-12T04:00:20.000Z',
      content: '<task-notification>\n<task-id>bg_task1</task-id>\n<tool-use-id>tu_bg1</tool-use-id>\n<status>completed</status>\n<summary>Background command finished with exit code 0: VM audit clean</summary>\n</task-notification>',
    },
  );
  const subFiles = {
    ag_hex1: {
      meta: { agentType: 'Explore', description: '查 WebKit 泄漏', model: 'sonnet' },
      jsonl: lines(
        { type: 'user', timestamp: '2026-11-12T04:00:06.100Z', message: { role: 'user', content: 'Inspect WebKit footprint' } },
        { type: 'assistant', timestamp: '2026-11-12T04:00:18.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Root cause: ServeDesktop double-hop buffers.' }] } },
      ),
      done: true,
    },
  };

  const out = parseClaudeSession(main, subFiles);
  assert.equal(out.sessionId, 'c-1');
  assert.equal(out.model, 'fable-5-2');
  assert.equal(out.activity, '补充看 WKURLSchemeHandler');
  assert.equal(out.agents.length, 2);
  const [explore, agyBg] = out.agents;
  assert.deepEqual([explore.name, explore.via, explore.model, explore.state], ['查 WebKit 泄漏', 'Explore', 'sonnet', 'done']);
  assert.match(explore.reply, /ServeDesktop double-hop/);
  assert.deepEqual([agyBg.via, agyBg.model, agyBg.state], ['agy', 'carbon', 'done']);
  assert.deepEqual(out.events.map((e) => e.kind), ['spawn', 'spawn', 'message', 'message', 'return', 'return']);
});

test('Antigravity parser extracts invoke_subagent, send_message, swarm workers, and SYSTEM_MESSAGE replies', () => {
  const main = lines(
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-12T08:00:00Z', content: '<USER_REQUEST>\n帮我并行审计前后端\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>' },
    {
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-12T08:00:02Z',
      tool_calls: [
        { name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Frontend Auditor"', Model: '"pro"', Prompt: '"Audit ui/src memory leaks"' } },
        { name: 'swarm', args: { action: 'add', name: 'verifier', model: 'flash', brief: 'Run test suite in share workspace' } },
      ],
    },
    {
      step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-12T08:00:03Z',
      content: 'Created At: 2026-11-12T16:00:03+08:00\nCreated the following subagent:\n{\n  "conversationId": "conv-sub-1",\n  "logAbsoluteUri": "file:///tmp/conv-sub-1/transcript.jsonl"\n}',
    },
    {
      step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-12T08:01:00Z',
      tool_calls: [{ name: 'send_message', args: { Recipient: 'conv-sub-1', Message: 'Also check Safari WebSocket closures' } }],
    },
    {
      step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: '2026-11-12T08:02:00Z',
      content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-12T08:02:00Z sender=conv-sub-1 priority=MESSAGE_PRIORITY_HIGH content=# Frontend Leak Report\n\nFound unclosed EventSource in `app.ts`.\n</SYSTEM_MESSAGE>',
    },
    {
      step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-12T08:02:10Z',
      tool_calls: [{ name: 'swarm', args: { action: 'kill', name: 'verifier' } }],
    },
  );

  const out = parseAgySession(main, { sessionId: 'agy-main' });
  assert.equal(out.sessionId, 'agy-main');
  assert.equal(out.agents.length, 2);
  const [fe, sw] = out.agents;
  assert.deepEqual([fe.id, fe.name, fe.via, fe.model, fe.state], ['conv-sub-1', 'Frontend Auditor', 'research', 'pro', 'done']);
  assert.match(fe.reply, /Frontend Leak Report/);
  assert.deepEqual([sw.name, sw.via, sw.state], ['verifier', 'swarm', 'stopped']);
  assert.deepEqual(out.events.map((e) => e.kind), ['spawn', 'spawn', 'message', 'return', 'return']);
  assert.equal(out.events[2].to, 'conv-sub-1');
});

test('Codex parser extracts collaboration spawn_agent/send_message and strips encrypted Fernet blobs', () => {
  const text = lines(
    { timestamp: '2026-11-12T05:00:00Z', type: 'session_meta', payload: { session_id: 'cx-1', cwd: '/w/app' } },
    { timestamp: '2026-11-12T05:00:01Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra' } } },
    { timestamp: '2026-11-12T05:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /w/app' }] } },
    { timestamp: '2026-11-12T05:00:03Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '并行 review 渲染与业务模块' }] } },
    {
      timestamp: '2026-11-12T05:00:05Z', type: 'response_item',
      payload: { type: 'function_call', call_id: 'fc1', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'review_render', message: 'gAAAAABq0NeYgIQTd-JU4UQGPhD_Ql4m3IZnGNT6LV5L-EKzMVTw' }) },
    },
    { timestamp: '2026-11-12T05:00:06Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'fc1', output: JSON.stringify({ task_name: '/root/review_render' }) } },
    {
      timestamp: '2026-11-12T05:00:10Z', type: 'response_item',
      payload: { type: 'function_call', call_id: 'fc2', name: 'send_message', namespace: 'collaboration', arguments: JSON.stringify({ target: 'review_render', message: 'gAAAAABq0NfM2E_BtVIx3zDZPrZGLzsoRoCtA5i5W5fDh' }) },
    },
    {
      timestamp: '2026-11-12T05:00:20Z', type: 'response_item',
      payload: { type: 'function_call', call_id: 'fc3', name: 'close_agent', namespace: 'collaboration', arguments: JSON.stringify({ target: 'review_render' }) },
    },
  );
  const out = parseCodexSession(text);
  assert.equal(out.model, 'gpt-6-astra');
  assert.equal(out.agents.length, 1);
  assert.equal(out.agents[0].name, 'review_render');
  assert.equal(out.agents[0].prompt, null, 'encrypted payload leaves prompt empty rather than filler text');
  assert.deepEqual(out.events.map((e) => e.kind), ['spawn', 'message', 'return']);
  assert.deepEqual(out.events.map((e) => e.summary || ''), ['', '', ''], 'no Spawned/Message to/Completed filler captions');
});

test('Pi/Epi parser extracts subagent toolCall and subagent-notify completion', () => {
  const text = lines(
    { type: 'session', id: 'pi-1', timestamp: '2026-11-12T06:00:00Z', cwd: '/w/app' },
    { type: 'model_change', timestamp: '2026-11-12T06:00:00Z', modelId: 'factory/gpt-6-astra' },
    { type: 'message', timestamp: '2026-11-12T06:00:01Z', message: { role: 'user', content: [{ type: 'text', text: '派后台 worker 跑检查' }] } },
    { type: 'message', timestamp: '2026-11-12T06:00:02Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'subagent', arguments: { agent: 'worker', task: 'Run lint & tests' } }] } },
    { type: 'message', timestamp: '2026-11-12T06:00:03Z', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'subagent', content: [{ type: 'text', text: 'Async: worker [run-123]' }] } },
    { type: 'custom_message', customType: 'subagent-notify', timestamp: '2026-11-12T06:00:15Z', content: 'Background task completed: **worker**\n\nworker:\nAll 42 checks passed.' },
  );
  const out = parsePiSession(text);
  assert.equal(out.model, 'gpt-6-astra');
  assert.equal(out.agents.length, 1);
  assert.deepEqual([out.agents[0].name, out.agents[0].state], ['worker', 'done']);
  assert.match(out.agents[0].reply, /All 42 checks passed/);
  assert.deepEqual(out.events.map((e) => e.kind), ['spawn', 'return']);
});

test('createSessionReader maps terminal PID via open files and falls back to cwd matching', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  // 1. AGY transcript + conversation DB model + live toolSummary activity resolved via lsof
  const agyConv = '8ca11314-a55b-4d08-998f-1406206150dc';
  const agyBase = join(home, '.gemini', 'antigravity-cli');
  const agyLog = join(agyBase, 'brain', agyConv, '.system_generated', 'logs');
  const agyConvDir = join(agyBase, 'conversations');
  mkdirSync(agyLog, { recursive: true });
  mkdirSync(agyConvDir, { recursive: true });
  writeFileSync(join(agyBase, 'settings.json'), JSON.stringify({ model: 'Claude Opus 5.5 (High)' }));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(agyConvDir, `${agyConv}.db`));
  db.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob)');
  const modelStr = 'Gemini 4 Carbon (High)';
  const proto = Buffer.concat([Buffer.from([0xaa, 0x01, Buffer.byteLength(modelStr)]), Buffer.from(modelStr)]);
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, proto);
  db.close();
  writeFileSync(join(agyLog, 'transcript.jsonl'), lines(
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-12T08:00:00Z', content: '<USER_REQUEST>\nHello AGY\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-12T08:00:02Z', tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Run unit test suite' } }] },
  ));

  // 2. Claude transcript resolved via cwd project directory
  const claudeDir = join(home, '.claude', 'projects', '-Users-me-repo');
  mkdirSync(claudeDir, { recursive: true });
  const cf = join(claudeDir, 'sess-claude.jsonl');
  writeFileSync(cf, lines(
    { type: 'user', uuid: 'u1', timestamp: '2026-11-12T08:05:00Z', message: { role: 'user', content: 'Hello Claude' } },
  ));
  const t = new Date('2026-11-12T08:05:05Z');
  utimesSync(cf, t, t);

  const reader = createSessionReader({
    homeDir: home,
    listProcs: () => [{ pid: 200, ppid: 100, comm: 'agy' }],
    listOpenFiles: (pids) => (pids.includes(200) ? { 200: [`${home}/.gemini/antigravity-cli/conversations/${agyConv}.db`] } : {}),
  });

  const agy = reader.read({ address: 't1', pid: 100, app: 'antigravity', cwd: '/Users/me/other', since: Date.parse('2026-11-12T07:59:00Z') }, Date.parse('2026-11-12T08:01:00Z'));
  assert.equal(agy?.sessionId, agyConv);
  assert.equal(agy?.model, 'Gemini 4 Carbon (High)');
  assert.equal(agy?.activity, 'Run unit test suite');
  assert.deepEqual(agy?.events, []);

  const claude = reader.read({ address: 't2', pid: 300, app: 'claude-code', cwd: '/Users/me/repo', since: Date.parse('2026-11-12T08:00:00Z') }, Date.parse('2026-11-12T08:06:00Z'));
  assert.equal(claude?.sessionId, 'sess-claude');
  assert.deepEqual(claude?.events, []);

  // 3. Claude PID session file + subagents/ bundle + Codex open jsonl + Pi cwd fallback
  const sessDir = join(home, '.claude', 'sessions');
  const subDir = join(claudeDir, 'sess-claude', 'subagents');
  mkdirSync(sessDir, { recursive: true });
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(sessDir, '401.json'), JSON.stringify({ sessionId: 'sess-claude', cwd: '/Users/me/repo' }));
  writeFileSync(cf, lines(
    { type: 'user', uuid: 'u1', timestamp: '2026-11-12T08:05:00Z', message: { role: 'user', content: 'Hello Claude' } },
    { type: 'assistant', timestamp: '2026-11-12T08:05:01Z', message: { content: [{ type: 'tool_use', id: 'tu-a1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Scan', prompt: 'Go' } }] } },
    { type: 'user', timestamp: '2026-11-12T08:05:02Z', toolUseResult: { agentId: 'a1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tu-a1', content: 'Async agent launched' }] } },
  ));
  writeFileSync(join(subDir, 'agent-a1.meta.json'), JSON.stringify({ model: 'claude-haiku-4-5' }));
  const subFile = join(subDir, 'agent-a1.jsonl');
  writeFileSync(subFile, lines({ type: 'assistant', timestamp: '2026-11-12T08:05:10Z', message: { content: [{ type: 'text', text: 'Subagent finished scan' }] } }));
  const old = new Date(Date.now() - 10_000);
  utimesSync(subFile, old, old);

  const codexDir = join(home, '.codex', 'sessions', '2026');
  mkdirSync(codexDir, { recursive: true });
  const codexFile = join(codexDir, 'cx-live.jsonl');
  writeFileSync(codexFile, lines({ timestamp: '2026-11-12T08:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Codex task' }] } }));

  const piDir = join(home, '.pi', 'agent', 'sessions', '--Users-me-repo--');
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, 'pi-live.jsonl'), lines({ type: 'message', timestamp: '2026-11-12T08:00:00Z', message: { role: 'user', content: 'Pi task' } }));

  const reader2 = createSessionReader({
    homeDir: home,
    listProcs: () => [{ pid: 401, ppid: 400, comm: 'claude' }, { pid: 501, ppid: 500, comm: 'codex' }],
    listOpenFiles: (pids) => (pids.includes(501) ? { 501: [codexFile] } : {}),
  });
  const claude2 = reader2.read({ address: 't3', pid: 400, app: 'claude-code', cwd: '/Users/me/other' }, 10_000);
  assert.equal(claude2?.agents[0]?.model, 'claude-haiku-4-5');
  assert.equal(claude2?.agents[0]?.state, 'done');
  assert.match(claude2?.agents[0]?.reply ?? '', /Subagent finished scan/);

  const cx = reader2.read({ address: 't4', pid: 500, app: 'codex', cwd: '/Users/me/repo' }, 10_000);
  assert.equal(cx?.sessionId, 'cx-live');
  const pi = reader2.read({ address: 't5', pid: 999, app: 'epi', cwd: '/Users/me/repo' }, 10_000);
  assert.equal(pi?.sessionId, 'pi-live');
});

test('Antigravity parser handles nested childTranscripts, CLI workers, and manage_subagents kill_all', () => {
  const main = lines(
    {
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-12T08:00:00Z',
      tool_calls: [
        { name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Lead', Model: 'inherit', Prompt: 'Coordinate' } },
        { name: 'run_command', args: { CommandLine: 'hc run -- claude -p "sub check"', toolSummary: 'Spawn hc child' } },
      ],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-12T08:00:01Z', content: '{"conversationId": "lead-1"}' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-12T08:00:10Z', tool_calls: [{ name: 'manage_subagents', args: { Action: 'kill_all' } }] },
  );
  const child = lines(
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-12T08:00:05Z', tool_calls: [{ name: 'swarm', args: { action: 'add', name: 'helper', tasks: ['slice-a', 'slice-b'], brief: 'Verify' } }] },
  );
  const out = parseAgySession(main, { sessionId: 'agy-2', childTranscripts: { 'lead-1': child } });
  assert.equal(out.agents.length, 4);
  assert.equal(out.agents[0].state, 'stopped');
  assert.equal(out.agents[1].via, 'hc');
  assert.equal(out.agents[2].parentAgent, 'lead-1');
  assert.equal(out.agents[3].name, 'helper-2');

  // Shell inspection commands (--help, strings, hc get) must NOT create bogus subagents,
  // whereas `hc send --if idle t5w` captures split-pane Reviewer communication cleanly.
  const shellNoise = lines(
    {
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-12T09:00:00Z',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'agy --help; codex --help; droid --help', toolSummary: 'Check agy, codex, claude help' } },
        { name: 'run_command', args: { CommandLine: 'env -u HC_TERMINAL_ID hc send --if idle t5w "请完整阅读 proposal.md 做独立评审"', toolSummary: 'Send review task to Claude in t5w' } },
      ],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-12T09:00:01Z', content: 'Usage: agy ...' },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-12T09:00:02Z', content: 'Created At: 2026-11-12T09:00:02Z\nCommand exited with code 0.\n\nCommand output:\nsent at turn 0 (idle)' },
  );
  const cleanOut = parseAgySession(shellNoise, { sessionId: 'agy-clean' });
  assert.equal(cleanOut.agents.length, 1, 'agy --help must not spawn a fake subagent');
  assert.deepEqual([cleanOut.agents[0].terminal, cleanOut.agents[0].state, cleanOut.agents[0].reply], ['t5w', 'done', 'sent at turn 0 (idle)']);
});

test('supports local Droid, Epi, Devin (ATIF + sidekick), Dim (SQLite), Grok, and Amp sessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-all-'));
  const { DatabaseSync } = await import('node:sqlite');

  // 1. Epi (~/.epi/pi/sessions/) via cwd fallback
  const epiDir = join(home, '.epi', 'pi', 'sessions', '--Users-me-epiapp--');
  mkdirSync(epiDir, { recursive: true });
  writeFileSync(join(epiDir, 'epi-1.jsonl'), lines(
    { type: 'session', id: 'epi-1', timestamp: '2026-11-12T06:00:00Z', cwd: '/Users/me/epiapp' },
    { type: 'model_change', timestamp: '2026-11-12T06:00:01Z', modelId: 'factory/gpt-6.1-sol' },
    { type: 'message', timestamp: '2026-11-12T06:00:02Z', message: { role: 'user', content: [{ type: 'text', text: 'Audit cage memory' }] } },
  ));

  // 2. Factory Droid (~/.factory/sessions/) + companion .settings.json + Task subagent
  const droidDir = join(home, '.factory', 'sessions', '-Users-me-droidapp');
  mkdirSync(droidDir, { recursive: true });
  writeFileSync(join(droidDir, 'dr-1.settings.json'), JSON.stringify({ model: 'custom:magpie/auto/claude-opus-5-5' }));
  writeFileSync(join(droidDir, 'dr-1.jsonl'), lines(
    { type: 'session_start', id: 'dr-1', cwd: '/Users/me/droidapp' },
    { type: 'message', timestamp: '2026-11-12T07:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_d1', name: 'Task', input: { subagent_type: 'worker', description: 'Simplify producer', prompt: 'Refactor tools' } }] } },
    { type: 'message', timestamp: '2026-11-12T07:00:05Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_d1', is_error: false, content: 'Producer simplified' }] } },
    { type: 'agent_turn_outcome', turnId: 't1', reason: 'completed' },
  ));

  // 3. Devin CLI (~/.local/share/devin/cli/session_locks/<id>.lock + transcripts/<id>.json ATIF-v1.7)
  const devinLocks = join(home, '.local/share/devin/cli/session_locks');
  const devinTx = join(home, '.local/share/devin/cli/transcripts');
  mkdirSync(devinLocks, { recursive: true });
  mkdirSync(devinTx, { recursive: true });
  writeFileSync(join(devinLocks, 'calm-otter.lock'), '701\n');
  const devinDoc = {
    schema_version: 'ATIF-v1.7',
    session_id: 'calm-otter',
    agent: { name: 'devin', model_name: 'Fusion (Claude Opus 5.5 High + SWE-2 High)' },
    steps: [
      { step_id: 1, timestamp: '2026-11-12T08:00:00Z', source: 'system', message: 'You are Devin' },
      { step_id: 2, timestamp: '2026-11-12T08:00:01Z', source: 'user', message: 'Support ego lite browser' },
      {
        step_id: 3, timestamp: '2026-11-12T08:00:05Z', source: 'agent', message: '',
        tool_calls: [{ tool_call_id: 'tc_sk1', function_name: 'sidekick', arguments: { message: 'Add case egoLite to BrowserCookies.swift' } }],
        observation: { results: [{ source_call_id: 'tc_sk1', content: 'Sidekick launched' }] },
      },
      {
        step_id: 4, timestamp: '2026-11-12T08:00:20Z', source: 'user',
        message: '<subagent_completion_notification>\n[Background subagent with agent_id=sidekick completed]\n\nAdded egoLite and tests pass.\n</subagent_completion_notification>',
      },
      {
        step_id: 5, timestamp: '2026-11-12T08:00:25Z', source: 'agent', message: '',
        tool_calls: [
          { tool_call_id: 'tc_sk2', function_name: 'sidekick', arguments: { message: 'Re-run localization script' } },
          { tool_call_id: 'tc_rs1', function_name: 'run_subagent', arguments: { subagent_type: 'subagent_explore', prompt: 'Scan fixtures' } },
        ],
        observation: { results: [{ source_call_id: 'tc_sk2', content: 'Sidekick resumed' }] },
      },
    ],
  };
  writeFileSync(join(devinTx, 'calm-otter.json'), JSON.stringify(devinDoc));
  const parsedDevin = parseDevinSession(JSON.stringify(devinDoc));
  assert.equal(parsedDevin.model, 'Fusion (Claude Opus 5.5 High + SWE-2 High)');
  assert.equal(parsedDevin.agents.length, 2);
  assert.deepEqual(parsedDevin.events.map((e) => e.kind), ['spawn', 'return', 'message', 'spawn']);

  // 4. Dim (~/.dimcode/v2/dimcode.sqlite: sessions + session_states + session_relations + messages)
  const dimDir = join(home, '.dimcode/v2');
  mkdirSync(dimDir, { recursive: true });
  const dimDb = new DatabaseSync(join(dimDir, 'dimcode.sqlite'));
  dimDb.exec(`
    CREATE TABLE sessions (sessionId TEXT PRIMARY KEY, cwd TEXT, title TEXT, status TEXT, heldBy TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE session_states (sessionId TEXT PRIMARY KEY, selectedModelId TEXT);
    CREATE TABLE session_relations (relationId TEXT PRIMARY KEY, sourceSessionId TEXT, targetSessionId TEXT, relationType TEXT);
    CREATE TABLE messages (messageId TEXT PRIMARY KEY, sessionId TEXT, role TEXT, parts TEXT);
  `);
  dimDb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('dim-main', '/Users/me/dimapp', 'Dim main', 'active', 'cli-801@mac', '2026-11-12T09:00:00Z', '2026-11-12T09:01:00Z');
  dimDb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('dim-sub1', '/Users/me/dimapp', 'Sub verify', 'completed', null, '2026-11-12T09:00:10Z', '2026-11-12T09:00:40Z');
  dimDb.prepare('INSERT INTO session_states VALUES (?, ?)').run('dim-main', 'anthropic/claude-opus-5-5');
  dimDb.prepare('INSERT INTO session_relations VALUES (?, ?, ?, ?)').run('rel-1', 'dim-main', 'dim-sub1', 'subagent');
  dimDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run('m1', 'dim-main', 'user', JSON.stringify([{ type: 'text', text: 'Verify dim topology' }]));
  dimDb.close();

  // 5. Grok (~/.grok/sessions/<encoded-cwd>/<id>/)
  const grokDir = join(home, '.grok/sessions', encodeURIComponent('/Users/me/grokapp'), 'gr-1');
  mkdirSync(grokDir, { recursive: true });
  const grokSum = JSON.stringify({ info: { id: 'gr-1', cwd: '/Users/me/grokapp' }, current_model_id: 'grok-4.7' });
  const grokEv = lines(
    { ts: '2026-11-12T09:10:00Z', type: 'turn_started', model_id: 'grok-4.7' },
    { ts: '2026-11-12T09:10:02Z', type: 'tool_started', tool_name: 'read_file' },
  );
  const grokChat = lines({ type: 'user', content: [{ type: 'text', text: '<user_query>\nFix OAuth token\n</user_query>' }] });
  writeFileSync(join(grokDir, 'summary.json'), grokSum);
  writeFileSync(join(grokDir, 'events.jsonl'), grokEv);
  writeFileSync(join(grokDir, 'chat_history.jsonl'), grokChat);
  const parsedGrok = parseGrokSession(grokSum, grokEv, grokChat, 'gr-1');
  assert.deepEqual([parsedGrok.model, parsedGrok.state, parsedGrok.activity], ['grok-4.7', 'working', 'read_file']);

  // 6. Amp (~/.local/share/amp/session.json + history.jsonl)
  const ampDir = join(home, '.local/share/amp');
  mkdirSync(ampDir, { recursive: true });
  writeFileSync(join(ampDir, 'session.json'), JSON.stringify({ pluginAgentModeKey: 'claude-opus-5-5' }));
  writeFileSync(join(ampDir, 'history.jsonl'), lines({ text: 'Check amp orb quota', cwd: '/Users/me/ampapp' }));

  const reader = createSessionReader({
    homeDir: home,
    listProcs: () => [{ pid: 701, ppid: 700, comm: 'devin' }, { pid: 801, ppid: 800, comm: 'dim' }],
    listOpenFiles: () => ({}),
  });

  const epi = reader.read({ address: 'te', pid: 1, app: 'epi', cwd: '/Users/me/epiapp' }, 1000);
  assert.deepEqual([epi?.model, epi?.state, epi?.activity], ['gpt-6.1-sol', 'working', 'Audit cage memory']);

  const droid = reader.read({ address: 'td', pid: 2, app: 'droid', cwd: '/Users/me/droidapp' }, 1000);
  assert.deepEqual([droid?.model, droid?.state, droid?.agents.length], ['claude-opus-5-5', 'done', 1]);

  const devin = reader.read({ address: 'tv', pid: 700, app: 'devin', cwd: '/Users/me/pulse' }, 1000);
  assert.equal(devin?.sessionId, 'calm-otter');
  assert.equal(devin?.agents[0]?.id, 'sidekick');

  const dim = reader.read({ address: 'tm', pid: 800, app: 'dim', cwd: '/Users/me/dimapp' }, 1000);
  assert.deepEqual([dim?.model, dim?.state, dim?.activity, dim?.agents.length], ['claude-opus-5-5', 'working', 'Verify dim topology', 1]);

  const grok = reader.read({ address: 'tg', pid: 3, app: 'grok', cwd: '/Users/me/grokapp' }, 1000);
  assert.deepEqual([grok?.model, grok?.state], ['grok-4.7', 'working']);

  const amp = reader.read({ address: 'ta', pid: 4, app: 'amp', cwd: '/Users/me/ampapp' }, 1000);
  assert.deepEqual([amp?.model, amp?.activity], ['claude-opus-5-5', 'Check amp orb quota']);
});

test('Claude 2.1.316: skips timestamp-less api-request-blob, uses meta.finished over mtime, extracts sub activity & real reply', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-claude2-'));
  const claudeDir = join(home, '.claude', 'projects', '-Users-me-editor');
  const sessDir = join(home, '.claude', 'sessions');
  const subDir = join(claudeDir, 'sess-213', 'subagents');
  mkdirSync(subDir, { recursive: true });
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(join(sessDir, '601.json'), JSON.stringify({ sessionId: 'sess-213', cwd: '/Users/me/editor' }));

  const cf = join(claudeDir, 'sess-213.jsonl');
  writeFileSync(cf, lines(
    { type: 'user', uuid: 'u1', timestamp: '2026-11-16T03:00:00.000Z', message: { role: 'user', content: 'Fix I-018 and I-019 in parallel' } },
    {
      type: 'assistant', timestamp: '2026-11-16T03:00:05.000Z',
      message: {
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_done', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Finish I-018 hardening', prompt: 'Fix all 9 items' } },
          { type: 'tool_use', id: 'toolu_run', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Build I-019 real TTY', prompt: 'Replace mock PTY' } },
        ],
      },
    },
    {
      type: 'user', timestamp: '2026-11-16T03:00:06.000Z',
      toolUseResult: { agentId: 'aa75a040' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_done', content: 'Async agent launched' }] },
    },
    {
      type: 'user', timestamp: '2026-11-16T03:00:06.500Z',
      toolUseResult: { agentId: 'abd0f0ff' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_run', content: 'Async agent launched' }] },
    },
    // Timestamp-less api-request-blob replaying historical Agent tool_use blocks must NOT duplicate spawns or emit at < 1000
    {
      type: 'api-request-blob',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_done', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Finish I-018 hardening', prompt: 'Fix all 9 items' } },
        ],
      },
    },
    {
      type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-16T03:10:00.000Z',
      content: '<task-notification>\n<task-id>aa75a040</task-id>\n<tool-use-id>toolu_done</tool-use-id>\n<status>completed</status>\n<summary>Agent "Finish I-018 hardening" finished</summary>\n</task-notification>',
    },
  ));

  // Subagent 1: finished: true, real final conclusion in subagents/agent-aa75a040.jsonl
  writeFileSync(join(subDir, 'agent-aa75a040.meta.json'), JSON.stringify({
    agentType: 'general-purpose', toolUseId: 'toolu_done', spawnDepth: 1, model: 'sonnet', finished: true,
  }));
  writeFileSync(join(subDir, 'agent-aa75a040.jsonl'), lines(
    { type: 'assistant', timestamp: '2026-11-16T03:09:58.000Z', message: { content: [{ type: 'text', text: 'All 9 parts of I-018 fixed and committed on fix/hardening.' }] } },
  ));

  // Subagent 2: finished: false, mtime > 20s old (waiting on slow LLM call) + active tool_use step
  writeFileSync(join(subDir, 'agent-abd0f0ff.meta.json'), JSON.stringify({
    agentType: 'general-purpose', toolUseId: 'toolu_run', spawnDepth: 1, finished: false,
  }));
  const runSubFile = join(subDir, 'agent-abd0f0ff.jsonl');
  writeFileSync(runSubFile, lines(
    { type: 'assistant', timestamp: '2026-11-16T03:01:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu_s1', name: 'Bash', input: { description: 'Run nsh check --trace', command: 'nsh check' } }] } },
  ));
  const stale = new Date(Date.now() - 25_000);
  utimesSync(runSubFile, stale, stale);

  const reader = createSessionReader({
    homeDir: home,
    listProcs: () => [{ pid: 601, ppid: 600, comm: 'claude' }],
    listOpenFiles: () => ({}),
  });
  const out = reader.read({ address: 't6r', pid: 600, app: 'claude-code', cwd: '/Users/me/editor' }, Date.now());
  assert.equal(out?.agents.length, 2, 'api-request-blob must not create duplicate subagents');
  assert.equal(out?.events.some((e) => e.at < 1000), false, 'no epoch-0 zombie events from timestamp-less records');

  const [doneSub, runSub] = out.agents;
  assert.equal(doneSub.agentId, 'aa75a040');
  assert.equal(doneSub.state, 'done');
  assert.match(doneSub.reply ?? '', /All 9 parts of I-018 fixed/, 'real subagent reply overrides notification boilerplate');
  const retEv = out.events.find((e) => e.kind === 'return' && e.from === 'toolu_done');
  assert.match(retEv?.detail ?? '', /All 9 parts of I-018 fixed/);

  assert.equal(runSub.agentId, 'abd0f0ff');
  assert.equal(runSub.state, 'working', 'meta.finished=false stays working even when mtime > 4s');
  assert.equal(runSub.activity, 'Run nsh check --trace');
});

test('AGY Native Swarm: enriches members.json working/waiting, live worker activity, cross-rail messages, [done] preservation across kill, and idle monitor settlement', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-swarm-'));
  const agyBase = join(home, '.gemini', 'antigravity-cli');
  const rootId = 'e932aabe-c737-4f3e-b241-d2f78949bb4a';
  const rootBrain = join(agyBase, 'brain', rootId, '.system_generated');
  const swarmDir = join(rootBrain, 'swarm');
  mkdirSync(join(rootBrain, 'logs'), { recursive: true });
  mkdirSync(swarmDir, { recursive: true });

  const perfCid = '053c7d33-be3a-4e6e-8b30-a71d8e8ced04';
  mkdirSync(join(agyBase, 'brain', perfCid, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(join(agyBase, 'brain', perfCid, '.system_generated', 'logs', 'transcript.jsonl'), lines(
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-16T03:35:00Z', tool_calls: [{ name: 'read_file', args: { Path: '/repo/native/src/pty.rs' } }, { name: 'swarm_wait', args: { since: 4 } }] },
  ));

  writeFileSync(join(rootBrain, 'logs', 'transcript.jsonl'), lines(
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-16T03:30:00Z', content: '<USER_REQUEST>\nAudit Aed with swarm\n</USER_REQUEST>' },
    {
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-16T03:30:05Z',
      tool_calls: [
        { name: 'swarm', args: { action: 'add', name: 'paradigm', brief: '"You own UX...\\n\\nGoal: partial<truncated 1642 bytes>' } },
        { name: 'swarm', args: { action: 'add', name: 'perf', brief: '"Truncated perf\\nline2<truncated 800 bytes>' } },
        { name: 'swarm', args: { action: 'add', name: 'verifier', brief: 'Gatekeeper' } },
        { name: 'swarm', args: { action: 'add', name: 'monitor', brief: 'Stall monitor' } },
      ],
    },
    {
      step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-16T03:42:00Z',
      tool_calls: [{ name: 'swarm', args: { action: 'kill', name: 'paradigm' } }],
    },
  ));

  writeFileSync(join(swarmDir, 'members.json'), JSON.stringify({
    title: 'Aed Audit',
    members: {
      coordinator: { conversation_id: rootId, role: 'coordinator', applied_model: 'gemini-4-carbon-high', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
      paradigm: { conversation_id: 'cc298b11-98f4-4a2f-9995-faa559fcaa9e', role: 'worker', applied_model: 'gemini-4-carbon-high', phase: 'KILLED', wake_mode: 'working', killed: true },
      perf: { conversation_id: perfCid, role: 'worker', applied_model: 'gemini-4-carbon-high', phase: 'RUNNING', wake_mode: 'working', killed: false },
      verifier: { conversation_id: 'd1111111-1111-4111-8111-111111111111', role: 'worker', applied_model: 'gemini-4-carbon-high', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
      monitor: { conversation_id: 'ba1ee585-8c3c-4883-b093-0f1bacbee90f', role: 'worker', applied_model: 'gemini-4-carbon-high', phase: 'RUNNING', wake_mode: 'anything', killed: false },
    },
  }));

  const doneTime = '2026-11-16T03:40:31Z';
  writeFileSync(join(swarmDir, 'board.jsonl'), lines(
    { seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-16T03:30:05Z', text: '@paradigm Audit IME paradigm' },
    { seq: 2, agent: 'coordinator', kind: 'brief', time: '2026-11-16T03:30:06Z', text: '@perf Audit Rust PTY' },
    { seq: 3, agent: 'coordinator', kind: 'brief', time: '2026-11-16T03:30:07Z', text: '@verifier Gatekeeper' },
    { seq: 4, agent: 'coordinator', kind: 'brief', time: '2026-11-16T03:30:08Z', text: '@monitor Stall monitor' },
    { seq: 5, agent: 'coordinator', time: '2026-11-16T03:34:00Z', text: '@perf Also inspect ring buffer sizing' },
    { seq: 6, agent: 'paradigm', time: doneTime, text: '@verifier [done] IME composition sync gap verified' },
  ));

  const reader = createSessionReader({
    homeDir: home,
    listProcs: () => [{ pid: 901, ppid: 900, comm: 'agy' }],
    listOpenFiles: () => ({ 901: [`${agyBase}/presence/${rootId}.lock`] }),
  });
  const live = reader.read({ address: 't71', pid: 900, app: 'antigravity', cwd: '/w/aed' }, 1000);
  const byName = Object.fromEntries(live.agents.map((a) => [a.name, a]));
  assert.equal(byName.paradigm.prompt, 'Audit IME paradigm', 'authoritative board.jsonl brief overwrites truncated transcript arg');
  const paraSpawn = live.events.find((e) => e.kind === 'spawn' && e.to === 'swarm:paradigm');
  assert.equal(paraSpawn?.detail, 'Audit IME paradigm', 'spawn event detail updated to clean brief without raw quotes or <truncated>');
  // Also verify standalone parseAgySession unescapes truncated JSON string args when no board.jsonl is present
  const truncStandalone = parseAgySession(lines({
    step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-16T03:30:05Z',
    tool_calls: [{ name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Auditor"', Prompt: '"First line\\nSecond line<truncated 512 bytes>' } }],
  }));
  assert.equal(truncStandalone.agents[0].prompt, 'First line\nSecond line');
  assert.equal(byName.paradigm.model, 'gemini-4-carbon-high');
  assert.equal(byName.paradigm.state, 'done', '[done] worker killed later must preserve done state');
  assert.equal(byName.paradigm.end, Date.parse(doneTime), '[done] worker preserves board completion timestamp');
  assert.match(byName.paradigm.reply ?? '', /IME composition sync gap verified/);
  assert.equal(byName.perf.state, 'working');
  assert.match(byName.perf.activity ?? '', /pty\.rs/);
  assert.equal(byName.verifier.state, 'waiting', 'sleeping swarm worker on mentions is waiting, not working');
  assert.equal(byName.monitor.state, 'waiting');
  assert.equal(
    live.events.some((e) => e.kind === 'message' && e.from === 'swarm:paradigm' && e.to === 'swarm:verifier'),
    true,
    'peer @verifier post creates cross-rail message event',
  );

  // Phase 2: all non-monitor workers finish and main turn completes -> idle unposted monitor settles
  writeFileSync(join(swarmDir, 'members.json'), JSON.stringify({
    title: 'Aed Audit',
    members: {
      coordinator: { conversation_id: rootId, role: 'coordinator', applied_model: 'gemini-4-carbon-high', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
      paradigm: { conversation_id: 'cc298b11-98f4-4a2f-9995-faa559fcaa9e', role: 'worker', applied_model: 'gemini-4-carbon-high', phase: 'KILLED', wake_mode: 'working', killed: true },
      perf: { conversation_id: perfCid, role: 'worker', applied_model: 'gemini-4-carbon-high', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
      verifier: { conversation_id: 'd1111111-1111-4111-8111-111111111111', role: 'worker', applied_model: 'gemini-4-carbon-high', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
      monitor: { conversation_id: 'ba1ee585-8c3c-4883-b093-0f1bacbee90f', role: 'worker', applied_model: 'gemini-4-carbon-high', phase: 'RUNNING', wake_mode: 'anything', killed: false },
    },
  }));
  writeFileSync(join(swarmDir, 'board.jsonl'), lines(
    { seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-16T03:30:05Z', text: '@paradigm Audit IME paradigm' },
    { seq: 2, agent: 'coordinator', kind: 'brief', time: '2026-11-16T03:30:06Z', text: '@perf Audit Rust PTY' },
    { seq: 3, agent: 'coordinator', kind: 'brief', time: '2026-11-16T03:30:07Z', text: '@verifier Gatekeeper' },
    { seq: 4, agent: 'coordinator', kind: 'brief', time: '2026-11-16T03:30:08Z', text: '@monitor Stall monitor' },
    { seq: 5, agent: 'paradigm', time: doneTime, text: '@verifier [done] IME composition sync gap verified' },
    { seq: 6, agent: 'perf', time: '2026-11-16T03:45:00Z', text: '@verifier [done] PTY frame budget verified' },
    { seq: 7, agent: 'verifier', time: '2026-11-16T03:46:00Z', text: '@coordinator [done] Combined synthesis complete' },
  ));
  writeFileSync(join(rootBrain, 'logs', 'transcript.jsonl'), lines(
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-16T03:30:00Z', content: '<USER_REQUEST>\nAudit Aed with swarm\n</USER_REQUEST>' },
    {
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-16T03:30:05Z',
      tool_calls: [
        { name: 'swarm', args: { action: 'add', name: 'paradigm', brief: '"You own UX...\\n\\nGoal: partial<truncated 1642 bytes>' } },
        { name: 'swarm', args: { action: 'add', name: 'perf', brief: '"Truncated perf\\nline2<truncated 800 bytes>' } },
        { name: 'swarm', args: { action: 'add', name: 'verifier', brief: 'Gatekeeper' } },
        { name: 'swarm', args: { action: 'add', name: 'monitor', brief: 'Stall monitor' } },
      ],
    },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-16T03:47:00Z', content: 'Here is the final synthesis report.' },
  ));

  const settled = reader.read({ address: 't71', pid: 900, app: 'antigravity', cwd: '/w/aed' }, 6000);
  const settledMonitor = settled.agents.find((a) => a.name === 'monitor');
  assert.equal(settledMonitor.state, 'stopped', 'idle unposted monitor settles when main turn & all workers finish');
  assert.equal(typeof settledMonitor.end, 'number');
});

test('Session discovery: lsof exit code 1 tolerance, AGY presence lock & subagent exclusion, 4s /new rebind, and stale cwd rejection', async () => {
  const txMod = await import('../host/transcripts.js');
  assert.equal(typeof txMod.defaultListOpenFiles, 'function', 'exports defaultListOpenFiles for lsof verification');
  // Passing a dead PID alongside live process.pid makes macOS lsof exit with code 1 while printing valid stdout
  const realOpen = txMod.defaultListOpenFiles([process.pid, 9_999_999]);
  assert.equal(Array.isArray(realOpen[process.pid]) && realOpen[process.pid].length > 0, true, 'parses lsof stdout even on exit status 1');

  const home = mkdtempSync(join(tmpdir(), 'home-disc-'));
  const agyBase = join(home, '.gemini', 'antigravity-cli');
  const rootA = '1cb06234-e181-4d1c-b2fe-466223012146';
  const rootB = 'eab2880f-a8be-4da2-84b8-9babef5d3d5f';
  const subWorker = '88fdeec4-7116-49c6-93a0-7ab2a6e9ec64';
  for (const id of [rootA, rootB, subWorker]) {
    mkdirSync(join(agyBase, 'brain', id, '.system_generated', 'logs'), { recursive: true });
    writeFileSync(join(agyBase, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), lines(
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-16T03:00:00Z', content: `<USER_REQUEST>\nSession ${id}\n</USER_REQUEST>` },
    ));
  }
  mkdirSync(join(agyBase, 'brain', rootA, '.system_generated', 'subagents'), { recursive: true });
  writeFileSync(join(agyBase, 'brain', rootA, '.system_generated', 'subagents', `${subWorker}.json`), JSON.stringify({ conversationId: subWorker }));

  let activeOpen = [
    `${agyBase}/conversations/${subWorker}.db-shm`,
    `${agyBase}/brain/${subWorker}`,
    `${agyBase}/conversations/${subWorker}.db`,
    `${agyBase}/presence/${rootA}.lock`,
  ];
  const reader = createSessionReader({
    homeDir: home,
    listProcs: () => [{ pid: 710, ppid: 700, comm: 'agy' }, { pid: 810, ppid: 800, comm: 'claude' }],
    listOpenFiles: (pids) => (pids.includes(710) ? { 710: activeOpen } : {}),
  });

  // 1. Subagent .db-shm / brain / .db come BEFORE presence/<rootA>.lock -> rootA still wins
  const hit1 = reader.read({ address: 't70', pid: 700, app: 'antigravity', cwd: '/w/relay', since: 1000 }, 1000);
  assert.equal(hit1?.sessionId, rootA);

  // 2. Without presence lock, subWorker is still excluded via .system_generated/subagents/ and .db-shm end-boundary
  activeOpen = [`${agyBase}/conversations/${subWorker}.db-shm`, `${agyBase}/conversations/${subWorker}.db`, `${agyBase}/conversations/${rootA}.db`];
  const hitNoLock = reader.read({ address: 't72', pid: 700, app: 'antigravity', cwd: '/w/relay', since: 1000 }, 1000);
  assert.equal(hitNoLock?.sessionId, rootA);

  // 3. Same process runs /new -> switches presence lock to rootB; after 4s cache TTL, reader rebinds to rootB
  activeOpen = [`${agyBase}/presence/${rootB}.lock`];
  const hit2 = reader.read({ address: 't70', pid: 700, app: 'antigravity', cwd: '/w/relay', since: 1000 }, 5500);
  assert.equal(hit2?.sessionId, rootB, 'isFreshBound re-checks open handles after 4s and switches session');

  // 4. Newly opened Claude pane (before new .jsonl exists) rejects 3-day-old cwd session, then binds once new .jsonl lands
  const claudeDir = join(home, '.claude', 'projects', '-w-relay');
  mkdirSync(claudeDir, { recursive: true });
  const oldFile = join(claudeDir, 'old-3d.jsonl');
  writeFileSync(oldFile, lines({ type: 'user', uuid: 'u0', timestamp: '2026-11-13T03:00:00Z', message: { role: 'user', content: 'Stale prompt' } }));
  const nowMs = Date.parse('2026-11-16T04:00:00Z');
  const threeDaysAgo = new Date(nowMs - 3 * 86400_000);
  utimesSync(oldFile, threeDaysAgo, threeDaysAgo);

  const beforeFirstMsg = reader.read({ address: 't5g', pid: 800, app: 'claude-code', cwd: '/w/relay', since: nowMs }, nowMs);
  assert.equal(beforeFirstMsg, null, 'stale cwd session older than term.since - 5000 must be rejected');

  const freshFile = join(claudeDir, 'fresh-now.jsonl');
  writeFileSync(freshFile, lines({ type: 'user', uuid: 'u1', timestamp: '2026-11-16T04:00:02Z', message: { role: 'user', content: 'Fresh prompt' } }));
  const freshDate = new Date(nowMs + 2000);
  utimesSync(freshFile, freshDate, freshDate);

  const afterFirstMsg = reader.read({ address: 't5g', pid: 800, app: 'claude-code', cwd: '/w/relay', since: nowMs }, nowMs + 4500);
  assert.equal(afterFirstMsg?.sessionId, 'fresh-now', 'binds fresh session once written');
});

test('Codex agent_message (MESSAGE/FINAL_ANSWER) + SubAgentActivity completed and Epi synchronous toolResult', () => {
  const cxText = lines(
    { timestamp: '2026-11-16T01:00:00Z', type: 'session_meta', payload: { session_id: 'cx-sub', cwd: '/w/app' } },
    {
      timestamp: '2026-11-16T01:00:02Z', type: 'response_item',
      payload: { type: 'function_call', call_id: 'c1', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'terminal_options', message: 'Check Ghostty markdown' }) },
    },
    {
      timestamp: '2026-11-16T01:00:10Z', type: 'response_item',
      payload: {
        type: 'agent_message', author: '/root/terminal_options', recipient: '/root',
        content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/terminal_options\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'gAAAAABqnm' }],
      },
    },
    {
      timestamp: '2026-11-16T01:00:20Z', type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'completed', agent_path: '/root/terminal_options' }, completed_at_ms: Date.parse('2026-11-16T01:00:20Z') },
    },
    {
      timestamp: '2026-11-16T01:00:22Z', type: 'response_item',
      payload: {
        type: 'agent_message', author: '/root/terminal_options', recipient: '/root',
        content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/terminal_options\nPayload:\nUse BIRSAx2/mdcat for Kitty graphics.' }],
      },
    },
  );
  const cx = parseCodexSession(cxText);
  assert.equal(cx.agents.length, 1);
  assert.equal(cx.agents[0].state, 'done');
  assert.match(cx.agents[0].reply ?? '', /BIRSAx2\/mdcat/);
  assert.deepEqual(cx.events.map((e) => e.kind), ['spawn', 'message', 'return']);
  assert.match(cx.events[2].detail ?? '', /BIRSAx2\/mdcat/);

  const epiText = lines(
    { type: 'session', id: 'epi-sync', timestamp: '2026-11-16T02:00:00Z', cwd: '/w/forge' },
    { type: 'message', timestamp: '2026-11-16T02:00:02Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_sync1', name: 'task', arguments: { agent: 'runner', task: 'Run harness tests' } }] } },
    {
      type: 'message', timestamp: '2026-11-16T02:00:30Z',
      message: {
        role: 'toolResult', toolCallId: 'call_sync1', toolName: 'task', isError: false,
        content: [{ type: 'text', text: 'tests 65, pass 65, fail 0' }],
        details: { status: 'completed', result: 'tests 65, pass 65, fail 0' },
      },
    },
  );
  const epi = parsePiSession(epiText);
  assert.equal(epi.agents.length, 1);
  assert.equal(epi.agents[0].state, 'done');
  assert.match(epi.agents[0].reply ?? '', /pass 65/);
  assert.deepEqual(epi.events.map((e) => e.kind), ['spawn', 'return']);
});

test('createSessionReader uses stat-first caching to avoid re-reading unchanged bundles and still catches updates', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'home-cache-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // 1. Antigravity bundle with swarm board
  const agyId = '7a111111-2222-3333-4444-555555555555';
  const agyLogDir = join(home, '.gemini/antigravity-cli/brain', agyId, '.system_generated/logs');
  const agySwarmDir = join(home, '.gemini/antigravity-cli/brain', agyId, '.system_generated/swarm');
  mkdirSync(agyLogDir, { recursive: true });
  mkdirSync(agySwarmDir, { recursive: true });
  const agyFile = join(agyLogDir, 'transcript.jsonl');
  const boardFile = join(agySwarmDir, 'board.jsonl');
  const membersFile = join(agySwarmDir, 'members.json');
  writeFileSync(agyFile, lines(
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T01:00:00Z', content: '<USER_REQUEST>Perf check</USER_REQUEST>' },
  ));
  writeFileSync(membersFile, JSON.stringify({ members: { coordinator: { role: 'coordinator', applied_model: 'neon-high' } } }));
  writeFileSync(boardFile, lines({ seq: 1, kind: 'brief', agent: 'coordinator', time: '2026-11-20T01:00:01Z', text: '@w1 inspect' }));

  // 2. Claude bundle with subagent file
  const claudeDir = join(home, '.claude/projects/-w-perf');
  const claudeSid = 'cl-perf-1';
  const claudeSubDir = join(claudeDir, claudeSid, 'subagents');
  mkdirSync(claudeSubDir, { recursive: true });
  const claudeFile = join(claudeDir, `${claudeSid}.jsonl`);
  const subJsonl = join(claudeSubDir, 'agent-a1.jsonl');
  const subMeta = join(claudeSubDir, 'agent-a1.meta.json');
  writeFileSync(claudeFile, lines(
    { type: 'user', sessionId: claudeSid, timestamp: '2026-11-20T01:00:00Z', message: { role: 'user', content: 'Audit perf' } },
    { type: 'assistant', sessionId: claudeSid, timestamp: '2026-11-20T01:00:01Z', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Sub', subagent_type: 'Explore', prompt: 'Go' } }] } },
    { type: 'user', sessionId: claudeSid, timestamp: '2026-11-20T01:00:02Z', toolUseResult: { agentId: 'a1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Async agent launched' }] } },
  ));
  writeFileSync(subMeta, JSON.stringify({ toolUseId: 'tu1', finished: false }));
  writeFileSync(subJsonl, lines({ type: 'assistant', timestamp: '2026-11-20T01:00:03Z', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/w/a.js' } }] } }));

  const reader = createSessionReader({
    homeDir: home,
    listProcs: () => [{ pid: 101, ppid: 100, comm: 'agy' }, { pid: 201, ppid: 200, comm: 'claude' }],
    listOpenFiles: (pids) => ({
      ...(pids.includes(101) ? { 101: [`${home}/.gemini/antigravity-cli/presence/${agyId}.lock`] } : {}),
      ...(pids.includes(201) ? { 201: [claudeFile] } : {}),
    }),
  });

  const agyTerm = { address: 't1', pid: 100, app: 'antigravity', cwd: '/w/perf', since: 1000 };
  const clTerm = { address: 't2', pid: 200, app: 'claude', cwd: '/w/perf', since: 1000 };

  const a1 = reader.read(agyTerm, 2000);
  const c1 = reader.read(clTerm, 2000);
  assert.equal(a1?.sessionId, agyId);
  assert.equal(c1?.sessionId, claudeSid);
  assert.equal(c1?.agents[0]?.activity, 'Read a.js');

  // Make transcript files unreadable without modifying size/mtime: stat-first cache must hit without calling readFileSync
  chmodSync(agyFile, 0o000);
  chmodSync(claudeFile, 0o000);
  t.after(() => {
    try { chmodSync(agyFile, 0o600); } catch {}
    try { chmodSync(claudeFile, 0o600); } catch {}
  });
  const a2 = reader.read(agyTerm, 3000);
  const c2 = reader.read(clTerm, 3000);
  assert.equal(a2, a1, 'unchanged agy bundle returns cached object without reading files');
  assert.equal(c2, c1, 'unchanged claude bundle returns cached object without reading files');

  // Restoring permissions and updating sidecar files invalidates cache cleanly
  chmodSync(agyFile, 0o600);
  chmodSync(claudeFile, 0o600);
  writeFileSync(boardFile, lines(
    { seq: 1, kind: 'brief', agent: 'coordinator', time: '2026-11-20T01:00:01Z', text: '@w1 inspect' },
    { seq: 2, kind: 'post', agent: 'w1', time: '2026-11-20T01:00:10Z', text: '@coordinator [done] all clear' },
  ));
  writeFileSync(subMeta, JSON.stringify({ toolUseId: 'tu1', finished: true }));
  writeFileSync(subJsonl, lines({ type: 'assistant', timestamp: '2026-11-20T01:00:08Z', message: { content: [{ type: 'text', text: 'Done auditing' }] } }));

  const a3 = reader.read(agyTerm, 3500);
  const c3 = reader.read(clTerm, 3500);
  assert.equal(a3?.agents[0]?.state, 'done', 'swarm board update invalidates agy cache');
  assert.equal(c3?.agents[0]?.state, 'done', 'subagent meta/jsonl update invalidates claude cache');
  assert.equal(c3?.agents[0]?.reply, 'Done auditing');

  // Updating swarm members.json while transcript.jsonl is unchanged also invalidates agyFastSig
  writeFileSync(membersFile, JSON.stringify({
    members: {
      coordinator: { role: 'coordinator', applied_model: 'neon-high' },
      w2: { role: 'worker', wake_mode: 'working', applied_model: 'carbon-high', brief: 'Verify cache' },
    },
  }));
  const a4 = reader.read(agyTerm, 3600);
  assert.equal(a4?.agents.some((x) => x.name === 'w2'), true, 'members.json update invalidates agyFastSig');
});

test('createSessionReader prepare and prepareAsync batch lsof into one call across terminals', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'home-batch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const ids = [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
  ];
  for (const id of ids) {
    const dir = join(home, '.gemini/antigravity-cli/brain', id, '.system_generated/logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'transcript.jsonl'), lines({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T01:00:00Z', content: `<USER_REQUEST>${id}</USER_REQUEST>` }));
  }

  let lsofCalls = 0;
  let asyncLsofCalls = 0;
  const openMap = {
    101: [`${home}/.gemini/antigravity-cli/presence/${ids[0]}.lock`],
    201: [`${home}/.gemini/antigravity-cli/presence/${ids[1]}.lock`],
    301: [`${home}/.gemini/antigravity-cli/presence/${ids[2]}.lock`],
  };
  const procs = [{ pid: 101, ppid: 100, comm: 'agy' }, { pid: 201, ppid: 200, comm: 'agy' }, { pid: 301, ppid: 300, comm: 'agy' }];
  const terms = [
    { address: 't1', pid: 100, app: 'antigravity', cwd: '/w/a', since: 1000 },
    { address: 't2', pid: 200, app: 'antigravity', cwd: '/w/b', since: 1000 },
    { address: 't3', pid: 300, app: 'antigravity', cwd: '/w/c', since: 1000 },
  ];

  const reader = createSessionReader({
    homeDir: home,
    listProcs: () => procs,
    listOpenFiles: (pids) => { lsofCalls++; return Object.fromEntries(pids.map((p) => [p, openMap[p] || []])); },
    listProcsAsync: async () => procs,
    listOpenFilesAsync: async (pids) => { asyncLsofCalls++; return Object.fromEntries(pids.map((p) => [p, openMap[p] || []])); },
  });

  reader.prepare(terms, 2000);
  assert.equal(lsofCalls, 1, 'sync prepare batches all 3 terminals into one lsof call');
  assert.deepEqual(terms.map((tm) => reader.read(tm, 2000)?.sessionId), ids);
  assert.equal(lsofCalls, 1, 'subsequent read() reuses prepared bindings');

  // After 4s TTL, prepareAsync refreshes all 3 in one non-blocking call without touching sync lsof
  await reader.prepareAsync(terms, 6500);
  assert.equal(asyncLsofCalls, 1, 'prepareAsync batches all 3 terminals into one async lsof call');
  assert.equal(lsofCalls, 1, 'prepareAsync never calls sync listOpenFiles');
  assert.deepEqual(terms.map((tm) => reader.readBound(tm)?.sessionId), ids);

  // Real defaultListOpenFilesAsync tolerates exit status 1 from vanished child PIDs
  const realOpen = await defaultListOpenFilesAsync([process.pid, 99999999]);
  assert.equal(Array.isArray(realOpen[process.pid]) && realOpen[process.pid].length > 0, true);
});
