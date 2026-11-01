import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const themeUrl = name => new URL(`../themes/${name}`, import.meta.url);
const THEMES = ['kepos-default.json', 'kepos-dark.json', 'kepos-light.json'];
const { loadThemeFromPath } = await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url));

const rgb = c => [c.r, c.g, c.b];
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = c => '#' + rgb(c).map(x => x.toString(16).padStart(2, '0')).join('');

// 三套品牌主题必须都能加载、名字唯一且自洽——否则 /theme 切过去就切不回来。
test('all three brand themes ship, load, and keep unique consistent names', () => {
  const names = new Set();
  for (const file of THEMES) {
    const path = fileURLToPath(themeUrl(file));
    assert.ok(existsSync(path), `${file} is bundled`);
    const theme = loadThemeFromPath(path, 'truecolor');
    const expected = file.replace('.json', '');
    assert.equal(theme.name, expected, `${file} declares its own name`);
    assert.ok(['dark', 'light'].includes(theme.appearance), `${file} declares an appearance`);
    assert.equal(Object.keys(theme.colors).length, 56, `${file} defines the full token set`);
    names.add(theme.name);
  }
  assert.equal(names.size, THEMES.length, 'theme names are unique');
});

// 可读性下限：正文、次要文字与主要语义色在各自背景上都够清晰。
test('every brand theme keeps body and semantic colors readable', () => {
  for (const file of THEMES) {
    const theme = loadThemeFromPath(fileURLToPath(themeUrl(file)), 'truecolor');
    const bg = theme.appearance === 'dark' ? [18, 23, 21] : [250, 246, 239];
    for (const token of ['text', 'muted', 'dim', 'accent', 'warning', 'success', 'error', 'toolTitle', 'syntaxKeyword', 'syntaxOperator']) {
      const color = theme.colors[token];
      assert.ok(color && color.kind === 'rgb', `${file}: ${token} resolves`);
      const ratio = contrast(rgb(color), bg);
      assert.ok(ratio >= 4.5, `${file}: ${token} (${hex(color)}) contrast ${ratio.toFixed(2)} must be >= 4.5`);
    }
  }
});

// 环图用这四个 token 区分分组；撞色会让不同分组看起来是同一组。
test('group palette stays distinguishable in every brand theme', () => {
  for (const file of THEMES) {
    const theme = loadThemeFromPath(fileURLToPath(themeUrl(file)), 'truecolor');
    const palette = ['toolTitle', 'syntaxKeyword', 'syntaxOperator', 'accent'].map(token => [token, rgb(theme.colors[token])]);
    for (let i = 0; i < palette.length; i++) {
      for (let j = i + 1; j < palette.length; j++) {
        const distance = Math.hypot(...palette[i][1].map((v, n) => v - palette[j][1][n]));
        assert.ok(distance > 40, `${file}: ${palette[i][0]} vs ${palette[j][0]} distance ${distance.toFixed(0)}`);
      }
    }
  }
});

// 标题、强调各司其职：mdHeading 与 accent 完全同色会让正文层级糊掉。
test('headings do not reuse the accent color verbatim', () => {
  for (const file of THEMES) {
    const theme = loadThemeFromPath(fileURLToPath(themeUrl(file)), 'truecolor');
    assert.notEqual(hex(theme.colors.mdHeading), hex(theme.colors.accent), `${file}: heading differs from accent`);
  }
});

// 纵深：背景三层必须有单调且可感知的明度阶梯，否则面板会糊成一片。
// 方向随主题明暗而定且必须全程一致：
//   深色主题 page < card < info（越"高"越亮，像叠起的卡片）
//   浅色主题 page > card > info（纸面越"高"越白，信息块向内收）
// 无论哪个方向，只要单调且每级差距可感知，层级就读得出来。
test('every theme keeps a monotone background ladder', () => {
  for (const file of THEMES) {
    const json = JSON.parse(readFileSync(fileURLToPath(themeUrl(file)), 'utf8'));
    const steps = ['pageBg', 'cardBg', 'infoBg'].map(key => lum(rgb(hexToRgb(json.export[key]))));
    const rising = steps[0] < steps[1] && steps[1] < steps[2];
    const falling = steps[0] > steps[1] && steps[1] > steps[2];
    assert.ok(rising || falling, `${file}: luminance ladder is monotone (got ${steps.map(s => s.toFixed(4)).join(' / ')})`);
    // 方向要与主题明暗自洽：深色向上更亮，浅色向上更暗。
    if (json.appearance === 'dark') assert.ok(rising, `${file}: dark theme elevates by getting lighter`);
    else assert.ok(falling, `${file}: light theme recedes by getting darker`);
    // 相邻层要有可感知的差距。
    assert.ok(Math.abs(steps[1] - steps[0]) > 0.002, `${file}: page→card step is perceptible`);
    assert.ok(Math.abs(steps[2] - steps[1]) > 0.002, `${file}: card→info step is perceptible`);
  }
});

// 语义色分工：选中态(borderAccent) / 强调(accent) / 警告(warning) / 标题(mdHeading)
// 必须两两不同色，否则界面层次会被同一种颜色抹平。
test('semantic roles stay visually distinct within each theme', () => {
  for (const file of THEMES) {
    const theme = loadThemeFromPath(fileURLToPath(themeUrl(file)), 'truecolor');
    const roles = ['borderAccent', 'accent', 'warning', 'mdHeading', 'mdLink'];
    const seen = new Map();
    for (const role of roles) {
      const value = hex(theme.colors[role]);
      assert.equal(seen.has(value), false, `${file}: ${role} duplicates ${seen.get(value)} (${value})`);
      seen.set(value, role);
    }
  }
});

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
}
