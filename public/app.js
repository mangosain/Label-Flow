"use strict";
/**
 * LabelFlow (user) app. Flow: join with a name -> claim an unclaimed page ->
 * annotate -> SAVE (manual sync to the admin-side store) -> Save & Complete
 * unlocks the next claim. Work is NOT autosaved: the Save button is the
 * sync point (by design), and leaving with unsaved changes warns.
 */

const TOKEN_KEY = "labeler_identity";
const $ = (sel) => document.querySelector(sel);
const app = $("#app");

let identity = null; // {token, user:{id,name}}
let project = null;
let labels = [];
let currentImage = null;
let canvas = null;

// Tool switching lives here (module scope, added once) so it works whether
// triggered by a button click or a global keyboard shortcut, and so we only
// ever attach ONE keydown listener for the app's lifetime (attaching this
// inside renderWorkspace() would stack a new listener on every image).
function selectTool(name) {
  if (!canvas) return;
  const btn = document.querySelector(`[data-tool="${name}"]`);
  if (!btn) return;
  document.querySelectorAll("[data-tool]").forEach((x) => x.classList.remove("active"));
  btn.classList.add("active");
  canvas.setTool(name);
  const el = $("#holder .anno-canvas");
  if (el) el.classList.toggle("select", name === "select");
}

window.addEventListener("keydown", (e) => {
  if (!canvas || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  const key = e.key.toLowerCase();
  const map = { a: "select", s: "bbox", d: "polygon" };
  if (map[key]) { e.preventDefault(); selectTool(map[key]); }
});

// Ctrl/Cmd+S saves, same as clicking the Save button. Always prevents the
// browser's own "Save Page As" dialog, and -- like Ctrl+Z elsewhere in this
// app -- fires even while a floating input (label editor, line chip) has
// focus, since no text field here has any legitimate use for a literal
// Ctrl/Cmd+S chord. A no-op outside the workspace (no #save button exists
// on the join/claim screens).
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
  e.preventDefault();
  const btn = $("#save");
  if (btn && !btn.disabled) btn.click();
});

function loadIdentity() {
  try { const v = JSON.parse(localStorage.getItem(TOKEN_KEY)); return v && v.token ? v : null; }
  catch { return null; }
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (identity) headers["x-user-token"] = identity.token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); identity = null; renderJoin("Your session expired. Enter your name again."); throw new Error("unauthorized"); }
  return res;
}

function setWho() {
  $("#who").textContent = identity ? identity.user.name : "";
  $("#switch-user").hidden = !identity;
}

// ---------------- screens ----------------
function renderJoin(error) {
  app.innerHTML = `
    <div class="center-screen">
      <form id="join" class="card" style="width: 336px; padding: 22px;">
        <h1 style="margin-bottom: 4px;">Welcome</h1>
        <p class="muted" style="margin-bottom: 14px;">Enter your name to start labeling.</p>
        ${error ? `<div class="notice err" style="margin-bottom: 10px;">${error}</div>` : ""}
        <input class="input" name="name" maxlength="60" required autofocus placeholder="e.g. Priya Sharma" />
        <button class="btn primary" style="width: 100%; margin-top: 12px;">Continue</button>
        <p class="faint" style="text-align:center; margin-top: 10px;">No password needed — we'll remember you on this device.</p>
      </form>
    </div>`;
  $("#join").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get("name").trim();
    if (!name) return;
    const res = await fetch("/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const data = await res.json();
    if (!res.ok) return renderJoin(data.error || "Something went wrong");
    identity = { token: data.token, user: data.user };
    localStorage.setItem(TOKEN_KEY, JSON.stringify(identity));
    setWho();
    boot();
  });
}

function renderNoProject() {
  app.innerHTML = `
    <div class="center-screen">
      <div class="card" style="width: 400px; padding: 26px; text-align: center;">
        <h1 style="margin-bottom: 6px;">No active project</h1>
        <p class="muted">The admin hasn't set up a project yet. Check back in a moment.</p>
        <button id="retry" class="btn" style="margin-top: 14px;">Refresh</button>
      </div>
    </div>`;
  $("#retry").addEventListener("click", boot);
}

function renderClaimScreen(message) {
  const s = project.stats;
  app.innerHTML = `
    <div class="center-screen">
      <div class="card" style="width: 420px; padding: 26px; text-align: center;">
        <h1 style="margin-bottom: 4px;">${project.project.name}</h1>
        ${message ? `<div class="notice info" style="margin: 10px 0;">${message}</div>` : ""}
        <p class="muted" style="margin-bottom: 12px;">Claim the next unclaimed page to start annotating.</p>
        <div class="row" style="justify-content: center; margin-bottom: 16px;">
          <span class="badge gray">${s.total} total</span>
          <span class="badge gray">${s.unclaimed} unclaimed</span>
          <span class="badge amber">${s.claimed} in progress</span>
          <span class="badge green">${s.completed} completed</span>
        </div>
        <button id="claim" class="btn primary">Claim next page</button>
      </div>
    </div>`;
  $("#claim").addEventListener("click", claimNext);
}

async function claimNext() {
  const res = await api("/api/claim", { method: "POST" });
  const data = await res.json();
  if (!res.ok) return renderClaimScreen(data.error);
  if (!data.image) return renderClaimScreen("No pages are available right now — everything is claimed or completed.");
  currentImage = data.image;
  renderWorkspace(data.resumed);
}

// ---------------- workspace ----------------
function renderWorkspace(resumed) {
  app.innerHTML = `
    <div class="workspace">
      <aside class="side">
        <div>
          <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${currentImage.fileName}">${currentImage.fileName}</div>
          <div class="faint"><span id="dims">${currentImage.width}×${currentImage.height}</span> · <span id="shape-count"></span> · <span id="save-state" class="muted"></span></div>
          ${currentImage.importedFrom ? `<div class="faint" style="color:var(--amber)">Pre-labeled from ${currentImage.importedFrom}</div>` : ""}
          ${resumed ? `<div class="notice info" style="margin-top:8px; font-size:12px;">Resumed your in-progress page. Save &amp; complete it to claim the next one.</div>` : ""}
        </div>
        <div class="stack" style="margin-top:0;">
          <button id="save" class="btn" style="width:100%">Save (sync to admin)</button>
          <button id="complete" class="btn primary" style="width:100%">Save &amp; Mark Complete</button>
          <div class="export-grid">
            <button id="download-json" class="btn sm">⬇ JSON</button>
            <button id="download-xml" class="btn sm">⬇ XML</button>
            <button id="download-voc" class="btn sm">⬇ VOC</button>
            <button id="download-coco" class="btn sm">⬇ COCO</button>
            <button id="download-yolo" class="btn sm">⬇ YOLO</button>
          </div>
        </div>
        <div>
          <div class="section-title">Tools</div>
          <div class="tools">
            <button class="btn sm active" data-tool="select">Select<span class="kbd-badge">⇧A</span></button>
            <button class="btn sm" data-tool="bbox">Box<span class="kbd-badge">⇧S</span></button>
            <button class="btn sm" data-tool="polygon">Polygon<span class="kbd-badge">⇧D</span></button>
          </div>
          <p class="faint" style="margin-top:6px;">Draw a shape — a small box asks you to name it. Names become labels for everyone.</p>
        </div>
        <div class="stack" style="margin-top:0;">
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

  canvas = new AnnotationCanvas($("#holder"), {
    getLabels: () => labels,
    createLabel: async (name) => {
      const res = await api("/api/labels", { method: "POST", body: JSON.stringify({ name }) });
      if (!res.ok) return null;
      const data = await res.json();
      if (!labels.some((l) => l.id === data.label.id)) labels.push(data.label);
      renderLabels();
      return data.label;
    },
    onChange: () => { refreshMeta(); renderShapesList(); },
  });
  canvas.load(`/api/image/${currentImage.id}/file`, currentImage.width, currentImage.height, currentImage.annotations);
  $("#holder .anno-canvas").classList.add("select");

  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.addEventListener("click", () => selectTool(b.dataset.tool));
  });
  const showLinesChk = $("#show-line-numbers");
  showLinesChk.checked = canvas.showLineNumbers;
  showLinesChk.addEventListener("change", () => canvas.setShowLineNumbers(showLinesChk.checked));
  const showLabelInputChk = $("#show-label-input");
  showLabelInputChk.checked = canvas.showLabelInput;
  showLabelInputChk.addEventListener("change", () => canvas.setShowLabelInput(showLabelInputChk.checked));

  $("#save").addEventListener("click", () => saveWork(false));
  $("#complete").addEventListener("click", () => saveWork(true));
  ["json", "xml", "voc", "coco", "yolo"].forEach((fmt) => {
    $(`#download-${fmt}`).addEventListener("click", () => downloadExport(fmt));
  });
  renderLabels();
  renderShapesList();
  refreshMeta();
}

function renderShapesList() {
  const el = $("#shapes");
  if (!el || !canvas) return;
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

function renderLabels() {
  const el = $("#labels");
  if (!el) return;
  const highlightId = canvas ? canvas.highlightLabelId : null;
  // No delete cross here on purpose: labelers only have a route to CREATE
  // labels (POST /api/labels), not delete them -- deleting a label unassigns
  // it from every image project-wide, which is an admin-only action (see
  // admin.js's version of this same list for that side of it).
  el.innerHTML = labels.map((l) =>
    `<div class="label-item ${highlightId === l.id ? "active" : ""}">
       <button type="button" class="label-item-main" data-id="${l.id}" title="Click to highlight every shape with this label on the canvas">
         <span class="swatch" style="background:${l.color}"></span><span class="grow">${l.name}</span>
       </button>
     </div>`).join("") ||
    `<p class="faint">No labels yet — draw a shape and name it to create one.</p>`;
  el.querySelectorAll(".label-item-main").forEach((b) => {
    b.addEventListener("click", () => {
      canvas.setActiveLabel(b.dataset.id);
      canvas.toggleHighlightLabel(b.dataset.id);
      renderLabels();
    });
  });
}

function refreshMeta() {
  const el = $("#shape-count");
  if (el && canvas) el.textContent = `${canvas.getAnnotations().length} shapes`;
  const s = $("#save-state");
  if (s && canvas) {
    s.textContent = canvas.isDirty() ? "unsaved changes" : "saved";
    s.style.color = canvas.isDirty() ? "var(--amber)" : "var(--green)";
  }
}

async function saveWork(complete) {
  const anns = canvas.getAnnotations();
  if (complete) {
    const unlabeled = anns.filter((a) => !a.labelId).length;
    if (unlabeled && !confirm(`${unlabeled} shape(s) have no label. Complete anyway?`)) return;
  }
  const res = await api(`/api/image/${currentImage.id}/${complete ? "complete" : "save"}`, {
    method: "POST",
    body: JSON.stringify({ annotations: anns }),
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.error || "Save failed", { type: "error" }); return; }
  canvas.markSaved();
  refreshMeta();
  showToast(complete ? "Saved & marked complete" : "Saved");
  if (complete) {
    currentImage = null;
    await refreshProject();
    renderClaimScreen("Page completed. Claim the next one when ready.");
  }
}

// The server's actual file extension per format -- "yolo" downloads a small
// zip (the .txt needs its classes.txt alongside to mean anything), not a
// bare .txt, so it can't just reuse the format name like the others can.
const EXPORT_EXT = { json: "json", xml: "xml", voc: "xml", coco: "json", yolo: "zip" };

// json/xml are this app's own formats and support a coordinate-system
// choice (normalized/pixel/both) -- ask before downloading. voc/coco/yolo
// each have exactly one coordinate convention fixed by their own spec, so
// the question would be pointless (or actively misleading) for those.
async function downloadExport(format) {
  let coords = null;
  if (format === "json" || format === "xml") {
    coords = await askExportCoords();
    if (!coords) return; // cancelled
  }
  const qs = coords ? `?coords=${coords}` : "";
  const res = await api(`/api/image/${currentImage.id}/export/${format}${qs}`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const base = currentImage.fileName.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  a.download = `${base}.${EXPORT_EXT[format] || format}`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Manual-save model: warn before losing unsaved work.
window.addEventListener("beforeunload", (e) => {
  if (canvas && canvas.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});

// ---------------- boot ----------------
async function refreshProject() {
  const res = await fetch("/api/project");
  project = await res.json();
}

async function boot() {
  setWho();
  if (!identity) return renderJoin();
  try {
    const me = await api("/api/me");
    if (!me.ok) return;
    await refreshProject();
    if (!project.project) return renderNoProject();
    labels = project.project.labels;
    await claimNext(); // resumes an in-progress claim automatically
  } catch (err) {
    if (err.message !== "unauthorized") renderJoin("Could not reach the server. Try again.");
  }
}

$("#switch-user").addEventListener("click", () => {
  if (canvas && canvas.isDirty() && !confirm("You have unsaved changes. Switch user anyway?")) return;
  localStorage.removeItem(TOKEN_KEY);
  identity = null;
  setWho();
  renderJoin();
});

identity = loadIdentity();
boot();
