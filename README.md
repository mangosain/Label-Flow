# LabelFlow

A zero-dependency, self-hosted tool for collaboratively annotating images with
bounding boxes and polygons — built to run with nothing but Node.js. No
`npm install`, no database server, no build step.

```
node server.js
```

That's it. Two HTTP servers start: one for the people doing the labeling, one
for the admin.

## Why two ports

LabelFlow's access model is the network, not a login screen.

| Listener | Default port | Reachable from | Who it's for |
|---|---|---|---|
| LAN | `3000` | Anyone on your local network | Labelers — join with just a name |
| Admin | `3001` | This machine only (loopback) | Whoever is sitting at this computer |

The admin port refuses connections from anywhere but `localhost`, so there's
no password to manage — physical/network access to the admin machine *is*
the permission. Labelers get a lightweight name-based identity (no
password) scoped to the LAN port only; they can never reach `/admin*` or
`/api/admin/*` routes, even if they guess the URL.

## Features

- **Bounding boxes and polygons**, drawn, selected, moved, and resized
  directly on an HTML canvas — no framework, no build step.
- **Automatic line & sequence numbering.** Shapes are grouped into reading
  "lines" by vertical position and numbered left-to-right within each line
  (`L2-3` = line 2, 3rd shape), with a manual override when the automatic
  grouping guesses wrong. Numbers are recomputed fresh every time, from
  whatever shapes currently exist — delete one and everything renumbers
  itself.
- **Multi-user collaboration.** Labelers claim an image, annotate it, and
  save — work syncs to the admin the moment Save is pressed (not
  autosaved continuously, by design, so "saved" always means something).
- **Multi-project support.** Create, switch between, unload, or
  permanently delete projects from the admin dashboard. Deleting a
  project only removes this app's own tracking data — your dataset and
  annotation files on disk are never touched.
- **Pre-annotation import.** Point at a folder of images and, optionally,
  a separate folder of existing labels — they're matched by filename and
  loaded as ordinary, fully editable shapes. See [Importing](#importing-pre-annotations) below for supported formats.
- **Export to 5 formats**, barebones by design — just the page and the
  shapes on it, nothing else. See [Exporting](#exporting) below.
- Undo/redo, zoom (`Ctrl`+scroll), pan (scroll, or `Shift`+scroll for
  horizontal), keyboard shortcuts for every tool, label autocomplete with
  per-browser history, and a live shapes/labels sidebar for
  jumping straight to any box or polygon.

## Quick start

1. **Start the server** from the project folder:
   ```
   node server.js
   ```
   Optionally set `PORT` (LAN listener, default `3000`) and `ADMIN_PORT`
   (admin listener, default `3001`) as environment variables.
2. **Open the admin panel** on the host machine: `http://localhost:3001`.
   Create a project, then upload a dataset (a folder of images) and,
   optionally, a separate folder of pre-existing annotations.
3. **Share the LAN URL** the server prints on startup with your labelers.
   They open it in a browser, type their name, and start claiming pages.

No accounts, no database setup, no dependencies to install.

## Importing pre-annotations

Pointing the admin dataset-upload panel at a folder of images will, if you
also give it an annotations folder, automatically match files to images by
filename (ignoring subfolders) and load whatever it finds as normal,
editable shapes. Supported formats, auto-detected per file:

- **Pascal VOC XML** (`<object><bndbox>`, with an optional `<polygon>`
  extension and manual `<line>` override)
- **LabelFlow's own JSON/XML** (round-trips its own exports losslessly)
- **LabelMe JSON** (`{shapes:[{shape_type, points, label}]}`)
- **COCO JSON** — one manifest for the whole dataset, matched by `file_name`
- **YOLO `.txt`** — normalized `class_id cx cy w h` per line, reading class
  names from `classes.txt` / `obj.names` / `data.yaml`
- **Raw detector/OCR output** (`{boxes:[{bbox, confidence}]}`) — imported as
  unlabeled boxes for a human to name, since detector output has no class
  names

Re-running an import is always safe: brand-new images are added, and any
already-uploaded image with zero shapes gets backfilled, but an image that
already has shapes — imported earlier or hand-drawn — is never touched or
overwritten.

## Exporting

Every format exports just two things: the page (filename, width, height)
and the shapes on it (type, line/sequence number, label, coordinates) — no
project metadata, timestamps, status, or internal ids.

| Format | Coordinates | Notes |
|---|---|---|
| JSON | your choice: normalized, pixel, or both | LabelFlow's own schema; round-trips back in as a pre-annotation import |
| XML | your choice: normalized, pixel, or both | Same content as JSON, in XML form |
| Pascal VOC | pixel (fixed by spec) | Strict, standard VOC — no custom elements, so any VOC tool reads it. Polygons degrade to their bounding box (VOC has no polygon concept) |
| COCO | pixel (fixed by spec) | One combined manifest (not per-image files), as COCO expects. Carries `line`/`sequence` too, since COCO has room for extra keys |
| YOLO | normalized (fixed by spec) | `class_id cx cy w h` per line, plus a shared `classes.txt`. Can't carry line/sequence — every real YOLO reader expects an exact fixed token count per line |

JSON and XML ask which coordinate system to include before downloading,
since they're the two formats LabelFlow fully controls. VOC/COCO/YOLO each
have exactly one valid coordinate convention by their own spec, so there's
nothing to ask.

Downloads are available per-image or in bulk (every image in the project).
Bulk exports can be filtered to completed images only, or every image that
currently has any shapes at all.

## Project structure

```
server.js       Two HTTP listeners (LAN + admin), all API routes
lib/            Server-side logic: storage, import, export, image sizing, zip/dialog helpers
public/         Browser-side: the labeler workspace, admin dashboard, and the shared canvas engine
```

Runtime data (projects, images, annotations) is written to `./state`
relative to wherever `node server.js` is run from — see `.gitignore`.

## Requirements

Node.js (built-in `http`, `fs`, `crypto`, `url` modules only — no
dependencies to install, ever).
