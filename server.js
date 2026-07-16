"use strict";
/**
 * LabelFlow -- zero-dependency collaborative image annotation.
 *
 * Two HTTP listeners against one app (the admin boundary is the NETWORK,
 * not a login):
 *   LAN   0.0.0.0:<auto>   -- labelers; /admin* and /api/admin* hard-404
 *   Admin 127.0.0.1:<you choose> -- host machine only (the OS refuses
 *                                   remote connections to loopback), full
 *                                   access
 *
 * Run: node server.js     (no build step, no npm install)
 *
 * Interactively (a real terminal), it asks which port to run the admin
 * panel on, then automatically picks the next free port after that for the
 * LAN/labeler listener -- see resolveAdminPort()/findAvailablePort() below.
 * Non-interactively (piped stdin, a process manager, CI, Docker, etc.) it
 * skips the prompt so startup never blocks on input that will never arrive;
 * set the ADMIN_PORT and/or PORT environment variables to control the ports
 * explicitly in that case (both are still honored and take priority over
 * the interactive prompt/auto-detection either way).
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const os = require("node:os");
const net = require("node:net");
const readline = require("node:readline");

const store = require("./lib/store");
const { registerDataset } = require("./lib/importer");
const {
  buildImageJson, buildImageXml, fileFor, buildExportZip,
  buildCocoExportAll, buildYoloSingleZip,
} = require("./lib/exporter");
const { pickFolder } = require("./lib/dialog");
const { MIME } = require("./lib/imagesize");

// Set once resolveAdminPort()/main() run -- see the bottom of this file.
// (Was previously a fixed pair of top-level consts; now resolved at startup
// since the admin port can come from a prompt and the LAN port from a
// port scan, not just env vars.)
let LAN_PORT, ADMIN_PORT;
const PUBLIC_DIR = path.join(__dirname, "public");
const TOKEN_HEADER = "x-user-token";

// Every export format this app can produce, and how a single-image download
// of each is packaged. YOLO is "zip" (its .txt needs classes.txt alongside
// to mean anything); everything else is a lone file. COCO's ALL-IMAGES
// download is handled as a special case in each route below (one combined
// manifest, not a zip) -- see buildCocoExportAll.
const EXPORT_FORMATS = new Set(["json", "xml", "voc", "coco", "yolo"]);
const EXPORT_EXT = { json: "json", xml: "xml", voc: "xml", coco: "json", yolo: "txt" };
const EXPORT_MIME = { json: "application/json", xml: "application/xml", voc: "application/xml", coco: "application/json", yolo: "text/plain" };

// Coordinate-system choice: only meaningful for json/xml (this app's own two
// formats); fileFor()/buildExportZip() accept it unconditionally and simply
// ignore it for voc/coco/yolo, whose coordinate convention is fixed by spec
// -- so it's safe to always read and pass through here without checking
// format first.
const VALID_COORDS = new Set(["normalized", "pixel", "both"]);
function readCoords(url) {
  const v = url.searchParams.get("coords");
  return VALID_COORDS.has(v) ? v : "both";
}

// ---------------- helpers ----------------
function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(data);
}
const json = (res, obj, status = 200) => send(res, status, obj);
const fail = (res, status, message) => send(res, status, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function requireUser(req, res) {
  const token = req.headers[TOKEN_HEADER];
  const user = token ? store.userByToken(String(token)) : null;
  if (!user) { fail(res, 401, "Unknown identity. Enter your name again."); return null; }
  return user;
}

function requireProject(res) {
  const p = store.getProject();
  if (!p) { fail(res, 404, "No active project. Ask the admin to create one."); return null; }
  return p;
}

function imageSummary(r) {
  return {
    id: r.id, fileName: r.fileName, width: r.width, height: r.height,
    status: r.status, claimedByName: r.claimedByName, completedByName: r.completedByName,
    savedAt: r.savedAt, importedFrom: r.importedFrom,
    annotationCount: r.annotations.length,
  };
}

function sanitizeBase(fileName) {
  return (fileName.split(/[\\/]/).pop() || "image").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function download(res, content, contentType, filename) {
  send(res, 200, content, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

function validAnnotations(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const a of list) {
    if (a.type === "bbox" && a.rect && [a.rect.x, a.rect.y, a.rect.w, a.rect.h].every((v) => typeof v === "number")) {
      out.push(a);
    } else if (a.type === "polygon" && Array.isArray(a.points) && a.points.length >= 3) {
      out.push(a);
    }
  }
  return out;
}

// Line-annotation regions ("lasso" polygons that fix line numbers on a
// skewed page -- see lib/lines.js). Optional in every save payload: a
// missing/absent lineRegions key is NOT an error (it just means "no change
// requested to this image's regions"), unlike annotations which are always
// a full replace -- see the two call sites below for exactly how each
// treats a missing key.
function validLineRegions(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const r of list) {
    if (Array.isArray(r.points) && r.points.length >= 3 && r.points.every((p) => typeof p.x === "number" && typeof p.y === "number")) {
      out.push(r);
    }
  }
  return out;
}

// ---------------- API ----------------
let folderDialogOpen = false;

async function handleApi(req, res, url, isAdminPort) {
  const p = url.pathname;
  const method = req.method;
  const seg = p.split("/").filter(Boolean); // ["api", ...]

  // ======== shared (both ports) ========
  if (p === "/api/join" && method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return fail(res, 400, "Name is required");
    if (name.length > 60) return fail(res, 400, "Name is too long");
    const user = store.createUser(name);
    return json(res, { user: { id: user.id, name: user.name }, token: user.token }, 201);
  }

  if (p === "/api/me" && method === "GET") {
    const user = requireUser(req, res);
    if (!user) return;
    return json(res, { user: { id: user.id, name: user.name } });
  }

  if (p === "/api/project" && method === "GET") {
    const project = store.getProject();
    if (!project) return json(res, { project: null });
    return json(res, {
      project: { id: project.id, name: project.name, labels: project.labels },
      stats: store.stats(),
    });
  }

  // Image bytes: ids are opaque UUIDs handed out via identity-checked APIs.
  if (seg[1] === "image" && seg[3] === "file" && method === "GET") {
    const image = store.getImage(seg[2]);
    if (!image) return fail(res, 404, "Not found");
    let bytes;
    try { bytes = fs.readFileSync(image.path); }
    catch { return fail(res, 404, "File missing on disk"); }
    return send(res, 200, bytes, {
      "Content-Type": MIME[path.extname(image.path).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  }

  // ======== labeler ========
  if (p === "/api/claim" && method === "POST") {
    const user = requireUser(req, res);
    if (!user) return;
    if (!requireProject(res)) return;
    const { image, resumed } = store.claimNext(user.id, user.name);
    return json(res, { image: image ? { ...imageSummary(image), annotations: image.annotations, lineRegions: image.lineRegions } : null, resumed });
  }

  if (seg[1] === "image" && seg.length === 3 && method === "GET") {
    const user = requireUser(req, res);
    if (!user) return;
    const image = store.getImage(seg[2]);
    if (!image) return fail(res, 404, "Image not found");
    if (image.claimedBy !== user.id && image.status !== "COMPLETED") {
      return fail(res, 403, "This image is not assigned to you");
    }
    return json(res, { image: { ...imageSummary(image), annotations: image.annotations, lineRegions: image.lineRegions } });
  }

  // Manual save: THE sync point -- persists to the admin-side store.
  if (seg[1] === "image" && (seg[3] === "save" || seg[3] === "complete") && method === "POST") {
    const user = requireUser(req, res);
    if (!user) return;
    const image = store.getImage(seg[2]);
    if (!image) return fail(res, 404, "Image not found");
    if (image.claimedBy !== user.id) return fail(res, 403, "This image is not assigned to you");
    const body = await readBody(req);
    const anns = validAnnotations(body.annotations);
    if (!anns) return fail(res, 400, "annotations must be an array");
    store.replaceAnnotations(image, anns, user.id, user.name);
    // lineRegions is optional in the payload (a client that doesn't know
    // about it yet just omits the key) -- only touch existing regions when
    // the client actually sent a (possibly empty) array.
    if (body.lineRegions !== undefined) {
      const regions = validLineRegions(body.lineRegions);
      if (!regions) return fail(res, 400, "lineRegions must be an array");
      store.replaceLineRegions(image, regions);
    }
    if (seg[3] === "complete") store.completeImage(image, user.id, user.name);
    return json(res, { image: imageSummary(image), savedAt: image.savedAt });
  }

  if (p === "/api/labels" && method === "POST") {
    const user = requireUser(req, res);
    if (!user) return;
    if (!requireProject(res)) return;
    const body = await readBody(req);
    if (!body.name || !String(body.name).trim()) return fail(res, 400, "Label name is required");
    const label = store.getOrCreateLabel(body.name);
    return json(res, { label });
  }

  // Labeler's own per-image export (token-checked; must own or be completed).
  if (seg[1] === "image" && seg[3] === "export" && method === "GET") {
    const user = requireUser(req, res);
    if (!user) return;
    const project = requireProject(res);
    if (!project) return;
    const image = store.getImage(seg[2]);
    if (!image) return fail(res, 404, "Image not found");
    if (image.claimedBy !== user.id && image.status !== "COMPLETED") {
      return fail(res, 403, "This image is not assigned to you");
    }
    const format = EXPORT_FORMATS.has(seg[4]) ? seg[4] : "json";
    const coords = readCoords(url);
    const base = sanitizeBase(image.fileName);
    if (format === "yolo") {
      return download(res, buildYoloSingleZip(project, image), "application/zip", `${base}-yolo.zip`);
    }
    const f = fileFor(project, image, format, coords);
    return download(res, f.data, EXPORT_MIME[format], `${base}.${EXPORT_EXT[format]}`);
  }

  // ======== admin (unreachable from the LAN listener) ========
  if (seg[1] !== "admin") return fail(res, 404, "Not found");
  if (!isAdminPort) return fail(res, 404, "Not found"); // defense in depth

  if (p === "/api/admin/state" && method === "GET") {
    const project = store.getProject();
    return json(res, {
      project,
      stats: project ? store.stats() : null,
      users: store.listUsers().map((u) => ({ id: u.id, name: u.name, lastSeenAt: u.lastSeenAt })),
    });
  }

  if (p === "/api/admin/project" && method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return fail(res, 400, "Project name is required");
    const project = store.createProject(name, Array.isArray(body.labels) ? body.labels : []);
    return json(res, { project }, 201);
  }

  // Multi-project: list everything on this machine, switch which one is
  // active, or unload without touching any project's data.
  if (p === "/api/admin/projects" && method === "GET") {
    return json(res, { projects: store.listProjects() });
  }

  if (seg[2] === "projects" && seg.length === 5 && seg[4] === "activate" && method === "POST") {
    const project = store.activateProject(seg[3]);
    if (!project) return fail(res, 404, "Project not found");
    return json(res, { project, stats: store.stats() });
  }

  if (p === "/api/admin/unload" && method === "POST") {
    store.unloadProject();
    return json(res, { ok: true });
  }

  // Permanent delete: removes this app's own tracking data for the project
  // (image list, annotations, labels, backups) -- never the dataset or
  // annotations folders on disk. See store.deleteProjectCompletely.
  if (seg[2] === "projects" && seg.length === 4 && method === "DELETE") {
    const deleted = store.deleteProjectCompletely(seg[3]);
    if (!deleted) return fail(res, 404, "Project not found");
    return json(res, { ok: true });
  }

  if (p === "/api/admin/pick-folder" && method === "POST") {
    if (folderDialogOpen) return fail(res, 409, "A folder dialog is already open on this machine.");
    folderDialogOpen = true;
    try {
      const body = await readBody(req);
      const title = String(body.title || "Select a dataset folder");
      const result = await pickFolder(title);
      if (result.status === "selected") return json(res, { path: result.path });
      if (result.status === "cancelled") return json(res, { cancelled: true });
      return fail(res, 501, result.message);
    } finally {
      folderDialogOpen = false;
    }
  }

  if (p === "/api/admin/dataset" && method === "POST") {
    if (!requireProject(res)) return;
    const body = await readBody(req);
    const dataset = String(body.path || store.getProject().datasetPath || "").trim();
    if (!dataset) return fail(res, 400, "Provide a dataset folder path");
    let stat;
    try { stat = fs.statSync(path.resolve(dataset)); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) return fail(res, 400, `Not a folder on this machine: ${dataset}`);

    // Optional, decoupled from the dataset folder: a separate folder of
    // pre-existing annotations (bboxes/polygons) matched to images by
    // filename. See lib/importer.js for the matching + format rules.
    const annotationsPath = String(body.annotationsPath || "").trim();
    if (annotationsPath) {
      let annStat;
      try { annStat = fs.statSync(path.resolve(annotationsPath)); } catch { annStat = null; }
      if (!annStat || !annStat.isDirectory()) return fail(res, 400, `Annotations path is not a folder on this machine: ${annotationsPath}`);
    }

    const result = registerDataset(dataset, annotationsPath || null);
    return json(res, result);
  }

  if (p === "/api/admin/labels" && method === "POST") {
    if (!requireProject(res)) return;
    const body = await readBody(req);
    if (!body.name || !String(body.name).trim()) return fail(res, 400, "Label name is required");
    return json(res, { label: store.getOrCreateLabel(body.name) });
  }

  if (seg[2] === "labels" && seg.length === 4 && method === "DELETE") {
    if (!requireProject(res)) return;
    store.deleteLabel(seg[3]);
    return json(res, { ok: true });
  }

  if (p === "/api/admin/images" && method === "GET") {
    if (!requireProject(res)) return;
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const status = url.searchParams.get("status") || "ALL";
    const q = (url.searchParams.get("q") || "").toLowerCase();
    let list = store.getImages();
    if (status !== "ALL") list = list.filter((r) => r.status === status);
    if (q) list = list.filter((r) => r.fileName.toLowerCase().includes(q));
    return json(res, {
      total: list.length,
      images: list.slice(offset, offset + limit).map(imageSummary),
      stats: store.stats(),
    });
  }

  if (seg[2] === "image" && seg.length === 4 && method === "GET") {
    const image = store.getImage(seg[3]);
    if (!image) return fail(res, 404, "Image not found");
    return json(res, { image: { ...imageSummary(image), annotations: image.annotations, lineRegions: image.lineRegions } });
  }

  // Admin can annotate any image regardless of claims.
  if (seg[2] === "image" && seg[4] === "save" && method === "POST") {
    const image = store.getImage(seg[3]);
    if (!image) return fail(res, 404, "Image not found");
    const body = await readBody(req);
    const anns = validAnnotations(body.annotations);
    if (!anns) return fail(res, 400, "annotations must be an array");
    store.replaceAnnotations(image, anns, null, "Admin");
    if (body.lineRegions !== undefined) {
      const regions = validLineRegions(body.lineRegions);
      if (!regions) return fail(res, 400, "lineRegions must be an array");
      store.replaceLineRegions(image, regions);
    }
    if (body.markComplete) store.completeImage(image, null, "Admin");
    return json(res, { image: imageSummary(image) });
  }

  if (seg[2] === "image" && seg[4] === "reopen" && method === "POST") {
    const image = store.getImage(seg[3]);
    if (!image) return fail(res, 404, "Image not found");
    store.reopenImage(image); // also releases a stuck claim
    return json(res, { image: imageSummary(image) });
  }

  // Exports: single image file (or small zip for yolo), a combined bulk
  // download of everything (a zip for json/xml/voc/yolo, one manifest for
  // coco), filterable to completed-only or all-available either way.
  if (seg[2] === "export" && method === "GET") {
    const project = requireProject(res);
    if (!project) return;
    const format = EXPORT_FORMATS.has(seg[3]) ? seg[3] : "json";
    const coords = readCoords(url);

    if (seg.length === 5) {
      const image = store.getImage(seg[4]);
      if (!image) return fail(res, 404, "Image not found");
      if (format === "yolo") {
        return download(res, buildYoloSingleZip(project, image), "application/zip", `${sanitizeBase(image.fileName)}-yolo.zip`);
      }
      const f = fileFor(project, image, format, coords);
      return download(res, f.data, EXPORT_MIME[format], `${sanitizeBase(image.fileName)}.${EXPORT_EXT[format]}`);
    }

    const completedOnly = url.searchParams.get("completedOnly") === "true";
    const safe = project.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (format === "coco") {
      // One combined manifest, not a zip -- that's how COCO is meant to be
      // consumed (a single file describing the whole dataset).
      return download(res, buildCocoExportAll(project, store.getImages(), completedOnly), "application/json", `${safe}-coco.json`);
    }
    const zip = buildExportZip(project, store.getImages(), format, completedOnly, coords);
    return download(res, zip, "application/zip", `${safe}-${format}.zip`);
  }

  return fail(res, 404, "Not found");
}

// ---------------- static files ----------------
const STATIC_MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function serveStatic(res, filePath) {
  let bytes;
  try { bytes = fs.readFileSync(filePath); }
  catch { return fail(res, 404, "Not found"); }
  send(res, 200, bytes, { "Content-Type": STATIC_MIME[path.extname(filePath)] || "application/octet-stream" });
}

// ---------------- request handling ----------------
function isAdminPath(pathname) {
  return pathname === "/admin.html" || pathname === "/admin" ||
    pathname.startsWith("/api/admin/") || pathname === "/api/admin";
}

function makeHandler(isAdminPort) {
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (!isAdminPort && isAdminPath(p)) return fail(res, 404, "Not found");

    if (p.startsWith("/api/")) {
      handleApi(req, res, url, isAdminPort).catch((err) => {
        console.error("[server]", err);
        if (!res.headersSent) fail(res, 500, err.message || "Internal error");
      });
      return;
    }

    if (p === "/") {
      res.writeHead(302, { Location: isAdminPort ? "/admin.html" : "/index.html" });
      return res.end();
    }
    if (p === "/admin") { res.writeHead(302, { Location: "/admin.html" }); return res.end(); }
    if (p === "/shared/lines.js") return serveStatic(res, path.join(__dirname, "lib", "lines.js"));

    // Static: strictly inside public/ (no traversal).
    const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) return fail(res, 404, "Not found");
    return serveStatic(res, filePath);
  };
}

// ---------------- boot ----------------
function lanAddresses() {
  const out = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const i of infos || []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

let started = 0;
const announce = () => {
  if (++started < 2) return;
  console.log("\nLabelFlow is running");
  console.log("---------------------------------------------");
  console.log(`Admin panel (this machine only): http://localhost:${ADMIN_PORT}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log("Labelers on this network, open one of:");
    for (const a of lan) console.log(`  http://${a}:${LAN_PORT}`);
  } else {
    console.log(`Labelers: http://localhost:${LAN_PORT} (no LAN interface detected)`);
  }
  console.log("---------------------------------------------\n");
};

// A bare .listen() failure (almost always EADDRINUSE -- a previous `node
// server.js` still running, or the OS hasn't released the port yet right
// after stopping one) is an unhandled 'error' event on an EventEmitter,
// which Node turns into an uncaught exception that kills the process
// outright. That's exactly the failure mode that looks like "the app was
// working, then every request suddenly fails" to whoever's using it,
// because the browser tab stays open pointed at a server that's no longer
// there. Naming it here turns a silent crash into an actionable message.
function listenOrExplain(server, port, host, label) {
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n[server] Port ${port} (${label}) is already in use -- is another copy of this server already running?`);
      console.error(`[server] Stop it first (or wait a few seconds after stopping it for the OS to release the port) and try again.\n`);
    } else {
      console.error(`[server] Failed to start ${label} listener on port ${port}:`, err);
    }
    process.exit(1);
  });
  server.listen(port, host, announce);
}

// Defense in depth: a truly uncaught error anywhere outside a request's own
// try/catch (every /api/* route is already wrapped, see makeHandler above)
// would otherwise crash the whole process silently -- both listeners going
// down at once, every open browser tab failing every request from that
// point on with a generic network error, no clue why. Log loudly instead of
// dying, so at minimum there's a paper trail in the terminal.
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception (server is still running):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[server] Unhandled promise rejection (server is still running):", err);
});

// ---------------- interactive port selection ----------------
function parsePort(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

// Tries to bind `port` on `host` and immediately releases it. This is a
// point-in-time check only (another process could grab the port a moment
// later), which is exactly why listenOrExplain()'s EADDRINUSE handling
// still exists as a backstop -- this just avoids the common case of
// prompting/auto-picking a port that's obviously already taken.
function isPortFree(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.listen(port, host, () => tester.close(() => resolve(true)));
  });
}

// Scans upward from startPort (inclusive) for the first free port on host.
async function findAvailablePort(startPort, host, maxTries = 500) {
  let port = startPort;
  for (let i = 0; i < maxTries && port <= 65535; i++, port++) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`Could not find a free port on ${host} starting from ${startPort}`);
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

const DEFAULT_ADMIN_PORT = 3001;

// Admin port: explicit env var always wins (scripts, process managers,
// Docker, and this project's own test scripts all rely on setting
// ADMIN_PORT/PORT and getting a silent, non-interactive boot). Otherwise,
// in a real terminal, ask; outside one (piped stdin, a service unit, CI)
// stdin.isTTY is false and there is no one to answer a prompt, so fall
// straight through to the default rather than hanging forever on input
// that will never arrive.
async function resolveAdminPort() {
  if (process.env.ADMIN_PORT) {
    const n = parsePort(process.env.ADMIN_PORT);
    if (n) return n;
    console.error(`[server] ADMIN_PORT="${process.env.ADMIN_PORT}" is not a valid port (1-65535); using ${DEFAULT_ADMIN_PORT} instead.`);
    return DEFAULT_ADMIN_PORT;
  }
  if (!process.stdin.isTTY) return DEFAULT_ADMIN_PORT;

  for (;;) {
    const answer = (await promptLine(`Which port should the admin panel run on? [${DEFAULT_ADMIN_PORT}]: `)).trim();
    const port = answer === "" ? DEFAULT_ADMIN_PORT : parsePort(answer);
    if (!port) { console.log(`  "${answer}" isn't a valid port (1-65535). Try again.`); continue; }
    if (!(await isPortFree(port, "127.0.0.1"))) { console.log(`  Port ${port} is already in use on this machine. Try a different one.`); continue; }
    return port;
  }
}

// LAN/labeler port: explicit PORT env var wins, same rationale as above.
// Otherwise auto-pick -- the user is only ever asked about the admin port;
// the labeler port is meant to "just work" -- scanning forward from
// adminPort + 1 for the first free port on 0.0.0.0 (the interface the LAN
// listener actually binds).
async function resolveLanPort(adminPort) {
  if (process.env.PORT) {
    const n = parsePort(process.env.PORT);
    if (n) return n;
    console.error(`[server] PORT="${process.env.PORT}" is not a valid port (1-65535); auto-selecting one instead.`);
  }
  return findAvailablePort(adminPort + 1, "0.0.0.0");
}

async function main() {
  ADMIN_PORT = await resolveAdminPort();
  LAN_PORT = await resolveLanPort(ADMIN_PORT);
  listenOrExplain(http.createServer(makeHandler(false)), LAN_PORT, "0.0.0.0", "LAN");
  listenOrExplain(http.createServer(makeHandler(true)), ADMIN_PORT, "127.0.0.1", "Admin");
}

main();
