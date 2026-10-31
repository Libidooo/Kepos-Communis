import { getCellDimensions, type CellDimensions, type Component } from '@earendil-works/pi-tui';

// An opening interpretation of the v14 lectern mark, not a replacement for the formal logo.
export const SPLASH_TIMING = {
  frameMs: 40,
  tableMs: 640,
  lightStartMs: 720,
  lightEndMs: 1520,
  wordmarkStartMs: 880,
  sweepStartMs: 1120,
  sweepEndMs: 1640,
  revealMs: 1720,
  holdMs: 1000,
  fadeMs: 240,
} as const;
export const SPLASH_STEPS = (SPLASH_TIMING.revealMs + SPLASH_TIMING.holdMs + SPLASH_TIMING.fadeMs) / SPLASH_TIMING.frameMs;
export const SPLASH_VIEW = { tilt: Math.PI / 9, depth: Math.cos(Math.PI / 9), drop: Math.sin(Math.PI / 9) } as const;

const SEATS = 48;
// Brand reds, from the darkest shadow to the lit rim, all inside the vermilion family.
const SHADOW = [62, 14, 22] as const;
const BRAND = [181, 47, 59] as const;
const LIT = [238, 128, 102] as const;
const RIM = [252, 190, 150] as const;
const AMBER = [255, 196, 120] as const;
const WHITE = [255, 255, 255] as const;
const QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];

// A 5x7 stencil grotesque: squared counters, flat terminals, cut diagonals on K/M/N.
const DISPLAY: Record<string, string[]> = {
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
};
const COMPACT: Record<string, string[]> = {
  K: ['101', '101', '110', '100', '110', '101', '101'],
  E: ['111', '100', '100', '110', '100', '100', '111'],
  P: ['110', '101', '101', '110', '100', '100', '100'],
  O: ['010', '101', '101', '101', '101', '101', '010'],
  S: ['011', '100', '100', '010', '001', '001', '110'],
  C: ['011', '100', '100', '100', '100', '100', '011'],
  M: ['101', '111', '111', '101', '101', '101', '101'],
  U: ['101', '101', '101', '101', '101', '101', '010'],
  N: ['101', '111', '111', '111', '111', '111', '101'],
  I: ['111', '010', '010', '010', '010', '010', '111'],
};

const MICRO: Record<string, string[]> = {
  K: ['101', '101', '110', '100', '110', '101', '101'],
  E: ['111', '100', '110', '100', '111', '100', '111'],
  P: ['110', '101', '110', '100', '100', '100', '100'],
  O: ['010', '101', '101', '101', '101', '101', '010'],
  S: ['011', '100', '010', '001', '001', '110', '000'],
  C: ['011', '100', '100', '100', '100', '100', '011'],
  M: ['101', '111', '111', '101', '101', '101', '101'],
  U: ['101', '101', '101', '101', '101', '101', '010'],
  N: ['101', '111', '111', '111', '111', '111', '101'],
  I: ['111', '010', '010', '010', '010', '010', '111'],
};

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Variant = 'display' | 'compact' | 'micro';
export type SplashSample = { x: number; y: number; part: 'desktop' | 'plaque'; coverage: number };
export type SplashLectern = {
  id: number; angle: number; center: Point; outward: Point;
  tablet: Point[]; plate: Point[]; slot: number;
  samples: SplashSample[];
};
export type SplashWordmark = Rect & {
  variant: Variant; fontWidth: number; fontHeight: number; bits: Uint8Array;
};
export type SplashLayout = {
  width: number; height: number; cellAspect: number; gap: number;
  ring: Rect & { cx: number; cy: number; radius: number; lecterns: SplashLectern[] };
  wordmark: SplashWordmark;
};
export type SplashOptions = { cellAspect?: number };

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const extent = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const aspectOf = (dimensions: CellDimensions) => dimensions.widthPx > 0 && dimensions.heightPx > 0 ? dimensions.heightPx / dimensions.widthPx : 2;
const mix = (a: readonly number[], b: readonly number[], t: number) => a.map((c, i) => c + (b[i] - c) * clamp(t));

// Square type pixels: two sub-columns by one sub-row renders 10x10 px in a 10x20 cell.
function textGrid(font: Record<string, string[]>, text: string): boolean[][] {
  const rows = Array.from({ length: 7 }, () => [] as boolean[]);
  [...text].forEach((char, index) => {
    const glyph = font[char];
    if (!glyph) return;
    if (index) rows.forEach(row => row.push(false));
    rows.forEach((row, y) => [...glyph[y]].forEach(bit => row.push(bit === '1')));
  });
  return rows;
}
function makeWordmark(font: Record<string, string[]>, variant: Variant, block = 1): SplashWordmark {
  const lines = [textGrid(font, 'KEPOS'), Array.from({ length: 7 }, () => [] as boolean[]), textGrid(font, 'COMMUNIS')].flat();
  const fontWidth = Math.max(...lines.map(line => line.length)), fontHeight = lines.length;
  // A terminal sub-pixel is 5x10 px, so one glyph pixel is square only at 2 sub-columns by 1 sub-row.
  // Scaling `block` multiplies BOTH axes by the same factor, keeping the face undistorted.
  const subWidth = fontWidth * 2 * block, subHeight = fontHeight * block;
  const bits = new Uint8Array(subWidth * subHeight);
  lines.forEach((line, y0) => line.forEach((on, x) => {
    if (!on) return;
    for (let dy = 0; dy < block; dy++) for (let dx = 0; dx < block * 2; dx++) {
      bits[(y0 * block + dy) * subWidth + x * block * 2 + dx] = 1;
    }
  }));
  // Reserve one extra sub-pixel column for the offset drop shadow so it stays inside the logotype box.
  return { x: 0, y: 0, width: Math.ceil((subWidth + 1) / 2), height: Math.ceil((subHeight + 1) / 2), variant, fontWidth, fontHeight, bits };
}
// Largest first: layout picks the biggest lockup that fits, so wide terminals get a poster-scale wordmark.
const WORDMARKS = [
  makeWordmark(DISPLAY, 'display', 2),
  makeWordmark(DISPLAY, 'display', 1),
  makeWordmark(COMPACT, 'compact', 1),
];

function projectSeat(radius: number, angle: number, aspect: number) {
  const nx = Math.sin(angle), ny = -Math.cos(angle), tx = Math.cos(angle), ty = Math.sin(angle);
  return {
    nx, ny, tx, ty,
    // Near-overhead orthographic camera: the ring stays round, depth drops toward the viewer.
    point: (tangent: number, radial: number): Point => ({
      x: (nx * (radius + radial) + tx * tangent) * aspect,
      y: (ny * (radius + radial) + ty * tangent) * SPLASH_VIEW.depth,
    }),
  };
}

function buildLecterns(radius: number, aspect: number): SplashLectern[] {
  const slot = 2 * Math.PI * radius / SEATS;
  // Pure top-view tablet: brand trapezoid proportions (narrow outer edge, wider inner edge),
  // sized to fill its angular slot so neighbouring desks sit close without touching.
  // Slightly inside the angular slot: large enough to read as a desk, with a clean gap all round.
  const outer = slot * .38 / 2, inner = slot * .68 / 2, depth = slot * .62;
  return Array.from({ length: SEATS }, (_, id) => {
    const angle = id * Math.PI * 2 / SEATS, seat = projectSeat(radius, angle, aspect);
    // Diagonal seats project their long edge into fewer cells, so they need a little more
    // clearance than the axis-aligned ones to keep the same visible gap.
    // Trim by how flat the projected seat is: near the horizontal axis the tabletop
    // compresses vertically and its cells crowd against its neighbours.
    const trim = 1 - .16 * Math.abs(Math.sin(angle));
    const o = outer * trim, i = inner * trim;
    return {
      id, angle, center: seat.point(0, 0), outward: { x: seat.nx, y: seat.ny }, slot,
      tablet: [seat.point(-o, depth / 2), seat.point(o, depth / 2), seat.point(i, -depth / 2), seat.point(-i, -depth / 2)],
      plate: [],
      samples: [],
    };
  });
}

function inside(point: Point, polygon: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

function sampleSurface(lectern: SplashLectern, part: 'desktop' | 'plaque', polygon: Point[]): void {
  const x0 = Math.floor(Math.min(...polygon.map(p => p.x)) * 2), x1 = Math.ceil(Math.max(...polygon.map(p => p.x)) * 2);
  const y0 = Math.floor(Math.min(...polygon.map(p => p.y)) * 2), y1 = Math.ceil(Math.max(...polygon.map(p => p.y)) * 2);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    let hits = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      if (inside({ x: (x + (sx + .5) / 4) / 2, y: (y + (sy + .5) / 4) / 2 }, polygon)) hits++;
    }
    // Keep every touched sub-cell and let coverage modulate brightness: this anti-aliases edges
    // instead of dropping half-cells, which is what produced the staircase silhouette.
    if (hits >= 5)     lectern.samples.push({ x, y, part, coverage: hits / 16 });
  }
}

const layoutCache = new Map<string, SplashLayout | null>();

export function layoutSplash(width: number, rows: number, options: SplashOptions = {}): SplashLayout | null {
  const W = extent(width), H = extent(rows);
  const cellAspect = Number.isFinite(options.cellAspect) ? Math.max(1, Math.min(3, options.cellAspect!)) : 2;
  const cacheKey = `${W}|${H}|${cellAspect}`;
  if (layoutCache.has(cacheKey)) return layoutCache.get(cacheKey)!;
  const result = computeLayout(W, H, cellAspect);
  if (layoutCache.size > 12) layoutCache.clear();
  layoutCache.set(cacheKey, result);
  return result;
}

function computeLayout(W: number, H: number, cellAspect: number): SplashLayout | null {
  const marginX = W < 90 ? 1 : Math.max(2, Math.min(6, Math.floor(W * .04))), marginY = 2;
  const gap = W < 90 ? 3 : Math.max(4, Math.min(8, Math.round(W * .04)));
  const availableW = W - marginX * 2, availableH = H - marginY * 2;
  for (const wordmark of WORDMARKS) {
    if (wordmark.height > availableH) continue;
    // Try every radius from the largest plausible one downwards and let the measured
    // footprint decide — geometry here is not linear enough for a safe closed-form budget.
    // Keep the ring at least as wide as the logotype so the lockup stays balanced.
    const minRing = Math.max(24, Math.round(wordmark.width * .9));
    for (let radius = 20; radius >= 5; radius -= .25) {
      // Below this slot size 48 separate lecterns cannot coexist; shrink the ring instead of merging shapes.
      if (2 * Math.PI * radius / SEATS < .80) continue;
      const lecterns = buildLecterns(radius, cellAspect);
      // Only near-side plates hang below the ring; far-side ones tuck up behind their tablets.
      const tablets = lecterns.flatMap(seat => seat.tablet);
      const nearPlate = lecterns.flatMap(seat => seat.center.y > 0 ? seat.plate : []);
      const vertices = [...tablets, ...nearPlate];
      const rx = Math.max(...vertices.map(p => Math.abs(p.x))), ry = Math.max(...vertices.map(p => Math.abs(p.y)));
      const ringWidth = Math.ceil(rx * 2) + 2, ringHeight = Math.ceil(ry * 2) + 2;
      if (ringWidth < minRing) continue;
      if (ringWidth + gap + wordmark.width > availableW || ringHeight > availableH) continue;
      const x = Math.floor((W - ringWidth - gap - wordmark.width) / 2);
      const y = Math.floor((H - ringHeight) / 2), cx = x + ringWidth / 2, cy = y + ringHeight / 2;
      const translate = (p: Point) => ({ x: cx + p.x, y: cy + p.y });
      lecterns.forEach(seat => {
        seat.center = translate(seat.center);
        seat.tablet = seat.tablet.map(translate);
        seat.plate = seat.plate.map(translate);
        sampleSurface(seat, 'desktop', seat.tablet);
        sampleSurface(seat, 'plaque', seat.plate);
      });
      // Narrow lockups drop the name plates: 48 tablets must stay separate, and the plates
      // are what collide first when the slot shrinks.
      const compact = ringWidth < 62;
      if (compact) for (const seat of lecterns) seat.samples = seat.samples.filter(s => s.part === 'desktop');
      if (lecterns.some(seat => !seat.samples.some(s => s.part === 'desktop') || (!compact && !seat.samples.some(s => s.part === 'plaque')))) { continue; }
      return {
        width: W, height: H, cellAspect, gap,
        ring: { x, y, width: ringWidth, height: ringHeight, cx, cy, radius, lecterns },
        wordmark: { ...wordmark, x: x + ringWidth + gap, y: Math.round(cy - wordmark.height / 2) },
      };
    }
  }
  return null;
}

export function splashLight(elapsed: number): { x: number; y: number; z: number; progress: number } {
  const progress = smooth((elapsed - SPLASH_TIMING.lightStartMs) / (SPLASH_TIMING.lightEndMs - SPLASH_TIMING.lightStartMs));
  const azimuth = Math.PI * (1 - progress), elevation = Math.PI / 5;
  return { x: Math.cos(azimuth) * Math.cos(elevation), y: Math.sin(azimuth) * Math.cos(elevation), z: Math.sin(elevation), progress };
}

export function lecternProgress(elapsed: number, index: number): { desktop: number; plaque: number } {
  const tablet = smooth((elapsed - index / (SEATS - 1) * (SPLASH_TIMING.tableMs - 260)) / 260);
  // Light is a moving front, so plates read as illuminated rather than grown.
  const facing = (Math.sin(index * Math.PI * 2 / SEATS) + 1) / 2;
  const plaque = smooth((splashLight(elapsed).progress - facing * .62) / .38);
  return { desktop: tablet, plaque };
}

export function lecternLighting(elapsed: number, seat: SplashLectern): { desktop: number; plaque: number } {
  const light = splashLight(elapsed);
  // Plates are vertical signs: their brightness follows how squarely they face the light.
  const plaque = Math.max(0, seat.outward.x * light.x + seat.outward.y * light.y);
  // Tables are the only surface now, so the tonal spread has to come from them: a deeper
  // shadow at the far side and a brighter lit rim near the light.
  return { desktop: .12 + .92 * plaque + .12 * light.z, plaque };
}

type Buffer = { rgb: Float32Array; alpha: Float32Array };

function paint(buffer: Buffer, subWidth: number, subHeight: number, x: number, y: number, rgb: readonly number[], alpha: number) {
  const ix = Math.round(x), iy = Math.round(y);
  if (alpha <= 0 || ix < 0 || iy < 0 || ix >= subWidth || iy >= subHeight) return;
  const index = iy * subWidth + ix, previous = buffer.alpha[index], next = alpha + previous * (1 - alpha);
  for (let channel = 0; channel < 3; channel++) {
    buffer.rgb[index * 3 + channel] = (rgb[channel] * alpha + buffer.rgb[index * 3 + channel] * previous * (1 - alpha)) / next;
  }
  buffer.alpha[index] = next;
}

function drawSplash(elapsed: number, layout: SplashLayout): string[] {
  const subWidth = layout.width * 2, subHeight = layout.height * 2;
  const buffer: Buffer = { rgb: new Float32Array(subWidth * subHeight * 3), alpha: new Float32Array(subWidth * subHeight) };
  const exitAt = SPLASH_TIMING.revealMs + SPLASH_TIMING.holdMs;
  const fade = 1 - smooth((elapsed - exitAt) / SPLASH_TIMING.fadeMs);
  const light = splashLight(elapsed);
  const lightScreen = { x: light.x * layout.cellAspect, y: light.y * SPLASH_VIEW.depth };
  const lightLength = Math.hypot(lightScreen.x, lightScreen.y) || 1;

  if (fade > 0) [...layout.ring.lecterns].sort((a, b) => a.center.y - b.center.y).forEach(seat => {
    const progress = lecternProgress(elapsed, seat.id), lighting = lecternLighting(elapsed, seat);
    for (const sample of seat.samples) {
      const opacity = progress[sample.part] * fade;
      if (opacity <= 0) continue;
      const dx = (sample.x / 2 - seat.center.x) / (seat.slot * layout.cellAspect);
      const dy = (sample.y / 2 - seat.center.y) / (seat.slot * SPLASH_VIEW.depth);
      const rim = sample.part === 'desktop' ? Math.max(0, (dx * lightScreen.x + dy * lightScreen.y) / lightLength) ** 2 : 0;
      const base = sample.part === 'desktop'
        ? mix(SHADOW, LIT, lighting.desktop)
        : mix(SHADOW, LIT, lighting.plaque);
      const rgb = mix(base, RIM, rim * .8);
      paint(buffer, subWidth, subHeight, sample.x, sample.y, rgb, opacity * sample.coverage);
    }
  });

  if (fade > 0) {
    const originX = layout.wordmark.x * 2, originY = layout.wordmark.y * 2;
    const opacity = smooth((elapsed - SPLASH_TIMING.wordmarkStartMs) / 320) * fade;
    const sweep = clamp((elapsed - SPLASH_TIMING.sweepStartMs) / (SPLASH_TIMING.sweepEndMs - SPLASH_TIMING.sweepStartMs));
    const colorAt = (column: number) => {
      const position = column / Math.max(1, layout.wordmark.fontWidth * 2 - 1);
      const head = sweep * 1.35 - .15;
      const glow = sweep <= 0 || sweep >= 1 ? 0 : Math.max(0, 1 - Math.abs(position - head) / .22);
      // The band starts deep vermilion and warms to amber before settling back to white.
      const tint = mix(BRAND, AMBER, sweep);
      return { rgb: mix(WHITE, tint, glow * .9), glow };
    };
    // The shadow clears before the lockup settles, so the held frame is byte-identical every tick.
    const shadowLife = 1 - smooth((elapsed - (SPLASH_TIMING.sweepEndMs - 320)) / 200);
    if (opacity > 0 && shadowLife > 0) {
      for (let y = 0; y < layout.wordmark.fontHeight; y++) for (let x = 0; x < layout.wordmark.fontWidth * 2; x++) {
        if (!layout.wordmark.bits[y * layout.wordmark.fontWidth * 2 + x]) continue;
        paint(buffer, subWidth, subHeight, originX + x + 1, originY + y + 1, SHADOW, opacity * shadowLife * .55);
      }
    }
    if (opacity > 0) {
      for (let y = 0; y < layout.wordmark.fontHeight; y++) for (let x = 0; x < layout.wordmark.fontWidth * 2; x++) {
        if (!layout.wordmark.bits[y * layout.wordmark.fontWidth * 2 + x]) continue;
        paint(buffer, subWidth, subHeight, originX + x, originY + y, colorAt(x).rgb, opacity);
      }
    }
  }

  const lines: string[] = [];
  for (let row = 0; row < layout.height; row++) {
    let line = '', current = '';
    for (let column = 0; column < layout.width; column++) {
      let mask = 0, r = 0, g = 0, b = 0, weight = 0;
      for (let bit = 0; bit < 4; bit++) {
        const index = (row * 2 + Math.floor(bit / 2)) * subWidth + column * 2 + (bit % 2);
        const alpha = buffer.alpha[index];
        if (alpha < .06) continue;
        mask |= 1 << bit;
        r += buffer.rgb[index * 3] * alpha; g += buffer.rgb[index * 3 + 1] * alpha; b += buffer.rgb[index * 3 + 2] * alpha;
        weight += alpha;
      }
      const color = weight ? `${Math.round(r / weight)};${Math.round(g / weight)};${Math.round(b / weight)}` : '';
      if (color !== current) { line += color ? `\x1b[38;2;${color}m` : '\x1b[39m'; current = color; }
      line += mask ? QUADRANTS[mask] : ' ';
    }
    lines.push(line + (current ? '\x1b[39m' : ''));
  }
  return lines;
}

export function buildSplashFrame(step: number, width: number, rows: number, _theme?: any, options: SplashOptions = {}): string[] {
  const layout = layoutSplash(width, rows, options);
  if (!layout) return Array.from({ length: extent(rows) }, () => ' '.repeat(extent(width)));
  return drawSplash(Math.max(0, Number.isFinite(step) ? step : 0) * SPLASH_TIMING.frameMs, layout);
}

export type SplashClock = {
  now: () => number;
  every: (callback: () => void, milliseconds: number) => unknown;
  clear: (timer: unknown) => void;
};
const systemClock: SplashClock = {
  now: () => performance.now(),
  every: (callback, milliseconds) => { const timer = setInterval(callback, milliseconds); timer.unref?.(); return timer; },
  clear: timer => clearInterval(timer as ReturnType<typeof setInterval>),
};

export function createSplashComponent(tui: any, done: () => void, options: {
  ready?: Promise<unknown>; clock?: SplashClock; cellDimensions?: () => CellDimensions;
} = {}): Component & { focused: boolean; dispose: () => void } {
  const clock = options.clock || systemClock;
  let finished = false, ready = !options.ready, unsupported = false;
  let startedAt: number | undefined, holdAt: number | undefined, fadeAt: number | undefined;
  let lastGeometry = '';
  const finish = () => { if (finished) return; finished = true; clock.clear(timer); done(); };
  const timer = clock.every(() => {
    if (finished) return;
    if (unsupported || fadeAt !== undefined && clock.now() - fadeAt >= SPLASH_TIMING.fadeMs) { finish(); return; }
    tui.requestRender();
  }, SPLASH_TIMING.frameMs);
  if (options.ready) {
    const settled = () => { ready = true; if (!finished) tui.requestRender(); };
    void options.ready.then(settled, settled);
  }
  return {
    focused: true,
    render(width: number) {
      const rows = extent(tui.terminal.rows || 0);
      const cellAspect = aspectOf((options.cellDimensions || getCellDimensions)());
      const layout = layoutSplash(width, rows, { cellAspect });
      unsupported = !layout;
      if (finished || !layout) return Array.from({ length: rows }, () => ' '.repeat(extent(width)));
      const now = clock.now(), geometry = `${width}|${rows}|${cellAspect}`;
      if (lastGeometry && geometry !== lastGeometry && holdAt !== undefined) { holdAt = now; fadeAt = undefined; }
      lastGeometry = geometry;
      startedAt ??= now;
      let elapsed = now - startedAt;
      if (elapsed >= SPLASH_TIMING.revealMs) {
        // The one-second hold starts when a complete lockup is actually rendered, not at a timer tick.
        holdAt ??= now;
        if (ready && now - holdAt >= SPLASH_TIMING.holdMs) fadeAt ??= now;
        elapsed = fadeAt === undefined ? SPLASH_TIMING.revealMs : SPLASH_TIMING.revealMs + SPLASH_TIMING.holdMs + now - fadeAt;
      }
      return drawSplash(elapsed, layout);
    },
    invalidate() {},
    dispose() { if (!finished) { finished = true; clock.clear(timer); } },
    handleInput() { finish(); },
    handleMouse(event: any) { if (event.type === 'press' || event.type === 'click') finish(); return { handled: true }; },
  };
}

const playedKey = Symbol.for('kepos.splash.played');
export async function playSplash(ctx: any, config?: { motion?: boolean }, ready?: Promise<unknown>): Promise<void> {
  if (config?.motion === false || process.env.KEPOS_NO_SPLASH === '1' || !ctx?.ui?.custom) return;
  const state = globalThis as any;
  if (state[playedKey]) return;
  state[playedKey] = true;
  await ctx.ui.custom((tui: any, _theme: any, _keys: any, done: () => void) => createSplashComponent(tui, done, { ready }),
    { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
}
