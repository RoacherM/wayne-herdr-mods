/**
 * Hold-to-talk voice recording on the iOS terminal page, as an explicit state machine
 * (DESIGN.md「语音输入（已实现）」). Pure: no I/O, no timers. ios/App.tsx feeds it events and
 * carries out the effects. The PWA (app/src/main.js) already covers the same cases with its
 * `held` flag, so it does not use this module.
 *
 *   phase    '' → starting → rec → busy → ''
 *
 * The bug it pins: voice.start is async — a release while it is in flight used to land on
 * phase '' and do nothing, so the recording ran to the 60 s limit. Here `held` and `gone`
 * decide what a late `started` must do.
 *
 * Events (`step(state, event)`):
 *   {type:'press'}        finger down (ignored unless phase is '' and the page is alive)
 *   {type:'release'}      finger up
 *   {type:'started'}      voice.start resolved
 *   {type:'startFailed'}  voice.start threw
 *   {type:'cancel'}       the bubble's cancel tap
 *   {type:'busy'}         voice.stop left us waiting on the recognizer
 *   {type:'done'}         stop/cancel finished (record path settled)
 *   {type:'dispose'}      the page unmounted
 *
 * Effects (strings, carried out in order):
 *   'start'      call voice.start, then send 'started' / 'startFailed'
 *   'recording'  voice.start is live: timers, haptic, clock
 *   'finish'     finger up while recording: the stop-or-cancel path (<400 ms still cancels)
 *   'cancel'     call voice.cancel, forget the recording
 *   'hint'       tell the person to hold longer ('按住说话，松开输入')
 */

export function initial() {
  return { phase: '', held: false, gone: false };
}

export function step(st, ev) {
  const fx = [];
  const go = (phase, extra = {}) => ({ ...st, ...extra, phase });
  switch (ev.type) {
    case 'press':
      if (st.phase !== '' || st.gone) return { state: st, fx };
      fx.push('start');
      return { state: { ...st, phase: 'starting', held: true }, fx };
    case 'release':
      if (st.phase === 'starting') return { state: { ...st, held: false }, fx };
      if (st.phase === 'rec') { fx.push('finish'); return { state: st, fx }; }
      return { state: st, fx };
    case 'started':
      if (st.phase !== 'starting') return { state: st, fx };
      if (st.gone) { fx.push('cancel'); return { state: go(''), fx }; }
      if (!st.held) { fx.push('cancel', 'hint'); return { state: go(''), fx }; }
      fx.push('recording');
      return { state: go('rec'), fx };
    case 'startFailed':
      if (st.phase !== 'starting') return { state: st, fx };
      return { state: go('', { held: false }), fx };
    case 'cancel':
      if (st.phase !== 'rec') return { state: st, fx };
      fx.push('cancel');
      return { state: go(''), fx };
    case 'busy':
      if (st.phase !== 'rec') return { state: st, fx };
      return { state: go('busy'), fx };
    case 'done':
      if (st.phase !== 'rec' && st.phase !== 'busy') return { state: st, fx };
      return { state: go('', { held: false }), fx };
    case 'dispose':
      if (st.phase === 'rec') { fx.push('cancel'); return { state: go('', { gone: true }), fx }; }
      return { state: { ...st, gone: true }, fx };
    default:
      return { state: st, fx };
  }
}

/** A session for one page: `send(event)` steps it and hands the effects to `run`. */
export function voiceHold(run) {
  let state = initial();
  const session = {
    get state() { return state; },
    send(ev) {
      const r = step(state, ev);
      state = r.state;
      run(r.fx, session);
      return r.fx;
    },
  };
  return session;
}
