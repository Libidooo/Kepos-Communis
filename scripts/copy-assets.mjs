import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
const source = resolve('terminal/worker-host.cjs');
const target = resolve('dist/terminal/worker-host.cjs');
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
const BRAND_THEMES = ['kepos-default.json', 'kepos-dark.json', 'kepos-light.json'];
const missing = BRAND_THEMES.filter(name => !existsSync(resolve('themes', name)));
if (missing.length) throw Error('Missing bundled brand themes: ' + missing.join(', '));
// 品牌主题发布指纹：运行时据此判断用户目录里的副本是否仍是我们发布的版本，
// 只升级未被自定义的主题。每次构建按当前主题内容重新生成，不能手工维护。
const manifest = Object.fromEntries(BRAND_THEMES.map(name => [
 name, createHash('sha256').update(readFileSync(resolve('themes', name))).digest('hex'),
]));
writeFileSync(resolve('themes', '.brand-theme-hashes.json'), JSON.stringify(manifest, null, 2) + '\n');
const { writeBuildStamp } = createRequire(import.meta.url)('../bin/build-support.cjs');
writeBuildStamp(process.cwd());
console.log('Kepos build ready');
