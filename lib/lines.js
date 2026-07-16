"use strict";
/**
 * Text-line grouping + per-line sequence numbering (the "L<line>-<seq>"
 * shown on every shape). Shapes cluster into lines by vertical center
 * (same line when centers are within ~60% of average height); lines number
 * top-to-bottom, sequence resets per line counting left-to-right. A shape's
 * `line` field is a manual override that pins it to a line without
 * affecting the automatic assignment of others.
 *
 * Line-annotation regions (freeform "lasso" polygons, drawn to fix line
 * numbers on skewed pages where the automatic vertical-clustering above
 * breaks down) are a second, higher-priority override source: any shape
 * whose area is more than 50% covered by a region takes that region's line
 * number, overwriting BOTH the automatic line and the shape's own manual
 * override. Regions are persistent, re-editable objects
 * (id/points/line) stored alongside -- but separate from -- annotations;
 * see areaFractionInside()/computeLineNumbers() below.
 *
 * A region doesn't just relabel its own shapes -- it acts as a CHECKPOINT
 * in the top-to-bottom auto sequence. Example: five automatic clusters
 * (auto lines 1-5) exist; a region captures cluster 1's shapes and is set
 * to line 17. Cluster 2's shapes (nothing to do with the region) don't stay
 * "2" -- they cascade to 18, cluster 3 to 19, and so on, exactly as if line
 * 1 had really been renumbered to 17 and everything after it shifted to
 * match. Shapes with their own plain per-shape manual override (the
 * original, simpler override -- see the `line` field above) are NOT swept
 * along by this cascade; only genuinely-still-automatic shapes are. See the
 * cascade-mapping step inside computeLineNumbers() for exactly how.
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
  // Sample resolution for area-overlap testing (areaFractionInside). 8x8 =
  // up to 64 samples per shape-vs-region pair -- plenty to resolve a >50%
  // threshold decision reliably (a wrong call needs the true fraction within
  // a percent or two of exactly 0.5, which 64 samples resolves fine) without
  // this becoming expensive when it runs on every canvas redraw.
  const OVERLAP_GRID = 8;

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

  /** Ray-casting point-in-polygon test (even-odd rule). Works for convex,
   *  concave, and even mildly self-intersecting polygons -- important since
   *  a hand-drawn freeform region is not guaranteed to be either convex or
   *  perfectly simple. */
  function pointInPolygon(pt, vs) {
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      const xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y;
      if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function shapePolygon(a) {
    if (a.type === "bbox") {
      const r = a.rect;
      return [
        { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
      ];
    }
    return a.points || [];
  }

  function bboxOf(points) {
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  /**
   * Fraction (0..1) of shape `a`'s own area that falls inside `regionPoints`.
   * Exact polygon-clipping (e.g. Sutherland-Hodgman) would need the region to
   * be convex, which a freehand mouse-drawn loop is not guaranteed to be, and
   * a general clipper robust to self-intersection is a lot more machinery for
   * a threshold decision that only needs to land on the right side of 50%.
   * Grid-sampling degrades gracefully for any polygon shape (convex, concave,
   * self-intersecting) and is more than accurate enough here.
   */
  function areaFractionInside(a, regionPoints) {
    if (!regionPoints || regionPoints.length < 3) return 0;
    const poly = shapePolygon(a);
    if (!poly || poly.length < 3) return 0;
    const bb = bboxOf(poly);
    let total = 0, inside = 0;
    for (let i = 0; i < OVERLAP_GRID; i++) {
      for (let j = 0; j < OVERLAP_GRID; j++) {
        const px = bb.minX + (bb.maxX - bb.minX) * ((i + 0.5) / OVERLAP_GRID);
        const py = bb.minY + (bb.maxY - bb.minY) * ((j + 0.5) / OVERLAP_GRID);
        if (!pointInPolygon({ x: px, y: py }, poly)) continue; // only count samples actually inside the shape itself
        total++;
        if (pointInPolygon({ x: px, y: py }, regionPoints)) inside++;
      }
    }
    return total ? inside / total : 0;
  }

  /**
   * @param annotations [{id, type: "bbox"|"polygon", rect?, points?, line?}]
   * @param lineRegions [{id, points: [{x,y}...], line}] -- optional
   * @returns Map id -> {line, seq, autoLine, isManual, isRegion, regionId}
   */
  function computeLineNumbers(annotations, lineRegions) {
    const regions = (lineRegions || []).filter((r) => r.points && r.points.length >= 3);
    // AABB per region up front -- a cheap reject before the (still cheap,
    // but not free) per-shape grid sampling below, since most shape/region
    // pairs on a real page won't be anywhere near each other.
    const regionBB = regions.map((r) => ({ region: r, bb: bboxOf(r.points) }));

    const shapes = [];
    annotations.forEach((a, index) => {
      const g = geometry(a);
      if (!g) return;
      const manual = typeof a.line === "number" && isFinite(a.line) && a.line >= 1 ? Math.floor(a.line) : null;

      // Region coverage takes priority over both auto and manual -- later
      // regions in the array win ties (matches "most recently drawn/edited"
      // for the common case where regions don't actually overlap each other).
      let regionLine = null, regionId = null;
      if (regionBB.length) {
        const poly = shapePolygon(a);
        const sbb = poly.length >= 3 ? bboxOf(poly) : null;
        if (sbb) {
          for (const { region, bb } of regionBB) {
            if (sbb.maxX < bb.minX || sbb.minX > bb.maxX || sbb.maxY < bb.minY || sbb.minY > bb.maxY) continue;
            if (areaFractionInside(a, region.points) > 0.5) { regionLine = region.line; regionId = region.id; }
          }
        }
      }

      shapes.push({ id: a.id, yc: g.yc, h: g.h, x: g.x, index, manual, regionLine, regionId });
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

    // A region acts as a checkpoint in the top-to-bottom auto sequence, not
    // just a relabel of its own shapes: everything auto-numbered AFTER the
    // region's anchor cluster shifts to keep counting up from the region's
    // assigned number. "Anchor" = the earliest (smallest) pure auto-cluster
    // index the region actually captures a shape from -- if a region spans
    // several clusters, only the first one anchors the cascade.
    const memberAutoLinesByRegionId = new Map();
    for (const s of shapes) {
      if (s.regionId == null) continue;
      const pureAuto = autoById.get(s.id);
      if (pureAuto == null) continue;
      if (!memberAutoLinesByRegionId.has(s.regionId)) memberAutoLinesByRegionId.set(s.regionId, []);
      memberAutoLinesByRegionId.get(s.regionId).push(pureAuto);
    }
    const regionByAnchor = new Map();
    for (const region of regions) {
      const memberAutoLines = memberAutoLinesByRegionId.get(region.id);
      if (!memberAutoLines || !memberAutoLines.length) continue; // captures nothing right now -> no cascade effect
      const anchor = Math.min(...memberAutoLines);
      regionByAnchor.set(anchor, region); // later region in the array wins ties, matching direct-capture tie-breaking above
    }

    // Walk the pure auto-cluster indices in order, building
    // pureAutoLine -> cascaded-line. Before the first anchor, numbers pass
    // through unchanged; at an anchor, the cascade jumps to the region's
    // assigned line; after an anchor, numbers just keep counting up from
    // there regardless of what the original pure index was.
    const cascadeMap = new Map();
    let cursor = null;
    for (let i = 1; i <= clusters.length; i++) {
      const anchorRegion = regionByAnchor.get(i);
      const finalLine = anchorRegion ? anchorRegion.line : cursor !== null ? cursor : i;
      cascadeMap.set(i, finalLine);
      cursor = finalLine + 1;
    }

    // Effective line = region ?? manual ?? cascaded-auto; sequence =
    // left-to-right within line. Manual per-shape overrides are deliberately
    // NOT swept along by the cascade -- they stay pinned to the exact line
    // number the user typed, same as before regions existed.
    const byLine = new Map();
    for (const s of shapes) {
      const cascadedAuto = cascadeMap.get(autoById.get(s.id));
      const line = s.regionLine != null ? s.regionLine : (s.manual != null ? s.manual : cascadedAuto);
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(s);
    }
    for (const [line, bucket] of byLine) {
      bucket.sort((a, b) => a.x - b.x || a.yc - b.yc || a.index - b.index);
      bucket.forEach((s, i) => {
        result.set(s.id, {
          line, seq: i + 1, autoLine: cascadeMap.get(autoById.get(s.id)),
          isManual: s.manual != null, isRegion: s.regionLine != null, regionId: s.regionId,
        });
      });
    }
    return result;
  }

  return { computeLineNumbers, pointInPolygon, areaFractionInside };
});
