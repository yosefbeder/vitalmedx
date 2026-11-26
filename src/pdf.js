'use strict';
// Minimal Arabic-capable PDF writer (no dependencies): TrueType subset + Arabic shaping + simple bidi.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------------- TrueType ---------------- */
const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
let FONT = null;
function loadFont() {
  if (FONT) return FONT;
  const b = fs.readFileSync(FONT_PATH), n = b.readUInt16BE(4), tables = {};
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; tables[b.toString('latin1', o, o + 4)] = { off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) }; }
  const head = tables.head.off, upm = b.readUInt16BE(head + 18), locFmt = b.readInt16BE(head + 50);
  const numGlyphs = b.readUInt16BE(tables.maxp.off + 4), nhm = b.readUInt16BE(tables.hhea.off + 34);
  const ascent = b.readInt16BE(tables.hhea.off + 4), descent = b.readInt16BE(tables.hhea.off + 6);
  const adv = new Uint16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) adv[g] = b.readUInt16BE(tables.hmtx.off + 4 * Math.min(g, nhm - 1));
  const loca = g => (locFmt ? b.readUInt32BE(tables.loca.off + 4 * g) : b.readUInt16BE(tables.loca.off + 2 * g) * 2);
  // cmap: prefer format 12, else format 4
  const cmap = new Map(), c0 = tables.cmap.off, nsub = b.readUInt16BE(c0 + 2); let f4 = null, f12 = null;
  for (let i = 0; i < nsub; i++) { const pid = b.readUInt16BE(c0 + 4 + i * 8), eid = b.readUInt16BE(c0 + 6 + i * 8), off = c0 + b.readUInt32BE(c0 + 8 + i * 8), fmt = b.readUInt16BE(off);
    if (pid === 3 && eid === 10 && fmt === 12) f12 = off; if (pid === 3 && eid === 1 && fmt === 4) f4 = off; if (pid === 0 && fmt === 4 && !f4) f4 = off; }
  if (f12) { const ng = b.readUInt32BE(f12 + 12); for (let i = 0; i < ng; i++) { const o = f12 + 16 + i * 12, s = b.readUInt32BE(o), e = b.readUInt32BE(o + 4), g = b.readUInt32BE(o + 8); for (let c = s; c <= e && c < 0x30000; c++) cmap.set(c, g + c - s); } }
  else if (f4) { const segX2 = b.readUInt16BE(f4 + 6), ends = f4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) { const e = b.readUInt16BE(ends + 2 * i), s = b.readUInt16BE(starts + 2 * i), d = b.readInt16BE(deltas + 2 * i), ro = b.readUInt16BE(ranges + 2 * i);
      for (let c = s; c <= e && c !== 0xffff; c++) { let g; if (!ro) g = (c + d) & 0xffff; else { const go = ranges + 2 * i + ro + 2 * (c - s); g = b.readUInt16BE(go); if (g) g = (g + d) & 0xffff; } if (g) cmap.set(c, g); } } }
  FONT = { b, tables, upm, adv, loca, numGlyphs, cmap, ascent, descent };
  return FONT;
}
function subsetFont(used) {
  const F = loadFont(), b = F.b, gl = F.tables.glyf.off, keep = new Set([0, ...used]);
  // pull in composite components
  const stack = [...keep];
  while (stack.length) { const g = stack.pop(), s = F.loca(g), e = F.loca(g + 1); if (e <= s || b.readInt16BE(gl + s) >= 0) continue;
    let o = gl + s + 10, flags; do { flags = b.readUInt16BE(o); const c = b.readUInt16BE(o + 2); if (!keep.has(c)) { keep.add(c); stack.push(c); } o += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0); } while (flags & 0x20); }
  const parts = [], loca = Buffer.alloc(4 * (F.numGlyphs + 1)); let pos = 0;
  for (let g = 0; g < F.numGlyphs; g++) { loca.writeUInt32BE(pos, 4 * g); if (keep.has(g)) { const s = F.loca(g), e = F.loca(g + 1); if (e > s) { let chunk = b.subarray(gl + s, gl + e); if (chunk.length % 4) chunk = Buffer.concat([chunk, Buffer.alloc(4 - (chunk.length % 4))]); parts.push(chunk); pos += chunk.length; } } }
  loca.writeUInt32BE(pos, 4 * F.numGlyphs);
  const head = Buffer.from(b.subarray(F.tables.head.off, F.tables.head.off + F.tables.head.len)); head.writeInt16BE(1, 50); head.writeUInt32BE(0, 8);
  const out = { head, loca, glyf: Buffer.concat(parts) };
  for (const t of ['cvt ', 'fpgm', 'hhea', 'hmtx', 'maxp', 'prep']) if (F.tables[t]) out[t] = b.subarray(F.tables[t].off, F.tables[t].off + F.tables[t].len);
  const names = Object.keys(out).sort(), n = names.length, dir = Buffer.alloc(12 + 16 * n);
  dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(n, 4); let sr = 1, es = 0; while (sr * 2 <= n) { sr *= 2; es++; } dir.writeUInt16BE(sr * 16, 6); dir.writeUInt16BE(es, 8); dir.writeUInt16BE(n * 16 - sr * 16, 10);
  let off = dir.length; const bodies = [];
  names.forEach((nm, i) => { let d = out[nm]; const len = d.length; if (d.length % 4) d = Buffer.concat([d, Buffer.alloc(4 - (d.length % 4))]);
    let sum = 0; for (let j = 0; j < d.length; j += 4) sum = (sum + d.readUInt32BE(j)) >>> 0;
    dir.write(nm, 12 + 16 * i, 'latin1'); dir.writeUInt32BE(sum, 16 + 16 * i); dir.writeUInt32BE(off, 20 + 16 * i); dir.writeUInt32BE(len, 24 + 16 * i); bodies.push(d); off += d.length; });
  return Buffer.concat([dir, ...bodies]);
}

/* ---------------- Arabic shaping ---------------- */
// [isolated, final, initial, medial] (R-joining letters only have the first two)
const FORMS = {
  0x0621: [0xFE80], 0x0622: [0xFE81, 0xFE82], 0x0623: [0xFE83, 0xFE84], 0x0624: [0xFE85, 0xFE86], 0x0625: [0xFE87, 0xFE88], 0x0626: [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C],
  0x0627: [0xFE8D, 0xFE8E], 0x0628: [0xFE8F, 0xFE90, 0xFE91, 0xFE92], 0x0629: [0xFE93, 0xFE94], 0x062A: [0xFE95, 0xFE96, 0xFE97, 0xFE98], 0x062B: [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C],
  0x062C: [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0], 0x062D: [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4], 0x062E: [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8], 0x062F: [0xFEA9, 0xFEAA], 0x0630: [0xFEAB, 0xFEAC],
  0x0631: [0xFEAD, 0xFEAE], 0x0632: [0xFEAF, 0xFEB0], 0x0633: [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4], 0x0634: [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8], 0x0635: [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC],
  0x0636: [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0], 0x0637: [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4], 0x0638: [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8], 0x0639: [0xFEC9, 0xFECA, 0xFECB, 0xFECC],
  0x063A: [0xFECD, 0xFECE, 0xFECF, 0xFED0], 0x0641: [0xFED1, 0xFED2, 0xFED3, 0xFED4], 0x0642: [0xFED5, 0xFED6, 0xFED7, 0xFED8], 0x0643: [0xFED9, 0xFEDA, 0xFEDB, 0xFEDC],
  0x0644: [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0], 0x0645: [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4], 0x0646: [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8], 0x0647: [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC],
  0x0648: [0xFEED, 0xFEEE], 0x0649: [0xFEEF, 0xFEF0], 0x064A: [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4],
  0x067E: [0xFB56, 0xFB57, 0xFB58, 0xFB59], 0x0686: [0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D], 0x0698: [0xFB8A, 0xFB8B], 0x06A9: [0xFB8E, 0xFB8F, 0xFB90, 0xFB91],
  0x06AF: [0xFB92, 0xFB93, 0xFB94, 0xFB95], 0x06CC: [0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF],
};
const LAMALEF = { 0x0622: [0xFEF5, 0xFEF6], 0x0623: [0xFEF7, 0xFEF8], 0x0625: [0xFEF9, 0xFEFA], 0x0627: [0xFEFB, 0xFEFC] };
const isMark = c => (c >= 0x064B && c <= 0x065F) || c === 0x0670;
const joinsNext = c => c === 0x0640 || (FORMS[c] && FORMS[c].length === 4); // dual-joining
const joins = c => c === 0x0640 || !!FORMS[c];
const isArabic = c => (c >= 0x0600 && c <= 0x06FF) || (c >= 0xFB50 && c <= 0xFEFF);
function shape(text) {
  const cs = [...text].map(ch => ch.codePointAt(0)).filter(c => !isMark(c)), out = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], prev = i > 0 ? cs[i - 1] : 0, next = i + 1 < cs.length ? cs[i + 1] : 0;
    const pj = joinsNext(prev);
    if (c === 0x0644 && LAMALEF[next]) { out.push(LAMALEF[next][pj ? 1 : 0]); i++; continue; }
    const f = FORMS[c]; if (!f) { out.push(c); continue; }
    const nj = f.length === 4 && joins(next);
    out.push(f.length === 1 ? f[0] : pj && nj ? f[3] : pj ? f[1] : nj ? f[2] : f[0]);
  }
  return out;
}
// very small bidi for an RTL paragraph: runs of RTL / LTR, neutrals resolved by neighbours
const MIRROR = { 0x28: 0x29, 0x29: 0x28, 0x5B: 0x5D, 0x5D: 0x5B, 0x3C: 0x3E, 0x3E: 0x3C, 0x7B: 0x7D, 0x7D: 0x7B };
function visual(text, rtl = true) {
  const cs = shape(String(text ?? ''));
  const cls = cs.map(c => (isArabic(c) ? 'R' : /[\p{L}\p{N}]/u.test(String.fromCodePoint(c)) ? 'L' : 'N'));
  // numbers glue: "1,250.5" stays L
  for (let i = 1; i < cs.length - 1; i++) if (cls[i] === 'N' && /[.,:\/\-]/.test(String.fromCodePoint(cs[i])) && cls[i - 1] === 'L' && cls[i + 1] === 'L') cls[i] = 'L';
  const base = rtl ? 'R' : 'L';
  for (let i = 0; i < cs.length; i++) if (cls[i] === 'N') { let a = i - 1; while (a >= 0 && cls[a] === 'N') a--; let z = i + 1; while (z < cs.length && cls[z] === 'N') z++; const l = a >= 0 ? cls[a] : base, r = z < cs.length ? cls[z] : base; cls[i] = l === r ? l : base; }
  const runs = []; for (let i = 0; i < cs.length; i++) { if (!runs.length || runs.at(-1).d !== cls[i]) runs.push({ d: cls[i], c: [] }); runs.at(-1).c.push(cs[i]); }
  for (const r of runs) if (r.d === 'R') { r.c.reverse(); r.c = r.c.map(c => MIRROR[c] || c); }
  if (rtl) runs.reverse();
  return runs.flatMap(r => r.c);
}

/* ---------------- document ---------------- */
class Doc {
  constructor() { this.F = loadFont(); this.pages = []; this.used = new Set(); this.W = 595.28; this.Hh = 841.89; this.newPage(); }
  newPage() { this.cur = []; this.pages.push(this.cur); }
  gids(cps) { return cps.map(c => { const g = this.F.cmap.get(c) || this.F.cmap.get(0x3F) || 0; this.used.add(g); return g; }); }
  width(text, size, rtl = true) { return this.gids(visual(text, rtl)).reduce((s, g) => s + this.F.adv[g], 0) * size / this.F.upm; }
  fit(text, size, max, rtl = true) { text = String(text ?? ''); if (this.width(text, size, rtl) <= max) return text; let t = text; while (t.length > 1 && this.width(t + '…', size, rtl) > max) t = t.slice(0, -1); return t + '…'; }
  // align: 'r' (x = right edge), 'l' (x = left edge), 'c'
  text(text, x, y, { size = 10, align = 'r', bold = false, color = [0.1, 0.12, 0.16], rtl = true } = {}) {
    const g = this.gids(visual(text, rtl)), w = g.reduce((s, k) => s + this.F.adv[k], 0) * size / this.F.upm;
    const x0 = align === 'r' ? x - w : align === 'c' ? x - w / 2 : x;
    const hex = g.map(k => k.toString(16).padStart(4, '0')).join('');
    this.cur.push(`BT ${color.join(' ')} rg ${bold ? `2 Tr ${(size / 28).toFixed(2)} w ${color.join(' ')} RG` : '0 Tr'} /F1 ${size} Tf ${x0.toFixed(2)} ${y.toFixed(2)} Td <${hex}> Tj ET`);
    return w;
  }
  rect(x, y, w, h, fill, stroke) { this.cur.push(`${fill ? fill.join(' ') + ' rg ' : ''}${stroke ? stroke.join(' ') + ' RG 0.6 w ' : ''}${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`); }
  line(x1, y1, x2, y2, c = [0.85, 0.87, 0.9], w = 0.6) { this.cur.push(`${c.join(' ')} RG ${w} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); }
  build() {
    const font = subsetFont(this.used), ff = zlib.deflateSync(font);
    const objs = [], add = s => { objs.push(s); return objs.length; };
    const catalog = add(null), pagesId = add(null);
    const fileId = add(Buffer.concat([Buffer.from(`<< /Length ${ff.length} /Length1 ${font.length} /Filter /FlateDecode >>\nstream\n`), ff, Buffer.from('\nendstream')]));
    const s = 1000 / this.F.upm, fontBBox = `[-1021 -463 1793 1232]`;
    const desc = add(`<< /Type /FontDescriptor /FontName /VMXSans /Flags 32 /FontBBox ${fontBBox} /ItalicAngle 0 /Ascent ${Math.round(this.F.ascent * s)} /Descent ${Math.round(this.F.descent * s)} /CapHeight 729 /StemV 80 /FontFile2 ${fileId} 0 R >>`);
    const ws = [...this.used].sort((a, b) => a - b).map(g => `${g} [${Math.round(this.F.adv[g] * s)}]`).join(' ');
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /VMXSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /W [${ws}] /DW 600 /CIDToGIDMap /Identity >>`);
    const f1 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /VMXSans /Encoding /Identity-H /DescendantFonts [${cid} 0 R] >>`);
    const kids = [];
    for (const p of this.pages) { const content = zlib.deflateSync(Buffer.from(p.join('\n'), 'latin1'));
      const c = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream')]));
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.Hh}] /Resources << /Font << /F1 ${f1} 0 R >> >> /Contents ${c} 0 R >>`)); }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; let off = chunks[0].length; const xref = [];
    objs.forEach((o, i) => { const body = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n')]); xref.push(off); chunks.push(body); off += body.length; });
    chunks.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map(x => String(x).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${off}\n%%EOF\n`));
    return Buffer.concat(chunks);
  }
}

/* ---------------- monthly statement ---------------- */
const TYPES = { theory: 'نظري', practical: 'عملي', revision: 'مراجعة', repeat: 'معادة' };
const ROLE = { supervisor: 'مشرف', coordinator: 'مسؤول دفعة', cs: 'خدمة عملاء', doctor: 'دكتور' };
const PAY = { vodafone: 'فودافون كاش', instapay: 'إنستاباي', bank: 'حساب بنكي' };
const money = n => (Math.round((n || 0) * 100) / 100).toLocaleString('en-US');
const ACC = [0.06, 0.45, 0.42], INK = [0.1, 0.12, 0.16], MUT = [0.42, 0.45, 0.5], RED = [0.75, 0.16, 0.16], BAND = [0.94, 0.97, 0.96];
function statementPdf(d) {
  const doc = new Doc(), M = 40, R = doc.W - M, L0 = M, fmtD = t => (t ? new Intl.DateTimeFormat('en-GB', { timeZone: d.tz || 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(t) : '—');
  let y = doc.Hh - M;
  const header = () => {
    doc.rect(0, doc.Hh - 6, doc.W, 6, ACC);
    doc.text(d.brand || 'VitalMedX', R, y - 14, { size: 20, bold: true, color: ACC, rtl: false });
    doc.text('كشف حساب', L0, y - 14, { size: 16, bold: true, align: 'l' });
    y -= 30; doc.line(L0, y, R, y, [0.8, 0.83, 0.86], 0.8); y -= 18;
  };
  const ensure = h => { if (y - h < M + 30) { doc.newPage(); y = doc.Hh - M; header(); return true; } return false; };
  header();
  // info block
  const info = [['الاسم', d.user.name], ['الوظيفة', ROLE[d.user.role] || d.user.role], ['الفترة', d.period], ['نوع التقفيل', d.kind === 'early' ? 'معجّل' : 'شهري'], ['تاريخ التقفيل', fmtD(d.created_at)], ['الحالة', d.paid_at ? `اتدفع ${fmtD(d.paid_at)}` : 'لسه ماتدفعش']];
  doc.rect(L0, y - 62, R - L0, 70, BAND);
  info.forEach(([k, v], i) => { const col = i % 2, row = Math.floor(i / 2), x = col ? (L0 + R) / 2 - 10 : R - 12, yy = y - 8 - row * 21;
    const w = doc.text(k + ':', x, yy, { size: 9.5, color: MUT }); doc.text(v, x - w - 6, yy, { size: 10.5, bold: true }); });
  y -= 84;
  // lectures table
  if (d.lectures.length) {
    doc.text(`المحاضرات (${d.lectures.length})`, R, y, { size: 12, bold: true }); y -= 16;
    const cols = [[R, 28, '#'], [R - 28, 250, 'المحاضرة'], [R - 278, 70, 'النوع'], [R - 348, 85, 'التسليم'], [R - 433, R - 433 - L0, 'السعر']];
    const head = () => { doc.rect(L0, y - 6, R - L0, 20, ACC); cols.forEach(([x, , t], i) => (i === 4 ? doc.text(t, L0 + 6, y, { size: 9.5, bold: true, color: [1, 1, 1], align: 'l' }) : doc.text(t, x - 6, y, { size: 9.5, bold: true, color: [1, 1, 1] }))); y -= 20; };
    head();
    d.lectures.forEach((l, i) => {
      if (ensure(18)) head();
      if (i % 2) doc.rect(L0, y - 6, R - L0, 18, [0.975, 0.98, 0.985]);
      doc.text(String(i + 1), cols[0][0] - 6, y, { size: 9, color: MUT, rtl: false });
      const isLatin = !/[؀-ۿ]/.test(l.name);
      if (isLatin) doc.text(doc.fit(l.name, 9.5, cols[1][1] - 10, false), cols[1][0] - cols[1][1] + 4, y, { size: 9.5, align: 'l', rtl: false });
      else doc.text(doc.fit(l.name, 9.5, cols[1][1] - 10), cols[1][0] - 6, y, { size: 9.5 });
      doc.text(TYPES[l.type] || l.type, cols[2][0] - 6, y, { size: 9.5 });
      doc.text(fmtD(l.delivered_at), cols[3][0] - 6, y, { size: 9, color: MUT, rtl: false });
      doc.text(money(l.price), L0 + 6, y, { size: 9.5, align: 'l', rtl: false });
      y -= 18;
    });
    y -= 8;
  }
  // summary
  const lines = [];
  for (const [t, x] of Object.entries(d.byType || {})) lines.push([`${TYPES[t] || t}: ${x.n} محاضرة`, money(x.sum)]);
  if (d.salary) lines.push(['المرتب', money(d.salary)]);
  for (const e of d.extras || []) lines.push([`مستحق إضافي${e.note ? ` (${e.note})` : ''}`, money(e.amount)]);
  for (const b of d.bonuses || []) lines.push([`بونص${b.note ? ` (${b.note})` : ''}`, '+' + money(b.amount)]);
  for (const p of d.penalties || []) lines.push([`خصم: ${p.reason}`, '-' + money(p.amount), RED]);
  ensure(40 + lines.length * 18 + 50);
  doc.text('الملخص', R, y, { size: 12, bold: true }); y -= 8;
  for (const [k, v, c] of lines) { ensure(18); y -= 16; doc.text(doc.fit(k, 10, R - L0 - 120), R - 6, y, { size: 10, color: c || INK }); doc.text(v, L0 + 6, y, { size: 10, align: 'l', color: c || INK, rtl: false }); doc.line(L0, y - 5, R, y - 5); }
  y -= 14;
  const sumRow = (k, v, c) => { y -= 16; doc.text(k, R - 6, y, { size: 10, color: MUT }); doc.text(v, L0 + 6, y, { size: 10, align: 'l', color: c || INK, rtl: false }); };
  sumRow('الإجمالي', money(d.gross)); if (d.bonus) sumRow('بونص', '+' + money(d.bonus)); if (d.deductions) sumRow('الخصومات', '-' + money(d.deductions), RED);
  y -= 30; ensure(40); doc.rect(L0, y - 14, R - L0, 30, ACC);
  doc.text('الصافي المستحق', R - 12, y - 4, { size: 13, bold: true, color: [1, 1, 1] }); doc.text(money(d.net), L0 + 12, y - 4, { size: 15, bold: true, color: [1, 1, 1], align: 'l', rtl: false });
  y -= 44;
  if (d.payout) { ensure(40); const p = d.payout; doc.text('طريقة التحويل', R, y, { size: 11, bold: true }); y -= 16;
    const v = p.kind === 'bank' ? `${PAY.bank} · ${p.bank || ''} · ${p.name || ''}` : `${PAY[p.kind]} · ${p.name || ''}`; const w = doc.text(v, R - 6, y, { size: 10 });
    const num = p.kind === 'bank' ? (p.iban || p.account || '') : (p.number || ''); if (num) doc.text(num, R - 6 - w - 10, y, { size: 10, rtl: false, align: 'r' }); y -= 20; }
  // footers
  const n = doc.pages.length;
  doc.pages.forEach((p, i) => { doc.cur = p; doc.line(L0, M + 8, R, M + 8); doc.text(`مستند صادر من نظام ${d.brand || 'VitalMedX'} · ${fmtD(Date.now())}`, R, M - 6, { size: 8, color: MUT }); doc.text(`${i + 1} / ${n}`, L0, M - 6, { size: 8, color: MUT, align: 'l', rtl: false }); });
  return doc.build();
}

module.exports = { statementPdf, visual, shape, Doc };
