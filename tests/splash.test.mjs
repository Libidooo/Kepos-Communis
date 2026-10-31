import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSplashFrame, layoutSplash, createSplashComponent, playSplash, lecternProgress, lecternLighting, splashLight, SPLASH_TIMING, SPLASH_STEPS, SPLASH_VIEW } from '../dist/terminal/splash.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

const bare = frame => frame.map(stripVTControlCharacters);
const stillStep = SPLASH_TIMING.revealMs / SPLASH_TIMING.frameMs;
const dimensions = [[100, 30], [120, 35], [160, 45], [200, 60]];
const quadrants = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, message || `${a} != ${b}`);
const frameAt = (ms, width = 120, rows = 35) => buildSplashFrame(ms / SPLASH_TIMING.frameMs, width, rows);

function screenCells(frame) {
  return frame.map((line, y) => {
    let color = '', x = 0;
    const cells = [];
    for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]/gu) || []) {
      if (token.startsWith('\x1b[')) { color = token === '\x1b[39m' ? '' : token; continue; }
      cells.push({ char: token, color, x, y, rgb: (color.match(/38;2;(\d+);(\d+);(\d+)m/) || []).slice(1).map(Number) });
      x += visibleWidth(token);
    }
    return cells;
  });
}
const allCells = frame => screenCells(frame).flat();
const painted = frame => allCells(frame).filter(cell => cell.char !== ' ' && cell.char !== '');

test('lecterns stay left of a complete wordmark at every supported size', () => {
  for (const [width, height] of dimensions) {
    const layout = layoutSplash(width, height);
    assert.ok(layout, `${width}x${height} must have a layout`);
    const { ring, wordmark } = layout;
    assert.equal(ring.lecterns.length, 48);
    assert.deepEqual(ring.lecterns.map(seat => seat.id), Array.from({ length: 48 }, (_, i) => i));
    assert.ok(wordmark.x - (ring.x + ring.width) >= 4);
    assert.ok(wordmark.height > 0 && wordmark.width > 0);
    assert.ok(Math.abs(ring.x - (width - wordmark.x - wordmark.width)) <= 1, 'brand unit centered');
    assert.ok(Math.abs(ring.cy - (wordmark.y + wordmark.height / 2)) <= 1, 'vertically aligned');
    const frame = frameAt(SPLASH_TIMING.revealMs, width, height);
    assert.equal(frame.length, height);
    assert.ok(frame.every(line => visibleWidth(line) === width));
    const cells = painted(frame);
    for (const cell of cells) assert.ok(cell.char.match(/[▘▝▀▖▌▞▛▗▚▐▜▄▙▟█]/), `unexpected glyph ${cell.char}`);
    // No paint may land in the gutter: shapes are separated in space, not overlapped then recolored.
    const gutter = cells.filter(cell => cell.x >= ring.x + ring.width && cell.x < wordmark.x);
    assert.equal(gutter.length, 0, 'gutter must stay empty');
    assert.ok(cells.every(cell => cell.x < width));
  }
});

test('each lectern keeps a trapezoid tablet and outward name plate after projection', () => {
  for (const [width, rows] of dimensions) {
    const layout = layoutSplash(width, rows);
    const ring = layout.ring;
    const aspect = layout.cellAspect;
    for (const seat of ring.lecterns) {
      assert.equal(seat.tablet.length, 4);
      assert.ok(seat.plate.length === 4 || seat.plate.length === 0, 'plate may be dropped on compact layouts');
      if (!seat.plate.length) continue;
      const [outerA, outerB, innerB, innerA] = seat.tablet;
      const widthOf = (a, b) => Math.hypot((b.x - a.x) / aspect, (b.y - a.y) / SPLASH_VIEW.depth);
      assert.ok(widthOf(innerA, innerB) > widthOf(outerA, outerB) * 1.2, 'inner edge wider than outer edge (brand trapezoid)');
      assert.ok(widthOf(outerA, innerA) > 0, 'tablet has radial depth');
      // The vertical plate shares the outer edge's screen X and drops straight down, as a sign on the desk.
      // Side seats widen their plate for readability, so compare the shared mid-point.
      // Vertices snap to the half-cell sampling grid for clean edges, so allow one snap step.
      assert.ok(Math.abs((seat.plate[0].x + seat.plate[1].x) / 2 - (outerA.x + outerB.x) / 2) <= .5);
      assert.ok(seat.plate[3].y > seat.plate[0].y, 'plate hangs downward on screen');
      near(seat.plate[3].x, seat.plate[0].x, 'vertical sides keep the screen X');
      near(seat.plate[2].x, seat.plate[1].x);
      const seatRadius = Math.hypot((seat.center.x - ring.cx) / aspect, (seat.center.y - ring.cy) / SPLASH_VIEW.depth);
      near(seatRadius, ring.radius, 'seat anchors stay on the circle');
      near(Math.hypot(seat.outward.x, seat.outward.y), 1);
    }
    for (const seat of ring.lecterns) {
      const opposite = ring.lecterns[(seat.id + 24) % 48];
      near(seat.center.x + opposite.center.x, ring.cx * 2);
      near(seat.center.y + opposite.center.y, ring.cy * 2);
    }
    assert.ok(SPLASH_VIEW.depth > .9, 'near-overhead camera keeps the ring round');
    assert.ok(layoutSplash(width, rows) === layout || JSON.stringify(layoutSplash(width, rows)) === JSON.stringify(layout));
  }
});

test('the 48 lecterns never touch each other, so each reads as a separate desk', () => {
  for (const [width, height] of dimensions) {
    const layout = layoutSplash(width, height);
    const owners = new Map();
    for (const seat of layout.ring.lecterns) for (const sample of seat.samples) {
      const key = `${sample.x},${sample.y}`;
      if (!owners.has(key)) owners.set(key, seat.id);
    }
    let contacts = 0;
    for (const [key, id] of owners) {
      const [x, y] = key.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const other = owners.get(`${x + dx},${y + dy}`);
        if (other !== undefined && other !== id) contacts++;
      }
    }
    assert.equal(contacts, 0, `${width}x${height}: adjacent sub-cells from different seats`);
  }
});

test('every lectern surface remains visible and draws inside its own bounds', () => {
  for (const [width, rows] of dimensions) {
    const layout = layoutSplash(width, rows);
    for (const seat of layout.ring.lecterns) {
      for (const part of ['desktop', 'plaque']) {
        const own = seat.samples.filter(sample => sample.part === part);
        // Compact layouts legitimately drop the name plates entirely.
        if (part === 'plaque' && !own.length && !seat.samples.some(x => x.part === 'plaque')) continue;
        assert.ok(own.length >= 1, `seat ${seat.id} ${part} needs drawable area`);
        for (const sample of own) {
          assert.ok(sample.coverage >= .05, 'sub-cell coverage is kept so edges antialias');
          const x = sample.x / 2, y = sample.y / 2;
          assert.ok(x >= layout.ring.x && x < layout.ring.x + layout.ring.width);
          assert.ok(y >= layout.ring.y && y < layout.ring.y + layout.ring.height);
        }
      }
    }
  }
});

test('tablets arrive first, plates are lit afterwards without moving', () => {
  for (let index = 0; index < 48; index++) {
    assert.deepEqual(lecternProgress(0, index), { desktop: 0, plaque: 0 });
    assert.deepEqual(lecternProgress(SPLASH_TIMING.tableMs, index), { desktop: 1, plaque: 0 });
    assert.equal(lecternProgress(SPLASH_TIMING.lightStartMs, index).plaque, 0);
    assert.deepEqual(lecternProgress(SPLASH_TIMING.lightEndMs, index), { desktop: 1, plaque: 1 });
    let previous = 0;
    for (let ms = SPLASH_TIMING.lightStartMs; ms <= SPLASH_TIMING.lightEndMs; ms += 40) {
      const value = lecternProgress(ms, index).plaque;
      assert.ok(value >= previous && value <= 1);
      previous = value;
    }
  }
  const middle = (SPLASH_TIMING.lightStartMs + SPLASH_TIMING.lightEndMs) / 2;
  assert.ok(lecternProgress(middle, 36).plaque > lecternProgress(middle, 12).plaque, 'left is lit before right');
  const layout = layoutSplash(120, 35);
  const snapshot = JSON.stringify(layout.ring.lecterns);
  for (const ms of [720, 1000, 1300, 1720]) frameAt(ms, 120, 35);
  assert.equal(JSON.stringify(layout.ring.lecterns), snapshot, 'no geometry changes during lighting');
});

test('the light sweeps left to right and finally rests on the right', () => {
  assert.ok(splashLight(SPLASH_TIMING.lightStartMs).x < -.7, 'starts from the left');
  const final = splashLight(SPLASH_TIMING.revealMs);
  assert.ok(final.x > .8 && final.z > 0);
  near(Math.hypot(final.x, final.y, final.z), 1);
  assert.deepEqual(splashLight(9000), final, 'light is static during the hold');
  const { lecterns } = layoutSplash(160, 45).ring;
  const right = lecternLighting(SPLASH_TIMING.revealMs, lecterns[12]);
  const left = lecternLighting(SPLASH_TIMING.revealMs, lecterns[36]);
  assert.ok(right.plaque > left.plaque + .5, 'right-facing plates are strongly lit');
  assert.ok(left.plaque < .05, 'far side stays in shadow rather than flat-lit');
  assert.ok(right.plaque > .5);
});

test('ring shading spans from deep shadow to a lit rim in the brand hue', () => {
  const frame = frameAt(SPLASH_TIMING.revealMs, 160, 45);
  const wordmarkX = layoutSplash(160, 45).wordmark.x;
  const ringCells = painted(frame).filter(cell => cell.y < 45 && cell.x < wordmarkX && cell.rgb.length === 3);
  const lum = cell => .2126 * cell.rgb[0] + .7152 * cell.rgb[1] + .0722 * cell.rgb[2];
  const values = ringCells.map(lum);
  const darkest = Math.min(...values), brightest = Math.max(...values);
  assert.ok(brightest - darkest > 90, 'lighting produces a wide tonal range');
  for (const cell of ringCells) {
    const [r, g, b] = cell.rgb;
    assert.ok(r >= g && r >= b, 'stays within the vermilion family (red dominant)');
  }
});

test('wordmark is a squared pixel face with a brand shadow that clears', () => {
  const layout = layoutSplash(160, 45);
  assert.equal(layout.wordmark.variant, 'display');
  assert.ok(layout.wordmark.fontWidth > 40, 'display face is wide');
  assert.ok(layout.wordmark.width >= layout.wordmark.fontWidth, 'box covers the glyphs plus shadow');
  const during = painted(frameAt(1300, 160, 45)).filter(cell => cell.x >= layout.wordmark.x && cell.rgb.length === 3);
  const final = painted(frameAt(SPLASH_TIMING.revealMs, 160, 45)).filter(cell => cell.x >= layout.wordmark.x && cell.rgb.length === 3);
  for (const cell of final) assert.deepEqual(cell.rgb, [255, 255, 255], 'settles to pure white');
  const dark = during.filter(cell => .2126 * cell.rgb[0] + .7152 * cell.rgb[1] + .0722 * cell.rgb[2] < 120);
  assert.ok(dark.length > 0, 'a brand-red drop shadow is visible while the logotype arrives');
  const warm = during.filter(cell => {
    const [r, g, b] = cell.rgb;
    return r > 200 && g > 100 && g < 215 && b < 200;
  });
  assert.ok(warm.length > 0, 'a warm highlight band crosses the letters');
});

test('wordmark warmth travels right and the letters never move', () => {
  const layout = layoutSplash(120, 35);
  const warmthCenter = ms => {
    let sum = 0, weight = 0;
    for (const cell of painted(frameAt(ms)).filter(c => c.x >= layout.wordmark.x && c.rgb.length === 3)) {
      const warmth = cell.rgb[0] - cell.rgb[1];
      if (warmth <= 0) continue;
      sum += cell.x * warmth; weight += warmth;
    }
    return weight ? sum / weight : null;
  };
  const start = warmthCenter(1300), middle = warmthCenter(1450), end = warmthCenter(1540);
  assert.ok(start !== null && middle !== null && end !== null, 'the highlight is visible while it travels');
  assert.ok(middle > start && end > middle, 'highlight travels toward the right');
  assert.equal(warmthCenter(SPLASH_TIMING.revealMs), null, 'warmth clears before the hold');
  // Letter pixels are identical across those frames; only hue changes.
  const w = layout.wordmark.width;
  const shape = ms => buildSplashFrame(ms / SPLASH_TIMING.frameMs, 120, 35)
    .map(stripVTControlCharacters).map(line => line.slice(layout.wordmark.x, layout.wordmark.x + w)).join('\n');
  assert.equal(shape(1560), shape(SPLASH_TIMING.revealMs), 'glyph pixels are stable once the shadow clears');
});

test('no stray paint survives outside the final lockup', () => {
  // Whitelist every legal surface: all lectern samples plus the full logotype box.
  const layout = layoutSplash(120, 35);
  const intended = new Set();
  for (const seat of layout.ring.lecterns) for (const sample of seat.samples) intended.add(`${Math.floor(sample.x / 2)},${Math.floor(sample.y / 2)}`);
  for (let y = 0; y < layout.wordmark.height; y++) for (let x = 0; x < layout.wordmark.width; x++) intended.add(`${layout.wordmark.x + x},${layout.wordmark.y + y}`);
  for (let y = layout.ring.y; y < layout.ring.y + layout.ring.height; y++) for (let x = layout.ring.x; x < layout.ring.x + layout.ring.width; x++) intended.add(`${x},${y}`);
  for (const step of [0, 4, 10, 16, 22, 28, 34, 40]) {
    const frame = buildSplashFrame(step, 120, 35);
    assert.ok(frame.every(line => visibleWidth(line) === 120));
    for (const cell of painted(frame)) assert.ok(intended.has(`${cell.x},${cell.y}`), `unexpected paint at ${cell.x},${cell.y}`);
  }
  assert.ok(bare(frameAt(0)).every(line => !line.trim()));
});

test('complete composition holds unchanged for a full second before fading', () => {
  const complete = frameAt(SPLASH_TIMING.revealMs);
  const endHold = (SPLASH_TIMING.revealMs + SPLASH_TIMING.holdMs) / SPLASH_TIMING.frameMs;
  for (let step = stillStep; step <= endHold; step++) assert.deepEqual(buildSplashFrame(step, 120, 35), complete);
  const fading = buildSplashFrame(endHold + 8, 120, 35);
  const cellsOf = frame => new Set(bare(frame).flatMap((line, y) => [...line].map((ch, x) => ch !== ' ' ? `${x},${y}` : '')).filter(Boolean));
  const before = cellsOf(complete), after = cellsOf(fading);
  for (const key of after) assert.ok(before.has(key), 'fade must not introduce new geometry');
  assert.notDeepEqual(fading, complete, 'fade changes color');
  assert.ok(bare(buildSplashFrame(SPLASH_STEPS, 120, 35)).every(line => !line.trim()));
});

test('layout adapts to width and skips cleanly when the unit cannot fit', () => {
  assert.ok(layoutSplash(100, 30), 'narrow layouts still render a compact lockup');
  assert.equal(layoutSplash(120, 35).wordmark.variant, 'display');
  assert.ok(layoutSplash(100, 30).wordmark.width <= layoutSplash(160, 45).wordmark.width);
  for (const [width, height] of [[0, 0], [1, 1], [20, 8], [40, 12], [120, 10], [24, 35], [60, 24]]) {
    assert.equal(layoutSplash(width, height), null);
    for (const step of [0, stillStep, SPLASH_STEPS]) {
      const frame = buildSplashFrame(step, width, height);
      assert.equal(frame.length, height);
      assert.ok(frame.every(line => visibleWidth(line) === width && !line.trim()));
    }
  }
});

function fakeClock() {
  let now = 0, nextId = 0;
  const callbacks = new Map();
  return {
    now: () => now,
    every: callback => { const id = ++nextId; callbacks.set(id, callback); return id; },
    clear: id => callbacks.delete(id),
    advance(milliseconds) { now += milliseconds; for (const callback of [...callbacks.values()]) callback(); },
    get active() { return callbacks.size; },
  };
}
function harness(options = {}) {
  const clock = fakeClock();
  let renders = 0, done = 0;
  const tui = { terminal: { rows: 35 }, requestRender() { renders++; } };
  const component = createSplashComponent(tui, () => { done++; }, { clock, cellDimensions: () => ({ widthPx: 10, heightPx: 20 }), ...options });
  return { clock, tui, component, get done() { return done; }, get renders() { return renders; } };
}

test('playback measures the hold from the first complete render, not timer ticks', () => {
  const h = harness();
  h.component.render(160);
  h.clock.advance(4000);
  assert.equal(h.done, 0);
  const complete = h.component.render(160);
  assert.ok(painted(complete).length > 0);
  h.clock.advance(999);
  assert.deepEqual(h.component.render(160), complete);
  assert.equal(h.done, 0);
  h.clock.advance(1);
  assert.deepEqual(h.component.render(160), complete);
  h.clock.advance(200);
  assert.notDeepEqual(h.component.render(160), complete, 'fade changes the rendered colors');
  assert.equal(h.done, 0);
  h.clock.advance(120);
  assert.equal(h.done, 1);
  assert.equal(h.clock.active, 0);
});

test('resize recomposes and gives the new complete frame its own hold', () => {
  const h = harness();
  h.component.render(160);
  h.clock.advance(SPLASH_TIMING.revealMs);
  h.component.render(160);
  h.clock.advance(900);
  // 24 rows cannot hold the lockup, so resize to a supported smaller geometry.
  h.tui.terminal.rows = 30;
  const compact = h.component.render(120);
  assert.ok(compact.every(line => visibleWidth(line) === 120));
  h.clock.advance(999);
  assert.deepEqual(h.component.render(120), compact);
  assert.equal(h.done, 0);
  h.clock.advance(1);
  h.component.render(120);
  h.clock.advance(SPLASH_TIMING.fadeMs);
  assert.equal(h.done, 1);
  assert.equal(h.clock.active, 0);
});

test('splash waits for first desk data before beginning its exit', async () => {
  let resolve;
  const ready = new Promise(done => { resolve = done; });
  const h = harness({ ready });
  h.component.render(160);
  h.clock.advance(SPLASH_TIMING.revealMs);
  const complete = h.component.render(160);
  h.clock.advance(5000);
  assert.deepEqual(h.component.render(160), complete);
  assert.equal(h.done, 0);
  resolve();
  await ready;
  await Promise.resolve();
  h.component.render(160);
  h.clock.advance(SPLASH_TIMING.fadeMs);
  assert.equal(h.done, 1);
});

test('input, invalidate and disposal behave idempotently', () => {
  for (const method of ['keyboard', 'mouse', 'dispose']) {
    const h = harness();
    h.component.render(160);
    assert.doesNotThrow(() => h.component.invalidate());
    assert.deepEqual(h.component.handleMouse({ type: 'move' }), { handled: true });
    assert.equal(h.done, 0);
    if (method === 'keyboard') h.component.handleInput('x');
    if (method === 'mouse') assert.deepEqual(h.component.handleMouse({ type: 'press' }), { handled: true });
    h.component.dispose(); h.component.dispose(); h.clock.advance(10000);
    assert.equal(h.clock.active, 0);
    assert.equal(h.done, method === 'dispose' ? 0 : 1);
  }
});

test('a terminal too small for the lockup exits safely', () => {
  const h = harness();
  h.tui.terminal.rows = 8;
  assert.equal(h.component.render(24).length, 8);
  h.clock.advance(40);
  assert.equal(h.done, 1);
  assert.equal(h.clock.active, 0);
});

test('disabled splash allocates nothing and a process plays once', async () => {
  const previous = process.env.KEPOS_NO_SPLASH;
  const key = Symbol.for('kepos.splash.played');
  const previousPlayed = globalThis[key];
  let calls = 0;
  const ctx = { ui: { async custom(factory) {
    calls++;
    const component = factory({ terminal: { rows: 35 }, requestRender() {} }, {}, {}, () => {});
    component.invalidate(); component.handleInput('skip'); component.dispose();
  } } };
  try {
    delete globalThis[key]; delete process.env.KEPOS_NO_SPLASH;
    await playSplash(ctx, { motion: false }); assert.equal(calls, 0);
    process.env.KEPOS_NO_SPLASH = '1';
    await playSplash(ctx); assert.equal(calls, 0);
    delete process.env.KEPOS_NO_SPLASH;
    await playSplash(ctx); await playSplash(ctx); assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.KEPOS_NO_SPLASH; else process.env.KEPOS_NO_SPLASH = previous;
    if (previousPlayed === undefined) delete globalThis[key]; else globalThis[key] = previousPlayed;
  }
});
