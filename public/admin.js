"use strict";
/**
 * Admin panel. Loopback-only (see server.js) so there is no login: whoever
 * can reach this page IS the admin. Flow: create a project once -> upload a
 * dataset (with an optional, separate annotations folder) -> manage labels
 * -> browse/annotate/export images.
 *
 * The dataset upload panel is the important bit for this feature: choosing
 * an annotations folder is entirely optional. If skipped, images import
 * unlabeled exactly like before. If chosen, lib/importer.js flat-matches
 * every file in that folder to an image by filename and plots whatever it
 * finds as normal, fully editable shapes (same select/drag/resize/relabel
 * tools the labelers use) -- see the "Supports ..." line in the panel for
 * which formats are understood.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");

let state = { project: null, stats: null, users: [] };
let imagesPage = { images: [], total: 0, offset: 0, limit: 50, status: "ALL", q: "" };
let uploadState = { datasetPath: "", annotationsPath: "", annotationsPathCleared: false, lastResult: null, importing: false };
let searchDebounce = null;
// Snapshot of the image list + filters at the moment an editor was opened
// from a gallery row, so Prev/Next can walk it (and lazily fetch adjacent
// pages when you reach an edge) without re-deriving it from scratch.
let editorNav = null;
// The AnnotationCanvas of whichever editor is currently open, if any. Kept
// at module scope (rather than only as openEditor()'s local const) so the
// single global keyboard-shortcut listener below can reach it.
let activeCanvas = null;

// Tool switching lives here (module scope, added once) so it works whether
// triggered by a button click or a global keyboard shortcut, and so we only
// ever attach ONE keydown listener for the page's lifetime (attaching this
// inside openEditor() would stack a new listener every time an image is opened).
function selectTool(name) {
  if (!activeCanvas) return;
  // "line-lasso" has no [data-tool] button of its own -- it's driven by the
  // "Line annotation" checkbox instead (see wireLineAnnotationToggle) -- so
  // the button lookup below is allowed to come up empty; every OTHER tool
  // still has a real button to highlight.
  document.querySelectorAll("[data-tool]").forEach((x) => x.classList.remove("active"));
  const btn = document.querySelector(`[data-tool="${name}"]`);
  if (btn) btn.classList.add("active");
  activeCanvas.setTool(name);
  const el = $("#holder .anno-canvas");
  if (el) el.classList.toggle("select", name === "select");
  // Keep the checkbox in sync however the tool actually changed -- clicking
  // a normal tool button while it's checked should uncheck it, same as
  // checking it should deactivate the normal tool buttons above.
  const lassoChk = $("#line-annotation-tool");
  if (lassoChk) lassoChk.checked = name === "line-lasso";
}

window.addEventListener("keydown", (e) => {
  if (!activeCanvas || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  const key = e.key.toLowerCase();
  // Shift+Z is a TOGGLE (on -> off -> on), unlike A/S/D which always select
  // their tool outright -- matches the "Line annotation" checkbox's own
  // on/off nature rather than the exclusive Select/Box/Polygon tool group.
  if (key === "z") { e.preventDefault(); selectTool(activeCanvas.tool === "line-lasso" ? "select" : "line-lasso"); return; }
  const map = { a: "select", s: "bbox", d: "polygon" };
  if (map[key]) { e.preventDefault(); selectTool(map[key]); }
});

// Ctrl/Cmd+S saves, same as clicking the Save button -- see app.js for the
// identical labeler-side version and the reasoning (always prevents the
// browser save dialog, works even while a floating input has focus).
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
  e.preventDefault();
  const btn = $("#save");
  if (btn && !btn.disabled) btn.click();
});

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON (e.g. empty) response */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

const escAttr = (s) => String(s || "").replace(/"/g, "&quot;");

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------- boot / project picker ----------------
async function refreshState() { state = await api("/api/admin/state"); }

async function boot() {
  // A fresh boot always follows create/resume/unload -- never carry stale
  // dataset-path fields or list filters from whichever project was active
  // before into the next one.
  uploadState = { datasetPath: "", annotationsPath: "", annotationsPathCleared: false, lastResult: null, importing: false };
  imagesPage = { images: [], total: 0, offset: 0, limit: 50, status: "ALL", q: "" };
  editorNav = null;

  try { await refreshState(); }
  catch (err) {
    app.innerHTML = `<div class="page"><div class="notice err">Could not reach the server: ${err.message}</div></div>`;
    return;
  }
  $("#proj-name").textContent = state.project ? state.project.name : "";
  if (!state.project) return renderProjectPicker();
  renderDashboard();
}

async function renderProjectPicker(error) {
  let projects = [];
  try { projects = (await api("/api/admin/projects")).projects; } catch { /* show create form regardless */ }

  app.innerHTML = `
    <div class="center-screen">
      <div style="width: 460px;">
        ${projects.length ? `
        <div class="card" style="padding:20px; margin-bottom:16px;">
          <h2>Resume a project</h2>
          <div class="stack" style="margin-top:10px;">
            ${projects.map((p) => `
              <div class="row" style="justify-content:space-between; padding:8px 10px; border:1px solid var(--line); border-radius:8px;">
                <div style="min-width:0;">
                  <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.name}</div>
                  <div class="faint">${p.imageCount} image(s) · ${p.completedCount} completed · ${p.labelCount} label(s)</div>
                </div>
                <div class="row">
                  <button class="btn sm primary" data-resume="${p.id}" type="button">Resume</button>
                  <button class="btn sm danger" data-delete="${p.id}" data-delete-name="${escAttr(p.name)}" type="button" title="Delete permanently">Delete</button>
                </div>
              </div>`).join("")}
          </div>
        </div>` : ""}
        <form id="create-project" class="card" style="padding: 26px;">
          <h1 style="margin-bottom: 4px;">New project</h1>
          <p class="muted" style="margin-bottom: 14px;">Give it a name, then upload a dataset from the dashboard.</p>
          ${error ? `<div class="notice err" style="margin-bottom: 10px;">${error}</div>` : ""}
          <label class="faint">Project name</label>
          <input class="input" name="name" required autofocus placeholder="e.g. Odia OCR — batch 3" style="margin-top:4px;" />
          <label class="faint" style="display:block; margin-top:12px;">Starting labels <span class="faint">(optional, comma-separated)</span></label>
          <input class="input" name="labels" placeholder="word, line, table" style="margin-top:4px;" />
          <button class="btn primary" style="width:100%; margin-top:16px;">Create project</button>
        </form>
      </div>
    </div>`;

  $("#create-project").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get("name") || "").trim();
    const labels = String(fd.get("labels") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!name) return;
    try {
      await api("/api/admin/project", { method: "POST", body: JSON.stringify({ name, labels }) });
      await boot();
    } catch (err) { renderProjectPicker(err.message); }
  });
  document.querySelectorAll("[data-resume]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Resuming…";
      try {
        await api(`/api/admin/projects/${btn.dataset.resume}/activate`, { method: "POST" });
        await boot();
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "Resume"; }
    });
  });
  document.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDeleteProject(btn.dataset.delete, btn.dataset.deleteName);
      if (ok) renderProjectPicker();
    });
  });
}

/**
 * Two-step, deliberately annoying confirmation for an irreversible action:
 * a confirm() explaining exactly what is and isn't deleted, then a prompt()
 * requiring the project's exact name to be typed back. Returns true if the
 * project was actually deleted.
 */
async function confirmDeleteProject(id, name) {
  const step1 = confirm(
    `Permanently delete "${name}"?\n\n` +
    `This removes every image record, annotation, and label this app has for the project, ` +
    `and cannot be undone.\n\n` +
    `The dataset and annotations folders on your disk are NOT touched — only this app's ` +
    `tracking data goes away.`
  );
  if (!step1) return false;
  const typed = prompt(`Type the project name exactly to confirm: "${name}"`);
  if (typed !== name) {
    if (typed !== null) alert("Name didn't match — nothing was deleted.");
    return false;
  }
  try {
    await api(`/api/admin/projects/${id}`, { method: "DELETE" });
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

// ---------------- dashboard shell ----------------
function renderDashboard() {
  activeCanvas = null; // leaving the editor (if we were in one) -- shortcuts should go quiet
  if (!uploadState.datasetPath && state.project.datasetPath) uploadState.datasetPath = state.project.datasetPath;
  // Pre-fill from whatever the project already has on file -- but NOT if the
  // user just explicitly cleared this field: without that check, Clear would
  // blank the field and then this exact line (running again on the
  // re-render Clear triggers) would immediately put the old path right back,
  // making the button look completely broken.
  if (!uploadState.annotationsPath && !uploadState.annotationsPathCleared && state.project.annotationsPath) uploadState.annotationsPath = state.project.annotationsPath;

  $("#proj-name").textContent = state.project.name;
  app.innerHTML = `
    <div class="page" style="max-width:1440px;">
      <div class="row" style="justify-content:space-between; margin-bottom:16px;">
        <div>
          <h1>${state.project.name}</h1>
          <div id="stats-badges" class="row" style="margin-top:6px;"></div>
        </div>
        <div class="row">
          <button id="unload" class="btn sm" type="button">Unload project</button>
          <button id="refresh" class="btn sm">Refresh</button>
        </div>
      </div>
      <div class="admin-grid">
        <div class="stack">
          ${renderUploadPanel()}
        </div>
        <div class="stack">
          ${renderLabelsPanel()}
          ${renderExportPanel()}
        </div>
      </div>
      <div style="margin-top:20px;">
        ${renderImagesPanel()}
      </div>
      <section class="card" style="padding:16px; margin-top:20px; border-color:#fecaca;">
        <h2 style="color:var(--red);">Danger zone</h2>
        <p class="faint" style="margin:6px 0 10px;">
          Permanently deletes this project's tracking data — image list, every annotation, labels,
          claim history — from this app. The dataset and annotations folders on disk are never
          touched; re-running Import against the same folder later starts a brand-new, empty project.
        </p>
        <button id="delete-project" class="btn sm danger" type="button">Delete this project permanently</button>
      </section>
    </div>`;

  updateStatsBadges();
  wireDashboard();
  loadImages();
}

function updateStatsBadges() {
  const s = state.stats || { total: 0, unclaimed: 0, claimed: 0, completed: 0 };
  const el = $("#stats-badges");
  if (!el) return;
  const userCount = (state.users || []).length;
  el.innerHTML = `
    <span class="badge gray">${s.total} total</span>
    <span class="badge gray">${s.unclaimed} unclaimed</span>
    <span class="badge amber">${s.claimed} in progress</span>
    <span class="badge green">${s.completed} completed</span>
    <button type="button" id="users-pill" class="badge gray pill-btn" title="View labelers">${userCount} labeler${userCount === 1 ? "" : "s"}</button>`;
  $("#users-pill").addEventListener("click", openUsersDialog);
}

// Was a standalone "Labelers" card in the right column; now a click-through
// on the users-pill above (next to the other stat badges) instead, since a
// whole permanent section for what's usually a short, rarely-checked list
// took up more space than it earned -- same info, one click away instead of
// always-on screen real estate.
function openUsersDialog() {
  const users = state.users || [];
  const dlg = document.createElement("dialog");
  dlg.className = "export-coords-dialog users-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>Labelers</h3>
      ${users.length ? `
        <div class="stack" style="margin-top:10px; max-height:320px; overflow-y:auto;">
          ${users.map((u) => `
            <div class="row" style="justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--line);">
              <span>${u.name}</span><span class="faint">${timeAgo(u.lastSeenAt)}</span>
            </div>`).join("")}
        </div>` : `<p class="faint" style="margin-top:10px;">No one has joined yet.</p>`}
      <div class="row" style="justify-content:flex-end; margin-top:16px;">
        <button type="submit" class="btn">Close</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

function wireDashboard() {
  $("#refresh").addEventListener("click", async () => { await refreshState(); renderDashboard(); });
  $("#unload").addEventListener("click", async () => {
    if (!confirm("Unload this project? Nothing is deleted — every image, annotation, and label stays exactly as it is, and you can resume from the project picker any time.")) return;
    try { await api("/api/admin/unload", { method: "POST" }); await boot(); }
    catch (err) { alert(err.message); }
  });
  $("#delete-project").addEventListener("click", async () => {
    const ok = await confirmDeleteProject(state.project.id, state.project.name);
    if (ok) await boot();
  });
  wireUploadPanel();
  wireImagesPanel();
  wireLabelsPanel();
  wireExportPanel();
}

// ---------------- upload panel (dataset + optional annotations folder) ----------------
function renderUploadPanel() {
  return `
    <section id="upload-panel" class="card" style="padding:16px;">
      <h2>Upload dataset</h2>
      <p class="faint" style="margin-bottom:12px;">
        Point at a folder of images. Optionally also point at a separate folder of existing
        annotations — they're matched to images by filename and plotted automatically as
        editable bboxes/polygons using the same select/drag/resize tools as everywhere else.
      </p>
      <div class="stack">
        <div>
          <label class="faint">Dataset folder</label>
          <div class="row" style="margin-top:4px; flex-wrap:nowrap;">
            <input class="input grow" id="dataset-path" value="${escAttr(uploadState.datasetPath)}" placeholder="/path/to/images" />
            <button class="btn sm" id="browse-dataset" type="button">Browse…</button>
          </div>
        </div>
        <div>
          <label class="faint">Annotations folder <span class="faint">(optional)</span></label>
          <div class="row" style="margin-top:4px; flex-wrap:nowrap;">
            <input class="input grow" id="annotations-path" value="${escAttr(uploadState.annotationsPath)}" placeholder="Not set — images import unlabeled" />
            <button class="btn sm" id="browse-annotations" type="button">Browse…</button>
            ${uploadState.annotationsPath ? `<button class="btn sm" id="clear-annotations" type="button">Clear</button>` : ""}
          </div>
          <ul class="hint-list" style="margin-top:8px;">
            <li><strong>Formats:</strong> Pascal VOC XML, this app's own JSON, LabelMe JSON, one dataset-wide COCO JSON manifest, and YOLO .txt (reads classes.txt / obj.names / data.yaml for names).</li>
            <li><strong>Detector/OCR output</strong> (<span class="mono">{boxes:[{bbox,confidence}]}</span>) imports as unlabeled boxes — no class names in the source, so a labeler names each one.</li>
            <li><strong>Matching:</strong> ignores subfolders — any file with the same filename (minus extension) as an image is used for it.</li>
          </ul>
        </div>
        <button class="btn primary" id="import-btn" ${uploadState.datasetPath ? "" : "disabled"} ${uploadState.importing ? "disabled" : ""}>
          ${uploadState.importing ? "Importing…" : "Import dataset"}
        </button>
        <p class="faint">Safe to re-run: brand-new images are added, and any already-uploaded image with zero shapes gets backfilled from this folder too — no matter its claim/completion status. The only thing never touched is an image that already has shapes, imported or hand-drawn.</p>
        ${renderImportResult()}
      </div>
    </section>`;
}

function renderImportResult() {
  const r = uploadState.lastResult;
  if (!r) return "";
  if (r.error) return `<div class="notice err">${r.error}</div>`;
  const formatBits = Object.entries(r.formatCounts || {}).map(([k, v]) => `${v} ${k}`).join(", ");
  const hasIssues = (r.skipped || []).length || (r.unmatchedAnnotations || []).length;
  return `
    <div class="notice ${hasIssues ? "warn" : "info"}">
      <div>${r.added} new image(s) of ${r.scanned} scanned · ${r.importedLabels} pre-labeled${formatBits ? ` (${formatBits})` : ""}${r.backfilled ? ` · ${r.backfilled} backfilled onto already-uploaded images` : ""}</div>
      ${r.unmatchedAnnotations && r.unmatchedAnnotations.length ? `<div style="margin-top:6px;"><strong>${r.unmatchedAnnotations.length}</strong> annotation file(s) matched no image at all: ${r.unmatchedAnnotations.slice(0, 8).join(", ")}${r.unmatchedAnnotations.length > 8 ? "…" : ""}</div>` : ""}
      ${r.alreadyCovered && r.alreadyCovered.length ? `<div class="faint" style="margin-top:6px;">${r.alreadyCovered.length} file(s) matched an image that already has annotations (or is claimed/completed), so were left alone: ${r.alreadyCovered.slice(0, 8).join(", ")}${r.alreadyCovered.length > 8 ? "…" : ""}</div>` : ""}
      ${r.skipped && r.skipped.length ? `<div style="margin-top:6px;"><strong>${r.skipped.length}</strong> skipped: ${r.skipped.slice(0, 8).map((s) => `${s.name} (${s.reason})`).join("; ")}${r.skipped.length > 8 ? "…" : ""}</div>` : ""}
    </div>`;
}

function wireUploadPanel() {
  $("#dataset-path").addEventListener("change", (e) => { uploadState.datasetPath = e.target.value.trim(); syncImportButton(); });
  $("#annotations-path").addEventListener("change", (e) => { uploadState.annotationsPath = e.target.value.trim(); });
  $("#browse-dataset").addEventListener("click", async () => {
    const p = await browseFolder("Select a dataset folder (images)");
    if (p) { uploadState.datasetPath = p; renderDashboard(); }
  });
  $("#browse-annotations").addEventListener("click", async () => {
    const p = await browseFolder("Select an annotations folder (JSON / XML / YOLO txt)");
    if (p) { uploadState.annotationsPath = p; renderDashboard(); }
  });
  const clearBtn = $("#clear-annotations");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    uploadState.annotationsPath = "";
    uploadState.annotationsPathCleared = true;
    renderDashboard();
  });
  $("#import-btn").addEventListener("click", runImport);
}

function syncImportButton() {
  const btn = $("#import-btn");
  if (btn) btn.disabled = !uploadState.datasetPath || uploadState.importing;
}

async function browseFolder(title) {
  try {
    const data = await api("/api/admin/pick-folder", { method: "POST", body: JSON.stringify({ title }) });
    return data.cancelled ? null : data.path;
  } catch (err) {
    alert(err.message);
    return null;
  }
}

async function runImport() {
  uploadState.datasetPath = $("#dataset-path").value.trim();
  uploadState.annotationsPath = $("#annotations-path").value.trim();
  uploadState.importing = true;
  renderDashboard();
  try {
    const body = { path: uploadState.datasetPath };
    if (uploadState.annotationsPath) body.annotationsPath = uploadState.annotationsPath;
    uploadState.lastResult = await api("/api/admin/dataset", { method: "POST", body: JSON.stringify(body) });
    await refreshState();
  } catch (err) {
    uploadState.lastResult = { error: err.message };
  }
  uploadState.importing = false;
  renderDashboard();
}

// ---------------- images panel ----------------
function renderImagesPanel() {
  return `
    <section id="images-panel" class="card" style="padding:16px;">
      <div class="row" style="justify-content:space-between; margin-bottom:10px;">
        <h2 style="margin:0;">Images (${imagesPage.total})</h2>
        <div class="row">
          <select id="status-filter" class="input" style="width:auto;">
            <option value="ALL">All</option>
            <option value="UNCLAIMED">Unclaimed</option>
            <option value="CLAIMED">In progress</option>
            <option value="COMPLETED">Completed</option>
          </select>
          <input id="search" class="input" style="width:160px;" placeholder="Search filename…" value="${escAttr(imagesPage.q)}" />
        </div>
      </div>
      <div id="image-list">${renderImageRows()}</div>
      <div class="pager" style="justify-content:space-between; margin-top:10px;">
        <button id="prev-page" class="btn sm" ${imagesPage.offset === 0 ? "disabled" : ""}>&larr; Prev</button>
        <span class="faint">${imagesPage.total ? imagesPage.offset + 1 : 0}–${Math.min(imagesPage.offset + imagesPage.limit, imagesPage.total)} of ${imagesPage.total}</span>
        <button id="next-page" class="btn sm" ${imagesPage.offset + imagesPage.limit >= imagesPage.total ? "disabled" : ""}>Next &rarr;</button>
      </div>
    </section>`;
}

function renderImageRows() {
  if (!imagesPage.images.length) return `<p class="faint">No images match.</p>`;
  // Sequence number reflects each image's position across the whole
  // filtered/sorted list (offset + index), matching the "X–Y of Z" pager
  // text below -- not just 1..N restarting on every page, which would be
  // confusing to cross-reference against that same pager.
  return `<div class="image-grid">` + imagesPage.images.map((img, i) => `
    <div class="image-card ${img.status === "COMPLETED" ? "completed" : ""}" data-id="${img.id}">
      <div class="image-card-thumb">
        <img src="/api/image/${img.id}/file" loading="lazy" alt="" />
        <span class="image-card-seq">#${imagesPage.offset + i + 1}</span>
        <span class="badge ${img.status === "COMPLETED" ? "green" : img.status === "CLAIMED" ? "amber" : "gray"}">${img.status.toLowerCase()}</span>
      </div>
      <div class="image-card-meta">
        <div class="name" title="${escAttr(img.fileName)}">${img.fileName}</div>
        <div class="faint" style="margin-top:3px;">${img.width}×${img.height} · ${img.annotationCount} shape(s)</div>
      </div>
    </div>`).join("") + `</div>`;
}

async function loadImages() {
  const focusedSearch = document.activeElement && document.activeElement.id === "search";
  const caret = focusedSearch ? document.activeElement.selectionStart : null;
  const params = new URLSearchParams({ offset: imagesPage.offset, limit: imagesPage.limit, status: imagesPage.status, q: imagesPage.q });
  let data;
  try { data = await api(`/api/admin/images?${params}`); }
  catch { return; }
  imagesPage.images = data.images;
  imagesPage.total = data.total;
  state.stats = data.stats;
  const panel = $("#images-panel");
  if (!panel) return;
  panel.outerHTML = renderImagesPanel();
  wireImagesPanel();
  updateStatsBadges();
  if (focusedSearch) {
    const el = $("#search");
    if (el) { el.focus(); el.setSelectionRange(caret, caret); }
  }
}

function wireImagesPanel() {
  const panel = $("#images-panel");
  if (!panel) return;
  panel.querySelector("#status-filter").value = imagesPage.status;
  panel.querySelector("#status-filter").addEventListener("change", (e) => {
    imagesPage.status = e.target.value; imagesPage.offset = 0; loadImages();
  });
  panel.querySelector("#search").addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    const v = e.target.value;
    searchDebounce = setTimeout(() => { imagesPage.q = v; imagesPage.offset = 0; loadImages(); }, 300);
  });
  panel.querySelector("#prev-page").addEventListener("click", () => {
    imagesPage.offset = Math.max(0, imagesPage.offset - imagesPage.limit); loadImages();
  });
  panel.querySelector("#next-page").addEventListener("click", () => {
    imagesPage.offset += imagesPage.limit; loadImages();
  });
  panel.querySelectorAll(".image-card[data-id]").forEach((card) => {
    card.addEventListener("click", () => {
      editorNav = {
        ids: imagesPage.images.map((i) => ({ id: i.id, fileName: i.fileName })),
        meta: { offset: imagesPage.offset, limit: imagesPage.limit, status: imagesPage.status, q: imagesPage.q, total: imagesPage.total },
      };
      openEditor(card.dataset.id);
    });
  });
}

// ---------------- labels panel ----------------
function renderLabelsPanel() {
  const labels = state.project.labels || [];
  return `
    <section id="labels-panel" class="card" style="padding:16px;">
      <h2>Labels</h2>
      <div class="chips" style="margin:10px 0;">
        ${labels.length ? labels.map((l) => `
          <span class="chip"><span class="swatch" style="background:${l.color}"></span>${l.name}<button data-del="${l.id}" title="Delete label" type="button">×</button></span>`).join("")
          : `<p class="faint">No labels yet.</p>`}
      </div>
      <form id="add-label" class="tag-input-row">
        <input class="input" name="name" placeholder="New label name" />
        <button class="btn sm">Add</button>
      </form>
    </section>`;
}

function wireLabelsPanel() {
  const form = $("#add-label");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("input[name=name]");
    const name = input.value.trim();
    if (!name) return;
    try {
      const res = await api("/api/admin/labels", { method: "POST", body: JSON.stringify({ name }) });
      if (!state.project.labels.some((l) => l.id === res.label.id)) state.project.labels.push(res.label);
      refreshLabelsPanel();
    } catch (err) { alert(err.message); }
  });
  document.querySelectorAll("#labels-panel [data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this label? Shapes using it become unlabeled, everywhere.")) return;
      try {
        await api(`/api/admin/labels/${btn.dataset.del}`, { method: "DELETE" });
        state.project.labels = state.project.labels.filter((l) => l.id !== btn.dataset.del);
        refreshLabelsPanel();
      } catch (err) { alert(err.message); }
    });
  });
}

function refreshLabelsPanel() {
  const panel = $("#labels-panel");
  if (!panel) return;
  panel.outerHTML = renderLabelsPanel();
  wireLabelsPanel();
}

// ---------------- export panel ----------------
// A single "Export" button + modal (askBulkExport, below) replaces what used
// to be 5 separate format buttons plus a standalone checkbox and two dense
// explanation paragraphs -- the format-specific details (what each format
// carries, its fixed coordinate convention, etc.) now live as inline notes
// next to each choice inside the modal itself, where they're read exactly
// once, right when they matter, instead of permanently taking up space here.
function renderExportPanel() {
  return `
    <section id="export-panel" class="card" style="padding:16px;">
      <h2>Export</h2>
      <ul class="hint-list">
        <li><strong>JSON / XML</strong> are this app's own formats — the only two that round-trip losslessly (polygons, manual line numbers included) and let you choose a coordinate system.</li>
        <li><strong>VOC / COCO / YOLO</strong> are for other tools, each with one fixed coordinate convention by spec — see the note next to each when you export.</li>
      </ul>
      <button id="open-export-modal" class="btn primary" type="button" style="margin-top:14px; width:100%;">
        <svg viewBox="0 0 24 24" fill="none" width="15" height="15"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Export images
      </button>
    </section>`;
}

function wireExportPanel() {
  $("#open-export-modal").addEventListener("click", async () => {
    const choice = await askBulkExport();
    if (!choice) return; // cancelled
    const params = new URLSearchParams();
    if (choice.completedOnly) params.set("completedOnly", "true");
    // Coordinate system only means anything for this app's own json/xml
    // formats -- VOC/COCO/YOLO each have exactly one convention fixed by
    // their own spec, so the param is simply omitted for those (the server
    // ignores it either way, but there's no reason to send a value the
    // dialog itself just marked "fixed" and disabled).
    if (choice.coords && (choice.format === "json" || choice.format === "xml")) params.set("coords", choice.coords);
    const qs = params.toString();
    window.location.href = `/api/admin/export/${choice.format}${qs ? `?${qs}` : ""}`;
  });
}

/**
 * Bulk-export modal: format (json/xml/voc/coco/yolo) + coordinate system
 * (only meaningful for json/xml -- auto-disabled and replaced with a "fixed
 * by format" note for the other three, same reasoning as askExportCoords()
 * in canvas.js) + completed-only. Resolves to {format, coords, completedOnly}
 * or null if cancelled (Esc, backdrop dismissal, or the Cancel button).
 *
 * Shared by the dashboard's "Export images" button (every image in the
 * project, so completedOnly is a real choice) and the per-image editor's
 * "Export" button (a single, already-open image, where completedOnly is
 * meaningless -- pass showCompletedOnly: false to omit that toggle entirely
 * rather than showing a checkbox with no effect).
 */
function askBulkExport({ title = "Export images", showCompletedOnly = true } = {}) {
  const FORMATS = [
    { value: "json", label: "JSON", desc: "This app's own schema — round-trips back in as a pre-annotation import", coordsFixed: null },
    { value: "xml", label: "XML", desc: "Same content as JSON, in XML form", coordsFixed: null },
    { value: "voc", label: "Pascal VOC", desc: "Standard VOC XML for other tools — polygons degrade to their bounding box", coordsFixed: "Fixed: pixel (absolute), by the VOC spec" },
    { value: "coco", label: "COCO", desc: "One combined manifest for the whole project, not a zip — shapes with no label are left out", coordsFixed: "Fixed: pixel (absolute), by the COCO spec" },
    { value: "yolo", label: "YOLO", desc: "class_id cx cy w h per line, plus a shared classes.txt — shapes with no label are left out", coordsFixed: "Fixed: normalized, by the YOLO spec" },
  ];
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "export-coords-dialog bulk-export-dialog";
    dlg.innerHTML = `
      <form method="dialog">
        <h3>${title}</h3>
        <p class="faint">Choose a format and, for JSON/XML, a coordinate system.</p>

        <div class="section-title" style="margin-top:14px;">Format</div>
        <div class="coord-choice" id="bx-format">
          ${FORMATS.map((f, i) => `
            <label><input type="radio" name="format" value="${f.value}" ${i === 0 ? "checked" : ""} />
              <span><strong>${f.label}</strong><br><span class="faint">${f.desc}</span></span></label>`).join("")}
        </div>

        <div class="section-title" style="margin-top:14px;">Coordinates</div>
        <div class="coord-choice" id="bx-coords">
          <label><input type="radio" name="coords" value="normalized" />
            <span><strong>Normalized</strong><br><span class="faint">0–1, independent of image size</span></span></label>
          <label><input type="radio" name="coords" value="pixel" />
            <span><strong>Absolute</strong><br><span class="faint">actual x / y / width / height</span></span></label>
          <label><input type="radio" name="coords" value="both" checked />
            <span><strong>Both</strong><br><span class="faint">carries either, larger file</span></span></label>
        </div>
        <p class="faint" id="bx-coords-fixed" style="display:none; margin-top:6px;"></p>

        ${showCompletedOnly ? `
        <label class="row toggle-row" style="margin-top:14px;">
          <input type="checkbox" id="bx-completed-only" />
          <span>Completed images only</span>
        </label>` : ""}

        <div class="row" style="justify-content:flex-end; margin-top:18px; gap:8px;">
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="submit" class="btn primary">Download</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);

    const formatChoice = dlg.querySelector("#bx-format");
    const coordsChoice = dlg.querySelector("#bx-coords");
    const coordsFixedNote = dlg.querySelector("#bx-coords-fixed");

    const syncActive = (el) => el.querySelectorAll("label").forEach((l) => l.classList.toggle("active", l.querySelector("input").checked));

    function syncCoordsAvailability() {
      const format = formatChoice.querySelector('input[name="format"]:checked').value;
      const meta = FORMATS.find((f) => f.value === format);
      const disabled = Boolean(meta.coordsFixed);
      coordsChoice.querySelectorAll("input").forEach((inp) => { inp.disabled = disabled; });
      coordsChoice.style.opacity = disabled ? ".45" : "1";
      coordsFixedNote.style.display = disabled ? "block" : "none";
      coordsFixedNote.textContent = meta.coordsFixed || "";
      syncActive(coordsChoice);
    }

    formatChoice.addEventListener("change", () => { syncActive(formatChoice); syncCoordsAvailability(); });
    coordsChoice.addEventListener("change", () => syncActive(coordsChoice));
    syncActive(formatChoice);
    syncCoordsAvailability();

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
      const completedOnlyEl = dlg.querySelector("#bx-completed-only");
      finish({
        format: formatChoice.querySelector('input[name="format"]:checked').value,
        coords: coordsChoice.querySelector('input[name="coords"]:checked').value,
        completedOnly: completedOnlyEl ? completedOnlyEl.checked : false,
      });
    });
    dlg.addEventListener("cancel", () => finish(null)); // Esc key
    dlg.addEventListener("close", () => finish(null));  // any other dismissal path
    dlg.showModal();
  });
}

// ---------------- per-image editor (admin can edit/complete/reopen any image) ----------------
async function openEditor(imageId) {
  let data;
  try { data = await api(`/api/admin/image/${imageId}`); }
  catch (err) { alert(err.message); return; }
  const image = data.image;

  const navIdx = editorNav ? editorNav.ids.findIndex((i) => i.id === image.id) : -1;
  const hasPrev = editorNav && (navIdx > 0 || editorNav.meta.offset > 0);
  const hasNext = editorNav && navIdx >= 0 && (navIdx < editorNav.ids.length - 1 || editorNav.meta.offset + editorNav.meta.limit < editorNav.meta.total);
  const navPosition = editorNav && navIdx >= 0 ? `${editorNav.meta.offset + navIdx + 1} of ${editorNav.meta.total}` : "";

  app.innerHTML = `
    <div class="workspace">
      <aside class="side">
        <div class="row" style="justify-content:space-between; flex-wrap:nowrap;">
          <button id="back" class="btn sm" type="button">&larr; Back</button>
          ${navPosition ? `<span class="faint">${navPosition}</span>` : ""}
        </div>
        ${editorNav ? `
        <div class="row" style="flex-wrap:nowrap;">
          <button id="prev-image" class="btn sm" type="button" style="flex:1;" ${hasPrev ? "" : "disabled"}>&larr; Prev</button>
          <button id="next-image" class="btn sm" type="button" style="flex:1;" ${hasNext ? "" : "disabled"}>Next &rarr;</button>
        </div>` : ""}
        <div>
          <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${image.fileName}">${image.fileName}</div>
          <div class="faint"><span id="dims">${image.width}×${image.height}</span> · <span id="shape-count"></span></div>
          <span class="badge ${image.status === "COMPLETED" ? "green" : image.status === "CLAIMED" ? "amber" : "gray"}" style="margin-top:6px; display:inline-block;">${image.status.toLowerCase()}</span>
          ${image.claimedByName ? `<div class="faint">Claimed by ${image.claimedByName}</div>` : ""}
          ${image.importedFrom ? `<div class="faint" style="color:var(--amber);">Pre-labeled from ${image.importedFrom}</div>` : ""}
        </div>
        <div class="stack" style="margin-top:0;">
          <button id="save" class="btn" style="width:100%">Save</button>
          <button id="complete" class="btn primary" style="width:100%">Save &amp; Mark Complete</button>
          ${image.status === "COMPLETED" ? `<button id="reopen" class="btn sm" style="width:100%">Reopen</button>` : ""}
          <button type="button" id="export-image-btn" class="btn sm" style="width:100%;">
            <svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Export
          </button>
        </div>
        <div>
          <div class="section-title">Tools</div>
          <div class="tools">
            <button class="btn sm active" data-tool="select">Select<span class="kbd-badge">⇧A</span></button>
            <button class="btn sm" data-tool="bbox">Box<span class="kbd-badge">⇧S</span></button>
            <button class="btn sm" data-tool="polygon">Polygon<span class="kbd-badge">⇧D</span></button>
          </div>
        </div>
        <div class="stack" style="margin-top:0;">
          <label class="row toggle-row" title="Draw a freeform loop over several shapes to give them all the same line number -- fixes line numbers on a skewed page where the automatic top-to-bottom grouping guesses wrong">
            <input type="checkbox" id="line-annotation-tool" />
            <span>Line annotation<span class="kbd-badge">⇧Z</span></span>
          </label>
          <label class="row toggle-row">
            <input type="checkbox" id="show-line-numbers" />
            <span>Show line &amp; sequence numbers</span>
          </label>
          <label class="row toggle-row">
            <input type="checkbox" id="show-label-input" />
            <span>Show label input box</span>
          </label>
        </div>
        <div>
          <div class="section-title">Labels</div>
          <div id="labels" class="label-list"></div>
        </div>
        <div>
          <div class="section-title">Shapes</div>
          <div id="shapes" class="shape-list"></div>
        </div>
        <div style="margin-top:auto;" class="kbd-hints">
          <div class="section-title" style="margin-bottom:4px;">Shortcuts</div>
          <ul class="kbd-list">
            <li><kbd>Shift</kbd>+<kbd>A</kbd> Select tool</li>
            <li><kbd>Shift</kbd>+<kbd>S</kbd> Box tool</li>
            <li><kbd>Shift</kbd>+<kbd>D</kbd> Polygon tool</li>
            <li><kbd>Shift</kbd>+<kbd>Z</kbd> Toggle line annotation tool</li>
            <li><kbd>Ctrl</kbd>+scroll Zoom</li>
            <li>Scroll Pan (vertical)</li>
            <li><kbd>Shift</kbd>+scroll Pan (horizontal)</li>
            <li><kbd>Del</kbd> Remove shape</li>
            <li><kbd>Ctrl</kbd>+<kbd>S</kbd> Save</li>
            <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> Undo</li>
            <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> Redo</li>
            <li><kbd>Esc</kbd> Cancel drawing</li>
            <li><kbd>Enter</kbd> Finish polygon</li>
          </ul>
        </div>
      </aside>
      <div class="canvas-wrap"><div id="holder" class="canvas-holder"></div></div>
    </div>`;

  const canvas = new AnnotationCanvas($("#holder"), {
    getLabels: () => state.project.labels,
    createLabel: async (name) => {
      const res = await api("/api/admin/labels", { method: "POST", body: JSON.stringify({ name }) });
      if (!state.project.labels.some((l) => l.id === res.label.id)) state.project.labels.push(res.label);
      renderLabelChips();
      return res.label;
    },
    onChange: () => { refreshMeta(); renderShapesList(); },
  });
  activeCanvas = canvas;
  canvas.load(`/api/image/${image.id}/file`, image.width, image.height, image.annotations, image.lineRegions);
  $("#holder .anno-canvas").classList.add("select");
  const lineAnnoChk = $("#line-annotation-tool");
  lineAnnoChk.addEventListener("change", () => selectTool(lineAnnoChk.checked ? "line-lasso" : "select"));
  const showLinesChk = $("#show-line-numbers");
  showLinesChk.checked = canvas.showLineNumbers;
  showLinesChk.addEventListener("change", () => canvas.setShowLineNumbers(showLinesChk.checked));
  const showLabelInputChk = $("#show-label-input");
  showLabelInputChk.checked = canvas.showLabelInput;
  showLabelInputChk.addEventListener("change", () => canvas.setShowLabelInput(showLabelInputChk.checked));

  function renderLabelChips() {
    const el = $("#labels");
    el.innerHTML = state.project.labels.map((l) =>
      `<div class="label-item ${canvas.highlightLabelId === l.id ? "active" : ""}">
         <button type="button" class="label-item-main" data-id="${l.id}" title="Click to highlight every shape with this label on the canvas">
           <span class="swatch" style="background:${l.color}"></span><span class="grow">${l.name}</span>
         </button>
         <button type="button" class="label-item-del" data-del="${l.id}" title="Delete this label (unassigns it from every shape, project-wide)">×</button>
       </div>`).join("") || `<p class="faint">No labels yet — draw a shape and name it.</p>`;
    el.querySelectorAll(".label-item-main").forEach((b) => b.addEventListener("click", () => {
      canvas.setActiveLabel(b.dataset.id);
      canvas.toggleHighlightLabel(b.dataset.id);
      renderLabelChips();
    }));
    el.querySelectorAll(".label-item-del").forEach((b) => b.addEventListener("click", () => deleteLabelFromEditor(b.dataset.del)));
  }

  // Same destructive action as the dashboard's Labels panel (delete label,
  // unassign it from every shape across every image in the project) --
  // offered here too since editing an image is exactly when you're likely
  // to notice a label you want gone. The one thing the dashboard version
  // doesn't need to do: this image's canvas is already loaded in memory, so
  // if any of ITS shapes used the deleted label, sync that locally too
  // (canvas.unassignLabel) instead of leaving a stale label displayed until
  // a reload.
  async function deleteLabelFromEditor(labelId) {
    const label = state.project.labels.find((l) => l.id === labelId);
    if (!confirm(`Delete "${label ? label.name : "this label"}"? Shapes using it become unlabeled, everywhere.`)) return;
    try {
      await api(`/api/admin/labels/${labelId}`, { method: "DELETE" });
      state.project.labels = state.project.labels.filter((l) => l.id !== labelId);
      if (canvas.highlightLabelId === labelId) canvas.highlightLabelId = null;
      canvas.unassignLabel(labelId);
      renderLabelChips();
      renderShapesList();
      showToast("Label deleted");
    } catch (err) { showToast(err.message || "Could not delete label", { type: "error" }); }
  }
  function refreshMeta() {
    const el = $("#shape-count");
    if (el) el.textContent = `${canvas.getAnnotations().length} shapes`;
  }

  function renderShapesList() {
    const el = $("#shapes");
    if (!el) return;
    const shapes = canvas.getShapesSummary();
    el.innerHTML = shapes.map((s) =>
      `<div class="shape-item ${s.id === canvas.selectedId ? "active" : ""}">
         <button type="button" class="shape-item-main" data-id="${s.id}">
           <span class="tag">L${s.line}-${s.seq}</span>
           <span class="swatch" style="background:${s.color}"></span>
           <span class="name">${s.labelName || "Unlabeled"}</span>
         </button>
         <button type="button" class="shape-item-del" data-del="${s.id}" title="Delete this shape">×</button>
       </div>`).join("") || `<p class="faint">No shapes yet — draw a box or polygon.</p>`;
    el.querySelectorAll(".shape-item-main").forEach((b) => b.addEventListener("click", () => canvas.selectAnnotation(b.dataset.id)));
    el.querySelectorAll(".shape-item-del").forEach((b) => b.addEventListener("click", () => canvas.deleteAnnotation(b.dataset.del)));
  }

  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.addEventListener("click", () => selectTool(b.dataset.tool));
  });
  // Same format + coordinate-system modal as the dashboard's bulk "Export
  // images" button (askBulkExport, defined above) -- just scoped to this
  // one already-open image, so there's no completed-only toggle to show.
  $("#export-image-btn").addEventListener("click", async () => {
    const choice = await askBulkExport({ title: "Export this image", showCompletedOnly: false });
    if (!choice) return; // cancelled
    const params = new URLSearchParams();
    if (choice.coords && (choice.format === "json" || choice.format === "xml")) params.set("coords", choice.coords);
    const qs = params.toString();
    window.location.href = `/api/admin/export/${choice.format}/${image.id}${qs ? `?${qs}` : ""}`;
  });

  async function doSave(markComplete) {
    try {
      await api(`/api/admin/image/${image.id}/save`, {
        method: "POST",
        body: JSON.stringify({ annotations: canvas.getAnnotations(), lineRegions: canvas.getLineRegions(), markComplete }),
      });
      canvas.markSaved();
      await refreshState();
      showToast(markComplete ? "Saved & marked complete" : "Saved");
      // Stay on this image instead of bouncing back to the dashboard grid.
      // Re-opening it (rather than leaving the pre-save DOM as-is) refreshes
      // the status badge, claim info, and Reopen button so the sidebar
      // actually reflects "this is now complete" -- same pattern the Reopen
      // button below already uses for the same reason.
      if (markComplete) return openEditor(image.id);
    } catch (err) { showToast(err.message || "Save failed", { type: "error" }); }
  }
  $("#save").addEventListener("click", () => doSave(false));
  $("#complete").addEventListener("click", () => doSave(true));
  const reopenBtn = $("#reopen");
  if (reopenBtn) reopenBtn.addEventListener("click", async () => {
    try { await api(`/api/admin/image/${image.id}/reopen`, { method: "POST" }); await refreshState(); openEditor(image.id); }
    catch (err) { alert(err.message); }
  });
  $("#back").addEventListener("click", () => {
    if (canvas.isDirty() && !confirm("You have unsaved changes. Leave anyway?")) return;
    renderDashboard();
  });
  const prevBtn = $("#prev-image");
  const nextBtn = $("#next-image");
  if (prevBtn) prevBtn.addEventListener("click", () => navigateEditor(image.id, -1, canvas));
  if (nextBtn) nextBtn.addEventListener("click", () => navigateEditor(image.id, 1, canvas));

  renderLabelChips();
  renderShapesList();
  refreshMeta();
}

/**
 * Prev/Next within the image list + filters captured when the editor was
 * opened (editorNav). Walks the already-loaded page first; at an edge,
 * lazily fetches the adjacent page from the server (same status/search
 * filter) so navigation crosses page boundaries instead of dead-ending at
 * whatever page size happened to be loaded.
 */
async function navigateEditor(currentImageId, direction, canvas) {
  if (!editorNav) return;
  if (canvas.isDirty() && !confirm("You have unsaved changes. Leave anyway?")) return;

  const idx = editorNav.ids.findIndex((i) => i.id === currentImageId);
  if (idx === -1) return;
  const targetIdx = idx + direction;

  if (targetIdx >= 0 && targetIdx < editorNav.ids.length) {
    return openEditor(editorNav.ids[targetIdx].id);
  }

  // At an edge of the currently loaded page -- fetch the adjacent page
  // (same filters) and jump to its first/last image.
  const { meta } = editorNav;
  const newOffset = direction > 0 ? meta.offset + meta.limit : meta.offset - meta.limit;
  if (newOffset < 0 || newOffset >= meta.total) return; // truly nothing more in that direction

  let data;
  try {
    const params = new URLSearchParams({ offset: newOffset, limit: meta.limit, status: meta.status, q: meta.q });
    data = await api(`/api/admin/images?${params}`);
  } catch (err) { alert(err.message); return; }
  if (!data.images.length) return;

  editorNav = {
    ids: data.images.map((i) => ({ id: i.id, fileName: i.fileName })),
    meta: { offset: newOffset, limit: meta.limit, status: meta.status, q: meta.q, total: data.total },
  };
  const nextImage = direction > 0 ? editorNav.ids[0] : editorNav.ids[editorNav.ids.length - 1];
  return openEditor(nextImage.id);
}

boot();
