import fs from 'node:fs';
const b = fs.readFileSync('C:/Users/齐山冼/Downloads/not-jam-laika-14px-square.ttf');
const u16 = o => b.readUInt16BE(o), u32 = o => b.readUInt32BE(o), i16 = o => b.readInt16BE(o);
const n = u16(4), tables = {};
for (let i = 0; i < n; i++) { const o = 12 + i * 16; tables[b.toString('ascii', o, o + 4)] = { off: u32(o + 8) }; }
const head = tables.head.off, unitsPerEm = u16(head + 18), locaFmt = i16(head + 50);
const cm = tables.cmap.off, nt = u16(cm + 2);
let sub = null;
for (let i = 0; i < nt; i++) {
  const o = cm + 4 + i * 8, pid = u16(o), eid = u16(o + 2), off = u32(o + 4);
  if (pid === 3 && (eid === 1 || eid === 10) && u16(cm + off) === 4) sub = cm + off;
}
const segX2 = u16(sub + 6), segCount = segX2 / 2;
const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
const glyphOf = cp => {
  for (let s = 0; s < segCount; s++) {
    const end = u16(endO + s * 2); if (cp > end) continue;
    const start = u16(startO + s * 2); if (cp < start) return 0;
    const delta = i16(deltaO + s * 2), ro = u16(rangeO + s * 2);
    if (!ro) return (cp + delta) & 0xffff;
    const g = u16(rangeO + s * 2 + ro + (cp - start) * 2);
    return g ? (g + delta) & 0xffff : 0;
  }
  return 0;
};
const loca = tables.loca.off, glyf = tables.glyf.off;
const range = g => { const a = locaFmt ? u32(loca + g * 4) : u16(loca + g * 2) * 2; const z = locaFmt ? u32(loca + g * 4 + 4) : u16(loca + g * 2 + 2) * 2; return [glyf + a, glyf + z]; };
const contoursOf = gid => {
  const [s, e] = range(gid); if (e <= s) return null;
  const nc = i16(s); if (nc < 0) return null;
  const endPts = []; for (let i = 0; i < nc; i++) endPts.push(u16(s + 10 + i * 2));
  let o = s + 10 + nc * 2; o += 2 + u16(o);
  const total = endPts[endPts.length - 1] + 1; const flags = [];
  while (flags.length < total) { const f = b[o++]; flags.push(f); if (f & 8) { let r = b[o++]; while (r-- > 0) flags.push(f); } }
  const xs = []; let x = 0;
  for (const f of flags) { if (f & 2) { const d = b[o++]; x += (f & 16) ? d : -d; } else if (!(f & 16)) { x += i16(o); o += 2; } xs.push(x); }
  const ys = []; let y = 0;
  for (const f of flags) { if (f & 4) { const d = b[o++]; y += (f & 32) ? d : -d; } else if (!(f & 32)) { y += i16(o); o += 2; } ys.push(y); }
  const pts = [], starts = [0, ...endPts.map(p => p + 1)];
  for (let c = 0; c < nc; c++) { const arr = []; for (let i = starts[c]; i < starts[c + 1]; i++) arr.push({ x: xs[i], y: ys[i] }); pts.push(arr); }
  return pts;
};
const sample = (gid, cols, rows) => {
  const cs = contoursOf(gid); if (!cs) return null;
  const all = cs.flat(); const minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x));
  const minY = Math.min(...all.map(p => p.y)), maxY = Math.max(...all.map(p => p.y));
  const w = maxX - minX || 1, h = maxY - minY || 1;
  const inside = (px, py) => { let wind = 0; for (const c of cs) for (let i = 0; i < c.length; i++) { const a = c[i], q = c[(i + 1) % c.length]; const cr = (q.x - a.x) * (py - a.y) - (px - a.x) * (q.y - a.y); if (a.y <= py) { if (q.y > py && cr > 0) wind++; } else if (q.y <= py && cr < 0) wind--; } return wind !== 0; };
  const out = [];
  for (let r = 0; r < rows; r++) { let line = ''; for (let c2 = 0; c2 < cols; c2++) { let hit = 0; for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) { const px = minX + (w * (c2 + (sx + .5) / 4)) / cols, py = maxY - (h * (r + (sy + .5) / 4)) / rows; if (inside(px, py)) hit++; } line += hit >= 6 ? '1' : '0'; } out.push(line); }
  return out;
};
const letters = 'KEPOSCUMN';
const widthOf = ch => { const g = contoursOf(glyphOf(ch.charCodeAt(0))); if (!g) return 3; const all = g.flat(); return Math.round((Math.max(...all.map(p => p.x)) - Math.min(...all.map(p => p.x))) / (unitsPerEm / 14)); };
const out = {};
for (const ch of letters) {
  const cols = ch === 'K' || ch === 'M' || ch === 'N' ? 7 : ch === 'U' ? 7 : 6;
  const art = sample(glyphOf(ch.charCodeAt(0)), cols, 9);
  out[ch] = art;
}
fs.writeFileSync('/tmp/font-art.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
