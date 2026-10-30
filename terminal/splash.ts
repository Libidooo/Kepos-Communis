import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

// 开机动画：一点扩散成环（朱红起笔）→ 左右各现两座讲台 → 48 讲台成环 →
// 收缩 → 右侧亮出品牌名 → 交回议案。参考 docs/assets/kepos-lectern-ring：讲台即放射短线。
const FRAME_MS = 40;
export const SPLASH_STEPS = 64;
const SEATS = 48;

type Cell = { char: string; color: string };
type Grid = Cell[][];

const blankGrid = (rows: number, width: number): Grid => Array.from({ length: rows }, () => Array.from({ length: width }, () => ({ char: ' ', color: 'text' })));
const put = (grid: Grid, x: number, y: number, text: string, color: string) => { let column = x; for (const ch of text) { const w = Math.max(1, visibleWidth(ch)); if (grid[y]?.[column]) grid[y][column] = { char: ch, color }; for (let o = 1; o < w; o++) if (grid[y]?.[column + o]) grid[y][column + o] = { char: '', color }; column += w; } };
const radial = (angle: number) => { const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle)); return c > s * 2 ? '─' : s > c * 2 ? '│' : '╱'; };

// 讲台出场顺序：先左右一对，再上下一对，其余沿环对称补齐。
const REVEAL: number[] = (() => {
  const order = [0, 24, 12, 36]; const seen = new Set(order);
  for (let k = 1; k < SEATS / 2; k++) { for (const j of [k, SEATS - k]) if (!seen.has(j)) { order.push(j); seen.add(j); } }
  return order;
})();
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

export function buildSplashFrame(step: number, width: number, rows: number, theme: any): string[] {
  const W = Math.max(24, Math.min(width, 200)), H = Math.max(10, Math.min(rows, 60));
  const grid = blankGrid(H, W);
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  const maxR = Math.max(4, Math.min(Math.floor(W * 0.16), cy - 2, 12));
  const F = (color: string, ch: string) => theme?.fg ? theme.fg(color, ch) : ch;
  const seatAngle = (k: number) => (k / SEATS) * Math.PI * 2;
  const expanded = step >= 10, shrinking = step >= 45, branded = step >= 52;
  const revealed = expanded ? Math.min(SEATS, step < 12 ? (step >= 10 ? 2 : 0) : step < 14 ? 4 : 4 + Math.min(SEATS - 4, Math.floor((step - 14) * (SEATS - 4) / 30))) : 0;
  const scale = shrinking ? 1 - 0.3 * Math.min(1, (step - 45) / 7) : 1;
  const shown = new Set(REVEAL.slice(0, revealed));
  const radius = Math.max(3, maxR * scale);
  if (!shrinking) {
    // 扩散：朱红前导环，旧环留成暗色轨迹，即"小点扩大成圆环逐渐消失"。
    const trailSteps = Math.min(step, 10);
    for (let k = 0; k <= trailSteps; k++) {
      const r = Math.max(1, Math.round(maxR * easeOut(k / 10)));
      const color = k === trailSteps ? 'error' : 'dim';
      const dotN = Math.max(12, Math.round(r * 6));
      for (let i = 0; i < dotN; i++) { const a = (i / dotN) * Math.PI * 2; put(grid, Math.round(cx + Math.cos(a) * r * 2), Math.round(cy + Math.sin(a) * r), '·', color); }
    }
  } else {
    const dotN = Math.max(24, Math.round(radius * 6));
    for (let i = 0; i < dotN; i++) { const a = (i / dotN) * Math.PI * 2; put(grid, Math.round(cx + Math.cos(a) * radius * 2), Math.round(cy + Math.sin(a) * radius), '·', 'dim'); }
  }
  for (let k = 0; k < revealed; k++) {
    const seat = REVEAL[k]; if (!shown.has(seat) && !shrinking) continue;
    const a = seatAngle(seat);
    const x = Math.round(cx + Math.cos(a) * radius * 2), y = Math.round(cy + Math.sin(a) * radius);
    put(grid, x, y, radial(a), 'success');
  }
  if (branded) {
    const brandX = Math.min(W - 16, cx + Math.round(radius * 2) + 4);
    put(grid, brandX, cy - 1, 'Kepos Communis', 'accent');
    put(grid, brandX, cy + 1, '议案 · 议会 · 48 席', 'dim');
  }
  return grid.map(row => row.map(cell => cell.char ? F(cell.color, cell.char) : '').join('')).map(line => truncateToWidth(line, W));
}

let played = false;
export async function playSplash(ctx: any, config?: { motion?: boolean }): Promise<void> {
  if (played) return; played = true;
  if (config?.motion === false || process.env.KEPOS_NO_SPLASH === '1') return;
  if (!ctx?.ui?.custom) return;
  await ctx.ui.custom((tui, theme, _keys, done) => {
    let step = 0; let timer: any; let finished = false; let fast = false;
    const finish = () => { if (finished) return; finished = true; clearInterval(timer); done(); };
    timer = setInterval(() => { step++; tui.requestRender(); if (step >= SPLASH_STEPS) finish(); }, FRAME_MS);
    return {
      focused: true,
      render(width: number) {
        const rows = Math.max(1, tui.terminal.rows || 30);
        if (width < 80 || rows < 20) fast = true;
        if (fast && step < SPLASH_STEPS - 8) step = SPLASH_STEPS - 8;
        return buildSplashFrame(step, width, rows, theme);
      },
      // Pi 在失效/关闭 overlay 时会调用这些；补齐组件表面避免 uncaughtException。
      invalidate() { },
      dispose() { finish(); },
      handleInput() { finish(); },
      handleMouse() { finish(); },
    };
  }, { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
}
