"use strict";
/**
 * Annotation canvas engine (vanilla JS). Features carried over from the
 * previous app: bbox + polygon drawing, select/move/resize with handles,
 * zoom (ctrl+wheel) / pan (wheel or middle-drag), Ctrl+Z undo / Ctrl+Shift+Z
 * redo with gesture coalescing, L<line>-<seq> numbering with a manual line
 * override chip, and a floating label editor with prefix autocomplete
 * (project labels + per-browser history; Enter repeats the last label).
 *
 * Usage:
 *   const canvas = new AnnotationCanvas(containerEl, {
 *     getLabels: () => [{id,name,color}],
 *     createLabel: async (name) => labelOrNull,
 *     onChange: () => {},                    // any annotation mutation
 *   });
 *   canvas.load(imageUrl, width, height, annotations);
 *   canvas.getAnnotations();  canvas.isDirty();  canvas.markSaved();
 */

const LABEL_HISTORY_KEY = "labeler_label_history";
const SUGGESTIONS_SHOWN = 8;

function loadHistory() {
  try { const v = JSON.parse(localStorage.getItem(LABEL_HISTORY_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function rememberLabel(name) {
  try {
    const lower = name.toLowerCase();
    const next = [name, ...loadHistory().filter((n) => n.toLowerCase() !== lower)].slice(0, 200);
    localStorage.setItem(LABEL_HISTORY_KEY, JSON.stringify(next));
  } catch {}
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

// ---------- unsaved-change diffing (shared by both pages via canvas.getUnsavedChanges()) ----------
// Plain-data deep clone -- annotations/regions are JSON-safe (no functions,
// dates, etc.), so this is simpler and more broadly compatible than
// structuredClone for what's really just a snapshot-for-later-comparison.
const cloneData = (v) => JSON.parse(JSON.stringify(v));

function shapeGeometryEqual(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === "bbox") {
    const r1 = a.rect, r2 = b.rect;
    return Boolean(r1 && r2 && r1.x === r2.x && r1.y === r2.y && r1.w === r2.w && r1.h === r2.h);
  }
  const p1 = a.points || [], p2 = b.points || [];
  return p1.length === p2.length && p1.every((p, i) => p.x === p2[i].x && p.y === p2[i].y);
}
/** Human-readable list of what changed between the saved and current version
 *  of the same shape (by id) -- label, manual line override, and/or its
 *  actual geometry -- for the unsaved-changes dialog. Empty-list case
 *  ("changed" fallback) guards against a diff dimension added to shapes
 *  later without a matching check being added here. */
function describeShapeDiff(prev, cur) {
  const out = [];
  if ((prev.labelId ?? null) !== (cur.labelId ?? null)) out.push("label changed");
  if ((prev.line ?? null) !== (cur.line ?? null)) out.push("line number changed");
  if (!shapeGeometryEqual(prev, cur)) out.push(prev.type === "polygon" ? "shape reshaped" : "position/size changed");
  return out.length ? out : ["changed"];
}
function regionGeometryEqual(a, b) {
  const p1 = a.points || [], p2 = b.points || [];
  return p1.length === p2.length && p1.every((p, i) => p.x === p2[i].x && p.y === p2[i].y);
}
function describeRegionDiff(prev, cur) {
  const out = [];
  if ((prev.line ?? null) !== (cur.line ?? null)) out.push(`line number changed (${prev.line} → ${cur.line})`);
  if (!regionGeometryEqual(prev, cur)) out.push("region reshaped/moved");
  return out.length ? out : ["changed"];
}

// Whether to show it is remembered per-browser (like label history) so it
// stays off/on across images and reloads instead of resetting every time.
const SHOW_LINES_KEY = "labeler_show_line_numbers";
function loadShowLineNumbers() {
  try { const v = localStorage.getItem(SHOW_LINES_KEY); return v === null ? true : v === "true"; }
  catch { return true; }
}

// Same per-browser persistence pattern for the "name this shape" floating
// editor -- some workflows want to rip through drawing boxes fast and label
// everything in a separate pass later, rather than stopping to type a name
// after every single shape.
const SHOW_LABEL_INPUT_KEY = "labeler_show_label_input";
function loadShowLabelInput() {
  try { const v = localStorage.getItem(SHOW_LABEL_INPUT_KEY); return v === null ? true : v === "true"; }
  catch { return true; }
}

// ---------- toast (shared by both the labeler workspace and admin editor) ----------
// A small stack pinned to the side of the screen. Lives here (rather than
// duplicated in app.js/admin.js) because canvas.js is the one script both
// pages already load before their own code runs.
function showToast(message, { type = "success", duration = 2200 } = {}) {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  stack.appendChild(el);
  // rAF so the initial (off-screen) state paints before we transition in
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
  const remove = () => {
    el.classList.remove("show");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // fallback if transitionend never fires
  };
  setTimeout(remove, duration);
}
window.showToast = showToast;

// ---------- export coordinate-choice dialog (shared by both pages) ----------
/** Asks which coordinate system(s) to include in a json/xml download --
 *  normalized (0..1), pixel, or both. Resolves to one of those three
 *  strings, or null if the user cancels (Esc or the Cancel button) --
 *  callers should treat null as "don't download". VOC/COCO/YOLO never call
 *  this: each has exactly one coordinate convention fixed by its own spec
 *  (VOC/COCO: always pixel; YOLO: always normalized, by definition of the
 *  format), so asking would be a no-op at best and misleading at worst. */
function askExportCoords() {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "export-coords-dialog";
    dlg.innerHTML = `
      <form method="dialog">
        <h3>Choose export coordinates</h3>
        <p class="faint">Applies to this download only.</p>
        <div class="coord-choice">
          <label><input type="radio" name="coords" value="normalized" />
            <span><strong>Normalized</strong><br><span class="faint">0–1, independent of image size</span></span></label>
          <label><input type="radio" name="coords" value="pixel" />
            <span><strong>Absolute</strong><br><span class="faint">actual x / y / width / height</span></span></label>
          <label><input type="radio" name="coords" value="both" checked />
            <span><strong>Both</strong><br><span class="faint">carries either, larger file</span></span></label>
        </div>
        <div class="row" style="justify-content:flex-end; margin-top:16px; gap:8px;">
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="submit" class="btn primary">Download</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);

    const syncActive = () => {
      dlg.querySelectorAll(".coord-choice label").forEach((l) => l.classList.toggle("active", l.querySelector("input").checked));
    };
    dlg.querySelector(".coord-choice").addEventListener("change", syncActive);
    syncActive();

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      dlg.remove();
    };
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { dlg.close(); finish(null); });
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      finish(dlg.querySelector('input[name="coords"]:checked').value);
    });
    dlg.addEventListener("cancel", () => finish(null)); // Esc key
    dlg.addEventListener("close", () => finish(null));  // any other dismissal path
    dlg.showModal();
  });
}
window.askExportCoords = askExportCoords;

// ---------- unsaved-changes warning dialog (shared by both pages) ----------
/** One row in the unsaved-changes dialog: what kind of edit, where it is
 *  (line/seq -- the same coordinates the canvas tags and the exporter both
 *  use), and what specifically changed. Still-present shapes are clickable
 *  (jump the canvas to them); deleted shapes/regions have nothing left on
 *  the canvas to jump to, so they're listed but not clickable. */
function unsavedRowHtml(item, isRegion) {
  const kindLabel = item.kind === "added" ? "Added" : item.kind === "deleted" ? "Deleted" : "Modified";
  const kindClass = item.kind === "added" ? "green" : item.kind === "deleted" ? "red" : "amber";
  const where = `Line ${item.line}${!isRegion ? `-${item.seq}` : ""}`;
  const what = isRegion
    ? "Line-annotation region"
    : `${item.type === "polygon" ? "Polygon" : "Box"}${item.labelName ? ` "${item.labelName}"` : " (unlabeled)"}`;
  const detail = item.changes ? ` — ${item.changes.join(", ")}` : "";
  const jumpable = !isRegion && item.kind !== "deleted";
  return `<li class="unsaved-row${jumpable ? " jumpable" : ""}" ${jumpable ? `data-jump="${item.id}" tabindex="0" role="button"` : ""}>
    <span class="badge ${kindClass}">${kindLabel}</span>
    <span class="unsaved-row-text">${where} &middot; ${what}${detail}</span>
  </li>`;
}

/** Shows what's unsaved on this page (which shapes/regions, where, and what
 *  changed about each) before an export that would otherwise silently use
 *  the last-saved version instead of what's on screen. Resolves to
 *  "save" | "export" | "cancel". Clicking a still-present row jumps the
 *  canvas to it (via selectAnnotation) without closing the dialog, so you
 *  can review several before deciding. */
function askUnsavedChanges(canvas) {
  return new Promise((resolve) => {
    const diff = canvas.getUnsavedChanges();
    const rows = [
      ...diff.shapes.map((s) => unsavedRowHtml(s, false)),
      ...diff.regions.map((r) => unsavedRowHtml(r, true)),
    ].join("");

    const dlg = document.createElement("dialog");
    dlg.className = "export-coords-dialog unsaved-changes-dialog";
    dlg.innerHTML = `
      <form method="dialog">
        <h3>You have unsaved changes</h3>
        <p class="faint">Exporting now would use the last saved version of this page, not what's on screen. Here's what's changed:</p>
        <ul class="unsaved-list">${rows}</ul>
        <div class="row" style="justify-content:flex-end; margin-top:16px; gap:8px; flex-wrap:wrap;">
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="button" class="btn" data-act="export">Export anyway (stale)</button>
          <button type="button" class="btn primary" data-act="save">Save &amp; Export</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);

    dlg.querySelectorAll("[data-jump]").forEach((row) => {
      row.addEventListener("click", () => canvas.selectAnnotation(row.dataset.jump));
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      dlg.remove();
    };
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { dlg.close(); finish("cancel"); });
    dlg.querySelector('[data-act="export"]').addEventListener("click", () => { dlg.close(); finish("export"); });
    dlg.querySelector('[data-act="save"]').addEventListener("click", () => { dlg.close(); finish("save"); });
    dlg.addEventListener("cancel", () => finish("cancel")); // Esc key
    dlg.addEventListener("close", () => finish("cancel"));  // any other dismissal path
    dlg.showModal();
  });
}
window.askUnsavedChanges = askUnsavedChanges;

class AnnotationCanvas {
  constructor(container, opts) {
    this.container = container;
    this.opts = opts;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "anno-canvas";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    // floating UI
    this.labelEditor = null;
    this.lineChip = null;
    this.regionChip = null;

    this.img = null;
    this.imgW = 0; this.imgH = 0;
    this.view = { scale: 1, x: 0, y: 0 };
    this.tool = "select";
    this.annotations = [];
    // Line-annotation regions: freeform "lasso" polygons that fix line
    // numbers on a skewed page (see lib/lines.js computeLineNumbers) -- a
    // separate collection from annotations since they aren't shapes (no
    // label, never exported as their own object), just a persistent record
    // of "everything in here is line N".
    this.lineRegions = [];
    this.selectedId = null;
    this.selectedRegionId = null;
    this.pendingLabelId = null;
    this.activeLabelId = null;
    this.highlightLabelId = null; // set via toggleHighlightLabel() from the Labels sidebar
    this.lastAssigned = null;
    this.dirty = false;
    // Snapshots of annotations/lineRegions as of the last load()/markSaved()
    // -- i.e. what the server actually has on disk right now. Diffed against
    // the live collections above to answer "what exactly is unsaved" (see
    // getUnsavedChanges()), not just the yes/no isDirty() flag.
    this._savedAnnotations = [];
    this._savedRegions = [];
    this.showLineNumbers = loadShowLineNumbers();
    this.showLabelInput = loadShowLabelInput();
    this.drag = { mode: "none" };
    this.mouseNorm = null;
    this.undoStack = []; this.redoStack = []; this.lastRecordAt = 0;

    this._bind();
    this._resizeObserver = new ResizeObserver(() => { this._fitCanvas(); this.draw(); });
    this._resizeObserver.observe(container);
  }

  // ---------- lifecycle ----------
  load(imageUrl, width, height, annotations, lineRegions) {
    this.imgW = width; this.imgH = height;
    this.annotations = (annotations || []).map((a) => ({ ...a }));
    this.lineRegions = (lineRegions || []).map((r) => ({ ...r, points: (r.points || []).map((p) => ({ ...p })) }));
    this.selectedId = null; this.selectedRegionId = null; this.pendingLabelId = null; this.highlightLabelId = null;
    this.undoStack = []; this.redoStack = [];
    this.dirty = false;
    this._savedAnnotations = cloneData(this.annotations);
    this._savedRegions = cloneData(this.lineRegions);
    this._closeEditors();
    this.img = new Image();
    this.img.onload = () => { this.fit(); };
    this.img.src = imageUrl;
    this._fitCanvas();
    this.draw();
  }

  getAnnotations() { return this.annotations; }
  getLineRegions() { return this.lineRegions; }
  /** Every shape in on-canvas L<line>-<seq> order, with its label resolved
   *  to a name/color -- for a sidebar "Shapes" list. Same computeLineNumbers
   *  + sort as lib/exporter.js's orderedShapes(), so the list, the canvas
   *  tags, and the export all agree on ordering. */
  getShapesSummary() {
    const info = LFLines.computeLineNumbers(this.annotations, this.lineRegions);
    return this.annotations
      .map((a) => {
        const i = info.get(a.id) || { line: 1, seq: 1 };
        const label = this._labelOf(a.labelId);
        return { id: a.id, type: a.type, line: i.line, seq: i.seq, labelName: label ? label.name : null, color: this._colorOf(a.labelId) };
      })
      .sort((x, y) => x.line - y.line || x.seq - y.seq);
  }
  isDirty() { return this.dirty; }
  markSaved() {
    this.dirty = false;
    this._savedAnnotations = cloneData(this.annotations);
    this._savedRegions = cloneData(this.lineRegions);
    this.opts.onChange && this.opts.onChange();
  }

  /** Everything that differs from the last save, shape-by-shape and
   *  region-by-region -- for the "you have unsaved changes" export warning.
   *  Each entry carries its CURRENT line/seq (or, for a deleted shape, the
   *  line/seq it had as of the last save, since it no longer has a "current"
   *  one) so the dialog can say exactly where to look, not just that
   *  something changed. Shape entries also carry the id so the caller can
   *  jump the canvas to it (selectAnnotation) -- deleted shapes have nothing
   *  left to jump to, so callers should skip that affordance for those. */
  getUnsavedChanges() {
    const savedById = new Map(this._savedAnnotations.map((a) => [a.id, a]));
    const curById = new Map(this.annotations.map((a) => [a.id, a]));
    const curInfo = LFLines.computeLineNumbers(this.annotations, this.lineRegions);
    const savedInfo = LFLines.computeLineNumbers(this._savedAnnotations, this._savedRegions);

    const shapes = [];
    for (const a of this.annotations) {
      const prev = savedById.get(a.id);
      const i = curInfo.get(a.id) || { line: 1, seq: 1 };
      const label = this._labelOf(a.labelId);
      const base = { id: a.id, type: a.type, labelName: label ? label.name : null, line: i.line, seq: i.seq };
      if (!prev) shapes.push({ ...base, kind: "added" });
      else {
        const isSame = (prev.labelId ?? null) === (a.labelId ?? null) && (prev.line ?? null) === (a.line ?? null) && shapeGeometryEqual(prev, a);
        if (!isSame) shapes.push({ ...base, kind: "modified", changes: describeShapeDiff(prev, a) });
      }
    }
    for (const a of this._savedAnnotations) {
      if (curById.has(a.id)) continue;
      const i = savedInfo.get(a.id) || { line: 1, seq: 1 };
      const label = this._labelOf(a.labelId);
      shapes.push({ id: a.id, type: a.type, labelName: label ? label.name : null, line: i.line, seq: i.seq, kind: "deleted" });
    }
    shapes.sort((x, y) => x.line - y.line || x.seq - y.seq);

    const savedRegionById = new Map(this._savedRegions.map((r) => [r.id, r]));
    const curRegionById = new Map(this.lineRegions.map((r) => [r.id, r]));
    const regions = [];
    for (const r of this.lineRegions) {
      const prev = savedRegionById.get(r.id);
      if (!prev) regions.push({ id: r.id, line: r.line, kind: "added" });
      else if (!regionGeometryEqual(prev, r) || (prev.line ?? null) !== (r.line ?? null)) {
        regions.push({ id: r.id, line: r.line, kind: "modified", changes: describeRegionDiff(prev, r) });
      }
    }
    for (const r of this._savedRegions) {
      if (!curRegionById.has(r.id)) regions.push({ id: r.id, line: r.line, kind: "deleted" });
    }
    regions.sort((x, y) => x.line - y.line);

    return { shapes, regions, hasChanges: shapes.length > 0 || regions.length > 0 };
  }
  setTool(t) {
    this.tool = t;
    this._cancelPolygon();
    this._cancelLasso();
    // Regions are only visible/selectable while the "line-lasso" tool itself
    // is active (see draw()'s render gate + _onDown's tool branches) -- so
    // leaving that tool needs to drop any region selection and close its
    // chip, rather than leaving a selection that references something about
    // to visually disappear.
    if (t !== "line-lasso" && this.selectedRegionId) {
      this.selectedRegionId = null;
      if (this.regionChip) { this.regionChip.remove(); this.regionChip = null; }
    }
    this.draw();
  }
  setActiveLabel(id) { this.activeLabelId = id; }
  setShowLineNumbers(v) {
    this.showLineNumbers = Boolean(v);
    try { localStorage.setItem(SHOW_LINES_KEY, String(this.showLineNumbers)); } catch {}
    this.draw();
  }
  setShowLabelInput(v) {
    this.showLabelInput = Boolean(v);
    try { localStorage.setItem(SHOW_LABEL_INPUT_KEY, String(this.showLabelInput)); } catch {}
    // Re-evaluate immediately: flipping this ON with a shape mid-selection
    // should pop the editor open right away; flipping it OFF should close
    // whichever one is currently showing.
    this._syncEditors();
  }

  /** Toggle the canvas-wide highlight for every shape carrying this label
   *  (clicking the same label again clears it). Purely visual -- doesn't
   *  touch selectedId/resize handles, since it can apply to many shapes at
   *  once rather than the one you'd directly manipulate. */
  toggleHighlightLabel(labelId) {
    this.highlightLabelId = this.highlightLabelId === labelId ? null : labelId;
    this.draw();
  }

  /** Select a shape by id from outside (e.g. the sidebar shapes list) --
   *  same end state as clicking it on the canvas, plus panning it into view
   *  if it's currently scrolled/zoomed off-screen (a highlight you can't
   *  see isn't much of a highlight). */
  selectAnnotation(id) {
    const a = this.annotations.find((x) => x.id === id);
    if (!a) return;
    this.selectedId = id;
    this.selectedRegionId = null;
    this.pendingLabelId = null; // this is "look at an existing shape", never "name a brand-new one"
    this._revealIfOffscreen(a);
    this._syncEditors();
    this.draw();
    this.opts.onChange && this.opts.onChange();
  }

  /** Delete a shape by id (the sidebar shapes list's per-item ×). Goes
   *  through the normal _mutate() path, so this gets undo support and
   *  correct line/sequence renumbering for the remaining shapes for free --
   *  computeLineNumbers() is recomputed from scratch on every draw(), there
   *  is no separately-stored sequence number to go stale. */
  deleteAnnotation(id) {
    if (this.selectedId === id) { this.selectedId = null; this.pendingLabelId = null; this._closeEditors(); }
    this._mutate(this.annotations.filter((a) => a.id !== id));
  }

  /** Delete a line-annotation region. Shapes it was covering simply fall
   *  back to whatever line they'd otherwise have (their own manual override,
   *  or the automatic y-position line) -- deleting a region never deletes or
   *  otherwise touches the shapes themselves. */
  deleteRegion(id) {
    if (this.selectedRegionId === id) { this.selectedRegionId = null; this._closeEditors(); }
    this._mutateRegions(this.lineRegions.filter((r) => r.id !== id));
  }

  /** How many shapes on this page currently carry a manual line override
   *  (whether typed in by hand or brought in by pre-annotation import) --
   *  used to gray out / label the "Recalculate lines" button when there's
   *  nothing for it to do. */
  countManualLineOverrides() {
    return this.annotations.reduce((n, a) => n + (typeof a.line === "number" ? 1 : 0), 0);
  }

  /** Strip every shape's manual line override on this page (whether it was
   *  typed in by hand via the line chip, or arrived as a `line` value on
   *  pre-annotation import) and fall back to the tool's own top-to-bottom
   *  automatic numbering for all of them. Deliberately does NOT touch line
   *  regions -- those are a page-level fix drawn in this tool (not something
   *  pre-annotation could have set), so a "start over from automatic" reset
   *  leaves them in place; delete a region separately if you want that gone
   *  too. Goes through the normal _mutate() path, so this is undoable
   *  (Ctrl/Cmd+Z) and recomputes line/sequence for everyone in one redraw. */
  resetAllLines() {
    if (this.selectedId) { this.selectedId = null; this.pendingLabelId = null; this._closeEditors(); }
    this._mutate(this.annotations.map((a) => (typeof a.line === "number" ? { ...a, line: null } : a)));
  }

  /** Called after a label is deleted server-side (admin's Labels panel,
   *  project-wide): syncs this already-loaded image's in-memory copy so it
   *  stops showing a labelId that no longer exists, without waiting for a
   *  reload. Deliberately NOT routed through _mutate() -- this reflects a
   *  change that already happened and is already persisted elsewhere, so it
   *  shouldn't create an undo entry or mark the image dirty/unsaved. */
  unassignLabel(labelId) {
    let changed = false;
    const next = this.annotations.map((a) => {
      if (a.labelId !== labelId) return a;
      changed = true;
      return { ...a, labelId: null };
    });
    if (!changed) return;
    this.annotations = next;
    this.draw();
    this.opts.onChange && this.opts.onChange();
  }

  /** Pans (not zooms) so the shape is fully visible, only if it currently
   *  isn't -- so this never yanks the view around for something already on
   *  screen. */
  _revealIfOffscreen(a) {
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    let minX, minY, maxX, maxY;
    if (a.type === "bbox") {
      minX = a.rect.x; minY = a.rect.y; maxX = a.rect.x + a.rect.w; maxY = a.rect.y + a.rect.h;
    } else {
      const xs = a.points.map((p) => p.x), ys = a.points.map((p) => p.y);
      minX = Math.min(...xs); maxX = Math.max(...xs); minY = Math.min(...ys); maxY = Math.max(...ys);
    }
    const p1 = this.toCanvas(minX, minY), p2 = this.toCanvas(maxX, maxY);
    const margin = 20;
    const visible = p1.x >= margin && p1.y >= margin && p2.x <= cw - margin && p2.y <= ch - margin;
    if (visible) return;
    const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
    this.view.x += cw / 2 - cx;
    this.view.y += ch / 2 - cy;
  }

  fit() {
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    const scale = Math.min(1, cw / this.imgW, ch / this.imgH);
    this.view = { scale, x: (cw - this.imgW * scale) / 2, y: (ch - this.imgH * scale) / 2 };
    this.draw();
  }
  zoomTo(target) {
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    const cx = cw / 2, cy = ch / 2;
    const nx = (cx - this.view.x) / this.view.scale, ny = (cy - this.view.y) / this.view.scale;
    const s = Math.min(8, Math.max(0.05, target));
    this.view = { scale: s, x: cx - nx * s, y: cy - ny * s };
    this.draw();
  }

  // ---------- undo / redo ----------
  // One combined history for both annotations and lineRegions -- a single
  // linear undo stack the user experiences as "Ctrl+Z undoes my last
  // change", whichever collection it touched, rather than two independent
  // stacks that could desync (e.g. undoing a shape move while a region edit
  // sits "ahead" of it in a separate history would be confusing and, worse,
  // could silently drop the region edit entirely).
  _record() {
    const now = Date.now();
    const sameGesture = now - this.lastRecordAt < 400;
    this.lastRecordAt = now;
    this.redoStack = [];
    if (sameGesture && this.undoStack.length) return;
    this.undoStack.push({
      annotations: this.annotations.map((a) => ({ ...a })),
      lineRegions: this.lineRegions.map((r) => ({ ...r, points: r.points.map((p) => ({ ...p })) })),
    });
    if (this.undoStack.length > 100) this.undoStack.shift();
  }
  _mutate(next) { this._record(); this.annotations = next; this.dirty = true; this.opts.onChange && this.opts.onChange(); this.draw(); }
  _mutateRegions(next) { this._record(); this.lineRegions = next; this.dirty = true; this.opts.onChange && this.opts.onChange(); this.draw(); }
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push({ annotations: this.annotations, lineRegions: this.lineRegions });
    this.annotations = prev.annotations; this.lineRegions = prev.lineRegions;
    this.selectedId = null; this.pendingLabelId = null; this.selectedRegionId = null;
    this.dirty = true; this.lastRecordAt = 0; this._closeEditors();
    this.opts.onChange && this.opts.onChange(); this.draw();
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({ annotations: this.annotations, lineRegions: this.lineRegions });
    this.annotations = next.annotations; this.lineRegions = next.lineRegions;
    this.selectedId = null; this.pendingLabelId = null; this.selectedRegionId = null;
    this.dirty = true; this.lastRecordAt = 0; this._closeEditors();
    this.opts.onChange && this.opts.onChange(); this.draw();
  }

  // ---------- coordinates ----------
  toCanvas(nx, ny) { return { x: nx * this.imgW * this.view.scale + this.view.x, y: ny * this.imgH * this.view.scale + this.view.y }; }
  toNorm(cx, cy) { return { x: (cx - this.view.x) / (this.imgW * this.view.scale), y: (cy - this.view.y) / (this.imgH * this.view.scale) }; }
  _pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  // ---------- rendering ----------
  _fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    this.canvas.width = cw * dpr; this.canvas.height = ch * dpr;
    this.canvas.style.width = cw + "px"; this.canvas.style.height = ch + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _labelOf(id) { return (this.opts.getLabels() || []).find((l) => l.id === id) || null; }
  _colorOf(id) { const l = this._labelOf(id); return l ? l.color : "#94a3b8"; }

  draw() {
    const ctx = this.ctx;
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    this._fitCanvas();
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, cw, ch);
    if (this.img && this.img.complete && this.imgW) {
      ctx.drawImage(this.img, this.view.x, this.view.y, this.imgW * this.view.scale, this.imgH * this.view.scale);
    }

    const lineInfo = LFLines.computeLineNumbers(this.annotations, this.lineRegions);

    // Line-annotation regions render as a background layer -- a dashed rose
    // outline + faint fill -- so real shape outlines/handles always stay
    // crisp on top of them. These aren't shapes: no label, not exported as
    // their own object, just a persistent visual record of "everything in
    // here is line N" (see lib/lines.js computeLineNumbers).
    //
    // Only drawn (and only selectable -- see _onDown's "line-lasso" branch)
    // while the Line annotation tool itself is checked/active: toggling it
    // off hides the loops entirely to declutter the canvas, while the line
    // numbers they already assigned stay in effect either way -- lineInfo
    // above was computed from this.lineRegions regardless of this flag, so
    // hiding the loops never touches what they actually did to any shape.
    if (this.tool === "line-lasso") {
      for (const r of this.lineRegions) {
        if (!r.points || r.points.length < 2) continue;
        const selR = r.id === this.selectedRegionId;
        let memberCount = 0;
        for (const info of lineInfo.values()) if (info.regionId === r.id) memberCount++;
        ctx.save();
        ctx.strokeStyle = "#f43f5e"; ctx.lineWidth = selR ? 3 : 2; ctx.setLineDash([7, 5]);
        ctx.beginPath();
        const rf = this.toCanvas(r.points[0].x, r.points[0].y);
        ctx.moveTo(rf.x, rf.y);
        for (let i = 1; i < r.points.length; i++) { const c = this.toCanvas(r.points[i].x, r.points[i].y); ctx.lineTo(c.x, c.y); }
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#f43f5e1a";
        ctx.fill();
        ctx.restore();
        if (selR) this._drawHandles(r.points.map((p) => this.toCanvas(p.x, p.y)), "#f43f5e");
        this._drawTag(`Line ${r.line} · ${memberCount} shape${memberCount === 1 ? "" : "s"}`, rf.x, rf.y, "#f43f5e");
      }
    }

    for (const a of this.annotations) {
      const color = this._colorOf(a.labelId);
      const sel = a.id === this.selectedId;
      const highlighted = this.highlightLabelId != null && a.labelId === this.highlightLabelId;
      const info = lineInfo.get(a.id);
      const label = this._labelOf(a.labelId);
      const parts = [];
      // While something is selected, only ITS line/sequence number shows --
      // everyone else's hides so you can focus on the shape you're working
      // on. Nothing selected (or the toggle is off) reverts to normal: every
      // shape shows its own number.
      const showNum = this.showLineNumbers && info && (!this.selectedId || a.id === this.selectedId);
      if (showNum) parts.push(`L${info.line}-${info.seq}`);
      if (label) parts.push(label.name);
      const text = parts.join(" ");

      if (a.type === "bbox") {
        const p1 = this.toCanvas(a.rect.x, a.rect.y);
        const p2 = this.toCanvas(a.rect.x + a.rect.w, a.rect.y + a.rect.h);
        ctx.strokeStyle = color; ctx.lineWidth = sel ? 3 : 2;
        ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
        ctx.fillStyle = color + "33";
        ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
        if (sel) this._drawHandles(this._bboxHandles(p1, p2), color);
        if (highlighted) this._drawHighlight([p1, { x: p2.x, y: p1.y }, p2, { x: p1.x, y: p2.y }]);
        this._drawTag(text, p1.x, p1.y, color);
      } else {
        const pts = a.points;
        if (pts.length < 2) continue;
        ctx.beginPath();
        const f = this.toCanvas(pts[0].x, pts[0].y);
        ctx.moveTo(f.x, f.y);
        for (let i = 1; i < pts.length; i++) { const c = this.toCanvas(pts[i].x, pts[i].y); ctx.lineTo(c.x, c.y); }
        ctx.closePath();
        ctx.strokeStyle = color; ctx.lineWidth = sel ? 3 : 2; ctx.stroke();
        ctx.fillStyle = color + "33"; ctx.fill();
        if (sel) this._drawHandles(pts.map((p) => this.toCanvas(p.x, p.y)), color);
        if (highlighted) this._drawHighlight(pts.map((p) => this.toCanvas(p.x, p.y)));
        this._drawTag(text, f.x, f.y, color);
      }
    }

    // in-progress shapes
    const d = this.drag;
    if (d.mode === "draw-bbox" && d.start && this.mouseNorm) {
      const p1 = this.toCanvas(d.start.x, d.start.y);
      const p2 = this.toCanvas(this.mouseNorm.x, this.mouseNorm.y);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = this._colorOf(this.activeLabelId); ctx.lineWidth = 2;
      ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      ctx.setLineDash([]);
    } else if (d.mode === "draw-poly" && d.points && d.points.length) {
      ctx.strokeStyle = this._colorOf(this.activeLabelId); ctx.lineWidth = 2;
      ctx.beginPath();
      const f = this.toCanvas(d.points[0].x, d.points[0].y);
      ctx.moveTo(f.x, f.y);
      for (let i = 1; i < d.points.length; i++) { const c = this.toCanvas(d.points[i].x, d.points[i].y); ctx.lineTo(c.x, c.y); }
      if (this.mouseNorm) { const c = this.toCanvas(this.mouseNorm.x, this.mouseNorm.y); ctx.lineTo(c.x, c.y); }
      ctx.stroke();
      this._drawHandles(d.points.map((p) => this.toCanvas(p.x, p.y)), "#fff");
    } else if (d.mode === "draw-lasso" && d.points && d.points.length) {
      ctx.strokeStyle = "#f43f5e"; ctx.lineWidth = 2;
      ctx.beginPath();
      const f = this.toCanvas(d.points[0].x, d.points[0].y);
      ctx.moveTo(f.x, f.y);
      for (let i = 1; i < d.points.length; i++) { const c = this.toCanvas(d.points[i].x, d.points[i].y); ctx.lineTo(c.x, c.y); }
      if (this.mouseNorm) { const c = this.toCanvas(this.mouseNorm.x, this.mouseNorm.y); ctx.lineTo(c.x, c.y); }
      ctx.stroke();
    }

    this._positionFloatingUi();
  }

  /** Dashed amber outline traced over a shape whose label is currently
   *  highlighted from the Labels sidebar -- a distinct visual signal from
   *  the "selected" treatment (thicker solid stroke + resize handles), since
   *  this can apply to many shapes across the image at once. */
  _drawHighlight(canvasPoints) {
    if (!canvasPoints.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 4;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(canvasPoints[0].x, canvasPoints[0].y);
    for (let i = 1; i < canvasPoints.length; i++) ctx.lineTo(canvasPoints[i].x, canvasPoints[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  _drawTag(text, x, y, color) {
    if (!text.trim()) return;
    const ctx = this.ctx;
    ctx.font = "12px system-ui, sans-serif";
    const w = ctx.measureText(text).width;
    ctx.fillStyle = color;
    ctx.fillRect(x, y - 16, w + 8, 16);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x + 4, y - 4);
  }
  _drawHandles(points, color) {
    const ctx = this.ctx, S = 8;
    for (const h of Array.isArray(points) ? points : Object.values(points)) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(h.x - S / 2, h.y - S / 2, S, S);
      ctx.strokeStyle = color;
      ctx.strokeRect(h.x - S / 2, h.y - S / 2, S, S);
    }
  }
  _bboxHandles(p1, p2) {
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    return {
      nw: { x: p1.x, y: p1.y }, n: { x: mx, y: p1.y }, ne: { x: p2.x, y: p1.y }, e: { x: p2.x, y: my },
      se: { x: p2.x, y: p2.y }, s: { x: mx, y: p2.y }, sw: { x: p1.x, y: p2.y }, w: { x: p1.x, y: my },
    };
  }

  // ---------- hit testing ----------
  _hitHandle(a, pos) {
    if (a.type !== "bbox") return null;
    const p1 = this.toCanvas(a.rect.x, a.rect.y);
    const p2 = this.toCanvas(a.rect.x + a.rect.w, a.rect.y + a.rect.h);
    for (const [name, h] of Object.entries(this._bboxHandles(p1, p2))) {
      if (Math.abs(pos.x - h.x) <= 8 && Math.abs(pos.y - h.y) <= 8) return name;
    }
    return null;
  }
  _hitShape(pos) {
    const n = this.toNorm(pos.x, pos.y);
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const a = this.annotations[i];
      if (a.type === "bbox") {
        const r = a.rect;
        if (n.x >= r.x && n.x <= r.x + r.w && n.y >= r.y && n.y <= r.y + r.h) return a;
      } else if (this._pointInPoly(n, a.points)) return a;
    }
    return null;
  }
  _pointInPoly(pt, vs) {
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      const xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y;
      if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  /** Like _hitShape, but for line-annotation regions -- only consulted when
   *  a click didn't land on a real shape (see _onDown's "select" branch),
   *  since a shape should always take precedence over the (usually much
   *  larger) region loosely drawn around it. */
  _hitRegion(pos) {
    const n = this.toNorm(pos.x, pos.y);
    for (let i = this.lineRegions.length - 1; i >= 0; i--) {
      const r = this.lineRegions[i];
      if (r.points && r.points.length >= 3 && this._pointInPoly(n, r.points)) return r;
    }
    return null;
  }

  // ---------- events ----------
  _bind() {
    const c = this.canvas;
    c.addEventListener("mousedown", (e) => this._onDown(e));
    c.addEventListener("mousemove", (e) => this._onMove(e));
    c.addEventListener("mouseup", () => this._onUp());
    c.addEventListener("mouseleave", () => this._onUp());
    c.addEventListener("dblclick", () => { if (this.drag.mode === "draw-poly") this._finishPolygon(); });
    // Non-passive: ctrl+wheel must not zoom the whole page.
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const pos = this._pos(e);
        const f = e.deltaY > 0 ? 0.9 : 1.1;
        const s = Math.min(8, Math.max(0.05, this.view.scale * f));
        const nx = (pos.x - this.view.x) / this.view.scale, ny = (pos.y - this.view.y) / this.view.scale;
        this.view = { scale: s, x: pos.x - nx * s, y: pos.y - ny * s };
      } else if (e.shiftKey) {
        // Shift+scroll = horizontal pan, like image editors. Trackpads (and
        // some browsers) already swap deltaX/deltaY for a shift+wheel
        // gesture; a plain vertical-only mouse wheel never populates
        // deltaX at all, so it falls back to deltaY -- either way, whichever
        // axis actually carries the gesture drives horizontal movement.
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.view.x -= delta;
      } else {
        this.view.x -= e.deltaX; this.view.y -= e.deltaY;
      }
      this.draw();
    }, { passive: false });

    this._keyHandler = (e) => {
      const t = e.target;
      const isUndo = (e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z");
      const isRedo = (e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y");
      // Undo/redo always work, even while a floating input (the "name this
      // shape" editor, the line-number chip) has focus -- Ctrl+Z on a shape
      // you regret is exactly as useful mid-naming as it is anywhere else,
      // and it's a chord no text field here actually needs for itself.
      // Everything else still backs off while typing, so plain letters/
      // Delete/Backspace behave like normal text editing in those inputs.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) && !isUndo && !isRedo) return;
      if (isUndo) {
        e.preventDefault(); e.shiftKey ? this.redo() : this.undo();
      } else if (isRedo) {
        e.preventDefault(); this.redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && this.selectedId) {
        e.preventDefault();
        // Clear selection state BEFORE mutating: _mutate() fires onChange
        // synchronously, and anything listening (e.g. a sidebar shapes list
        // reading canvas.selectedId to highlight the active row) should see
        // the post-deletion state, not a stale reference to an id that's
        // about to stop existing.
        const id = this.selectedId;
        this.selectedId = null; this.pendingLabelId = null; this._closeEditors();
        this._mutate(this.annotations.filter((a) => a.id !== id));
      } else if ((e.key === "Delete" || e.key === "Backspace") && this.selectedRegionId) {
        e.preventDefault();
        const id = this.selectedRegionId;
        this.selectedRegionId = null; this._closeEditors();
        this._mutateRegions(this.lineRegions.filter((r) => r.id !== id));
      } else if (e.key === "Escape") {
        this._cancelPolygon(); this._cancelLasso(); this._closeEditors(); this.pendingLabelId = null; this.draw();
      } else if (e.key === "Enter" && this.drag.mode === "draw-poly") {
        this._finishPolygon();
      }
    };
    window.addEventListener("keydown", this._keyHandler);
  }

  _onDown(e) {
    const pos = this._pos(e);
    if (e.button === 1) {
      this.drag = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
      return;
    }
    if (this.tool === "select") {
      const sel = this.annotations.find((a) => a.id === this.selectedId);
      if (sel) {
        const h = this._hitHandle(sel, pos);
        if (h) { this.drag = { mode: "resize", id: sel.id, handle: h, orig: { ...sel.rect } }; return; }
      }
      const hit = this._hitShape(pos);
      if (hit) {
        this.selectedId = hit.id;
        this.pendingLabelId = hit.labelId == null ? hit.id : null;
        this.drag = {
          mode: "move", id: hit.id, origin: this.toNorm(pos.x, pos.y),
          orig: hit.type === "bbox" ? { ...hit.rect } : hit.points.map((p) => ({ ...p })),
        };
      } else {
        this.selectedId = null; this.pendingLabelId = null;
      }
      this._syncEditors(); this.draw();
      // A plain selection change isn't a content edit (no _mutate call, so
      // isDirty()/undo are correctly untouched), but the sidebar shapes list
      // needs to know its "active row" changed -- reuse onChange as the
      // general "re-sync your UI" signal rather than adding a second
      // parallel callback for what is, from the app's point of view, the
      // same kind of "please re-render" event.
      this.opts.onChange && this.opts.onChange();
      return;
    }
    if (this.tool === "bbox") {
      this.drag = { mode: "draw-bbox", start: this.toNorm(pos.x, pos.y) };
      return;
    }
    if (this.tool === "polygon") {
      const n = this.toNorm(pos.x, pos.y);
      const pt = { x: clamp01(n.x), y: clamp01(n.y) };
      if (this.drag.mode !== "draw-poly") this.drag = { mode: "draw-poly", points: [pt] };
      else {
        const first = this.toCanvas(this.drag.points[0].x, this.drag.points[0].y);
        if (Math.hypot(pos.x - first.x, pos.y - first.y) < 10 && this.drag.points.length >= 3) return this._finishPolygon();
        this.drag.points.push(pt);
      }
      this.draw();
    }
    if (this.tool === "line-lasso") {
      // Regions are only ever visible/selectable while THIS tool is active
      // (see draw()'s render gate and setTool()'s deselect-on-leave) -- so,
      // unlike the Select tool (which only ever draws NEW shapes via the
      // dedicated bbox/polygon tools), this one doubles as both "select an
      // existing region to move/reshape/delete it" AND "draw a brand new
      // one", the same way the plain Select tool doubles as select+move for
      // shapes. _tryPickRegion() tries the former first; only an empty-space
      // click falls through to starting a new freehand loop.
      if (this._tryPickRegion(pos)) {
        this._syncEditors(); this.draw();
        this.opts.onChange && this.opts.onChange();
        return;
      }
      // A single click-drag-release gesture (unlike the polygon tool's
      // click-click-click), so it just starts capturing points here --
      // _onMove appends more as the mouse moves, _onUp finalizes it.
      const n = this.toNorm(pos.x, pos.y);
      this.selectedRegionId = null; this._closeEditors();
      this.drag = { mode: "draw-lasso", points: [{ x: clamp01(n.x), y: clamp01(n.y) }] };
    }
  }

  /** Shared by the "line-lasso" tool's mousedown: try to pick up an existing
   *  region -- first a vertex handle on the CURRENTLY selected one (to
   *  reshape it), then any region under the cursor at all (to select + drag
   *  it as a whole). Returns true if it started a drag/selection (caller
   *  should stop there); false means nothing existing was under the cursor,
   *  so the caller falls through to starting a brand new region instead. */
  _tryPickRegion(pos) {
    const selRegion = this.lineRegions.find((r) => r.id === this.selectedRegionId);
    if (selRegion) {
      const hv = this._hitRegionVertex(selRegion, pos);
      if (hv != null) { this.drag = { mode: "reshape-region", id: selRegion.id, pointIndex: hv }; return true; }
    }
    const hitRegion = this._hitRegion(pos);
    if (hitRegion) {
      this.selectedId = null; this.pendingLabelId = null;
      this.selectedRegionId = hitRegion.id;
      this.drag = { mode: "move-region", id: hitRegion.id, origin: this.toNorm(pos.x, pos.y), orig: hitRegion.points.map((p) => ({ ...p })) };
      return true;
    }
    return false;
  }

  /** Index of the region point under the cursor (within resize-handle
   *  tolerance), or null -- same 8px hit radius as _hitHandle uses for bbox
   *  handles, so dragging a region vertex feels exactly as forgiving. */
  _hitRegionVertex(region, pos) {
    for (let i = 0; i < region.points.length; i++) {
      const c = this.toCanvas(region.points[i].x, region.points[i].y);
      if (Math.abs(pos.x - c.x) <= 8 && Math.abs(pos.y - c.y) <= 8) return i;
    }
    return null;
  }

  _onMove(e) {
    const pos = this._pos(e);
    this.mouseNorm = this.toNorm(pos.x, pos.y);
    const d = this.drag;
    if (d.mode === "pan") {
      this.view.x = d.vx + (e.clientX - d.sx); this.view.y = d.vy + (e.clientY - d.sy);
      this.draw(); return;
    }
    if (d.mode === "draw-bbox" || d.mode === "draw-poly") { this.draw(); return; }
    if (d.mode === "draw-lasso") {
      // Sparse-sample the freehand path: only record a new point once the
      // cursor has moved a few canvas pixels from the last one, so a slow
      // drag doesn't pile up thousands of near-duplicate points. Distance is
      // measured in CANVAS pixels (not normalized image units) so the
      // sampling density stays visually consistent regardless of zoom level.
      const last = d.points[d.points.length - 1];
      const lastCanvas = this.toCanvas(last.x, last.y);
      if (Math.hypot(pos.x - lastCanvas.x, pos.y - lastCanvas.y) >= 4) {
        d.points.push({ x: clamp01(this.mouseNorm.x), y: clamp01(this.mouseNorm.y) });
      }
      this.draw();
      return;
    }
    if (d.mode === "move-region") {
      const dx = this.mouseNorm.x - d.origin.x, dy = this.mouseNorm.y - d.origin.y;
      const xs = d.orig.map((p) => p.x), ys = d.orig.map((p) => p.y);
      const cdx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), dx));
      const cdy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), dy));
      const pts = d.orig.map((p) => ({ x: p.x + cdx, y: p.y + cdy }));
      this._mutateRegions(this.lineRegions.map((r) => (r.id === d.id ? { ...r, points: pts } : r)));
      return;
    }
    if (d.mode === "reshape-region") {
      // Drags a single vertex -- shape membership (>50% area inside) is
      // recomputed fresh on every draw(), so reshaping the region live
      // updates which bboxes/polygons it covers with no extra bookkeeping.
      const n = { x: clamp01(this.mouseNorm.x), y: clamp01(this.mouseNorm.y) };
      this._mutateRegions(this.lineRegions.map((r) => {
        if (r.id !== d.id) return r;
        return { ...r, points: r.points.map((p, i) => (i === d.pointIndex ? n : p)) };
      }));
      return;
    }
    if (d.mode === "move") {
      const a = this.annotations.find((x) => x.id === d.id);
      if (!a) return;
      const dx = this.mouseNorm.x - d.origin.x, dy = this.mouseNorm.y - d.origin.y;
      if (a.type === "bbox") {
        const o = d.orig;
        const nx = Math.max(0, Math.min(1 - o.w, o.x + dx));
        const ny = Math.max(0, Math.min(1 - o.h, o.y + dy));
        this._mutate(this.annotations.map((x) => (x.id === d.id ? { ...x, rect: { ...o, x: nx, y: ny } } : x)));
      } else {
        // clamp the TRANSLATION so the polygon keeps its shape at edges
        const xs = d.orig.map((p) => p.x), ys = d.orig.map((p) => p.y);
        const cdx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), dx));
        const cdy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), dy));
        const pts = d.orig.map((p) => ({ x: p.x + cdx, y: p.y + cdy }));
        this._mutate(this.annotations.map((x) => (x.id === d.id ? { ...x, points: pts } : x)));
      }
      return;
    }
    if (d.mode === "resize") {
      const n = { x: clamp01(this.mouseNorm.x), y: clamp01(this.mouseNorm.y) };
      const o = d.orig;
      let x = o.x, y = o.y, w = o.w, h = o.h;
      const x2 = o.x + o.w, y2 = o.y + o.h;
      const hd = d.handle;
      if (hd.includes("w")) { x = n.x; w = x2 - n.x; }
      if (hd.includes("e")) { w = n.x - o.x; }
      if (hd.includes("n")) { y = n.y; h = y2 - n.y; }
      if (hd.includes("s")) { h = n.y - o.y; }
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      this._mutate(this.annotations.map((a) => (a.id === d.id ? { ...a, rect: { x: clamp01(x), y: clamp01(y), w, h } } : a)));
    }
  }

  _onUp() {
    const d = this.drag;
    if (d.mode === "draw-bbox" && d.start && this.mouseNorm) {
      const x1 = clamp01(Math.min(d.start.x, this.mouseNorm.x));
      const y1 = clamp01(Math.min(d.start.y, this.mouseNorm.y));
      const x2 = clamp01(Math.max(d.start.x, this.mouseNorm.x));
      const y2 = clamp01(Math.max(d.start.y, this.mouseNorm.y));
      if (x2 - x1 > 0.004 && y2 - y1 > 0.004) {
        // Every new shape starts UNLABELED and asks for its name.
        const a = { id: uuid(), labelId: null, type: "bbox", rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, line: null };
        this._mutate([...this.annotations, a]);
        this.selectedId = a.id; this.pendingLabelId = a.id;
        this._syncEditors();
      }
    }
    if (d.mode === "draw-lasso") { this._finishLasso(); return; }
    if (d.mode !== "draw-poly") this.drag = { mode: "none" };
    this.draw();
  }

  _finishPolygon() {
    const d = this.drag;
    if (d.mode !== "draw-poly" || !d.points || d.points.length < 3) { this._cancelPolygon(); return; }
    const a = { id: uuid(), labelId: null, type: "polygon", points: d.points, line: null };
    this.drag = { mode: "none" };
    this._mutate([...this.annotations, a]);
    this.selectedId = a.id; this.pendingLabelId = a.id;
    this._syncEditors();
  }
  _cancelPolygon() { if (this.drag.mode === "draw-poly") this.drag = { mode: "none" }; }
  _cancelLasso() { if (this.drag.mode === "draw-lasso") this.drag = { mode: "none" }; }

  /** Finalizes a freehand line-annotation region: needs at least 3 points to
   *  be a real polygon (fewer is treated as a stray click/tiny accidental
   *  drag and just discarded). The new region's line number defaults to one
   *  past whatever the highest region line currently is -- "starting from 1
   *  and so on" for the first region on a fresh image, continuing on from
   *  there for subsequent ones -- and is immediately editable via the
   *  floating chip _syncEditors() opens for it (see _openRegionChip). */
  _finishLasso() {
    const d = this.drag;
    this.drag = { mode: "none" };
    if (!d.points || d.points.length < 3) { this.draw(); return; }
    const points = d.points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
    const nextLine = this.lineRegions.reduce((m, r) => Math.max(m, r.line), 0) + 1;
    const region = { id: uuid(), points, line: nextLine };
    this._mutateRegions([...this.lineRegions, region]);
    this.selectedId = null; this.pendingLabelId = null;
    this.selectedRegionId = region.id;
    this._syncEditors();
  }

  // ---------- floating label editor + line chip ----------
  _closeEditors() {
    if (this.labelEditor) { this.labelEditor.remove(); this.labelEditor = null; }
    if (this.lineChip) { this.lineChip.remove(); this.lineChip = null; }
    if (this.regionChip) { this.regionChip.remove(); this.regionChip = null; }
  }

  _syncEditors() {
    this._closeEditors();
    // Both float together whenever there's a selection: the label editor
    // (only while the shape still needs naming) alongside the line-number
    // chip (whenever anything is selected), rather than the line chip
    // waiting for the label editor to close first (e.g. via Escape).
    const pending = this.annotations.find((a) => a.id === this.pendingLabelId);
    if (pending && this.showLabelInput) this._openLabelEditor(pending);
    const sel = this.annotations.find((a) => a.id === this.selectedId);
    if (sel) this._openLineChip(sel);
    const selRegion = this.lineRegions.find((r) => r.id === this.selectedRegionId);
    if (selRegion) this._openRegionChip(selRegion);
  }

  /** Top-center or bottom-center anchor point of a shape, in canvas
   *  coordinates -- used to position floating UI symmetrically above/below
   *  the shape rather than off to one side. */
  _anchor(a, where) {
    if (a.type === "bbox") {
      const r = a.rect;
      return where === "below"
        ? this.toCanvas(r.x + r.w / 2, r.y + r.h)
        : this.toCanvas(r.x + r.w / 2, r.y);
    }
    const xs = a.points.map((p) => p.x), ys = a.points.map((p) => p.y);
    return where === "below"
      ? this.toCanvas(xs.reduce((s, v) => s + v, 0) / xs.length, Math.max(...ys))
      : this.toCanvas(xs.reduce((s, v) => s + v, 0) / xs.length, Math.min(...ys));
  }

  /** Top-center or bottom-center anchor point of a region's bounding box, in
   *  canvas coordinates -- same idea as _anchor() above but for a region's
   *  raw points array rather than an annotation object. */
  _regionAnchor(r, where) {
    const xs = r.points.map((p) => p.x), ys = r.points.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const y = where === "below" ? Math.max(...ys) : Math.min(...ys);
    return this.toCanvas(cx, y);
  }

  _positionFloatingUi() {
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    const GAP = 8;
    // Clearance between the chip and the shape's own top edge -- deliberately
    // bigger than GAP. Resize handles sit centered ON that edge and stick out
    // ~4px past it, so anything tighter risks the chip overlapping the very
    // handles you'd click to resize, or just sitting close enough to get in
    // the way of a drag. 16px clears the handles with room to spare.
    const CHIP_GAP = 16;

    // Line chip goes first -- centered ABOVE the shape (not off to a side,
    // where it could sit over the shape itself or crowd the cursor's room to
    // drag) -- and is measured (not assumed) so the overlap check below is
    // accurate even as its content (the line number) changes width.
    let chipRect = null;
    if (this.lineChip) {
      const a = this.annotations.find((x) => x.id === this.selectedId);
      if (a) {
        const w = this.lineChip.offsetWidth || 150, h = this.lineChip.offsetHeight || 30;
        const above = this._anchor(a, "above");
        let left = Math.max(4, Math.min(cw - w - 4, above.x - w / 2));
        let top = above.y - h - CHIP_GAP;
        if (top < 4) {
          // Not enough room above -- the shape sits near the top of the
          // visible canvas. Fall back to below it rather than clamping into
          // an overlap with the very shape this is meant to stay clear of.
          // (If the label editor also wants "below" for this shape, its own
          // overlap check further down repositions IT relative to wherever
          // the chip actually landed -- see chipRect below.)
          const below = this._anchor(a, "below");
          left = Math.max(4, Math.min(cw - w - 4, below.x - w / 2));
          top = below.y + CHIP_GAP;
        }
        top = Math.max(4, Math.min(ch - h - 4, top));
        this.lineChip.style.left = left + "px";
        this.lineChip.style.top = top + "px";
        chipRect = { left, top, right: left + w, bottom: top + h };
      }
    }

    // Label editor anchors below the shape by default. If that spot would
    // overlap the (already-placed) line chip -- a small shape and/or a
    // cramped canvas edge -- it tries each side of the CHIP in turn (below,
    // above, right, left). Each of those four guarantees ZERO overlap by
    // construction (pure axis separation: e.g. "below" only needs top to
    // clear the chip's bottom edge -- left doesn't matter once that's true),
    // and is only accepted if it also lands fully inside the canvas. If none
    // of the four fit fully on-screen, the canvas is smaller than the two
    // elements combined and no placement can satisfy both "on screen" and
    // "non-overlapping" at once -- a real (if rare) limit, not a bug.
    if (this.labelEditor) {
      const a = this.annotations.find((x) => x.id === this.pendingLabelId);
      if (a) {
        const c = this._anchor(a, "below");
        const w = this.labelEditor.offsetWidth || 240, h = this.labelEditor.offsetHeight || 40;
        const clampX = (l) => Math.max(4, Math.min(cw - w - 4, l));
        const clampY = (t) => Math.max(4, Math.min(ch - h - 4, t));
        let left = clampX(c.x - w / 2);
        let top = clampY(c.y + GAP);

        const overlapsChip = (l, t) =>
          chipRect && l < chipRect.right && l + w > chipRect.left && t < chipRect.bottom && t + h > chipRect.top;

        if (overlapsChip(left, top)) {
          const below = { left: clampX(c.x - w / 2), top: chipRect.bottom + GAP };
          const above = { left: clampX(c.x - w / 2), top: chipRect.top - GAP - h };
          const right = { left: chipRect.right + GAP, top: clampY(c.y + GAP) };
          const leftOf = { left: chipRect.left - GAP - w, top: clampY(c.y + GAP) };
          const fitsOnScreen = (p) => p.left >= 4 && p.top >= 4 && p.left + w <= cw - 4 && p.top + h <= ch - 4;
          const pick = [below, above, right, leftOf].find(fitsOnScreen);
          if (pick) { left = pick.left; top = pick.top; }
        }
        this.labelEditor.style.left = left + "px";
        this.labelEditor.style.top = top + "px";
      }
    }

    // Region chip: same above-with-below-fallback placement as the line
    // chip, anchored to the region's own bounding box instead of a shape's.
    // Never open at the same time as the line chip or label editor (regions
    // and shapes are mutually exclusive selections), so no overlap-avoidance
    // against those is needed here.
    if (this.regionChip) {
      const r = this.lineRegions.find((x) => x.id === this.selectedRegionId);
      if (r) {
        const w = this.regionChip.offsetWidth || 190, h = this.regionChip.offsetHeight || 30;
        const above = this._regionAnchor(r, "above");
        let left = Math.max(4, Math.min(cw - w - 4, above.x - w / 2));
        let top = above.y - h - CHIP_GAP;
        if (top < 4) {
          const below = this._regionAnchor(r, "below");
          left = Math.max(4, Math.min(cw - w - 4, below.x - w / 2));
          top = below.y + CHIP_GAP;
        }
        top = Math.max(4, Math.min(ch - h - 4, top));
        this.regionChip.style.left = left + "px";
        this.regionChip.style.top = top + "px";
      }
    }
  }

  _suggestions(query) {
    const seen = new Set();
    const all = [];
    for (const src of [(this.opts.getLabels() || []).map((l) => l.name), loadHistory()]) {
      for (const raw of src) {
        const name = String(raw).trim(), lower = name.toLowerCase();
        if (!name || seen.has(lower)) continue;
        seen.add(lower); all.push(name);
      }
    }
    all.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const q = query.trim().toLowerCase();
    if (!q) {
      const def = this.lastAssigned || loadHistory()[0];
      if (def) {
        const i = all.findIndex((n) => n.toLowerCase() === def.toLowerCase());
        if (i > 0) all.unshift(all.splice(i, 1)[0]);
      }
      return all.slice(0, SUGGESTIONS_SHOWN);
    }
    return all.filter((n) => n.toLowerCase().startsWith(q)).slice(0, SUGGESTIONS_SHOWN);
  }

  _openLabelEditor(annotation) {
    const el = document.createElement("div");
    el.className = "label-editor";
    el.innerHTML = `<input type="text" placeholder="Name this label… (Enter)" />
      <ul class="label-suggestions"></ul>
      <div class="label-hint"></div>`;
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    this.container.appendChild(el);
    this.labelEditor = el;

    const input = el.querySelector("input");
    const list = el.querySelector("ul");
    const hint = el.querySelector(".label-hint");
    let highlight = -1;
    let items = [];

    const render = () => {
      items = this._suggestions(input.value);
      if (highlight === -1 && !input.value && items.length && (this.lastAssigned || loadHistory()[0])) highlight = 0;
      list.innerHTML = items.map((n, i) =>
        `<li class="${i === highlight ? "hl" : ""}" data-name="${n.replace(/"/g, "&quot;")}">${n}</li>`).join("");
      hint.textContent = highlight >= 0 && items[highlight]
        ? `Enter ↵ "${items[highlight]}" · new names become labels · Esc to skip`
        : "New names become labels automatically · Esc to skip";
      // The suggestion list's height changes with every keystroke, which can
      // newly create (or resolve) an overlap with the line chip -- rerun the
      // anti-overlap layout each time, not just once at open.
      this._positionFloatingUi();
    };
    render();
    setTimeout(() => input.focus(), 0);

    const commit = async (name) => {
      const trimmed = String(name || "").trim();
      if (!trimmed) return;
      input.disabled = true;
      hint.textContent = "Saving label…";
      const labels = this.opts.getLabels() || [];
      let label = labels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
      if (!label) label = await this.opts.createLabel(trimmed);
      if (!label) { input.disabled = false; hint.textContent = "Could not create label"; return; }
      rememberLabel(label.name);
      this.lastAssigned = label.name;
      this.activeLabelId = label.id;
      this._mutate(this.annotations.map((a) => (a.id === annotation.id ? { ...a, labelId: label.id } : a)));
      this.pendingLabelId = null;
      this._syncEditors();
    };

    input.addEventListener("input", () => { highlight = -1; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); highlight = Math.min(highlight + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); highlight = Math.max(highlight - 1, -1); render(); }
      else if (e.key === "Enter") { e.preventDefault(); commit(highlight >= 0 ? items[highlight] : input.value); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.pendingLabelId = null; this._syncEditors(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && !input.value) {
        // Nothing typed yet, so there's no text to delete -- treat it as
        // "get rid of this shape" instead, the same key you'd use anywhere
        // else on the canvas. Once you've typed a character, Backspace/
        // Delete edit the text like normal, same as any other input.
        e.preventDefault(); e.stopPropagation();
        this.selectedId = null; this.pendingLabelId = null; this._closeEditors();
        this._mutate(this.annotations.filter((a) => a.id !== annotation.id));
      }
    });
    list.addEventListener("click", (e) => {
      const li = e.target.closest("li");
      if (li) commit(li.dataset.name);
    });
    this._positionFloatingUi();
  }

  _openLineChip(annotation) {
    const info = LFLines.computeLineNumbers(this.annotations, this.lineRegions).get(annotation.id);
    if (!info) return;
    const el = document.createElement("div");
    el.className = "line-chip";
    // A shape currently covered by a line-annotation region (>50% of its
    // area, see lib/lines.js) has its line number governed by that region,
    // not by this per-shape override -- typing a number here would just get
    // silently overwritten again on the next recompute. Rather than let that
    // happen invisibly, the input is disabled with an explanatory note
    // pointing at the region instead (same "explain why, don't just block"
    // pattern as the export modal's fixed-coordinate notes).
    if (info.isRegion) {
      el.innerHTML = `<span>Line ${info.line}</span><span class="faint">set by a line-annotation region — select it to change</span>`;
    } else {
      el.innerHTML = `<span>Line</span><input type="number" min="1" value="${info.line}" />
        <button type="button" class="${info.isManual ? "manual" : "auto"}" title="${info.isManual ? `Back to automatic (would be line ${info.autoLine})` : "Automatic from y-position — type a number to override"}">auto</button>`;
    }
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    this.container.appendChild(el);
    this.lineChip = el;

    if (!info.isRegion) {
      const input = el.querySelector("input");
      input.addEventListener("change", () => {
        const v = parseInt(input.value, 10);
        if (isFinite(v) && v >= 1) {
          this._mutate(this.annotations.map((a) => (a.id === annotation.id ? { ...a, line: v } : a)));
          this._syncEditors();
        }
      });
      el.querySelector("button").addEventListener("click", () => {
        this._mutate(this.annotations.map((a) => (a.id === annotation.id ? { ...a, line: null } : a)));
        this._syncEditors();
      });
    }
    this._positionFloatingUi();
  }

  /** Floating chip for a selected line-annotation region: change its line
   *  number (re-sweeps automatically -- computeLineNumbers() is recomputed
   *  fresh on every draw(), there's no separately-cached membership to go
   *  stale) or delete the region outright. */
  _openRegionChip(region) {
    const info = LFLines.computeLineNumbers(this.annotations, this.lineRegions);
    let memberCount = 0;
    for (const i of info.values()) if (i.regionId === region.id) memberCount++;
    const el = document.createElement("div");
    el.className = "line-chip region-chip";
    el.innerHTML = `<span>Line</span><input type="number" min="1" value="${region.line}" />
      <span class="faint">${memberCount} shape${memberCount === 1 ? "" : "s"}</span>
      <button type="button" class="danger" title="Delete this region — shapes inside fall back to their own line">Delete</button>`;
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    this.container.appendChild(el);
    this.regionChip = el;

    const input = el.querySelector("input");
    input.addEventListener("change", () => {
      const v = parseInt(input.value, 10);
      if (isFinite(v) && v >= 1) {
        this._mutateRegions(this.lineRegions.map((r) => (r.id === region.id ? { ...r, line: v } : r)));
        this._syncEditors();
      }
    });
    el.querySelector("button").addEventListener("click", () => {
      this.selectedRegionId = null;
      this._closeEditors();
      this._mutateRegions(this.lineRegions.filter((r) => r.id !== region.id));
    });
    this._positionFloatingUi();
  }

  destroy() {
    window.removeEventListener("keydown", this._keyHandler);
    this._resizeObserver.disconnect();
    this._closeEditors();
    this.canvas.remove();
  }
}

window.AnnotationCanvas = AnnotationCanvas;
