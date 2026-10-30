import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

// 开机动画：一点扩散成环（朱红起笔）→ 左右各现两座讲台 → 48 讲台成环 →
// 收缩 → 右侧亮出品牌名 → 交回议案。参考 docs/assets/kepos-lectern-ring：讲台即放射短线。
const FRAME_MS = 40;
export const SPLASH_STEPS = 70;
const SEATS = 48;

type Cell = { char: string; color: string };
type Grid = Cell[][];

const blankGrid = (rows: number, width: number): Grid => Array.from({ length: rows }, () => Array.from({ length: width }, () => ({ char: ' ', color: 'text' })));
const put = (grid: Grid, x: number, y: number, text: string, color: string) => { let column = x; for (const ch of text) { const w = Math.max(1, visibleWidth(ch)); if (grid[y]?.[column]) grid[y][column] = { char: ch, color }; for (let o = 1; o < w; o++) if (grid[y]?.[column + o]) grid[y][column + o] = { char: '', color }; column += w; } };
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
// 块状字标（设计感字体）：5 行像素字，品牌红实心块。
const FONT: Record<string, string[]> = {
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  E: ['█████', '█    ', '███  ', '█    ', '█████'],
  P: ['████ ', '█   █', '████ ', '█    ', '█    '],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  U: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
};
const word = (text: string) => { const out = ['','','','','']; for (const ch of text) { const g = FONT[ch]; if (!g) continue; for (let r = 0; r < 5; r++) out[r] += g[r] + ' '; } return out.map(r => r.trimEnd()); };

// 品牌朱红：开机时刻的小面积品牌使用，绕过主题直出 SGR（同 graph-view directColors 先例）。
const BRAND_SGR = '38;2;181;47;59';
const colorize = (cell: Cell, theme: any) => { if (!cell.char) return ''; if (cell.color === 'brand') return `[${BRAND_SGR}m${cell.char}[39m`; return theme?.fg ? theme.fg(cell.color, cell.char) : cell.char; };

export function buildSplashFrame(step: number, width: number, rows: number, theme: any): string[] {
  const W = Math.max(24, Math.min(width, 200)), H = Math.max(12, Math.min(rows, 60));
  const grid = blankGrid(H, W);
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  const maxR = Math.max(7, Math.min(Math.floor(W * 0.2), cy - 6, 16));
  const seatAngle = (k: number) => -Math.PI / 2 + (k / SEATS) * Math.PI * 2;
  const scale = step < 10 ? easeOut(step / 10) : 1;
  const r = Math.max(4, Math.round(maxR * scale));
  // 圆环自描：48 个红圆点从顶部顺时针依次落位，无任何杂点。
  for (let k = 0; k < SEATS; k++) {
    const appear = 2 + Math.floor((k * 30) / (SEATS - 1));
    if (step < appear) break;
    const a = seatAngle(k);
    put(grid, Math.round(cx + Math.cos(a) * r * 2), Math.round(cy + Math.sin(a) * r), '●', 'brand');
  }
  // 字标嵌进环心：KEPOS / COMMUNIS 品牌红块字，与圆点环构成品牌圆章；定格 1 秒。
  if (step >= 45) {
    const two = W >= 104;
    const line1 = word('KEPOS');
    const line2 = two ? word('COMMUNIS') : word('COMMUNIS').map(row2 => row2);
    const block = two ? [...line1, '', ...line2] : [...line1, '', ...word('COMMUNIS').map(row2 => row2)];
    const top = cy - Math.floor(block.length / 2);
    block.forEach((row2, i) => { const y = top + i; if (!row2.trim() || y < 0 || y >= H) return; put(grid, cx - Math.floor(visibleWidth(row2) / 2), y, row2, 'brand'); });
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
