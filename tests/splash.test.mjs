import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSplashFrame, layoutSplash, createSplashComponent, playSplash, lecternProgress, lecternLighting, splashLight, SPLASH_TIMING, SPLASH_STEPS, SPLASH_VIEW } from '../dist/terminal/splash.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

const bare = frame => frame.map(stripVTControlCharacters);
const stillStep = SPLASH_TIMING.revealMs / SPLASH_TIMING.frameMs;
const dimensions = [[80, 24], [100, 30], [120, 35], [160, 45], [260, 80]];
const quadrants = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-7, message || `${a} != ${b}`);
const frameAt = (ms, width = 120, rows = 35) => buildSplashFrame(ms / SPLASH_TIMING.frameMs, width, rows);

function screenCells(frame) {
  return frame.map(line => {
    let color = '', x = 0;
    const cells = [];
    for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]/gu) || []) {
      if (token.startsWith('\x1b[')) { color = token === '\x1b[39m' ? '' : token; continue; }
      cells.push({ char: token, color, x });
      x += visibleWidth(token);
    }
    return cells;
  });
}
function subpixels(frame) {
  const pixels = new Map();
  screenCells(frame).forEach((line, y) => line.forEach(cell => {
    const mask = quadrants.indexOf(cell.char);
    if (mask <= 0) return;
    for (let bit = 0; bit < 4; bit++) if (mask & (1 << bit)) {
      pixels.set(`${cell.x * 2 + bit % 2},${y * 2 + Math.floor(bit / 2)}`, cell.color);
    }
  }));
  return pixels;
}
function surfaceOwners(layout) {
  const owners = new Map();
  for (const seat of [...layout.ring.lecterns].sort((a, b) => a.center.y - b.center.y)) {
    for (const p of seat.samples) owners.set(`${p.x},${p.y}`, `${seat.id}:${p.part}`);
  }
  return owners;
}
function assertCompleteLecterns(frame, layout) {
  const pixels = subpixels(frame), owners = surfaceOwners(layout);
  assert.equal(layout.ring.lecterns.length, 48);
  for (const seat of layout.ring.lecterns) {
    for (const part of ['desktop', 'plaque']) {
      const own = seat.samples.filter(p => p.part === part && owners.get(`${p.x},${p.y}`) === `${seat.id}:${part}`);
      assert.ok(own.length, `seat ${seat.id} ${part} must retain visible area after depth ordering`);
      assert.ok(own.some(p => pixels.has(`${p.x},${p.y}`)), `seat ${seat.id} ${part} must be drawn`);
    }
  }
}

test('complete projected lecterns fit left of a fixed-width wordmark with no clipping', () => {
  for (const [width, height] of dimensions) {
    const layout = layoutSplash(width, height);
    assert.ok(layout, `${width}x${height} must have a layout`);
    const { ring, wordmark, gap } = layout;
    assert.deepEqual(ring.lecterns.map(seat => seat.id), Array.from({ length: 48 }, (_, i) => i));
    assert.equal(new Set(ring.points.map(p => `${p.x},${p.y}`)).size, 48);
    assert.ok(wordmark.x - (ring.x + ring.width) >= 4);
    assert.equal(wordmark.x - (ring.x + ring.width), gap);
    assert.ok(Math.abs(ring.cy - (wordmark.y + wordmark.height / 2)) <= .5);
    assert.ok(Math.abs(ring.x - (width - wordmark.x - wordmark.width)) <= 1, 'combined brand is centered');
    assert.ok(wordmark.lines.every(line => visibleWidth(line) === wordmark.width));
    const frame = frameAt(SPLASH_TIMING.revealMs, width, height);
    assert.equal(frame.length, height);
    assert.ok(frame.every(line => visibleWidth(line) === width));
    assertCompleteLecterns(frame, layout);
    for (const seat of ring.lecterns) {
      for (const p of [...seat.desktop, ...seat.plaque]) {
        assert.ok(p.x >= ring.x && p.x < ring.x + ring.width);
        assert.ok(p.y >= ring.y && p.y < ring.y + ring.height);
      }
    }
    const lines = bare(frame);
    for (let y = 0; y < wordmark.height; y++) {
      assert.equal(lines[wordmark.y + y].slice(wordmark.x, wordmark.x + wordmark.width), wordmark.lines[y]);
    }
    assert.doesNotMatch(lines.join('\n'), /[●·─│╱╲]|议案|议会|48 席/, 'no old dots, tracks or subtitle');
  }
});

test('all 48 desktops share a circular world layout and the same near-overhead projection', () => {
  for (const cellAspect of [1, 1.5, 2, 2.5, 3]) {
    const layout = layoutSplash(160, 45, { cellAspect });
    assert.ok(layout);
    const { ring } = layout;
    for (const seat of ring.lecterns) {
      const x = (seat.center.x - ring.cx) / cellAspect;
      const y = (seat.center.y - ring.cy) / SPLASH_VIEW.depth;
      near(Math.hypot(x, y), ring.radius, 'no whole-cell quantization of circle anchors');
      near(seat.angle, seat.id * Math.PI * 2 / 48);
      const opposite = ring.lecterns[(seat.id + 24) % 48].center;
      near(seat.center.x + opposite.x, ring.cx * 2);
      near(seat.center.y + opposite.y, ring.cy * 2);
      const worldEdge = (a, b) => ({ x: (b.x - a.x) / cellAspect, y: (b.y - a.y) / SPLASH_VIEW.depth });
      const a = worldEdge(seat.desktop[0], seat.desktop[1]);
      const b = worldEdge(seat.desktop[1], seat.desktop[2]);
      near(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y), 'square tabletop before projection');
      near(a.x * b.x + a.y * b.y, 0);
    }
    assert.ok(SPLASH_VIEW.depth >= .93, 'ring should not be flattened into a wide ellipse');
    assert.deepEqual(layoutSplash(160, 45, { cellAspect }), layout);
  }
});

test('boards attach to a visible desktop edge and hang downward in the shared projection', () => {
  for (const [width, rows] of dimensions) {
    const { ring } = layoutSplash(width, rows);
    for (const seat of ring.lecterns) {
      const [a, b, bottomB, bottomA] = seat.plaque;
      const isCorner = p => seat.desktop.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 1e-7);
      assert.ok(isCorner(a) && isCorner(b), 'board starts on a tabletop edge');
      near(bottomA.x, a.x); near(bottomB.x, b.x);
      near(bottomA.y - a.y, seat.boardHeight * SPLASH_VIEW.drop);
      near(bottomB.y - b.y, seat.boardHeight * SPLASH_VIEW.drop);
      assert.ok(bottomA.y > a.y && bottomB.y > b.y, 'board hangs below, not radially outward');
      near(Math.hypot(seat.normal.x, seat.normal.y, seat.normal.z), 1);
      assert.ok(seat.normal.y > 0, 'draw the camera-facing vertical face');
    }
  }
});

test('fixed boards reveal with a lighting front only after all desktops have appeared', () => {
  for (let i = 0; i < 48; i++) {
    assert.deepEqual(lecternProgress(0, i), { desktop: 0, plaque: 0 });
    assert.deepEqual(lecternProgress(SPLASH_TIMING.tableMs, i), { desktop: 1, plaque: 0 });
    assert.equal(lecternProgress(SPLASH_TIMING.plaqueStartMs, i).plaque, 0);
    assert.deepEqual(lecternProgress(SPLASH_TIMING.plaqueEndMs, i), { desktop: 1, plaque: 1 });
    let previous = 0;
    for (let ms = SPLASH_TIMING.plaqueStartMs; ms <= SPLASH_TIMING.plaqueEndMs; ms += 40) {
      const progress = lecternProgress(ms, i).plaque;
      assert.ok(progress >= previous && progress <= 1);
      previous = progress;
    }
  }
  const middle = (SPLASH_TIMING.plaqueStartMs + SPLASH_TIMING.plaqueEndMs) / 2;
  assert.ok(lecternProgress(middle, 36).plaque > lecternProgress(middle, 12).plaque, 'left is illuminated before right');
  const layout = layoutSplash(120, 35), desktopFrame = frameAt(SPLASH_TIMING.tableMs);
  const tablePixels = subpixels(desktopFrame);
  const desktopSamples = new Set(layout.ring.lecterns.flatMap(s => s.samples.filter(p => p.part === 'desktop').map(p => `${p.x},${p.y}`)));
  for (const key of tablePixels.keys()) assert.ok(desktopSamples.has(key), 'no hanging board is painted during the tabletop phase');
  const before = JSON.stringify(layout.ring.lecterns);
  for (const ms of [960, 1120, 1360, 1760]) frameAt(ms);
  assert.equal(JSON.stringify(layout.ring.lecterns), before, 'light never grows or translates geometry');
});

test('light settles on the right and face brightness follows the same light direction', () => {
  const light = splashLight(SPLASH_TIMING.revealMs);
  assert.ok(light.x > 0 && light.z > 0);
  near(light.y, 0);
  near(Math.hypot(light.x, light.y, light.z), 1);
  assert.deepEqual(splashLight(10000), light, 'final light stays still during hold');
  const { lecterns } = layoutSplash(120, 35).ring;
  const right = lecternLighting(SPLASH_TIMING.revealMs, lecterns[8]);
  const left = lecternLighting(SPLASH_TIMING.revealMs, lecterns[40]);
  assert.ok(right.plaque > left.plaque + .2, 'right-facing boards are brighter');
  assert.ok(right.desktop > left.desktop);
  assert.ok(left.plaque >= .3, 'shadow faces retain readable dark red');
  for (const seat of lecterns) {
    const levels = lecternLighting(SPLASH_TIMING.revealMs, seat);
    assert.ok(levels.desktop > levels.plaque, 'near-overhead tabletops stay brighter than vertical boards');
  }
});

test('final wordmark is pure white and lectern surfaces use only shaded brand red', () => {
  const hostileTheme = { fg() { throw Error('brand colors must not inherit a theme color'); } };
  for (const [width, height] of dimensions) {
    const layout = layoutSplash(width, height);
    const cells = screenCells(buildSplashFrame(stillStep, width, height, hostileTheme));
    let red = 0, white = 0;
    for (const cell of cells.flat().filter(c => c.char !== ' ')) {
      if (cell.x >= layout.wordmark.x) { assert.equal(cell.color, '\x1b[38;2;255;255;255m'); white++; }
      else {
        const match = cell.color.match(/38;2;(\d+);(\d+);(\d+)m/);
        assert.ok(match);
        const [r, g, b] = match.slice(1).map(Number);
        assert.ok(r >= g && r >= b && r <= 181 && b <= 59 && g <= 47, 'brand red, not another palette');
        red++;
      }
    }
    assert.ok(red > 48 && white > 40);
  }
});

test('wordmark warmth travels right inside stationary letters and then returns to white', () => {
  const layout = layoutSplash(120, 35);
  const centerOfWarmth = ms => {
    let sum = 0, weight = 0;
    for (const cell of screenCells(frameAt(ms)).flat()) {
      if (cell.x < layout.wordmark.x || cell.char === ' ') continue;
      const match = cell.color.match(/38;2;(\d+);(\d+);(\d+)m/);
      if (!match) continue;
      const [r, g] = match.slice(1).map(Number), warmth = Math.max(0, r - g);
      sum += cell.x * warmth; weight += warmth;
    }
    assert.ok(weight > 0, 'a warm band is present inside the letter mask');
    return sum / weight;
  };
  assert.ok(centerOfWarmth(1560) > centerOfWarmth(1320));
  const rows = [1320, 1560, SPLASH_TIMING.revealMs].map(ms => bare(frameAt(ms)));
  for (let y = 0; y < layout.wordmark.height; y++) {
    const text = rows.map(frame => frame[layout.wordmark.y + y].slice(layout.wordmark.x));
    assert.equal(text[0], text[1]); assert.equal(text[1], text[2]);
  }
});

test('every rendered subpixel belongs to a lectern or the letter mask, never a trail', () => {
  const layout = layoutSplash(120, 35);
  const intended = subpixels(frameAt(SPLASH_TIMING.revealMs));
  for (const step of [0, 4, 12, 18, 24, 30, 38, 44, 69, 72]) {
    const frame = buildSplashFrame(step, 120, 35);
    assert.ok(frame.every(line => visibleWidth(line) === 120));
    for (const key of subpixels(frame).keys()) assert.ok(intended.has(key), `unexpected paint at ${key}`);
  }
  assert.ok(bare(frameAt(0)).every(line => !line.trim()));
});

test('complete composition holds unchanged for a full second before fading', () => {
  const complete = frameAt(SPLASH_TIMING.revealMs);
  const endHold = (SPLASH_TIMING.revealMs + SPLASH_TIMING.holdMs) / SPLASH_TIMING.frameMs;
  for (let step = stillStep; step <= endHold; step++) assert.deepEqual(buildSplashFrame(step, 120, 35), complete);
  const fading = buildSplashFrame(endHold + 2, 120, 35);
  assert.deepEqual(bare(fading), bare(complete), 'fade affects color only, not geometry');
  assert.notDeepEqual(fading, complete);
  assert.ok(bare(buildSplashFrame(SPLASH_STEPS, 120, 35)).every(line => !line.trim()));
});

test('layout is adaptive and tiny viewports skip decoration rather than clipping it', () => {
  assert.equal(layoutSplash(80, 24).wordmark.variant, 'compact');
  assert.equal(layoutSplash(120, 35).wordmark.variant, 'regular');
  assert.equal(layoutSplash(160, 45).wordmark.variant, 'large');
  for (const [width, height] of [[0, 0], [1, 1], [20, 8], [40, 12], [120, 10], [24, 35]]) {
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

test('playback measures hold from the first complete render, not timer ticks', () => {
  const h = harness();
  h.component.render(120);
  h.clock.advance(4000);
  assert.equal(h.done, 0, 'no render has displayed the lockup yet');
  const complete = h.component.render(120);
  assertCompleteLecterns(complete, layoutSplash(120, 35));
  h.clock.advance(999);
  assert.deepEqual(h.component.render(120), complete);
  assert.equal(h.done, 0);
  h.clock.advance(1);
  assert.deepEqual(h.component.render(120), complete);
  h.clock.advance(120);
  assert.notDeepEqual(h.component.render(120), complete);
  assert.equal(h.done, 0);
  h.clock.advance(120);
  assert.equal(h.done, 1);
  assert.equal(h.clock.active, 0);
  h.component.dispose();
  h.component.handleInput('x');
  assert.equal(h.done, 1);
});

test('resize recomposes both shapes and gives the new complete frame its own hold', () => {
  const h = harness();
  h.component.render(120);
  h.clock.advance(SPLASH_TIMING.revealMs);
  h.component.render(120);
  h.clock.advance(900);
  h.tui.terminal.rows = 24;
  const compact = h.component.render(80);
  assertCompleteLecterns(compact, layoutSplash(80, 24));
  assert.ok(compact.every(line => visibleWidth(line) === 80));
  h.clock.advance(999);
  assert.deepEqual(h.component.render(80), compact);
  assert.equal(h.done, 0);
  h.clock.advance(1);
  h.component.render(80);
  h.clock.advance(SPLASH_TIMING.fadeMs);
  assert.equal(h.done, 1);
  assert.equal(h.clock.active, 0);
});

test('splash waits for the first desk data before beginning its exit transition', async () => {
  let resolve;
  const ready = new Promise(done => { resolve = done; });
  const h = harness({ ready });
  h.component.render(120);
  h.clock.advance(SPLASH_TIMING.revealMs);
  const complete = h.component.render(120);
  h.clock.advance(5000);
  assert.deepEqual(h.component.render(120), complete);
  assert.equal(h.done, 0);
  resolve();
  await ready;
  await Promise.resolve();
  h.component.render(120);
  h.clock.advance(SPLASH_TIMING.fadeMs);
  assert.equal(h.done, 1);
});

test('keyboard, click and disposal consume or clean up the overlay exactly once', () => {
  for (const method of ['keyboard', 'mouse', 'dispose']) {
    const h = harness();
    h.component.render(120);
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

test('a terminal too small for the lockup exits safely on the next tick', () => {
  const h = harness();
  h.tui.terminal.rows = 8;
  const frame = h.component.render(24);
  assert.equal(frame.length, 8);
  h.clock.advance(40);
  assert.equal(h.done, 1);
  assert.equal(h.clock.active, 0);
});

test('disabled splash does not allocate an overlay; a process only plays once', async () => {
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
