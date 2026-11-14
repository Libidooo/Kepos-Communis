import test from 'node:test';
import assert from 'node:assert/strict';
import { SEAT_COUNT, REVEAL_MS, COLORS, REVEAL_ORDER, revealLightAt, revealCountAt, seatRevealProgress, cardinalColorBlendAt, layoutCrystal, buildCrystalMesh, crystalMask, facetNormal, facetColor, shadeFacet, wordmarkAt, createRasterBuffer, rasterizeTriangle, renderCrystalBuffer, encodeHalfBlockFrame, renderCrystalFrame, terminalCleanupSequence } from '../prototypes/terminal-hive-crystal.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

const bare = frame => frame.map(stripVTControlCharacters);
const isEmpty = glyph => glyph === null || glyph === ' ';

test('indexed crystal mesh closes its profile around an open center', () => {
  const mesh = buildCrystalMesh();
  assert.equal(mesh.vertices.length, 8 * (SEAT_COUNT + 1));
  assert.equal(mesh.triangles.length, 8 * SEAT_COUNT * 2);
  assert.ok(mesh.triangles.every(face => face.a >= 0 && face.b < mesh.vertices.length && face.c < mesh.vertices.length));
  assert.deepEqual(new Set(mesh.triangles.map(face => face.facet)), new Set(Array.from({ length: 8 }, (_, facet) => facet)), 'the full fixed annular profile is retained for depth-tested rendering');
  const radii = mesh.vertices.slice(0, SEAT_COUNT).map(vertex => Math.hypot(vertex.x, vertex.y));
  assert.ok(radii.every(radius => radius > .98 && radius < 1.02), 'outer contour remains circular');
  const innerRing = mesh.vertices.slice(3 * (SEAT_COUNT + 1), 4 * (SEAT_COUNT + 1));
  const innerRadii = innerRing.map(vertex => Math.hypot(vertex.x, vertex.y));
  assert.ok(Math.max(...innerRadii) - Math.min(...innerRadii) < .02, 'inner contour is a smooth fixed-radius opening');
  assert.equal(mesh.facetArc, 4, 'broad face groups remain available for light shading');
  assert.equal(mesh.profileBands, 8, 'the cross-section remains complete and fixed');
  const firstAtEachBand = mesh.vertices.filter((_, index) => index % (SEAT_COUNT + 1) === 0);
  const lastAtEachBand = mesh.vertices.filter((_, index) => index % (SEAT_COUNT + 1) === SEAT_COUNT);
  assert.deepEqual(firstAtEachBand, lastAtEachBand, 'seam vertices close exactly without a raster gap');
});

test('prototype geometry is a 48-seat hollow annulus at supported sizes', () => {
  for (const [width, height] of [[70, 22], [80, 24], [100, 30], [120, 35], [160, 45], [200, 60]]) {
    const layout = layoutCrystal(width, height);
    assert.ok(layout, `${width}x${height}`);
    assert.equal(layout.seats.length, 48);
    assert.equal(new Set(layout.seats.map(seat => `${seat.x},${seat.y}`)).size, 48);
    const mask = crystalMask(layout, REVEAL_MS);
    const openingFrame = crystalMask(layout, 100);
    assert.ok(openingFrame.flat().filter(Boolean).length > 0, 'the ring geometry exists before the light arrives');
    assert.equal(openingFrame[layout.centerY]?.[layout.centerX], null, 'the unlit geometry still has a hollow center');
    let faces = 0, innerHoleCells = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (mask[y][x]) faces++;
      const centerRadius = Math.hypot((x - layout.centerX) / layout.outerX, (y - layout.centerY) / layout.outerY);
      if (centerRadius < .14 && mask[y][x]) innerHoleCells++;
    }
    assert.ok(faces > 48, 'crystal faces visible');
    assert.ok(faces < width * height * .38, 'the frame retains generous negative space');
    assert.equal(innerHoleCells, 0, 'annulus aperture stays open; it must not become a sphere');
    assert.equal(mask[layout.centerY]?.[layout.centerX], null, 'the geometric aperture contains the center cell');
  }
});

test('light wave starts with one point, splits four ways, then travels around a fixed ring', () => {
  assert.deepEqual(REVEAL_ORDER.slice(0, 4), [0, 24, 12, 36]);
  assert.deepEqual(REVEAL_ORDER.slice(4, 12), [47, 1, 23, 25, 11, 13, 35, 37]);
  assert.equal(new Set(REVEAL_ORDER).size, 48);
  assert.ok(revealLightAt(100, 0) > .75, 'a single warm point is lit first');
  assert.ok(revealLightAt(100, 12) < .1, 'other directions remain dim during the single-point phase');
  assert.ok(revealLightAt(700, 12) > .5 && revealLightAt(700, 24) > .5 && revealLightAt(700, 36) > .5, 'the four cardinal directions catch the light');
  assert.ok(revealCountAt(1400) > revealCountAt(700), 'four wavefronts propagate around the ring');
  assert.equal(revealCountAt(REVEAL_MS), 48);
  assert.ok(seatRevealProgress(100, 0) > seatRevealProgress(100, 12));
  const before = renderCrystalBuffer(100, 120, 35), after = renderCrystalBuffer(1000, 120, 35);
  assert.deepEqual(before.covered, after.covered, 'light movement never grows or reshapes the geometry');
  assert.deepEqual(before.depth, after.depth, 'depth geometry is fixed during the light animation');
  assert.notDeepEqual(before.color, after.color, 'only illumination and refraction colors change');
});

test('triangle depth test is order-independent and clips to the viewport', () => {
  const near = [{ x: -2, y: 1, z: 2 }, { x: 8, y: 1, z: 2 }, { x: 2, y: 9, z: 2 }];
  const far = [{ x: -2, y: 1, z: 5 }, { x: 8, y: 1, z: 5 }, { x: 2, y: 9, z: 5 }];
  const draw = order => {
    const buffer = createRasterBuffer(8, 8);
    for (const item of order) rasterizeTriangle(buffer, item, item === near ? [240, 20, 10] : [10, 20, 240], item === near ? 4 : 9);
    return buffer;
  };
  const first = draw([near, far]), second = draw([far, near]);
  assert.deepEqual(first.seats, second.seats);
  assert.deepEqual(first.color, second.color);
  assert.ok(first.covered.some(Boolean), 'partly offscreen triangle covers in-bounds samples');
  const center = 3 * first.width + 3;
  assert.equal(first.seats[center], 4, 'near surface wins the depth test');
  assert.deepEqual(Array.from(first.color.subarray(center * 3, center * 3 + 3)), [240, 20, 10]);
});

test('half-block encoding uses upper foreground and lower background colors', () => {
  const buffer = createRasterBuffer(2, 2);
  rasterizeTriangle(buffer, [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 1, z: 1 }], [220, 30, 40], 0);
  rasterizeTriangle(buffer, [{ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }, { x: 1, y: 2, z: 1 }], [30, 70, 220], 1);
  const line = encodeHalfBlockFrame(buffer)[0];
  assert.match(line, /38;2;220;30;40m.*48;2;11;12;16m▀/);
  assert.match(line, /38;2;30;70;220m.*▄/);
  assert.equal(visibleWidth(line), buffer.width);
});

test('rasterized full crystal keeps its projected central aperture open', () => {
  for (const time of [REVEAL_MS, 6200, 7200]) {
    const buffer = renderCrystalBuffer(time, 160, 45);
    const centerX = Math.floor(buffer.projection.centerX), centerY = Math.floor(buffer.projection.centerY);
    for (let y = centerY - 1; y <= centerY + 1; y++) for (let x = centerX - 1; x <= centerX + 1; x++) {
      assert.equal(buffer.covered[y * buffer.width + x], 0, `profile geometry leaves the aperture open at ${time}ms`);
    }
  }
});

test('the 48 seat modules contain finer facets without adding a second ring layout', () => {
  const mesh = buildCrystalMesh();
  assert.equal(new Set(mesh.triangles.map(face => face.seat)).size, 48);
  assert.equal(mesh.triangles.length, 48 * mesh.profileBands * 2);
  const before = renderCrystalBuffer(100, 120, 35), after = renderCrystalBuffer(1800, 120, 35);
  assert.equal(before.covered.reduce((sum, value) => sum + value, 0), after.covered.reduce((sum, value) => sum + value, 0));
  assert.notDeepEqual(before.color, after.color, 'facet light and color, not topology, create movement');
});

test('brand wordmark uses the DOSPilgi bitmap on an opaque plate beneath the ring after full reveal', () => {
  assert.equal(wordmarkAt(120, 35, 1800), null, 'brand mark waits for all modules to catch light');
  const mark = wordmarkAt(120, 35, 3300);
  assert.ok(mark);
  assert.ok(mark.y > 35 / 2, 'wordmark is below the ring centerline');
  assert.equal(mark.width, 69);
  assert.equal(mark.height, 6);
  const frame = renderCrystalFrame(3300, 120, 35).map(stripVTControlCharacters);
  const markLines = frame.slice(mark.y, mark.y + mark.height);
  assert.ok(markLines.some(line => line.includes('█')));
  assert.ok(markLines.every(line => line.slice(mark.x, mark.x + mark.width).includes(' ')), 'opaque plate clears crystal pixels in glyph counters and spacing');
  const narrow = wordmarkAt(68, 24, 3300);
  assert.equal(narrow, null, 'the complete bitmap is hidden rather than truncated on narrow terminals');
});

test('brand red-purple seed color survives pulse-like warm-white highlights', () => {
  const early = Array.from({ length: 48 }, (_, seat) => facetColor(2, seat, 1000, 0));
  const middle = Array.from({ length: 48 }, (_, seat) => facetColor(2, seat, 6200, 0));
  const late = Array.from({ length: 48 }, (_, seat) => facetColor(2, seat, 8200, 0));
  assert.ok(early.some(color => color[0] > color[2]), 'brand vermilion dominates at the opening');
  assert.ok(middle.some(color => color[2] > color[0] && color[2] < color[0] * 2.2), 'the violet phase bridges brand red and vivid blue');
  assert.ok(middle.some(color => color[0] > color[1] && color[2] > color[1]), 'the overlap creates visible violet tones');
  assert.ok([0, 12, 24, 36].every(seat => cardinalColorBlendAt(100, seat) === cardinalColorBlendAt(100, 0)), 'all four seed modules share the same opening tint');
  assert.ok(cardinalColorBlendAt(700, 1) > cardinalColorBlendAt(700, 2), 'tint falls off smoothly across the adjacent modules');
  assert.ok(cardinalColorBlendAt(2600, 1) < cardinalColorBlendAt(700, 1), 'nearby modules return to their ring color after the wave');
  assert.equal(new Set([0, 12, 24, 36].map(seat => facetColor(2, seat, 100, 0).join(','))).size, 1, 'cardinal material colors match at the start');
  assert.ok(late.some(color => color[2] > color[0]), 'blue refraction enters late without replacing the material');
  assert.ok(new Set(middle.map(color => color.join(','))).size > 4, 'light direction moves mixed hues across broad facets');
  const normal = facetNormal(2, .4);
  assert.deepEqual(normal, facetNormal(2, .4));
  const litA = shadeFacet(COLORS.vermilion, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, 0, 0);
  const litB = shadeFacet(COLORS.vermilion, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, 300, 0);
  const unlit = shadeFacet(COLORS.vermilion, normal, { x: 0, y: 0, z: 0 }, 0, 0);
  assert.ok(litA.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255));
  assert.ok(litA[0] > COLORS.vermilion[0] && litA[1] > COLORS.vermilion[1], 'reflection visibly brightens the vermilion face without bleaching it white');
  assert.ok(litA.every(channel => channel < COLORS.paper[0] - 35), 'the highlight remains below paper-white clipping');
  const seedLit = shadeFacet(facetColor(2, 0, 100), facetNormal(2, 0), { x: .8, y: 0, z: .56 }, 100, 0, .14);
  assert.ok(seedLit[0] > seedLit[2] * 1.5, 'seed highlights preserve a strong warm-red chroma');
  assert.notDeepEqual(litA, litB, 'the specular highlight has a subtle time pulse');
  assert.notDeepEqual(litA, unlit, 'geometry normals produce distinct light response');
});

test('rendered cardinal seed pixels share warm-red chroma and late refraction is vivid blue', () => {
  const sample = (time, seats) => {
    const buffer = renderCrystalBuffer(time, 160, 45), colors = [];
    for (const seat of seats) {
      const sums = [0, 0, 0]; let pixels = 0;
      for (let index = 0; index < buffer.seats.length; index++) if (buffer.covered[index] && buffer.seats[index] === seat) {
        pixels++;
        for (let channel = 0; channel < 3; channel++) sums[channel] += buffer.color[index * 3 + channel];
      }
      colors.push(sums.map(value => Math.round(value / Math.max(1, pixels))));
    }
    return colors;
  };
  for (const time of [700, 1200]) {
    const seeds = sample(time, [0, 12, 24, 36]);
    assert.ok(seeds.every(color => color[0] > color[2] * 1.45), `all four rendered seed modules stay warm red at ${time}ms`);
    assert.ok(seeds.every(color => Math.abs(color[0] - seeds[0][0]) < 18), `the four final rendered seed colors stay close at ${time}ms`);
  }
  const late = sample(8200, [6, 18, 30, 42]);
  assert.ok(late.every(color => color[2] > color[0] * 1.25), 'blue refracted faces retain vivid blue dominance');
  assert.ok(late.every(color => (Math.max(...color) - Math.min(...color)) / Math.max(...color) > .46), 'late blue stays saturated rather than gray-blue');
});

test('rotation and bob are bounded and do not close the center aperture', () => {
  const layout = layoutCrystal(160, 45);
  const opening = bare(renderCrystalFrame(0, 160, 45)).join('\n');
  assert.ok(!opening.includes('▱'), 'the opening frame begins in darkness');
  for (const ms of [1200, 2600, 4500, 7200, 8800]) {
    const frame = bare(renderCrystalFrame(ms, 160, 45)).join('\n');
    assert.ok(!frame.includes('▱'), `no desk glyph overlay at ${ms}ms`);
    const center = frame.split('\n')[layout.centerY]?.slice(layout.centerX - 2, layout.centerX + 3) || '';
    if (ms < 8000) assert.ok([...center].every(char => char === ' ' || char === '.'), 'the ring centre remains visibly hollow before the camera enters the aperture');
  }
  const at0 = bare(renderCrystalFrame(0, 160, 45)).join('\n');
  const at2 = bare(renderCrystalFrame(6200, 160, 45)).join('\n');
  assert.notEqual(at0, at2, 'moving light changes the rendered frame while geometry stays fixed');
});

test('every prototype frame is bounded and small viewports get a readable fallback', () => {
  for (const [width, height] of [[70, 22], [80, 24], [120, 35], [160, 45], [200, 60]]) {
    const frame = renderCrystalFrame(6000, width, height);
    assert.equal(frame.length, height);
    for (const line of frame) assert.equal(visibleWidth(line), width);
  }
  const small = renderCrystalFrame(1000, 40, 18).join('\n');
  assert.match(small, /Resize terminal/);
});

test('cleanup restores SGR, cursor visibility and the previous screen', () => {
  assert.equal(terminalCleanupSequence(), '\x1b[0m\x1b[?25h\x1b[?1049l');
});
