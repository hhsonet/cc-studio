'use strict';

// The width rules for the resizable editor columns (public/resize.js). The maths is pure, so no browser is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/resize.js');

test('the Files column may grow until the editor would drop below its minimum, and never past the cap', () => {
  // wide row: the cap (520) is the limit
  assert.equal(R.sideRoom(1900, 640), R.MAX_SIDE);
  // 1000px row with a 420px console: 1000 - 420 - 280 = 300
  assert.equal(R.sideRoom(1000, 420), 300);
  // a console stacked under the editor takes no width
  assert.equal(R.sideRoom(800, 0), 520);
  // a collapsed console is a thin rail
  assert.equal(R.sideRoom(1000, R.RAIL_PANEL), 520);
});

test('the console column may grow until the editor would drop below its minimum', () => {
  assert.equal(R.panelRoom(1900, 240), 1900 - 240 - R.MIN_EDITOR);
  assert.equal(R.panelRoom(1000, R.RAIL_SIDE), 1000 - 48 - 280);
});

test('fit keeps a width between the minimum and the room, and the minimum wins when there is no room', () => {
  assert.equal(R.fit(300, 160, 520), 300);
  assert.equal(R.fit(50, 160, 520), 160); // too narrow
  assert.equal(R.fit(900, 160, 520), 520); // too wide
  assert.equal(R.fit(300, 160, 100), 160); // a tiny window: never below the minimum
  assert.equal(R.fit(300.6, 160, 520), 301); // whole pixels
});

test('dragging right widens the Files column; dragging left widens the console column', () => {
  assert.equal(R.dragWidth(240, 300, 360, 1), 300); // right by 60
  assert.equal(R.dragWidth(240, 300, 260, 1), 200); // left by 40
  assert.equal(R.dragWidth(500, 900, 860, -1), 540); // left by 40 widens the right-hand column
  assert.equal(R.dragWidth(500, 900, 960, -1), 440); // right by 60 narrows it
});

test('limits stay sensible for a typical 1280px window', () => {
  const side = R.fit(R.dragWidth(240, 0, 2000, 1), R.MIN_SIDE, R.sideRoom(1280, 540));
  assert.equal(side, 460); // 1280 - 540 - 280
  assert.ok(1280 - side - 540 >= R.MIN_EDITOR);
  const panel = R.fit(R.dragWidth(540, 2000, 0, -1), R.MIN_PANEL, R.panelRoom(1280, 240));
  assert.equal(panel, 760); // 1280 - 240 - 280
  assert.ok(1280 - 240 - panel >= R.MIN_EDITOR);
});
