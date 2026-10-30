import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSplashFrame, SPLASH_STEPS } from '../dist/terminal/splash.js';
import { visibleWidth } from '@earendil-works/pi-tui';

const theme = { fg: (color, value) => value };

test('splash frames stay inside the terminal and end on the brand lockup', () => {
  for (const width of [80, 120, 160]) for (const step of [0, 5, 11, 20, 45, 50, SPLASH_STEPS - 1]) {
    const lines = buildSplashFrame(step, width, 35, theme);
    assert.ok(lines.length <= 35);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `step ${step} width ${width}`);
  }
  const early = buildSplashFrame(5, 120, 35, theme).join('\n');
  assert.ok(!early.includes('Kepos Communis'), 'brand appears only after the ring settles');
  const final = buildSplashFrame(SPLASH_STEPS - 1, 120, 35, theme).join('\n');
  assert.match(final, /Kepos Communis/);
  assert.match(final, /议案 · 议会 · 48 席/);
  assert.ok(final.split('').filter(c => c === '─' || c === '│' || c === '╱').length >= 40, 'lectern ring drawn as radial dashes');
});

test('the lectern reveal follows left-right, then top-bottom, then the rest', () => {
  const count = step => buildSplashFrame(step, 120, 35, theme).join('').split('').filter(c => '─│╱'.includes(c)).length;
  assert.ok(count(11) >= 2, 'first pair on the left-right axis');
  assert.ok(count(13) >= 4, 'second pair completes the four');
  assert.ok(count(13) < count(30), 'seats keep filling');
  assert.ok(count(44) >= 44, 'all 48 lecterns by the end of the fill phase');
});
