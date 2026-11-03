import { getCellDimensions, type CellDimensions, type Component } from '@earendil-works/pi-tui';

// An opening interpretation of the v14 lectern mark, not a replacement for the formal logo.
export const SPLASH_TIMING = {
  frameMs: 40,
  tableMs: 640,
  // Spread ignition over a longer window so the per-seat wave is actually visible.
  lightStartMs: 680,
  lightEndMs: 1780,
  wordmarkStartMs: 880,
  // A slower sweep: the highlight needs ~1.3s to cross, not 0.5s.
  sweepStartMs: 1080,
  sweepEndMs: 2380,
  revealMs: 2460,
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
  // Heavy square grotesque: every stroke is two full cells wide, matching the reference lockup.
  K: ['1100011', '1100110', '1101100', '1111000', '1111000', '1101100', '1100110', '1100011', '1100011'],
  E: ['1111111', '1111111', '1100000', '1100000', '1111110', '1111110', '1100000', '1111111', '1111111'],
  P: ['1111110', '1111111', '1100011', '1100011', '1111111', '1111110', '1100000', '1100000', '1100000'],
  O: ['0111110', '1111111', '1100011', '1100011', '1100011', '1100011', '1100011', '1111111', '0111110'],
  S: ['0111111', '1111111', '1100000', '1111000', '0111110', '0000111', '0000011', '1111111', '1111110'],
  C: ['0111111', '1111111', '1100000', '1100000', '1100000', '1100000', '1100000', '1111111', '0111111'],
  M: ['1100011', '1110111', '1111111', '1111111', '1101011', '1100011', '1100011', '1100011', '1100011'],
  U: ['1100011', '1100011', '1100011', '1100011', '1100011', '1100011', '1100011', '1111111', '0111110'],
  N: ['1100011', '1110011', '1111011', '1111111', '1101111', '1100111', '1100011', '1100011', '1100011'],
  I: ['1111111', '1111111', '0011100', '0011100', '0011100', '0011100', '0011100', '1111111', '1111111'],
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
  variant: Variant; fontWidth: number; fontHeight: number; bits: Uint8Array; bitmapWidth: number; bitmapHeight: number; splitRow: number;
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
  const rows = Array.from({ length: font.K.length }, () => [] as boolean[]);
  [...text].forEach((char, index) => {
    const glyph = font[char];
    if (!glyph) return;
    if (index) rows.forEach(row => row.push(false));
    rows.forEach((row, y) => [...glyph[y]].forEach(bit => row.push(bit === '1')));
  });
  return rows;
}
function makeWordmark(font: Record<string, string[]>, variant: Variant, block = 1): SplashWordmark {
  const glyphRows = font.K.length;
  const first = textGrid(font, 'KEPOS');
  const gap = Array.from({ length: Math.max(1, glyphRows - 4) }, () => [] as boolean[]);
  const second = textGrid(font, 'COMMUNIS');
  const lines = [...first, ...gap, ...second];
  // Row ranges let each word take its own treatment: KEPOS solid, COMMUNIS outlined.
  const firstEnd = first.length, secondStart = first.length + gap.length;
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
  return { x: 0, y: 0, width: Math.ceil((subWidth + 1) / 2), height: Math.ceil((subHeight + 1) / 2), variant, fontWidth, fontHeight, bits, bitmapWidth: subWidth, bitmapHeight: subHeight, splitRow: secondStart * block };
}
// Largest first: layout picks the biggest lockup that fits, so wide terminals get a poster-scale wordmark.
const WORDMARKS = [
  makeWordmark(DISPLAY, 'display', 2),
  makeWordmark(DISPLAY, 'display', 1),
  makeWordmark(COMPACT, 'compact', 1),
];

// Top-view lectern: one brand trapezoid (narrow outer edge, wider inner edge) per seat.
// The shape is defined in each seat's own local frame, so all 48 use identical dimensions.
function buildLecterns(radius: number, aspect: number): SplashLectern[] {
  const slot = 2 * Math.PI * radius / SEATS;
  // Desk proportions sized to fill the angular slot: the trapezoid uses ~68% of the seat
  // arc for the tabletop, leaving ~32% as visible gap between neighbouring desks.
  const outer = slot * .28, inner = slot * .38, depth = slot * .82;
  return Array.from({ length: SEATS }, (_, id) => {
    const angle = id * Math.PI * 2 / SEATS;
    const nx = Math.sin(angle), ny = -Math.cos(angle), tx = Math.cos(angle), ty = Math.sin(angle);
    const vertex = (tangent: number, radial: number): Point => ({
      x: (nx * (radius + radial) + tx * tangent) * aspect,
      y: (ny * (radius + radial) + ty * tangent) * SPLASH_VIEW.depth,
    });
    return {
      id, angle, center: vertex(0, 0), outward: { x: nx, y: ny }, slot,
      tablet: [vertex(-outer, depth / 2), vertex(outer, depth / 2), vertex(inner, -depth / 2), vertex(-inner, -depth / 2)],
      plate: [], samples: [],
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

// Supersample a polygon onto the half-cell grid; returns covered sub-cells with coverage.
function rasterise(polygon: Point[]): [number, number, number][] {
  const x0 = Math.floor(Math.min(...polygon.map(p => p.x)) * 2), x1 = Math.ceil(Math.max(...polygon.map(p => p.x)) * 2);
  const y0 = Math.floor(Math.min(...polygon.map(p => p.y)) * 2), y1 = Math.ceil(Math.max(...polygon.map(p => p.y)) * 2);
  const out: [number, number, number][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    let hits = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      if (inside({ x: (x + (sx + .5) / 4) / 2, y: (y + (sy + .5) / 4) / 2 }, polygon)) hits++;
    }
    if (hits >= 5) out.push([x, y, hits]);
  }
  return out;
}

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
    // The ring is the primary subject: keep it at least a third of the terminal, and fall
    // back to a narrower wordmark rather than letting the logotype squeeze the circle.
    const minRing = Math.max(Math.round(W * .34), 30);
    // Grow the ring until 48 identical trapezoid lecterns fit with a clear gap between them.
    for (let radius = 22; radius >= 6; radius -= .25) {
      const lecterns = buildLecterns(radius, cellAspect);
      // 48 desks in a small terminal cannot all stay fully apart; the last seat may share a
      // sub-cell with the first. The first desk wins, so the silhouette stays regular.
      let drawn = 0;
      for (const seat of lecterns) {
        const cells = rasterise(seat.tablet);
        if (!cells.length) continue;
        drawn++;
        seat.samples = cells.map(([x, y, hits]) => ({ x, y, part: 'desktop' as const, coverage: hits / 16 }));
      }
      if (drawn !== SEATS) continue;
      const xs = lecterns.flatMap(seat => seat.samples.map(s => s.x));
      const ys = lecterns.flatMap(seat => seat.samples.map(s => s.y));
      const ringWidth = Math.ceil((Math.max(...xs) - Math.min(...xs)) / 2) + 2;
      const ringHeight = Math.ceil((Math.max(...ys) - Math.min(...ys)) / 2) + 2;
      if (ringWidth < minRing) continue;
      if (ringWidth + gap + wordmark.width > availableW || ringHeight > availableH) continue;
      // Reject rings where two desks share a sub-cell; a clean ring is worth a smaller radius.
      {
        const seen = new Map<string, number>();
        let contacts = 0;
        for (const seat of lecterns) for (const sample of seat.samples) {
          const key = `${sample.x},${sample.y}`, owner = seen.get(key);
          if (owner !== undefined && owner !== seat.id) contacts++;
          seen.set(key, seat.id);
        }
        // Reject only genuine overlap (many shared cells); 1–2 shared edge cells are
        // sub-cell quantisation, not a layout flaw.
        if (contacts > 4) continue;
      }
      const x = Math.floor((W - ringWidth - gap - wordmark.width) / 2);
      const y = Math.floor((H - ringHeight) / 2), cx = x + ringWidth / 2, cy = y + ringHeight / 2;
      // Shift the whole lockup into place. Samples were rasterised in ring-local coordinates,
      // so they must move with the seat centres or the ring would render detached from its box.
      const shiftX = cx * 2, shiftY = cy * 2;
      for (const seat of lecterns) {
        seat.center = { x: cx + seat.center.x, y: cy + seat.center.y };
        seat.samples = seat.samples.map(sample => ({ ...sample, x: sample.x + Math.round(shiftX), y: sample.y + Math.round(shiftY) }));
      }
      return {
        width: W, height: H, cellAspect, gap,
        ring: { x, y, width: ringWidth, height: ringHeight, cx, cy, radius, lecterns },
        wordmark: { ...wordmark, x: x + ringWidth + gap, y: Math.round(cy - wordmark.height / 2) },
      };
    }
  }
  return null;
}

// One fixed lamp in world space at the upper right, exactly like the reference clip: the
// camera and the light never move; the surfaces ignite one after another.
export const LIGHT_DIR = (() => {
  const azimuth = Math.PI * .28, elevation = Math.PI / 5;
  return { x: Math.cos(azimuth) * Math.cos(elevation), y: Math.sin(azimuth) * Math.cos(elevation), z: Math.sin(elevation) };
})();

// Kept for callers that ask where the key light is; it no longer sweeps.
export function splashLight(_elapsed: number): { x: number; y: number; z: number; progress: number } {
  return { ...LIGHT_DIR, progress: 1 };
}

// Ignition order: seats light up one after another around the ring, like the reference clip's
// facets catching light. Each seat ramps over a short window, so the wave reads as discrete
// blocks igniting rather than one global fade.
export function lecternProgress(elapsed: number, index: number): { desktop: number; plaque: number } {
  const span = SPLASH_TIMING.lightEndMs - SPLASH_TIMING.lightStartMs;
  const ramp = Math.max(160, span / SEATS * 2.8);
  const start = SPLASH_TIMING.lightStartMs + (index / SEATS) * (span - ramp);
  const lit = smooth((elapsed - start) / ramp);
  return { desktop: lit, plaque: lit };
}

// Per-pixel shading: a tabletop tilts toward the lamp, so brightness depends on where a point
// sits inside the seat, not just on which seat it is.
// Cached per seat: each tabletop is normalised by its own extent, so the gradient spans the
// whole surface instead of saturating within half a cell.
const seatExtent = new WeakMap<SplashLectern, { hx: number; hy: number }>();
function extentOf(seat: SplashLectern): { hx: number; hy: number } {
  const cached = seatExtent.get(seat);
  if (cached) return cached;
  let maxX = .25, maxY = .25;
  for (const sample of seat.samples) {
    maxX = Math.max(maxX, Math.abs(sample.x / 2 - seat.center.x));
    maxY = Math.max(maxY, Math.abs(sample.y / 2 - seat.center.y));
  }
  const found = { hx: maxX, hy: maxY };
  seatExtent.set(seat, found);
  return found;
}

export function surfaceShade(seat: SplashLectern, nx: number, ny: number, part: 'desktop' | 'plaque'): number {
  const { hx, hy } = extentOf(seat);
  // Local -1..1 coordinates across this desk, so the gradient always spans the full surface.
  const gx = clamp((nx - seat.center.x) / hx), gy = clamp((ny - seat.center.y) / hy);
  if (part === 'desktop') {
    // Key light sits up-right: the +x / -y quadrant is brightest and the far corner falls away.
    // A raised lip on the outer edge adds the specular spark that makes each desk read solid.
    const facing = .5 + .5 * (gx * .60 - gy * .80);
    const lip = Math.max(0, Math.hypot(gx * .8, gy) - .35) / .65;
    // Bias upward: the ring should read as lit metal, with the gradient carried by the
    // highlight rather than by crushing everything into shadow.
    return clamp(.30 + .58 * facing + .30 * lip);
  }
  // Plates face outward; brightness follows how squarely they meet the light.
  const square = Math.max(0, seat.outward.x * LIGHT_DIR.x + seat.outward.y * LIGHT_DIR.y);
  return clamp(.10 + .86 * square);
}

// `painted` records membership in the geometry, independent of how bright a cell currently is.
type Buffer = { rgb: Float32Array; alpha: Float32Array; painted: Uint8Array };

function paint(buffer: Buffer, subWidth: number, subHeight: number, x: number, y: number, rgb: readonly number[], alpha: number, mark = true) {
  const ix = Math.round(x), iy = Math.round(y);
  if (alpha <= 0 || ix < 0 || iy < 0 || ix >= subWidth || iy >= subHeight) return;
  const index = iy * subWidth + ix, previous = buffer.alpha[index], next = alpha + previous * (1 - alpha);
  if (mark) buffer.painted[index] = 1;
  for (let channel = 0; channel < 3; channel++) {
    buffer.rgb[index * 3 + channel] = (rgb[channel] * alpha + buffer.rgb[index * 3 + channel] * previous * (1 - alpha)) / next;
  }
  buffer.alpha[index] = next;
}

function drawSplash(elapsed: number, layout: SplashLayout): string[] {
  const subWidth = layout.width * 2, subHeight = layout.height * 2;
  const buffer: Buffer = { rgb: new Float32Array(subWidth * subHeight * 3), alpha: new Float32Array(subWidth * subHeight), painted: new Uint8Array(subWidth * subHeight) };
  const exitAt = SPLASH_TIMING.revealMs + SPLASH_TIMING.holdMs;
  // Linear exit: a smoothstep here kept the first half visually identical to the held frame.
  // Ease-in exit: the first third must be visibly dimmer, otherwise 8-bit colour quantisation
  // makes the early fade frames byte-identical to the held frame.
  const fade = 1 - clamp((elapsed - exitAt) / SPLASH_TIMING.fadeMs) ** .55;

  if (fade > 0) [...layout.ring.lecterns].sort((a, b) => a.center.y - b.center.y).forEach(seat => {
    const progress = lecternProgress(elapsed, seat.id);
    for (const sample of seat.samples) {
      const opacity = progress[sample.part] * fade;
      if (opacity <= 0) continue;
      // Every sub-cell is shaded from its own position inside the tabletop, so a seat reads as
      // a lit solid rather than a flat silhouette.
      const shade = surfaceShade(seat, sample.x / 2, sample.y / 2, sample.part);
      const base = mix(SHADOW, LIT, shade);
      // A hot rim on the lit corner separates neighbouring desks without drawing outlines.
      const rim = sample.part === 'desktop' ? Math.max(0, shade - .78) / .22 : 0;
      const rgb = mix(base, RIM, rim * .85).map(channel => channel * fade);
      // Coverage stays full during the exit: the cell keeps its place and only loses luminance,
      // so the silhouette never reshapes while fading out.
      paint(buffer, subWidth, subHeight, sample.x, sample.y, rgb, Math.min(1, opacity * sample.coverage));
    }
  });

  if (fade > 0) {
    const originX = layout.wordmark.x * 2, originY = layout.wordmark.y * 2;
    const opacity = smooth((elapsed - SPLASH_TIMING.wordmarkStartMs) / 320) * fade;
    const sweep = clamp((elapsed - SPLASH_TIMING.sweepStartMs) / (SPLASH_TIMING.sweepEndMs - SPLASH_TIMING.sweepStartMs));
    const colorAt = (column: number) => {
      const position = column / Math.max(1, layout.wordmark.bitmapWidth - 1);
      const head = sweep * 1.35 - .15;
      const glow = sweep <= 0 || sweep >= 1 ? 0 : Math.max(0, 1 - Math.abs(position - head) / .22);
      // The band starts deep vermilion and warms to amber before settling back to white.
      const tint = mix(BRAND, AMBER, sweep);
      return { rgb: mix(WHITE, tint, glow * .9), glow };
    };
    // The shadow clears before the lockup settles, so the held frame is byte-identical every tick.
    const shadowLife = 1 - smooth((elapsed - (SPLASH_TIMING.sweepEndMs - 320)) / 200);
    if (opacity > 0 && shadowLife > 0) {
      const glyphW = layout.wordmark.bitmapWidth, glyphH = layout.wordmark.bitmapHeight;
      for (let y = 0; y < glyphH; y++) for (let x = 0; x < glyphW; x++) {
        if (!layout.wordmark.bits[y * glyphW + x]) continue;
        paint(buffer, subWidth, subHeight, originX + x + 1, originY + y + 1, SHADOW, opacity * shadowLife * .55);
      }
    }
    if (opacity > 0) {
      const w = layout.wordmark.bitmapWidth, h = layout.wordmark.bitmapHeight, bits = layout.wordmark.bits;
      const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === 1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!on(x, y)) continue;
        const { rgb: sweepBase, glow } = colorAt(x);
        // Two-tone lockup: KEPOS solid white with a subtle engraved bevel;
        // COMMUNIS solid brand vermilion — the second word carries the accent colour.
        let rgb: number[];
        if (y < layout.wordmark.splitRow) {
          const edge = !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1);
          const inner = !edge && (!on(x - 1, y - 1) || !on(x + 1, y + 1) || !on(x + 1, y - 1) || !on(x - 1, y + 1));
          rgb = edge ? mix(sweepBase, WHITE, .3) : inner ? mix(sweepBase, [0, 0, 0], .38) : sweepBase;
        } else {
          // Brand vermilion body; the sweep warms it toward amber and the bevel adds depth.
          const body = [225, 92, 78] as const;
          const bevel = y % 2 === 0 ? 1 : .82;
          rgb = mix([body[0] * bevel, body[1] * bevel, body[2] * bevel], AMBER, glow * .35);
          rgb = mix(rgb, sweepBase, .14);
        }
        paint(buffer, subWidth, subHeight, originX + x, originY + y, rgb, opacity);
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
        // Geometry must not depend on brightness: a dim cell is still part of the shape.
        // Only a cell that was never painted at all is background.
        if (buffer.painted[index] === 0) continue;
        const alpha = Math.max(buffer.alpha[index], .001);
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
