import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSplashFrame, SPLASH_STEPS } from '../dist/terminal/splash.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

const theme = { fg: (color, value) => value };
const bare = frame => stripVTControlCharacters(frame);

test('splash frames stay inside the terminal and end on the brand roundel', () => {
  for (const width of [80, 120, 160]) for (const step of [0, 5, 20, 40, SPLASH_STEPS - 1]) {
    const lines = buildSplashFrame(step, width, 35, theme);
    assert.ok(lines.length <= 35);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `step ${step} width ${width}`);
  }
  const early = bare(buildSplashFrame(5, 120, 35, theme).join('\n'));
  assert.ok(early.includes('●'), 'the ring traces itself with red dots');
  assert.ok(!early.includes('█'), 'no wordmark while tracing');
  const final = bare(buildSplashFrame(SPLASH_STEPS - 1, 120, 35, theme).join('\n'));
  assert.match(final, /KEPOS/);
  assert.match(final, /COMMUNIS/);
  assert.ok(final.split('').filter(c => c === '●').length >= 40, 'ring of red round dots');
  assert.ok(!final.includes('·'), 'no stray track dots');
});

test('the ring traces clockwise and settles before the wordmark lands', () => {
  const count = step => buildSplashFrame(step, 120, 35, theme).join('').split('').filter(c => c === '●').length;
  assert.ok(count(5) < count(15), 'dots keep appearing while tracing');
  assert.ok(count(33) >= 48, 'all 48 dots by the end of the trace');
  const contracted = count(44);
  assert.ok(contracted >= 40, 'contraction keeps most dots unique');
  assert.equal(count(70), contracted, 'the lockup holds still for one second');
});
