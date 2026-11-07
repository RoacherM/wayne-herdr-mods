// Who leads the terminal's size after a `size` event (app/src/lead.js, DESIGN.md「多个窗口怎么同步」).
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadsAfterSize } from '../app/src/lead.js';

const phone = JSON.stringify({ cols: 57, rows: 46 });

test('a Mac window resizing away from the phone grid takes the lead; the phone grid gives it back', () => {
  assert.equal(leadsAfterSize(true, phone, { cols: 108, rows: 55 }), false);
  assert.equal(leadsAfterSize(false, phone, { cols: 57, rows: 46 }), true);
});

// Live log 2026-11-07: term.open went out with fit null (page not ready yet); the Mac-size `size`
// replayed from `early` flipped leads to false, so the next reconnect gave up the lead.
test('a size while the phone sent no grid (none yet, or away) leaves leads as it was', () => {
  for (const sent of ['', 'null']) {
    assert.equal(leadsAfterSize(true, sent, { cols: 108, rows: 55 }), true, `fitSent ${JSON.stringify(sent)}`);
    assert.equal(leadsAfterSize(false, sent, { cols: 57, rows: 46 }), false, `fitSent ${JSON.stringify(sent)}`);
  }
});
