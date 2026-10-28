const path = require('node:path');
const fs = require('node:fs');
const { resolveEngine } = require('./runtime-paths.cjs');
const root = resolveEngine();
const { createJiti } = require(path.join(__dirname, 'node_modules/jiti'));
function firstExisting(candidates) {
 return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}
const tuiEntry = firstExisting([
 path.join(__dirname, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
 path.join(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
]);
const aiEntry = firstExisting([
 path.join(__dirname, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
 path.join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
]);
const jiti = createJiti(__filename, { alias: {
 '@earendil-works/pi-coding-agent': path.join(root, 'dist/index.js'),
 '@earendil-works/pi-tui': tuiEntry,
 '@earendil-works/pi-ai': path.join(path.dirname(aiEntry), 'compat.js'),
} });
// Exercise the checkout unless an installed/staged extension is explicitly selected.
const ext = path.resolve(process.env.KEPOS_EXTENSION_DIR || path.join(__dirname, 'terminal'));
module.exports = { jiti, root, ext };
