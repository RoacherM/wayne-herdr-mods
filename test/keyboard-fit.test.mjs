// The terminal page with the iOS keyboard up and down (app/src/keyboard-fit.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { followKeyboard } from '../app/src/keyboard-fit.js';

/** An iPhone page: 800 px high, a field, and a visual viewport that sends events only when told. */
function phone() {
  const on = (bag) => ({
    addEventListener: (t, f) => (bag[t] ??= new Set()).add(f),
    removeEventListener: (t, f) => bag[t]?.delete(f),
    fire: (t) => [...(bag[t] ?? [])].forEach((f) => f({ type: t })),
  });
  const vv = { height: 800, offsetTop: 0, ...on({}) };
  const field = on({});
  field.blur = () => { if (win.document.activeElement === field) blur(); };
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
  const keyboardUp = () => { vv.height = 420; vv.offsetTop = 60; win.scrollY = 60; vv.fire('resize'); };
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
  p.win.scrollY = 300; p.vv.offsetTop = 300; p.vv.fire('scroll');
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

test('note: each change once, with what set it off', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = phone();
  const notes = [];
  p.field.tagName = 'TEXTAREA'; p.field.className = 'term-keys';
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv, note: (d) => notes.push(d) });
  p.focus(); p.keyboardUp(); p.vv.fire('scroll');
  t.mock.timers.tick(1000);
  p.vv.height = 800; p.vv.offsetTop = 0; t.mock.timers.tick(200);
  assert.deepEqual(notes.map((n) => [n.why, n.f, n.vh, n.up]), [['start', false, 800, false], ['focus', true, 800, false], ['vv.resize', true, 420, true], ['poll', true, 800, false]]);
  assert.equal(notes[1].act, 'TEXTAREA.term-keys');
  stop();
});

// Chrome on iOS 27.0, 2026-11-07 (the phone's `kbd` records): with the keyboard up, iOS scrolls the
// window and the viewport together (offsetTop = scrollY). The keyboard's own hide key scrolls the
// window back to 0, but the viewport keeps its keyboard-up values (476 high, 72 down) and sends no
// event, until the field loses its focus.
const iPhone = (p) => { p.win.innerHeight = 753; p.vv.height = 753; };
const upAndScrolled = (p) => { p.vv.height = 476; p.vv.offsetTop = 0; p.vv.fire('resize'); p.vv.offsetTop = 72; p.win.scrollY = 72; p.vv.fire('scroll'); };

test('keyboard hidden by its own key, the viewport stale (iOS 27): the field lets go, the page goes back to full height', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_794_000_000_000 });
  const p = phone(); iPhone(p);
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.focus(); t.mock.timers.tick(100); upAndScrolled(p);
  t.mock.timers.tick(2000);
  assert.equal(p.screen.style.height, '476px');
  p.win.scrollY = 0; p.win.fire('scroll'); // hidden: only the window moved
  assert.equal(p.win.document.activeElement, p.field); // once: not yet
  t.mock.timers.tick(200); // the poll reads it again
  assert.equal(p.win.document.activeElement, null);
  assert.deepEqual(p.screen.style, { height: '', transform: '' });
  stop();
});

test('just focused, the viewport still at its old place: the keyboard is coming, the field keeps its focus', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_794_000_000_000 });
  const p = phone(); iPhone(p);
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.vv.height = 476; p.vv.offsetTop = 72; // left from before
  p.focus(); t.mock.timers.tick(200);
  assert.equal(p.win.document.activeElement, p.field);
  p.vv.offsetTop = 0; p.vv.fire('scroll');
  t.mock.timers.tick(2000);
  assert.equal(p.win.document.activeElement, p.field);
  assert.equal(p.screen.style.height, '476px');
  stop();
});

test('zoomed in with the keyboard up: the viewport is off the scroll, and that is not the hide key', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_794_000_000_000 });
  const p = phone(); iPhone(p);
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.focus(); t.mock.timers.tick(100); upAndScrolled(p);
  t.mock.timers.tick(2000);
  p.vv.scale = 1.5; p.vv.offsetTop = 200; p.vv.fire('scroll');
  assert.equal(p.win.document.activeElement, p.field);
  p.vv.scale = 1; p.vv.offsetTop = 72; p.vv.fire('scroll');
  p.win.scrollY = 50; p.vv.offsetTop = 70; p.win.fire('scroll'); // 20 px off: still the same
  assert.equal(p.win.document.activeElement, p.field);
  stop();
});

test('the viewport off the scroll for one read only (a bounce, a turn): the field keeps its focus', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_794_000_000_000 });
  const p = phone(); iPhone(p);
  const stop = followKeyboard({ screen: p.screen, field: p.field, win: p.win, vv: p.vv });
  p.focus(); t.mock.timers.tick(100); upAndScrolled(p);
  t.mock.timers.tick(2000);
  p.win.scrollY = 0; p.win.fire('scroll');
  t.mock.timers.tick(100); p.win.scrollY = 72; p.win.fire('scroll'); // back in step before the next read
  t.mock.timers.tick(1000);
  p.win.scrollY = 0; p.win.fire('scroll'); // off again: counts from now
  t.mock.timers.tick(100);
  assert.equal(p.win.document.activeElement, p.field);
  stop();
});
