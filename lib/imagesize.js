"use strict";
/**
 * Pure-JS image dimension sniffing (PNG, JPEG, GIF, BMP, WEBP) -- reads only
 * the first few KB of each file, no native deps. Returns {width, height} or
 * null if the format can't be determined.
 */

const fs = require("node:fs");

function readHead(filePath, bytes = 64 * 1024) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function pngSize(b) {
  // 8-byte signature, then IHDR chunk: length(4) "IHDR" width(4) height(4)
  if (b.length < 24) return null;
  if (b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b) {
  if (b.length < 10) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function bmpSize(b) {
  if (b.length < 26) return null;
  return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
}

function jpegSize(b) {
  // Walk markers until a SOFn frame header carrying dimensions.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT(C4)/JPGA(C8)/DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const fmt = b.toString("ascii", 12, 16);
  if (fmt === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (fmt === "VP8L") {
    const n = b.readUInt32LE(21);
    return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
  }
  if (fmt === "VP8X") {
    return {
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
    };
  }
  return null;
}

/** @returns {{width:number,height:number}|null} */
function imageSize(filePath) {
  let b;
  try {
    b = readHead(filePath);
  } catch {
    return null;
  }
  if (b.length < 12) return null;
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return pngSize(b); // PNG
    if (b[0] === 0xff && b[1] === 0xd8) return jpegSize(b); // JPEG
    if (b[0] === 0x47 && b[1] === 0x49) return gifSize(b); // GIF
    if (b[0] === 0x42 && b[1] === 0x4d) return bmpSize(b); // BMP
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return webpSize(b);
  } catch {
    return null;
  }
  return null;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
};

module.exports = { imageSize, IMAGE_EXTENSIONS, MIME };
