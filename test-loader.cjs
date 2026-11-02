const path = require('node:path');
const { resolveEngine } = require('./runtime-paths.cjs');
const root = resolveEngine();
const { createJiti } = require(path.join(__dirname, 'node_modules/jiti'));
const jiti = createJiti(__filename, { alias: {
 '@earendil-works/pi-coding-agent': path.join(root, 'dist/index.js'),
 '@earendil-works/pi-tui': '@earendil-works/pi-tui',
 // pi-ai 的 compat 门面已在包内 ./compat 导出；别名若再写 '/compat'，jiti 会二次追加
 // 变成 './compat/compat' 而解析失败。这里只做同包别名，让 subtype 解析正常。
 '@earendil-works/pi-ai': '@earendil-works/pi-ai',
} });
// Exercise the checkout unless an installed/staged extension is explicitly selected.
const ext = path.resolve(process.env.KEPOS_EXTENSION_DIR || path.join(__dirname, 'terminal'));
module.exports = { jiti, root, ext };
