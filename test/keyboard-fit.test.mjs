// The terminal page with the iOS keyboard up and down (app/src/keyboard-fit.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { followKeyboard } from '../app/src/keyboard-fit.js';

/** An iPhone page: 800 px high, a field, and a visual viewport that sends events only when told. */
function phone() {
  const on = (bag) => ({
    addEventListener: (t, f) => (bag[t] ??= new Set()).add(f),
    removeEventListener: (t, f) => bag[t]?.delete(f),
    fire: (t) => [...(bag[t] ?? [])].forEach((f) => f()),
  });
  const vv = { height: 800, offsetTop: 0, ...on({}) };
  const field = on({});
  const win = {
    innerHeight: 800, scrollX: 0, scrollY: 0, scrolls: [], scrollTo(x, y) { win.scrolls.push([x, y]); win.scrollX = x; win.scrollY = y; },
    polls: 0,
    document: { activeElement: null },
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t),
    setInterval: (...a) => { win.polls++; return setInterval(...a); }, clearInterval: (t) => clearInterval(t),
    ...on({}),
  };
  const screen = { style: { height: '', transform: '' } };
  const focus = () => { win.document.activeElement = field; field.fire('focus'); };
  const blur = () => { win.document.activeElement = null; field.fire('blur'); };
  const keyboardUp = () => { vv.height = 420; vv.offsetTop = 60; vv.fire('resize'); };
  return { vv, field, win, screen, focus, blur, keyboardUp };
}

test('keyboard up: the page takes the visible part of the screen', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = phone();
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.focus(); p.keyboardUp();
  assert.equal(p.screen.style.height, '420px');
  assert.equal(p.screen.style.transform, 'translateY(60px)');
  stop();
});

test('keyboard hidden by its own key (focus stays, iOS sends no event): the page goes back to full height', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = phone();
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.focus(); p.keyboardUp();
  t.mock.timers.tick(2000); // the checks after focus are long over
  p.vv.height = 800; p.vv.offsetTop = 0; // the keyboard is gone; no blur, no resize event
  t.mock.timers.tick(500);
  assert.equal(p.screen.style.height, '');
  assert.equal(p.screen.style.transform, '');
  stop();
});

test('blur: full height at once; stopped: nothing changes any more', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = phone();
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.focus(); p.keyboardUp();
  p.blur();
  assert.equal(p.screen.style.height, '');
  p.focus(); p.keyboardUp();
  stop();
  p.screen.style.height = 'kept';
  p.vv.height = 800; p.vv.offsetTop = 0;
  t.mock.timers.tick(5000);
  assert.equal(p.screen.style.height, 'kept');
});

test('iOS scrolled the page for the field: back to the top once the keyboard is down, not while it is up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = phone();
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.focus(); p.keyboardUp();
  p.win.scrollY = 300; p.vv.fire('scroll');
  assert.deepEqual(p.win.scrolls, []);
  p.vv.height = 800; p.vv.offsetTop = 0;
  t.mock.timers.tick(500);
  assert.deepEqual(p.win.scrolls, [[0, 0]]);
  p.win.scrollX = 40; t.mock.timers.tick(500);
  assert.deepEqual(p.win.scrolls, [[0, 0], [0, 0]]);
  stop();
});

test('no offset: no transform; a shorter viewport by 120 px or less is the toolbar, not the keyboard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = phone();
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.focus(); p.vv.height = 420; p.vv.fire('resize');
  assert.deepEqual(p.screen.style, { height: '420px', transform: '' });
  p.vv.height = 680; p.vv.fire('resize');
  assert.equal(p.screen.style.height, '');
  stop();
});

test('one poll at a time, and only while the field is focused', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = phone();
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  assert.equal(p.win.polls, 0);
  p.focus(); p.keyboardUp(); p.vv.fire('scroll'); t.mock.timers.tick(1000);
  assert.equal(p.win.polls, 1);
  p.blur(); p.vv.fire('resize'); t.mock.timers.tick(1000);
  assert.equal(p.win.polls, 1);
  stop();
});
