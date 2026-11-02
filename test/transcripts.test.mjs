// A coding agent's conversation from its transcript (host/transcripts.js), with made-up transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeItems, createConversations, lineEnd, livePart, locate, piItems, readBack, readForward } from '../host/transcripts.js';

const claudeLine = (type, content, extra = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, type, message: { role: type, content }, timestamp: '2026-11-03T00:00:00Z', ...extra });
const piLine = (role, content, extra = {}) => JSON.stringify({ type: 'message', id: 'x', parentId: null, timestamp: '2026-11-03T00:00:00Z', message: { role, content, ...extra } });

test('Claude Code: what a person typed, replies, tools and their output; not what it injects', () => {
  assert.deepEqual(claudeItems(JSON.parse(claudeLine('user', 'fix the bug\n<system-reminder>secret rules</system-reminder>'))).map((i) => i.text), ['fix the bug']);
  assert.deepEqual(claudeItems(JSON.parse(claudeLine('user', '<command-name>/compact</command-name><command-args>keep tests</command-args>'))).map((i) => i.text), ['/compact keep tests']);
  assert.deepEqual(claudeItems(JSON.parse(claudeLine('user', '<local-command-stdout>ok</local-command-stdout>'))), []);
  assert.deepEqual(claudeItems(JSON.parse(claudeLine('user', 'meta', { isMeta: true }))), []);
  assert.deepEqual(claudeItems(JSON.parse(claudeLine('user', 'sub agent', { isSidechain: true }))), []);
  const reply = claudeItems(JSON.parse(claudeLine('assistant', [
    { type: 'thinking', thinking: 'hidden' },
    { type: 'text', text: 'Done.' },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test\nmore', description: 'Run tests' } },
  ])));
  assert.deepEqual(reply, [{ k: 'assistant', text: 'Done.', time: '2026-11-03T00:00:00Z' }, { k: 'tool', id: 'tu1', name: 'Bash', sum: 'npm test' }]);
  const result = claudeItems(JSON.parse(claudeLine('user', [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'x'.repeat(5000) }], is_error: true }])));
  assert.equal(result[0].k, 'result');
  assert.equal(result[0].error, true);
  assert.ok(result[0].out.length <= 2001);
});

test('pi / epi: user text, replies, tool calls and results', () => {
  assert.deepEqual(piItems(JSON.parse(piLine('user', [{ type: 'text', text: 'hi' }, { type: 'image', data: '…' }]))).map((i) => [i.k, i.text, i.images]), [['user', 'hi', 1]]);
  assert.deepEqual(piItems(JSON.parse(piLine('assistant', [{ type: 'thinking', thinking: 'h' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.js' } }]))), [{ k: 'tool', id: 'c1', name: 'read', sum: 'a.js' }]);
  assert.deepEqual(piItems(JSON.parse(piLine('toolResult', [{ type: 'text', text: 'ok' }], { toolCallId: 'c1', isError: false }))), [{ k: 'result', id: 'c1', out: 'ok', error: false }]);
  assert.deepEqual(piItems({ type: 'model_change' }), []);
});

test('pages read backwards across chunk boundaries, in order, without gaps or repeats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conv-'));
  const file = join(dir, 'a.jsonl');
  const lines = [];
  for (let i = 0; i < 3000; i++) {
    lines.push(JSON.stringify({ type: 'api-request-blob', pad: 'z'.repeat(300) })); // never a message: skipped unparsed
    lines.push(claudeLine('user', `message ${i} ${'y'.repeat(i % 7 === 0 ? 3000 : 10)}`));
  }
  await writeFile(file, `${lines.join('\n')}\n`);
  const end = await lineEnd(file);
  const seen = [];
  let before = end, more = true, pages = 0;
  while (more) {
    const page = await readBack('claude', file, before, 60);
    seen.unshift(...page.items.map((i) => Number(i.text.split(' ')[1])));
    for (let i = 1; i < page.items.length; i++) assert.ok(page.items[i].seq > page.items[i - 1].seq);
    before = page.first; more = page.hasMore; pages++;
  }
  assert.ok(pages >= 50 && pages <= 51, `pages ${pages}`); // the last may hold only lines that are not messages
  assert.deepEqual(seen, Array.from({ length: 3000 }, (_, i) => i));
});

test('new lines are read as they come; a line still being written waits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conv-'));
  const file = join(dir, 'b.jsonl');
  await writeFile(file, `${piLine('user', 'one')}\n`);
  let end = await lineEnd(file);
  const half = piLine('user', 'two');
  await appendFile(file, half.slice(0, 20));
  assert.equal(await lineEnd(file), end);
  let r = await readForward('pi', file, end);
  assert.deepEqual(r.items, []);
  await appendFile(file, `${half.slice(20)}\n`);
  r = await readForward('pi', file, r.end);
  assert.deepEqual(r.items.map((i) => i.text), ['two']);
  end = r.end;
  assert.equal(end, await lineEnd(file));
});

test('Claude Code: the session named by its process', async () => {
  const home = await mkdtemp(join(tmpdir(), 'home-'));
  const id = '11111111-2222-3333-4444-555555555555';
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  await mkdir(join(home, '.claude', 'projects', '-Users-me-proj'), { recursive: true });
  await writeFile(join(home, '.claude', 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: id, cwd: '/Users/me/proj' }));
  await writeFile(join(home, '.claude', 'projects', '-Users-me-proj', `${id}.jsonl`), `${claudeLine('user', 'hello')}\n`);
  const found = await locate({ pid: 4242, cwd: '/elsewhere' }, 'claude', home);
  assert.equal(found.kind, 'claude');
  assert.ok(found.file.endsWith(`${id}.jsonl`));
  assert.equal(await locate({ pid: 9999 }, 'claude', home), null);
  assert.equal(await locate({ pid: 4242 }, 'vim', home), null);
});

test('epi: two in one folder each get the session they made', async () => {
  const home = await mkdtemp(join(tmpdir(), 'home-'));
  const dir = join(home, '.epi', 'pi', 'sessions', '--Users-me-proj--');
  await mkdir(dir, { recursive: true });
  const name = (ms) => `${new Date(ms).toISOString().replace(/[:.]/g, '-')}_id.jsonl`;
  // pid 1 started at boot; this test process just now. Each made a session after it started.
  const old = name(Date.now() - 60_000), fresh = name(Date.now() + 1000);
  await writeFile(join(dir, fresh), `${piLine('user', 'fresh')}\n`);
  await writeFile(join(dir, old), `${piLine('user', 'old')}\n`); // written last: the newest file
  const me = { pid: process.pid, cwd: '/Users/me/proj' }, boot = { pid: 1, cwd: '/Users/me/proj' };
  assert.ok((await locate(me, 'epi', home, [boot])).file.endsWith(fresh));
  assert.ok((await locate(boot, 'epi', home, [me])).file.endsWith(old));
});

test('a live conversation: first page, new items, a new session starts over', async () => {
  const home = await mkdtemp(join(tmpdir(), 'home-'));
  const dir = join(home, '.pi', 'agent', 'sessions', '--p--');
  await mkdir(dir, { recursive: true });
  const a = join(dir, '2026-01-01T00-00-00-000Z_a.jsonl');
  await writeFile(a, `${piLine('user', 'first')}\n`);
  const events = [];
  const convs = createConversations({ find: () => ({ fg: { pid: process.pid, cwd: '/p' }, program: 'pi', others: [] }), emit: (c, e) => events.push(e), home });
  const opened = await convs.open('t1');
  assert.deepEqual(opened.items.map((i) => i.text), ['first']);
  await appendFile(a, `${piLine('assistant', [{ type: 'text', text: 'second' }])}\n`);
  for (let i = 0; i < 30 && !events.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events[0].items.map((i) => i.text), ['second']);
  convs.closeAll();
});

test('the live part: what is above the input box, or the bottom when there is no box', () => {
  const rule = '─'.repeat(40);
  // Claude Code: a rule, "❯", a rule, then the footer.
  assert.equal(livePart(['  old', '', '  ⏺ writing the reply', '  · Thinking… (3s)', '', rule, '❯ ', rule, '  ⏵⏵ footer'].join('\n')), 'old\n\n⏺ writing the reply\n· Thinking… (3s)');
  // epi / pi: a rounded box.
  assert.equal(livePart(['  step 1', '  step 2', `  ╭${rule}╮`, '  │ ❯ typed │', `  ╰${rule}╯`, '  model · ctx'].join('\n')), 'step 1\nstep 2');
  // A question takes the box's place: the bottom of the screen, menu and all.
  assert.equal(livePart(['要运行 npm test 吗？', ' ❯ 1. 是', '   2. 否', '', ''].join('\n')), '要运行 npm test 吗？\n ❯ 1. 是\n   2. 否');
  // A menu inside a box is kept: it is not the input box.
  assert.equal(livePart(['Bash command', `╭${rule}╮`, '│ ❯ 1. Yes      │', '│   2. No       │', `╰${rule}╯`].join('\n')), `Bash command\n╭${rule}╮\n│ ❯ 1. Yes      │\n│   2. No       │\n╰${rule}╯`);
  // Only the last lines.
  assert.equal(livePart(Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n'), 3), 'l37\nl38\nl39');
  assert.equal(livePart(''), '');
});
