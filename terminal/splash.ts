import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

// 开机动画：一点扩散成环（朱红起笔）→ 左右各现两座讲台 → 48 讲台成环 →
// 收缩 → 右侧亮出品牌名 → 交回议案。参考 docs/assets/kepos-lectern-ring：讲台即放射短线。
const FRAME_MS = 40;
export const SPLASH_STEPS = 60;
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

// 品牌朱红：开机时刻的小面积品牌使用，绕过主题直出 SGR（同 graph-view directColors 先例）。
const BRAND_SGR = '38;2;181;47;59';
const colorize = (cell: Cell, theme: any) => { if (!cell.char) return ''; if (cell.color === 'brand') return `[${BRAND_SGR}m${cell.char}[39m`; return theme?.fg ? theme.fg(cell.color, cell.char) : cell.char; };

export function buildSplashFrame(step: number, width: number, rows: number, theme: any): string[] {
  const W = Math.max(24, Math.min(width, 200)), H = Math.max(10, Math.min(rows, 60));
  const grid = blankGrid(H, W);
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  const maxR = Math.max(4, Math.min(Math.floor(W * 0.16), cy - 2, 12));
  const seatAngle = (k: number) => (k / SEATS) * Math.PI * 2;
  // 每帧只画当前环：旧环真正消失，不留杂乱轨迹。
  const ring = (r: number, color: string) => { const n = Math.max(16, Math.round(r * 9)); for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; put(grid, Math.round(cx + Math.cos(a) * r * 2), Math.round(cy + Math.sin(a) * r), '·', color); } };
  const lectern = (k: number, r: number, color: string) => { const a = seatAngle(k); put(grid, Math.round(cx + Math.cos(a) * r * 2), Math.round(cy + Math.sin(a) * r), radial(a), color); };
  if (step < 9) {
    const r = Math.max(1, Math.round(maxR * easeOut(step / 9)));
    ring(r, 'brand');
  } else {
    const scale = step >= 38 ? 1 - 0.3 * Math.min(1, (step - 38) / 7) : 1;
    const r = Math.max(3, Math.round(maxR * scale));
    ring(r, 'dim');
    const revealed = step < 11 ? 0 : step < 13 ? 2 : step < 15 ? 4 : Math.min(SEATS, 4 + Math.floor(((step - 15) * (SEATS - 4)) / 23));
    for (let k = 0; k < revealed; k++) lectern(REVEAL[k], r, 'success');
  }
  if (step >= 45) {
    const brandX = Math.min(W - 16, cx + Math.round(maxR * 0.7 * 2) + 4);
    put(grid, brandX, cy - 1, 'Kepos Communis', 'brand');
    put(grid, brandX, cy + 1, '议案 · 议会 · 48 席', 'dim');
  }
  return grid.map(row => row.map(cell => colorize(cell, theme)).join('')).map(line => truncateToWidth(line, W));
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
