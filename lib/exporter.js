"use strict";
/**
 * Exports. Five formats. Every one is barebones by design: just the page
 * (filename + width/height) and the boxes (type, line + sequence number,
 * label, coordinates) -- no project name, timestamps, status, attribution,
 * internal ids, or label colors. That bookkeeping lives in the app; it has
 * no reason to leave in a file whose only job is "here's what's on this
 * image, and where."
 *
 *  - JSON  : this app's own minimal schema -- also what this app accepts
 *            back in as a pre-annotation import (round-trips losslessly
 *            regardless of which coordinate system(s) were exported).
 *  - XML   : this app's own schema, same content as JSON in XML form
 *            (<line>, <sequence>, <bndbox>/<polygon>, optionally their
 *            "Normalized" siblings). NOT strict Pascal VOC -- use "voc" for
 *            that.
 *  - VOC   : strict, standard Pascal VOC XML -- no custom elements, so any
 *            VOC-reading tool understands it. Always pixel coordinates
 *            (that's what the VOC spec expects; a coordinate-system choice
 *            doesn't apply here). Only rectangles exist in the VOC schema,
 *            so polygon shapes are represented by their bounding box
 *            (documented, lossy -- use XML or JSON to keep polygons intact).
 *            Unlabeled shapes still appear, as <name>unlabeled</name>.
 *  - COCO  : one manifest (not one file per image -- that's how COCO is
 *            meant to be consumed, e.g. pycocotools.COCO(path)) covering
 *            either a single image or the whole export. Always pixel
 *            coordinates per the COCO spec. Stable small integer ids for
 *            images/annotations/categories, as most COCO tooling expects,
 *            rather than this app's own UUIDs. `line`/`sequence` are added
 *            to each annotation too -- extra keys are harmless to standard
 *            COCO readers, and it's the one standard format with room to
 *            carry them. Polygon shapes carry real segmentation; bbox
 *            shapes don't. category_id is required, so a shape with no
 *            label can't be represented and is skipped (count reported,
 *            only when non-zero, so nothing silently vanishes).
 *  - YOLO  : `class_id cx cy w h` (always normalized -- that IS the YOLO
 *            format, there's no pixel variant) per bbox, or
 *            `class_id x1 y1 x2 y2 ...` for a polygon (YOLO-seg), plus a
 *            shared classes.txt mapping class_id -> name. No slot for
 *            line/sequence -- every real YOLO reader expects an exact,
 *            fixed token count per line, so inserting extra numbers would
 *            corrupt it for anyone else's trainer. Same "no label, can't
 *            represent, skipped + counted" limitation as COCO.
 *
 * Coordinate choice ("normalized", "pixel", or "both") only applies to
 * JSON and XML -- the two formats this app fully defines. VOC/COCO/YOLO
 * each have exactly one valid coordinate convention per their own spec, so
 * asking would either be a no-op or would break compatibility with the
 * external tools those formats exist to talk to.
 *
 * Delivered either as a single file/small-zip for one image, or a bulk
 * download covering every image. VOC/XML/JSON/YOLO's bulk download is a
 * zip, one file per image (YOLO's zip also carries the one shared
 * classes.txt); COCO's bulk download is a single combined manifest, per
 * COCO convention.
 */

const { computeLineNumbers } = require("./lines");
const { buildZip } = require("./zip");

const r2 = (n) => Math.round(n * 100) / 100; // pixel-coordinate rounding
const r6 = (n) => Math.round(n * 1e6) / 1e6; // normalized-coordinate rounding (YOLO convention)

function orderedShapes(image) {
  const info = computeLineNumbers(image.annotations);
  return image.annotations
    .map((a) => ({ a, i: info.get(a.id) || { line: 1, seq: 1, autoLine: 1, isManual: false } }))
    .sort((x, y) => x.i.line - y.i.line || x.i.seq - y.i.seq);
}

function labelOf(project, labelId) {
  return project.labels.find((l) => l.id === labelId) || null;
}

// ---------------- JSON ----------------
function buildImageJson(project, image, coords = "both") {
  const shapes = orderedShapes(image).map(({ a, i }) => {
    const label = labelOf(project, a.labelId);
    const out = { type: a.type, line: i.line, sequence: i.seq, label: label ? label.name : null };
    if (a.type === "bbox") {
      const r = a.rect;
      if (coords !== "pixel") out.normalized = { x: r.x, y: r.y, width: r.w, height: r.h };
      if (coords !== "normalized") {
        out.pixels = {
          x: r2(r.x * image.width), y: r2(r.y * image.height),
          width: r2(r.w * image.width), height: r2(r.h * image.height),
        };
      }
    } else {
      if (coords !== "pixel") out.normalized = { points: a.points };
      if (coords !== "normalized") {
        out.pixels = { points: a.points.map((p) => ({ x: r2(p.x * image.width), y: r2(p.y * image.height) })) };
      }
    }
    return out;
  });

  return {
    image: { fileName: image.fileName, width: image.width, height: image.height },
    annotations: shapes,
  };
}

// ---------------- XML (this app's own) ----------------
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildImageXml(project, image, coords = "both") {
  const L = [];
  L.push(`<annotation>`);
  L.push(`  <filename>${esc(image.fileName)}</filename>`);
  L.push(`  <width>${image.width}</width>`);
  L.push(`  <height>${image.height}</height>`);
  for (const { a, i } of orderedShapes(image)) {
    const label = labelOf(project, a.labelId);
    L.push(`  <object>`);
    L.push(`    <name>${esc(label ? label.name : "unlabeled")}</name>`);
    L.push(`    <line>${i.line}</line>`);
    L.push(`    <sequence>${i.seq}</sequence>`);
    if (a.type === "bbox") {
      const r = a.rect;
      if (coords !== "normalized") {
        L.push(`    <bndbox>`);
        L.push(`      <xmin>${Math.round(r.x * image.width)}</xmin>`);
        L.push(`      <ymin>${Math.round(r.y * image.height)}</ymin>`);
        L.push(`      <xmax>${Math.round((r.x + r.w) * image.width)}</xmax>`);
        L.push(`      <ymax>${Math.round((r.y + r.h) * image.height)}</ymax>`);
        L.push(`    </bndbox>`);
      }
      if (coords !== "pixel") {
        L.push(`    <bndboxNormalized>`);
        L.push(`      <xmin>${r6(r.x)}</xmin>`);
        L.push(`      <ymin>${r6(r.y)}</ymin>`);
        L.push(`      <xmax>${r6(r.x + r.w)}</xmax>`);
        L.push(`      <ymax>${r6(r.y + r.h)}</ymax>`);
        L.push(`    </bndboxNormalized>`);
      }
    } else {
      if (coords !== "normalized") {
        L.push(`    <polygon>`);
        for (const p of a.points) {
          L.push(`      <pt><x>${Math.round(p.x * image.width)}</x><y>${Math.round(p.y * image.height)}</y></pt>`);
        }
        L.push(`    </polygon>`);
      }
      if (coords !== "pixel") {
        L.push(`    <polygonNormalized>`);
        for (const p of a.points) {
          L.push(`      <pt><x>${r6(p.x)}</x><y>${r6(p.y)}</y></pt>`);
        }
        L.push(`    </polygonNormalized>`);
      }
    }
    L.push(`  </object>`);
  }
  L.push(`</annotation>`);
  return L.join("\n");
}

// ---------------- Pascal VOC (strict) ----------------
function buildImageVoc(project, image) {
  const L = [];
  L.push(`<annotation>`);
  L.push(`  <filename>${esc(image.fileName)}</filename>`);
  L.push(`  <size><width>${image.width}</width><height>${image.height}</height><depth>3</depth></size>`);
  for (const { a } of orderedShapes(image)) {
    const label = labelOf(project, a.labelId);
    let xmin, ymin, xmax, ymax;
    if (a.type === "bbox") {
      const r = a.rect;
      xmin = r.x * image.width; ymin = r.y * image.height;
      xmax = (r.x + r.w) * image.width; ymax = (r.y + r.h) * image.height;
    } else {
      // Standard VOC has no polygon concept -- fall back to the bounding
      // box. Lossy and intentional; see the module-level note above.
      const xs = a.points.map((p) => p.x * image.width);
      const ys = a.points.map((p) => p.y * image.height);
      xmin = Math.min(...xs); ymin = Math.min(...ys);
      xmax = Math.max(...xs); ymax = Math.max(...ys);
    }
    L.push(`  <object>`);
    L.push(`    <name>${esc(label ? label.name : "unlabeled")}</name>`);
    L.push(`    <pose>Unspecified</pose>`);
    L.push(`    <truncated>0</truncated>`);
    L.push(`    <difficult>0</difficult>`);
    L.push(`    <bndbox>`);
    L.push(`      <xmin>${Math.round(xmin)}</xmin>`);
    L.push(`      <ymin>${Math.round(ymin)}</ymin>`);
    L.push(`      <xmax>${Math.round(xmax)}</xmax>`);
    L.push(`      <ymax>${Math.round(ymax)}</ymax>`);
    L.push(`    </bndbox>`);
    L.push(`  </object>`);
  }
  L.push(`</annotation>`);
  return L.join("\n");
}

// ---------------- COCO ----------------
/**
 * Builds one COCO manifest covering `images` (works for a single image or
 * the whole project -- same function either way, just a different-length
 * array). Category/image/annotation ids are small sequential integers
 * (typical COCO tooling assumes ints, not this app's UUIDs) but are only
 * stable WITHIN one generated manifest, not across separate downloads.
 */
function buildCocoManifest(project, images) {
  const categories = project.labels.map((l, i) => ({ id: i + 1, name: l.name }));
  const catIdByLabelId = new Map(project.labels.map((l, i) => [l.id, i + 1]));

  const cocoImages = [];
  const annotations = [];
  let skippedUnlabeled = 0;
  let nextImgId = 1;
  let nextAnnId = 1;

  for (const image of images) {
    const imgId = nextImgId++;
    cocoImages.push({ id: imgId, file_name: image.fileName, width: image.width, height: image.height });
    for (const { a, i } of orderedShapes(image)) {
      const catId = catIdByLabelId.get(a.labelId);
      if (catId == null) { skippedUnlabeled++; continue; } // no category_id possible for an unlabeled shape
      let bbox, segmentation;
      if (a.type === "bbox") {
        const r = a.rect;
        bbox = [r2(r.x * image.width), r2(r.y * image.height), r2(r.w * image.width), r2(r.h * image.height)];
        segmentation = [];
      } else {
        const xs = a.points.map((p) => p.x * image.width);
        const ys = a.points.map((p) => p.y * image.height);
        const xmin = Math.min(...xs), ymin = Math.min(...ys), xmax = Math.max(...xs), ymax = Math.max(...ys);
        bbox = [r2(xmin), r2(ymin), r2(xmax - xmin), r2(ymax - ymin)];
        const flat = [];
        for (let k = 0; k < a.points.length; k++) flat.push(r2(xs[k]), r2(ys[k]));
        segmentation = [flat];
      }
      annotations.push({
        id: nextAnnId++, image_id: imgId, category_id: catId,
        bbox, area: r2(bbox[2] * bbox[3]), iscrowd: 0, segmentation,
        line: i.line, sequence: i.seq,
      });
    }
  }

  const manifest = { images: cocoImages, annotations, categories };
  // Only present when it matters -- nothing silently missing, but no
  // "info" clutter when every shape made it in.
  if (skippedUnlabeled > 0) manifest.info = { skippedUnlabeledAnnotations: skippedUnlabeled };
  return manifest;
}

function buildCocoExportAll(project, images, completedOnly) {
  const hasShapes = (i) => i.annotations.length > 0;
  const list = completedOnly
    ? images.filter((i) => i.status === "COMPLETED" && hasShapes(i))
    : images.filter(hasShapes);
  return JSON.stringify(buildCocoManifest(project, list), null, 2);
}

// ---------------- YOLO ----------------
function buildYoloTxt(project, image) {
  const classIdByLabelId = new Map(project.labels.map((l, i) => [l.id, i]));
  const lines = [];
  let skippedUnlabeled = 0;
  for (const { a } of orderedShapes(image)) {
    const classId = classIdByLabelId.get(a.labelId);
    if (classId == null) { skippedUnlabeled++; continue; } // no "no class" token in YOLO's format
    if (a.type === "bbox") {
      const r = a.rect;
      const cx = r6(r.x + r.w / 2), cy = r6(r.y + r.h / 2);
      lines.push(`${classId} ${cx} ${cy} ${r6(r.w)} ${r6(r.h)}`);
    } else {
      const coords = a.points.map((p) => `${r6(p.x)} ${r6(p.y)}`).join(" ");
      lines.push(`${classId} ${coords}`);
    }
  }
  return { text: lines.join("\n") + (lines.length ? "\n" : ""), skippedUnlabeled };
}

function buildClassesTxt(project) {
  return project.labels.map((l) => l.name).join("\n") + (project.labels.length ? "\n" : "");
}

/** A lone YOLO .txt is nearly meaningless without the class_id -> name
 *  mapping, so the single-image download is a small zip carrying both. */
function buildYoloSingleZip(project, image) {
  const base = image.fileName.replace(/\.[^.]+$/, "");
  const y = buildYoloTxt(project, image);
  return buildZip([
    { name: `${base}.txt`, data: y.text },
    { name: "classes.txt", data: buildClassesTxt(project) },
  ]);
}

// ---------------- assembly ----------------
// Single-image file for whichever format -- used both for the "download
// this one image" buttons and (json/xml/voc) as the per-file builder inside
// buildExportZip below. `coords` only affects json/xml (see module header);
// it's accepted here regardless so every call site can pass it uniformly
// without checking format first. YOLO and COCO are handled separately by
// their callers: YOLO needs classes.txt bundled alongside (see
// buildYoloSingleZip), and COCO's "all images" case is one combined
// manifest, not one-per-image (see buildCocoExportAll) -- but a single
// image's own COCO file is still just fileFor(..., "coco"), a valid
// one-image manifest on its own.
function fileFor(project, image, format, coords = "both") {
  const base = image.fileName.replace(/\.[^.]+$/, "");
  if (format === "xml") return { name: `${base}.xml`, data: buildImageXml(project, image, coords) };
  if (format === "voc") return { name: `${base}.xml`, data: buildImageVoc(project, image) };
  if (format === "coco") return { name: `${base}.json`, data: JSON.stringify(buildCocoManifest(project, [image]), null, 2) };
  if (format === "yolo") return { name: `${base}.txt`, data: buildYoloTxt(project, image).text };
  return { name: `${base}.json`, data: JSON.stringify(buildImageJson(project, image, coords), null, 2) };
}

/**
 * Zip with one json/xml/voc/yolo file per image. Two distinct inclusion
 * modes:
 *
 *  - completedOnly=true  ("Completed images only"): the strict, final-
 *    deliverable mode. Only images with status COMPLETED -- meaning a human
 *    explicitly finished reviewing them via Save & Mark Complete. Nothing
 *    that's merely sitting at whatever a pre-annotation import produced,
 *    untouched, ever qualifies here.
 *
 *  - completedOnly=false ("export all"): a full best-effort snapshot. Every
 *    image that currently has ANY shapes is included, whatever their
 *    source -- a human's saved/edited annotations if the image has been
 *    worked on, or the raw pre-annotation import if nobody has touched it
 *    yet (image.annotations already holds whichever of the two is current;
 *    there's nothing else to fall back to). The one thing skipped in both
 *    modes is an image with zero shapes -- it gets no file at all, not an
 *    empty one.
 *
 * The zip's manifest.json is deliberately tiny: just how many files are in
 * here, which coordinate system(s) json/xml used (needed to read those
 * files correctly), and how many shapes got left out of a yolo export for
 * having no label -- not project name, mode, or per-image bookkeeping.
 */
function buildExportZip(project, images, format, completedOnly, coords = "both") {
  const hasShapes = (i) => i.annotations.length > 0;
  const list = completedOnly
    ? images.filter((i) => i.status === "COMPLETED" && hasShapes(i))
    : images.filter(hasShapes);

  let skippedUnlabeledAnnotations;
  const entries = list.map((img) => {
    const base = img.fileName.replace(/\.[^.]+$/, "");
    if (format === "yolo") {
      // Built directly (not via fileFor) so the skipped-unlabeled count from
      // each image can be accumulated in the same pass, rather than
      // re-deriving every image's YOLO lines a second time just to count.
      const y = buildYoloTxt(project, img);
      skippedUnlabeledAnnotations = (skippedUnlabeledAnnotations || 0) + y.skippedUnlabeled;
      return { name: `annotations/${base}.txt`, data: y.text };
    }
    const f = fileFor(project, img, format, coords);
    return { name: `annotations/${f.name}`, data: f.data };
  });
  // YOLO's per-image .txt files are only meaningful alongside the shared
  // class_id -> name mapping -- bundle it once at the zip root rather than
  // repeating it in every per-image file.
  if (format === "yolo") entries.push({ name: "classes.txt", data: buildClassesTxt(project) });

  const manifest = { imageCount: list.length };
  if (format === "json" || format === "xml") manifest.coords = coords;
  if (skippedUnlabeledAnnotations) manifest.skippedUnlabeledAnnotations = skippedUnlabeledAnnotations;
  entries.unshift({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });

  return buildZip(entries);
}

module.exports = {
  buildImageJson, buildImageXml, buildImageVoc,
  buildCocoManifest, buildCocoExportAll,
  buildYoloTxt, buildClassesTxt, buildYoloSingleZip,
  fileFor, buildExportZip,
};
