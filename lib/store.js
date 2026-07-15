"use strict";
/**
 * Persistent multi-project store. Plain JSON on disk, everything for the
 * ACTIVE project held in memory, every mutation written back SYNCHRONOUSLY
 * with an atomic temp-file + rename (a crash can never leave half-written
 * state). Layout:
 *
 *   state/
 *     active.json          -- {activeId: string|null} -- which project (if
 *                              any) is currently loaded. "Unloading" only
 *                              ever changes this file -- it never touches a
 *                              project's own files, so resuming later is
 *                              exactly where you left off.
 *     projects/
 *       <projectId>/
 *         project.json      -- {version, id, name, datasetPath,
 *                                annotationsPath, labels[], createdAt}
 *         images.json       -- [{id, fileName, path, width, height, status,
 *                                claimedBy, claimedByName, completedBy,
 *                                completedByName, savedAt, importedFrom,
 *                                annotations: [{id, labelId, type,
 *                                               rect|points, line,
 *                                               createdBy, createdByName}]}]
 *     users.json            -- [{id, name, token, lastSeenAt}] -- identities
 *                               are global, independent of which project is
 *                               active (the same labeler name works across
 *                               every project on this machine)
 *     backups/<timestamp>/  -- snapshots of the active project (throttled,
 *                               capped)
 *
 * Legacy migration: earlier versions of this app kept a single project at
 * state/project.json + state/images.json with no way to have more than one.
 * On first load, if that old layout is found and the new one isn't, it's
 * copied (never deleted) into state/projects/<id>/ and marked active -- see
 * migrateLegacyIfNeeded(). Existing data always survives this.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STATE_DIR = path.join(process.cwd(), "state");
const PROJECTS_DIR = path.join(STATE_DIR, "projects");
const ACTIVE_FILE = path.join(STATE_DIR, "active.json");
const LEGACY_PROJECT_FILE = path.join(STATE_DIR, "project.json");
const LEGACY_IMAGES_FILE = path.join(STATE_DIR, "images.json");
const USERS_FILE = path.join(STATE_DIR, "users.json");

const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKUPS = 10;

const LABEL_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#14b8a6",
  "#06b6d4", "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#64748b",
];

function newId() { return crypto.randomUUID(); }
function newToken() { return crypto.randomBytes(24).toString("hex"); }
function nowIso() { return new Date().toISOString(); }

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT" && fs.existsSync(file)) {
      // Corrupt file: preserve a copy before starting fresh.
      const bak = `${file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(file, bak); console.error(`[store] ${file} corrupt; copy saved to ${bak}`); } catch {}
    }
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function projectFiles(id) {
  const dir = path.join(PROJECTS_DIR, id);
  return { dir, project: path.join(dir, "project.json"), images: path.join(dir, "images.json") };
}

/**
 * One-time, non-destructive migration from the old single-project layout.
 * Only runs when state/projects/ doesn't exist yet AND a legacy
 * state/project.json is present. COPIES (never deletes/renames) the legacy
 * files into the new per-project location, so even if something goes wrong
 * here the original files are untouched on disk.
 */
function migrateLegacyIfNeeded() {
  if (fs.existsSync(PROJECTS_DIR)) return; // already on the new layout
  if (!fs.existsSync(LEGACY_PROJECT_FILE)) return; // fresh install, nothing to migrate
  const legacyProject = readJson(LEGACY_PROJECT_FILE, null);
  if (!legacyProject || !legacyProject.id) return;
  const legacyImages = readJson(LEGACY_IMAGES_FILE, []);
  const pf = projectFiles(legacyProject.id);
  fs.mkdirSync(pf.dir, { recursive: true });
  if (legacyProject.annotationsPath === undefined) legacyProject.annotationsPath = null;
  writeJsonAtomic(pf.project, legacyProject);
  writeJsonAtomic(pf.images, legacyImages);
  writeJsonAtomic(ACTIVE_FILE, { activeId: legacyProject.id });
  console.log(`[store] migrated existing project "${legacyProject.name}" (${legacyImages.length} image(s)) into the multi-project layout -- original files at ${LEGACY_PROJECT_FILE} left in place, untouched.`);
}

// ---------------- in-memory state ----------------
// Order matters: migration must decide based on whether projects/ already
// exists BEFORE we unconditionally create it below -- otherwise the
// existence check always sees the directory we just made and skips
// migration every time.
migrateLegacyIfNeeded();
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

let activeId = readJson(ACTIVE_FILE, { activeId: null }).activeId || null;
let project = null;
let images = [];
if (activeId) {
  const pf = projectFiles(activeId);
  project = readJson(pf.project, null);
  images = project ? readJson(pf.images, []) : [];
  if (!project) activeId = null; // pointed at a project that no longer exists on disk
}

let users = readJson(USERS_FILE, []);

function saveProject() {
  if (!activeId) return;
  writeJsonAtomic(projectFiles(activeId).project, project);
  maybeBackup();
}
function saveImages() {
  if (!activeId) return;
  writeJsonAtomic(projectFiles(activeId).images, images);
  maybeBackup();
}
function saveUsers() { writeJsonAtomic(USERS_FILE, users); }

// ---------------- backups ----------------
let lastBackupAt = 0;
function maybeBackup(force = false) {
  if (!project || !activeId) return;
  const now = Date.now();
  if (!force && now - lastBackupAt < BACKUP_INTERVAL_MS) return;
  try {
    const pf = projectFiles(activeId);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(STATE_DIR, "backups", stamp);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [pf.project, pf.images, USERS_FILE]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    }
    lastBackupAt = now;
    const root = path.join(STATE_DIR, "backups");
    const dirs = fs.readdirSync(root).filter((d) => !d.startsWith(".")).sort();
    while (dirs.length > MAX_BACKUPS) {
      fs.rmSync(path.join(root, dirs.shift()), { recursive: true, force: true });
    }
  } catch (err) {
    console.error("[store] backup failed:", err.message);
  }
}

// ---------------- project ----------------
function getProject() { return project; }
function getImages() { return images; }

/** Creates a new, empty project and makes it active. Existing projects are
 *  left exactly as they are on disk -- nothing is archived or overwritten,
 *  so switching back to one later (activateProject) resumes it as-is. */
function createProject(name, labelNames) {
  const id = newId();
  project = {
    version: 1,
    id,
    name: String(name).trim(),
    datasetPath: null,
    annotationsPath: null,
    labels: [],
    createdAt: nowIso(),
  };
  images = [];
  activeId = id;
  fs.mkdirSync(projectFiles(id).dir, { recursive: true });
  for (const n of labelNames || []) {
    const trimmed = String(n).trim();
    if (trimmed) getOrCreateLabel(trimmed, false);
  }
  saveProject();
  saveImages();
  writeJsonAtomic(ACTIVE_FILE, { activeId: id });
  maybeBackup(true);
  return project;
}

/** Lists every project this machine knows about (active or not), newest
 *  first, for the "resume a project" picker. Cheap: reads each project.json
 *  + images.json off disk fresh (not from in-memory state), so it reflects
 *  reality even if the active project changed since boot. */
function listProjects() {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
  const out = [];
  for (const id of dirs) {
    const pf = projectFiles(id);
    const p = readJson(pf.project, null);
    if (!p) continue;
    const imgs = readJson(pf.images, []);
    out.push({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      imageCount: imgs.length,
      completedCount: imgs.filter((i) => i.status === "COMPLETED").length,
      labelCount: (p.labels || []).length,
      active: id === activeId,
    });
  }
  out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return out;
}

/** Switches the active project to `id`, loading its data from disk exactly
 *  as it was left. Returns the project, or null if that id doesn't exist. */
function activateProject(id) {
  const pf = projectFiles(id);
  const p = readJson(pf.project, null);
  if (!p) return null;
  project = p;
  images = readJson(pf.images, []);
  activeId = id;
  writeJsonAtomic(ACTIVE_FILE, { activeId: id });
  return project;
}

/** Clears the active project. Nothing on disk is touched -- this is purely
 *  "don't show me anything right now", not a delete. */
function unloadProject() {
  project = null;
  images = [];
  activeId = null;
  writeJsonAtomic(ACTIVE_FILE, { activeId: null });
}

/**
 * PERMANENTLY deletes a project's tracking data: state/projects/<id>/ (its
 * project.json + images.json -- the image list, every annotation, claim
 * history, labels) and any backup snapshot that belongs to it. This is
 * irreversible; there is no undo, no archive, no trash.
 *
 * What this does NOT touch, ever: the dataset folder or annotations folder
 * on disk (project.datasetPath / project.annotationsPath). Those are real
 * image/annotation files that live outside this app's state/ directory --
 * this only ever deletes this app's OWN bookkeeping about a project, never
 * the source files it was pointed at. Re-importing the same dataset folder
 * afterward starts a fresh project from scratch, same as any new import.
 *
 * If the deleted project was active, it's unloaded first so nothing is left
 * pointing at a project that no longer exists.
 *
 * @returns {boolean} true if a project was actually found and deleted.
 */
function deleteProjectCompletely(id) {
  const pf = projectFiles(id);
  if (!fs.existsSync(pf.dir)) return false;

  if (id === activeId) unloadProject();

  fs.rmSync(pf.dir, { recursive: true, force: true });

  // Best-effort: remove any backup snapshot that was taken while THIS
  // project was active (identified by the id inside its own project.json,
  // since backups aren't namespaced by project). Never let a bad backup
  // stop the rest of the cleanup.
  try {
    const backupsRoot = path.join(STATE_DIR, "backups");
    const stamps = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const stamp of stamps) {
      const snapshotProjectFile = path.join(backupsRoot, stamp, "project.json");
      const snapshot = readJson(snapshotProjectFile, null);
      if (snapshot && snapshot.id === id) {
        try { fs.rmSync(path.join(backupsRoot, stamp), { recursive: true, force: true }); } catch { /* skip this one, keep going */ }
      }
    }
  } catch { /* no backups directory yet, nothing to clean */ }

  return true;
}

function setDatasetPath(p) {
  project.datasetPath = p;
  saveProject();
}

function setAnnotationsPath(p) {
  project.annotationsPath = p;
  saveProject();
}

/**
 * Attaches freshly-found annotations to an EXISTING image that currently has
 * none (the "backfill" path -- the dataset was uploaded before an
 * annotations folder was chosen, or before this particular file existed).
 * Unlike replaceAnnotations, this does not touch status/claim/savedAt -- the
 * result looks exactly as if the annotations had been there since the image
 * was first registered. Caller is responsible for only calling this on
 * zero-annotation images (see lib/importer.js).
 */
function backfillAnnotations(image, annotations, importedFrom) {
  image.annotations = annotations;
  image.importedFrom = importedFrom;
  saveImages();
}

// ---------------- labels ----------------
function getOrCreateLabel(name, persist = true) {
  const trimmed = String(name).trim();
  if (!trimmed) throw new Error("Label name is required");
  const lower = trimmed.toLowerCase();
  const existing = project.labels.find((l) => l.name.toLowerCase() === lower);
  if (existing) return existing;
  const label = { id: newId(), name: trimmed, color: LABEL_COLORS[project.labels.length % LABEL_COLORS.length] };
  project.labels.push(label);
  if (persist) saveProject();
  return label;
}

function deleteLabel(labelId) {
  project.labels = project.labels.filter((l) => l.id !== labelId);
  let changed = false;
  for (const img of images) {
    for (const a of img.annotations) {
      if (a.labelId === labelId) { a.labelId = null; changed = true; }
    }
  }
  saveProject();
  if (changed) saveImages();
}

// ---------------- images ----------------
function addImage(rec) {
  const record = {
    id: newId(),
    fileName: rec.fileName,
    path: rec.path,
    width: rec.width,
    height: rec.height,
    status: "UNCLAIMED",
    claimedBy: null,
    claimedByName: null,
    completedBy: null,
    completedByName: null,
    savedAt: null,
    importedFrom: rec.importedFrom || null,
    annotations: rec.annotations || [],
  };
  images.push(record);
  return record;
}

function getImage(id) { return images.find((r) => r.id === id) || null; }

function replaceAnnotations(image, incoming, userId, userName) {
  // Upsert by id: existing shapes keep their original attribution.
  const byId = new Map(image.annotations.map((a) => [a.id, a]));
  image.annotations = incoming.map((a) => {
    const prev = a.id ? byId.get(a.id) : null;
    return {
      id: prev ? prev.id : a.id || newId(),
      labelId: a.labelId ?? null,
      type: a.type === "polygon" ? "polygon" : "bbox",
      rect: a.type === "bbox" ? a.rect : undefined,
      points: a.type === "polygon" ? a.points : undefined,
      line: typeof a.line === "number" && a.line >= 1 ? Math.floor(a.line) : null,
      createdBy: prev ? prev.createdBy : userId,
      createdByName: prev ? prev.createdByName : userName,
    };
  });
  image.savedAt = nowIso();
  saveImages();
}

/**
 * Claim rule (per spec): a user may claim the next UNCLAIMED image only if
 * they have NO image currently claimed -- they must Save & Mark Complete
 * first. Returns {image, resumed} or {error}.
 */
function claimNext(userId, userName) {
  const current = images.find((r) => r.status === "CLAIMED" && r.claimedBy === userId);
  if (current) return { image: current, resumed: true };
  const next = images.find((r) => r.status === "UNCLAIMED");
  if (!next) return { image: null, resumed: false };
  next.status = "CLAIMED";
  next.claimedBy = userId;
  next.claimedByName = userName;
  saveImages();
  return { image: next, resumed: false };
}

function completeImage(image, userId, userName) {
  image.status = "COMPLETED";
  image.completedBy = userId;
  image.completedByName = userName;
  image.claimedBy = null;
  image.claimedByName = null;
  image.savedAt = nowIso();
  saveImages();
}

/** Admin actions: reopen a completed image / release a stuck claim. */
function reopenImage(image) {
  image.status = "UNCLAIMED";
  image.claimedBy = null;
  image.claimedByName = null;
  image.completedBy = null;
  image.completedByName = null;
  saveImages();
}

function stats() {
  const s = { total: images.length, unclaimed: 0, claimed: 0, completed: 0 };
  for (const r of images) {
    if (r.status === "UNCLAIMED") s.unclaimed++;
    else if (r.status === "CLAIMED") s.claimed++;
    else s.completed++;
  }
  return s;
}

// ---------------- users ----------------
function createUser(name) {
  const user = { id: newId(), name: String(name).trim(), token: newToken(), lastSeenAt: nowIso() };
  users.push(user);
  saveUsers();
  return user;
}

function userByToken(token) {
  const u = users.find((x) => x.token === token) || null;
  if (u) { u.lastSeenAt = nowIso(); saveUsers(); }
  return u;
}

function listUsers() { return users; }

module.exports = {
  STATE_DIR, newId, nowIso,
  getProject, createProject, setDatasetPath, setAnnotationsPath,
  listProjects, activateProject, unloadProject, deleteProjectCompletely,
  getOrCreateLabel, deleteLabel,
  getImages, getImage, addImage, replaceAnnotations, backfillAnnotations,
  claimNext, completeImage, reopenImage, stats, saveImages, saveProject,
  createUser, userByToken, listUsers,
  maybeBackup,
};
