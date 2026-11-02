/**
 * Which herdr-core status changes become a push to the phone.
 *
 * A status report is the program's own word (idle, working, done, blocked, error), kept per
 * terminal by herdr-core. Only agents report; a plain shell never does, so it never pushes.
 *
 *   → blocked        "needs you" (permission / question / auth), urgent
 *   working → done   "finished", only after a run of at least `minRunMs`
 *   → error          "error"
 *   program finished while it was an agent: "exited"
 *
 * Pushes carry a summary only: where the terminal sits and the agent's own short message.
 */
export function createNotifier({ notify, minRunMs = 20_000, now = () => Date.now() }) {
  const startedAt = new Map(); // address → when it went working

  const label = (t) => [t?.app || t?.program, t?.where].filter(Boolean).join(' · ') || t?.address || '终端';

  function onStatus({ type, address, terminal, before, data }) {
    if (type === 'removed') { startedAt.delete(address); return; }
    if (type === 'finished') {
      const wasAgent = Boolean(before?.state);
      startedAt.delete(address);
      if (wasAgent) notify({ title: '⏹ 已退出', body: label(terminal), tag: `exit-${address}`, address });
      return;
    }
    if (type !== 'status' || !terminal) return;
    const was = before?.state ?? null;
    const is = terminal.state;
    if (is === was) return;
    if (is === 'working') { startedAt.set(address, now()); return; }
    const began = startedAt.get(address);
    startedAt.delete(address);
    if (is === 'blocked') {
      const what = { permission: '等你确认', question: '在问你问题', auth: '需要登录' }[terminal.kind] ?? '等你处理';
      notify({ title: `✋ ${what}`, body: [label(terminal), terminal.msg].filter(Boolean).join('：').slice(0, 160), tag: `need-${address}`, address, urgent: true });
    } else if (is === 'error') {
      notify({ title: '⚠️ 出错', body: [label(terminal), terminal.msg].filter(Boolean).join('：').slice(0, 160), tag: `err-${address}`, address });
    } else if (is === 'done' && was === 'working' && began !== undefined && now() - began >= minRunMs) {
      notify({ title: '✅ 完成', body: label(terminal), tag: `done-${address}`, address });
    }
    void data;
  }

  return { onStatus };
}
