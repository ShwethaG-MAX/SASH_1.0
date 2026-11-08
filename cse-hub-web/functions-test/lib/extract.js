'use strict';
/* Text extraction from an uploaded paper. Dependencies are loaded lazily so the pure logic can be unit-tested without them. */

/* pdf-parse's default page renderer drops each line's horizontal position, so code loses its indentation.
   This one rebuilds the lines (grouped by baseline) and turns each line's x-offset into leading spaces, measured in
   "characters" of the page's typical glyph width. Pure function over pdf.js text items so it can be unit-tested. */
function linesFromItems(items) {
  const it = (items || []).filter((i) => i && typeof i.str === 'string' && i.transform);
  if (!it.length) return '';
  const widths = it.filter((i) => i.str.trim().length >= 3 && i.width > 0).map((i) => i.width / i.str.length).sort((a, b) => a - b);
  const cw = widths.length ? widths[Math.floor(widths.length / 2)] : 5;
  const rows = [];
  for (const i of it) {
    const y = i.transform[5], x = i.transform[4];
    const tol = Math.max(2, (Math.abs(i.transform[3]) || 10) * 0.35);
    let row = rows.find((r) => Math.abs(r.y - y) <= tol);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, w: i.width || 0, s: i.str });
  }
  rows.sort((a, b) => b.y - a.y);                                   // top of the page first
  const left = Math.min(...rows.map((r) => Math.min(...r.parts.map((p) => p.x))));
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let out = '', end = null;
    for (const p of r.parts) {
      if (end === null) out = ' '.repeat(Math.max(0, Math.round((p.x - left) / cw)));
      else { const gap = Math.round((p.x - end) / cw); out += gap > 0 ? ' '.repeat(Math.min(gap, 40)) : ''; }
      out += p.s; end = p.x + p.w;
    }
    return out.replace(/\s+$/, '');
  }).join('\n');
}
function renderPage(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((tc) => linesFromItems(tc.items));
}

async function extractText(buf, kind) {
  if (kind === 'pdf') {
    const parse = require('pdf-parse/lib/pdf-parse.js');
    let text = '';
    try { text = (await parse(buf, { pagerender: renderPage })).text || ''; } catch (e) { text = ''; }
    if (text.replace(/\s/g, '').length < 40) text = (await parse(buf)).text || '';       // safety net: the stock renderer
    return text;
  }
  if (kind === 'docx') return (await require('mammoth').extractRawText({ buffer: buf })).value || '';
  throw new Error('Unsupported file type');
}
module.exports = { extractText, linesFromItems };
