"use strict";
/**
 * Text-line grouping + per-line sequence numbering (the "L<line>-<seq>"
 * shown on every shape). Shapes cluster into lines by vertical center
 * (same line when centers are within ~60% of average height); lines number
 * top-to-bottom, sequence resets per line counting left-to-right. A shape's
 * `line` field is a manual override that pins it to a line without
 * affecting the automatic assignment of others.
 *
 * Served to the browser too (see server.js /shared/lines.js) so the canvas
 * and the exporters use the SAME logic -- what you see is what exports.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LFLines = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MIN_TOL = 0.008;
  const HEIGHT_FRACTION = 0.6;

  function geometry(a) {
    if (a.type === "bbox") {
      const r = a.rect;
      return { yc: r.y + r.h / 2, h: r.h, x: r.x };
    }
    const pts = a.points || [];
    if (!pts.length) return null;
    let minX = 1, minY = 1, maxY = 0;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { yc: (minY + maxY) / 2, h: maxY - minY, x: minX };
  }

  /**
   * @param annotations [{id, type: "bbox"|"polygon", rect?, points?, line?}]
   * @returns Map id -> {line, seq, autoLine, isManual}
   */
  function computeLineNumbers(annotations) {
    const shapes = [];
    annotations.forEach((a, index) => {
      const g = geometry(a);
      if (!g) return;
      const manual = typeof a.line === "number" && isFinite(a.line) && a.line >= 1 ? Math.floor(a.line) : null;
      shapes.push({ id: a.id, yc: g.yc, h: g.h, x: g.x, index, manual });
    });
    const result = new Map();
    if (!shapes.length) return result;

    // Cluster all shapes by vertical center (overrides ignored -> stable auto).
    const byY = shapes.slice().sort((a, b) => a.yc - b.yc);
    const clusters = [];
    for (const s of byY) {
      const last = clusters[clusters.length - 1];
      if (last) {
        const mean = last.sumC / last.n;
        const avgH = (last.sumH / last.n + s.h) / 2;
        if (Math.abs(s.yc - mean) <= Math.max(avgH * HEIGHT_FRACTION, MIN_TOL)) {
          last.sumC += s.yc; last.sumH += s.h; last.n++; last.ids.push(s.id);
          continue;
        }
      }
      clusters.push({ sumC: s.yc, sumH: s.h, n: 1, ids: [s.id] });
    }
    const autoById = new Map();
    clusters.forEach((c, i) => c.ids.forEach((id) => autoById.set(id, i + 1)));

    // Effective line = manual ?? auto; sequence = left-to-right within line.
    const byLine = new Map();
    for (const s of shapes) {
      const line = s.manual != null ? s.manual : autoById.get(s.id);
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(s);
    }
    for (const [line, bucket] of byLine) {
      bucket.sort((a, b) => a.x - b.x || a.yc - b.yc || a.index - b.index);
      bucket.forEach((s, i) => {
        result.set(s.id, { line, seq: i + 1, autoLine: autoById.get(s.id), isManual: s.manual != null });
      });
    }
    return result;
  }

  return { computeLineNumbers };
});
