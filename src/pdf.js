"use strict";

/**
 * Minimal, dependency-free PDF writer — enough to produce a clean, branded, filable
 * one-or-two-page report. Not a general PDF engine: text (Helvetica), rules, filled
 * rectangles and colour. That is exactly what an audit/finance artefact needs, and it
 * keeps us at ZERO new production dependencies.
 *
 * Produces a valid PDF 1.4: header, object table, xref and trailer, with byte-accurate
 * offsets (a wrong xref makes the file unopenable, so offsets are computed on the real
 * serialized buffer, not estimated).
 */

const A4 = { w: 595.28, h: 841.89 };            // points
const FONTS = { regular: "F1", bold: "F2" };

// PDF strings escape backslash and parens; non-Latin-1 is dropped rather than corrupting
// the stream (we substitute a hyphen so text never silently disappears mid-sentence).
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/[‐-―]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/→/g, "->").replace(/×/g, "x").replace(/≥/g, ">=").replace(/≤/g, "<=")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Helvetica advance widths (1000-unit em) for the ASCII range — enough to wrap text
// correctly. Approximated per character class; good enough for layout, never for kerning.
const W_UPPER = 667, W_LOWER = 528, W_DIGIT = 556, W_NARROW = 278, W_WIDE = 778;
function charWidth(ch) {
  if (/[A-Z]/.test(ch)) return /[IJ]/.test(ch) ? 278 : /[MW]/.test(ch) ? W_WIDE : W_UPPER;
  if (/[a-z]/.test(ch)) return /[ijlt]/.test(ch) ? 250 : /[mw]/.test(ch) ? W_WIDE : W_LOWER;
  if (/[0-9]/.test(ch)) return W_DIGIT;
  if (/[ .,:;'`!|]/.test(ch)) return W_NARROW;
  return 500;
}
const textWidth = (s, size) => [...String(s)].reduce((w, c) => w + charWidth(c), 0) / 1000 * size;

// Greedy word wrap to a max width in points.
function wrap(text, size, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  for (const word of words) {
    const trial = cur ? cur + " " + word : word;
    if (textWidth(trial, size) > maxW && cur) { lines.push(cur); cur = word; }
    else cur = trial;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/**
 * A tiny page builder. Callers append content in document order; we track the cursor and
 * start new pages automatically so a long methodology section can't overflow off-page.
 */
function createDoc({ margin = 48 } = {}) {
  const pages = [];            // each: array of content-stream fragments
  let cur = null, y = 0;
  const maxW = A4.w - margin * 2;

  function newPage() { cur = []; pages.push(cur); y = A4.h - margin; }
  function need(h) { if (!cur || y - h < margin) newPage(); }
  newPage();

  const rgb = (hex) => {
    const n = parseInt(String(hex).replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => v.toFixed(3)).join(" ");
  };

  const api = {
    get y() { return y; },
    get width() { return maxW; },
    text(str, { size = 10, font = FONTS.regular, color = "#111111", x = margin, gap = 4 } = {}) {
      const lines = wrap(str, size, maxW - (x - margin));
      for (const ln of lines) {
        need(size + gap);
        cur.push(`BT /${font} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${x.toFixed(2)} ${(y - size).toFixed(2)} Tm (${esc(ln)}) Tj ET`);
        y -= size + gap;
      }
      return api;
    },
    // right-aligned value on the same baseline as a left label — for figure tables
    row(label, value, { size = 10, bold = false, color = "#111111", valueColor } = {}) {
      need(size + 6);
      const yy = (y - size).toFixed(2);
      cur.push(`BT /${FONTS.regular} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${margin.toFixed(2)} ${yy} Tm (${esc(label)}) Tj ET`);
      const vFont = bold ? FONTS.bold : FONTS.regular;
      const vx = A4.w - margin - textWidth(value, size);
      cur.push(`BT /${vFont} ${size} Tf ${rgb(valueColor || color)} rg 1 0 0 1 ${vx.toFixed(2)} ${yy} Tm (${esc(value)}) Tj ET`);
      y -= size + 6;
      return api;
    },
    rule({ color = "#DDDDDD", gap = 10 } = {}) {
      need(gap + 2);
      y -= gap / 2;
      cur.push(`${rgb(color)} RG 0.7 w ${margin} ${y.toFixed(2)} m ${(A4.w - margin).toFixed(2)} ${y.toFixed(2)} l S`);
      y -= gap / 2;
      return api;
    },
    band(h, color) {
      need(h + 6);
      cur.push(`${rgb(color)} rg ${margin} ${(y - h).toFixed(2)} ${maxW.toFixed(2)} ${h} re f`);
      return api;
    },
    space(h) { need(h); y -= h; return api; },
    _pages: () => pages
  };
  return api;
}

// Serialize to a real PDF buffer with a correct xref table.
function render(doc) {
  const pages = doc._pages();
  const objects = [];                       // 1-indexed content, filled below
  const add = (body) => { objects.push(body); return objects.length; };

  const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pagesId = objects.length + 1 + pages.length * 2;   // reserved below

  const pageIds = [];
  for (const frags of pages) {
    const stream = frags.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] ` +
      `/Resources << /Font << /${FONTS.regular} ${fontRegular} 0 R /${FONTS.bold} ${fontBold} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`
    ));
  }
  const realPagesId = add(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((i) => i + " 0 R").join(" ")}] >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  // page objects referenced `pagesId` before it existed; patch to the real id
  for (let i = 0; i < objects.length; i++) objects[i] = objects[i].replace(`/Parent ${pagesId} 0 R`, `/Parent ${realPagesId} 0 R`);

  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

module.exports = { createDoc, render, A4, FONTS, _wrap: wrap, _textWidth: textWidth };
