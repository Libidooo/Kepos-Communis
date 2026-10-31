import { getCellDimensions, type CellDimensions, type Component } from '@earendil-works/pi-tui';

// An opening interpretation of the v14 lectern mark, not a replacement for the formal logo.
export const SPLASH_TIMING = {
  frameMs: 40, tableMs: 720, plaqueStartMs: 840, plaqueEndMs: 1360,
  wordmarkStartMs: 960, sweepStartMs: 1120, sweepEndMs: 1720, revealMs: 1760,
  holdMs: 1000, fadeMs: 240,
} as const;
export const SPLASH_STEPS = (SPLASH_TIMING.revealMs + SPLASH_TIMING.holdMs + SPLASH_TIMING.fadeMs) / SPLASH_TIMING.frameMs;
const SEATS = 48;
const BRAND = [181, 47, 59] as const;
const WARM_WHITE = [232, 168, 151] as const;
const WHITE = [255, 255, 255] as const;
const QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];
// A near-overhead orthographic camera keeps the ring round while showing the boards below each top.
export const SPLASH_VIEW = { tilt: Math.PI / 9, depth: Math.cos(Math.PI / 9), drop: Math.sin(Math.PI / 9) } as const;

// Seven square pixels high, packed into half-blocks to suit a terminal's tall cells.
const FONT: Record<string, string[]> = {
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
const COMPACT_FONT: Record<string, string[]> = {
  K: ['101', '101', '110', '100', '110', '101', '101'],
  E: ['111', '100', '100', '110', '100', '100', '111'],
  P: ['110', '101', '101', '110', '100', '100', '100'],
  O: ['010', '101', '101', '101', '101', '101', '010'],
  S: ['011', '100', '100', '010', '001', '001', '110'],
  C: ['011', '100', '100', '100', '100', '100', '011'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  U: ['101', '101', '101', '101', '101', '101', '010'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  I: ['111', '010', '010', '010', '010', '010', '111'],
};

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Wordmark = { variant: 'large' | 'regular' | 'compact'; lines: string[]; width: number; height: number };
export type SplashLectern = {
  id: number; angle: number; center: Point; normal: { x: number; y: number; z: number };
  desktop: Point[]; plaque: Point[]; boardHeight: number;
  samples: { x: number; y: number; part: 'desktop' | 'plaque'; coverage: number }[];
};
export type SplashLayout = {
  width: number; height: number; cellAspect: number; gap: number;
  ring: Rect & { cx: number; cy: number; radius: number; points: Point[]; lecterns: SplashLectern[] };
  wordmark: Rect & { variant: Wordmark['variant']; lines: string[] };
};
export type SplashOptions = { cellAspect?: number };

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const extent = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const aspectOf = (dimensions: CellDimensions) => dimensions.widthPx > 0 && dimensions.heightPx > 0 ? dimensions.heightPx / dimensions.widthPx : 2;

function makeWordmark(font: Record<string, string[]>, scale: number, variant: Wordmark['variant']): Wordmark {
  const pixels = (text: string) => Array.from({ length: 7 }, (_, y) => [...text].map(ch => font[ch][y]).join('0'));
  const words = [pixels('KEPOS'), pixels('COMMUNIS')];
  const width = words[1][0].length * scale;
  const raster = [...words[0], ...Array(3).fill(''), ...words[1]]
    .flatMap(row => Array(scale).fill([...row.padEnd(width / scale, '0')].map(bit => bit.repeat(scale)).join('')));
  const lines: string[] = [];
  for (let y = 0; y < raster.length; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const top = raster[y][x] === '1', bottom = raster[y + 1]?.[x] === '1';
      line += top ? bottom ? '█' : '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return { variant, width, height: lines.length, lines };
}
const WORDMARKS = [makeWordmark(FONT, 2, 'large'), makeWordmark(FONT, 1, 'regular'), makeWordmark(COMPACT_FONT, 1, 'compact')];

function lecternGeometry(radius: number, aspect: number): SplashLectern[] {
  const side = 2 * radius * Math.sin(Math.PI / SEATS) * .53;
  return Array.from({ length: SEATS }, (_, id) => {
    const angle = id * Math.PI * 2 / SEATS;
    const nx = Math.sin(angle), ny = -Math.cos(angle), tx = Math.cos(angle), ty = Math.sin(angle);
    const point = (tangent: number, radial: number, z = 0): Point => ({
      x: (nx * (radius + radial) + tx * tangent) * aspect,
      y: (ny * (radius + radial) + ty * tangent) * SPLASH_VIEW.depth - z * SPLASH_VIEW.drop,
    });
    // Pick the visible front face; its board hangs below the shared tabletop edge, never out of the ring.
    const face = Math.abs(ny) >= Math.abs(ty) ? { tangent: false, sign: Math.sign(ny) || 1, x: nx, y: ny }
      : { tangent: true, sign: Math.sign(ty) || 1, x: tx, y: ty };
    const edge = (along: number, z: number) => face.tangent
      ? point(face.sign * side / 2, along, z) : point(along, face.sign * side / 2, z);
    const boardHeight = side * 1.35;
    return { id, angle, center: point(0, 0), normal: { x: face.x * face.sign, y: face.y * face.sign, z: 0 }, boardHeight,
      desktop: [point(-side / 2, -side / 2), point(side / 2, -side / 2), point(side / 2, side / 2), point(-side / 2, side / 2)],
      plaque: [edge(-side / 2, 0), edge(side / 2, 0), edge(side / 2, -boardHeight), edge(-side / 2, -boardHeight)],
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

function sampleLectern(lectern: SplashLectern): void {
  for (const part of ['desktop', 'plaque'] as const) {
    const polygon = lectern[part];
    const x0 = Math.floor(Math.min(...polygon.map(p => p.x)) * 2), x1 = Math.ceil(Math.max(...polygon.map(p => p.x)) * 2);
    const y0 = Math.floor(Math.min(...polygon.map(p => p.y)) * 2), y1 = Math.ceil(Math.max(...polygon.map(p => p.y)) * 2);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      let hits = 0;
      // Supersample each quadrant; edge coverage controls brightness, not stray outline dots.
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const p = { x: (x + (sx + .5) / 4) / 2, y: (y + (sy + .5) / 4) / 2 };
        if (inside(p, polygon)) hits++;
      }
      if (hits >= 3) lectern.samples.push({ x, y, part, coverage: hits / 16 });
    }
  }
}

export function layoutSplash(width: number, rows: number, options: SplashOptions = {}): SplashLayout | null {
  const W = extent(width), H = extent(rows);
  const cellAspect = Number.isFinite(options.cellAspect) ? Math.max(1, Math.min(3, options.cellAspect!)) : 2;
  const marginX = Math.max(2, Math.min(6, Math.floor(W * .04))), marginY = 2;
  const gap = Math.max(4, Math.min(8, Math.round(W * .04)));
  const availableW = W - marginX * 2, availableH = H - marginY * 2;
  for (const wordmark of WORDMARKS) {
    if (wordmark.height > availableH) continue;
    const radius = Math.min(16, Math.max(7, H * .31), (availableH - 2) / 2.2, (availableW - wordmark.width - gap - 2) / (2.2 * cellAspect));
    if (radius < 7) continue;
    const lecterns = lecternGeometry(radius, cellAspect);
    const vertices = lecterns.flatMap(seat => [...seat.desktop, ...seat.plaque]);
    const rx = Math.max(...vertices.map(p => Math.abs(p.x))), ry = Math.max(...vertices.map(p => Math.abs(p.y)));
    const ringWidth = Math.ceil(rx * 2) + 2, ringHeight = Math.ceil(ry * 2) + 2;
    if (ringWidth + gap + wordmark.width > availableW || ringHeight > availableH) continue;
    const x = Math.floor((W - ringWidth - gap - wordmark.width) / 2);
    const y = Math.floor((H - ringHeight) / 2), cx = x + ringWidth / 2, cy = y + ringHeight / 2;
    const translate = (p: Point) => ({ x: cx + p.x, y: cy + p.y });
    lecterns.forEach(seat => {
      seat.center = translate(seat.center); seat.desktop = seat.desktop.map(translate); seat.plaque = seat.plaque.map(translate);
      sampleLectern(seat);
    });
    if (lecterns.some(seat => !seat.samples.some(p => p.part === 'desktop') || !seat.samples.some(p => p.part === 'plaque'))) continue;
    return {
      width: W, height: H, cellAspect, gap,
      ring: { x, y, width: ringWidth, height: ringHeight, cx, cy, radius, lecterns, points: lecterns.map(seat => seat.center) },
      wordmark: { x: x + ringWidth + gap, y: Math.round(cy - wordmark.height / 2),
        width: wordmark.width, height: wordmark.height, lines: wordmark.lines, variant: wordmark.variant },
    };
  }
  return null;
}

type Cell = { char: string; color: string };
const ink = (rgb: readonly number[], opacity: number) => rgb.map(channel => Math.round(channel * clamp(opacity))).join(';');
export function splashLight(elapsed: number): { x: number; y: number; z: number; progress: number } {
  const progress = smooth((elapsed - SPLASH_TIMING.plaqueStartMs) / (SPLASH_TIMING.plaqueEndMs - SPLASH_TIMING.plaqueStartMs));
  const azimuth = Math.PI * (1 - progress), elevation = Math.PI / 6;
  return { x: Math.cos(azimuth) * Math.cos(elevation), y: Math.sin(azimuth) * Math.cos(elevation), z: Math.sin(elevation), progress };
}

export function lecternProgress(elapsed: number, index: number): { desktop: number; plaque: number } {
  const desktop = smooth((elapsed - index / (SEATS - 1) * (SPLASH_TIMING.tableMs - 280)) / 280);
  const light = splashLight(elapsed);
  // The illumination front sweeps left to right; boards do not grow or move in screen space.
  const position = (Math.sin(index * Math.PI * 2 / SEATS) + 1) / 2;
  const plaque = smooth((light.progress - position * .58) / .42);
  return { desktop, plaque };
}

export function lecternLighting(elapsed: number, seat: SplashLectern): { desktop: number; plaque: number } {
  const light = splashLight(elapsed);
  const incidence = Math.max(0, seat.normal.x * light.x + seat.normal.y * light.y);
  const rightBias = (Math.sin(seat.angle) * light.x - Math.cos(seat.angle) * light.y + 1) / 2;
  return { desktop: .76 + .22 * light.z + .12 * rightBias, plaque: .36 + .65 * incidence };
}

function drawSplash(elapsed: number, layout: SplashLayout): string[] {
  const grid: (Cell | undefined)[][] = Array.from({ length: layout.height }, () => Array(layout.width));
  const exitAt = SPLASH_TIMING.revealMs + SPLASH_TIMING.holdMs;
  const fade = 1 - smooth((elapsed - exitAt) / SPLASH_TIMING.fadeMs);
  const pixels = new Map<number, { x: number; y: number; rgb: number[]; alpha: number }>();
  if (fade > 0) [...layout.ring.lecterns].sort((a, b) => a.center.y - b.center.y).forEach(seat => {
    const progress = lecternProgress(elapsed, seat.id), lighting = lecternLighting(elapsed, seat);
    for (const sample of seat.samples) {
      const opacity = progress[sample.part];
      if (opacity <= 0) continue;
      const color = BRAND.map(c => c * lighting[sample.part]);
      const alpha = sample.coverage * opacity, key = sample.y * layout.width * 2 + sample.x;
      const previous = pixels.get(key);
      pixels.set(key, { x: sample.x, y: sample.y, alpha: alpha + (previous?.alpha || 0) * (1 - alpha),
        rgb: color.map((c, i) => c * alpha + (previous?.rgb[i] || 0) * (1 - alpha)) });
    }
  });
  const cells = new Map<number, { x: number; y: number; mask: number; rgb: number[]; count: number }>();
  for (const pixel of pixels.values()) {
    const x = Math.floor(pixel.x / 2), y = Math.floor(pixel.y / 2), key = y * layout.width + x;
    const cell = cells.get(key) || { x, y, mask: 0, rgb: [0, 0, 0], count: 0 };
    cell.mask |= 1 << ((pixel.y % 2) * 2 + pixel.x % 2);
    cell.rgb = cell.rgb.map((c, i) => c + pixel.rgb[i]); cell.count++;
    cells.set(key, cell);
  }
  for (const cell of cells.values()) grid[cell.y][cell.x] = { char: QUADRANTS[cell.mask], color: ink(cell.rgb.map(c => c / cell.count), fade) };

  const opacity = smooth((elapsed - SPLASH_TIMING.wordmarkStartMs) / 280) * fade;
  const sweep = clamp((elapsed - SPLASH_TIMING.sweepStartMs) / (SPLASH_TIMING.sweepEndMs - SPLASH_TIMING.sweepStartMs));
  const head = sweep * 1.4 - .2;
  if (opacity > 0) layout.wordmark.lines.forEach((line, y) => {
    [...line].forEach((char, x) => {
      if (char === ' ') return;
      const distance = Math.abs(x / Math.max(1, layout.wordmark.width - 1) - head);
      const glow = elapsed < SPLASH_TIMING.sweepStartMs || elapsed >= SPLASH_TIMING.sweepEndMs ? 0 : Math.max(0, 1 - distance / .18) * .85;
      const rgb = WHITE.map((c, i) => c + (WARM_WHITE[i] - c) * glow);
      grid[layout.wordmark.y + y][layout.wordmark.x + x] = { char, color: ink(rgb, opacity) };
    });
  });
  return grid.map(row => {
    let line = '', color = '';
    for (const cell of row) {
      const next = cell?.color || '';
      if (next !== color) { line += next ? `\x1b[38;2;${next}m` : '\x1b[39m'; color = next; }
      line += cell?.char || ' ';
    }
    return line + (color ? '\x1b[39m' : '');
  });
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
