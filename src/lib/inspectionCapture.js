// Phase 7 — inspection capture engine.
//
// Everything that turns "a photo on a phone" into "evidence" happens here, and
// it happens in the browser BEFORE upload, because the cheapest place to stop a
// bad or reused photo is while the person is still standing next to the
// machine.
//
// The pipeline for one photo:
//   1. parse EXIF from the ORIGINAL bytes (camera, clock, GPS)
//   2. decode, measure quality (blur / darkness) -> retake prompt on the spot
//   3. attach GPS (EXIF if the camera wrote it, else the live fix; EXIF wins)
//   4. bake a permanent stamp INTO THE PIXELS — report code, IST time, GPS
//   5. splice the original EXIF back in, so the file stays forensically useful
//   6. fingerprint: sha256 of the exact bytes + a perceptual dHash of the pixels
//
// Steps 1–2 are pure functions, unit-tested in node (scripts/test-trust.mjs)
// against real JPEG bytes — no canvas needed. Only 3–5 touch the browser.

import { POLICY } from "./depositPolicy.js";

// ---------------------------------------------------------------------------
// Slots — the guided shots. Four taps, no typing (docs/PHASE7 §2).
// ---------------------------------------------------------------------------

export const REQUIRED_SLOTS = ["full_left", "full_right", "meter", "work_area"];

export const SLOTS = [
  {
    id: "full_left",
    required: true,
    titleKey: "trust.slotFullLeft",
    hintKey: "trust.slotFullLeftHint",
    fallbackTitle: "Whole machine — front left",
    fallbackHint: "Step back so the whole machine fits. This is the shot that settles 'it was already like that'.",
  },
  {
    id: "full_right",
    required: true,
    titleKey: "trust.slotFullRight",
    hintKey: "trust.slotFullRightHint",
    fallbackTitle: "Whole machine — rear right",
    fallbackHint: "Same distance, other side.",
  },
  {
    id: "meter",
    required: true,
    titleKey: "trust.slotMeter",
    hintKey: "trust.slotMeterHint",
    fallbackTitle: "Hour meter / odometer",
    fallbackHint: "Close up on the dial, digits readable. We read the number for you.",
  },
  {
    id: "work_area",
    required: true,
    titleKey: "trust.slotWork",
    hintKey: "trust.slotWorkHint",
    fallbackTitle: "Tyres, implement & wear points",
    fallbackHint: "Where damage usually happens — tyres, blades, hitch, guards.",
  },
  {
    id: "extra",
    required: false,
    titleKey: "trust.slotExtra",
    hintKey: "trust.slotExtraHint",
    fallbackTitle: "Extra photo",
    fallbackHint: "Anything else worth recording — existing damage, a missing part, a repair estimate.",
  },
];

export function slotById(id) {
  return SLOTS.find((s) => s.id === id) || SLOTS[SLOTS.length - 1];
}

/** Storage path convention — MUST match the bucket RLS policies:
 *  `inspections/<booking_id>/<report_id>/<slot>-<rand>.jpg`. */
export function inspectionStoragePath(bookingId, reportId, slot, ext = "jpg") {
  const rand = Math.random().toString(36).slice(2, 10);
  return `inspections/${bookingId}/${reportId}/${slot}-${Date.now().toString(36)}-${rand}.${ext}`;
}

// ---------------------------------------------------------------------------
// 1. EXIF — minimal, dependency-free JPEG reader
// ---------------------------------------------------------------------------
// Deliberately hand-rolled: pulling in a full EXIF library to read six fields
// isn't worth the bundle, and this way the parsing rules are visible and
// testable. Handles JPEG only (HEIC from iOS gets no EXIF, which is recorded as
// `no_camera_exif` rather than guessed at) — see docs/PHASE7 §9 risk 3.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("expected bytes");
}

/** Walk JPEG segments; returns markers with their payload ranges. Stops at
 *  the start of scan data (0xDA) — image data is never parsed. */
export function jpegSegments(bytes) {
  const out = [];
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return out;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (len < 2) break;
    const payloadStart = offset + 4;
    const payloadEnd = payloadStart + len - 2;
    if (payloadEnd > bytes.length) break;
    out.push({ marker, start: offset, payloadStart, payloadEnd, length: len + 2 });
    offset = payloadEnd;
  }
  return out;
}

/** The APP1 "Exif\0\0" payload of a JPEG, or null. Used to carry the camera's
 *  own metadata across the watermark re-encode (see injectExifSegment). */
export function extractExifSegment(input) {
  const bytes = toBytes(input);
  for (const seg of jpegSegments(bytes)) {
    if (seg.marker !== 0xe1) continue;
    const p = seg.payloadStart;
    if (bytes[p] === 0x45 && bytes[p + 1] === 0x78 && bytes[p + 2] === 0x69 && bytes[p + 3] === 0x66) {
      return bytes.slice(seg.start, seg.payloadEnd); // FF E1 len len <payload>
    }
  }
  return null;
}

function readIfd(dv, offset, le, limit) {
  const entries = {};
  if (offset + 2 > limit) return { entries, next: 0 };
  const count = dv.getUint16(offset, le);
  if (count > 512) return { entries, next: 0 }; // malformed guard
  for (let i = 0; i < count; i++) {
    const off = offset + 2 + i * 12;
    if (off + 12 > limit) break;
    const tag = dv.getUint16(off, le);
    const type = dv.getUint16(off + 2, le);
    const n = dv.getUint32(off + 4, le);
    const size = (TYPE_SIZE[type] || 1) * n;
    const valueOffset = size <= 4 ? off + 8 : dv.getUint32(off + 8, le);
    if (valueOffset + size > limit) continue;
    entries[tag] = { type, count: n, valueOffset };
  }
  const nextOffsetPos = offset + 2 + count * 12;
  const next = nextOffsetPos + 4 <= limit ? dv.getUint32(nextOffsetPos, le) : 0;
  return { entries, next };
}

function readAscii(dv, e) {
  let s = "";
  for (let i = 0; i < e.count && i < 256; i++) {
    const c = dv.getUint8(e.valueOffset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function readU32(dv, e, le) {
  return e.count >= 1 ? dv.getUint32(e.valueOffset, le) : null;
}

function readRationals(dv, e, le) {
  const out = [];
  for (let i = 0; i < e.count; i++) {
    const num = dv.getUint32(e.valueOffset + i * 8, le);
    const den = dv.getUint32(e.valueOffset + i * 8 + 4, le);
    out.push(den === 0 ? 0 : num / den);
  }
  return out;
}

function dms([d, m, s], ref) {
  let v = (d || 0) + (m || 0) / 60 + (s || 0) / 3600;
  if (ref === "S" || ref === "W") v = -v;
  return v;
}

/**
 * Parse the handful of EXIF fields this feature actually uses.
 * Returns null when there is no usable EXIF (screenshots, WhatsApp-forwarded
 * images, HEIC, canvas output) — callers record that fact rather than
 * inventing data.
 *
 * `datetime_original` is the camera's LOCAL wall-clock with no zone, exactly as
 * written. `datetime_original_epoch` additionally assumes the device's current
 * UTC offset, which is what lets the server compare capture time against
 * receipt time without a 5:30 false flag for every farmer in India.
 */
export function parseJpegExif(input) {
  try {
    const bytes = toBytes(input);
    const seg = extractExifSegment(bytes);
    if (!seg) return null;

    const tiffStart = 4 + 6; // FF E1 + len(2) + "Exif\0\0"
    const tiffLen = seg.length - 2 /* marker */ - 2 /* len */ - 6;
    if (tiffLen <= 8) return null;

    const dv = new DataView(seg.buffer, seg.byteOffset + tiffStart, tiffLen);
    const order = dv.getUint16(0);
    const le = order === 0x4949; // "II" little-endian, else "MM" big-endian
    if (!le && order !== 0x4d4d) return null;
    if (dv.getUint16(2, le) !== 42) return null;

    const limit = tiffLen;
    const ifd0Offset = dv.getUint32(4, le);
    const { entries: ifd0 } = readIfd(dv, ifd0Offset, le, limit);

    const exifPointer = ifd0[0x8769] ? readU32(dv, ifd0[0x8769], le) : null;
    const gpsPointer = ifd0[0x8825] ? readU32(dv, ifd0[0x8825], le) : null;
    const exifIfd = exifPointer ? readIfd(dv, exifPointer, le, limit).entries : {};
    const gpsIfd = gpsPointer ? readIfd(dv, gpsPointer, le, limit).entries : {};

    const out = {};

    if (ifd0[0x010f]) out.make = readAscii(dv, ifd0[0x010f]);
    if (ifd0[0x0110]) out.model = readAscii(dv, ifd0[0x0110]);
    if (ifd0[0x0131]) out.software = readAscii(dv, ifd0[0x0131]);
    if (ifd0[0x0132]) out.datetime = readAscii(dv, ifd0[0x0132]);
    if (exifIfd[0x9003]) out.datetime_original = readAscii(dv, exifIfd[0x9003]);
    else if (ifd0[0x0132]) out.datetime_original = out.datetime;

    if (gpsIfd[0x0001] && gpsIfd[0x0002]) {
      const latRef = readAscii(dv, gpsIfd[0x0001]);
      out.gps_lat = dms(readRationals(dv, gpsIfd[0x0002], le), latRef);
    }
    if (gpsIfd[0x0003] && gpsIfd[0x0004]) {
      const lngRef = readAscii(dv, gpsIfd[0x0003]);
      out.gps_lng = dms(readRationals(dv, gpsIfd[0x0004], le), lngRef);
    }
    if (gpsIfd[0x0006]) out.gps_alt = readRationals(dv, gpsIfd[0x0006], le)[0] ?? null;

    if (out.datetime_original) {
      const m = out.datetime_original.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        out.datetime_original_iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
        const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        const tzOffsetMin = typeof Date !== "undefined" ? new Date().getTimezoneOffset() : 0;
        // getTimezoneOffset() is minutes BEHIND UTC (IST = -330).
        out.datetime_original_epoch = naive - tzOffsetMin * 60 * 1000;
        out.tz_offset_minutes = -tzOffsetMin;
      }
    }

    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Splice an APP1 EXIF segment (from the original file) into a freshly encoded
 * JPEG. This is what keeps evidence forensically useful after the watermark
 * forces a re-encode: canvas.toBlob() strips metadata, so we put the camera's
 * own EXIF back where a lab tool (and our own backend) can still read it.
 */
export function injectExifSegment(jpegInput, app1Input) {
  const bytes = toBytes(jpegInput);
  const app1 = app1Input ? toBytes(app1Input) : null;
  if (!app1) return bytes;
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;

  // Drop any Exif APP1 already present so there is exactly one.
  const segments = jpegSegments(bytes);
  const existing = segments.find(
    (s) => s.marker === 0xe1 && bytes[s.payloadStart] === 0x45 && bytes[s.payloadStart + 1] === 0x78,
  );
  let base = bytes;
  if (existing) {
    const stripped = new Uint8Array(bytes.length - existing.length);
    stripped.set(bytes.subarray(0, existing.start), 0);
    stripped.set(bytes.subarray(existing.payloadEnd), existing.start);
    base = stripped;
  }

  // JFIF (APP0) should stay first; insert after it when present.
  const first = jpegSegments(base)[0];
  const insertAt = first && first.marker === 0xe0 ? first.payloadEnd : 2;

  const out = new Uint8Array(base.length + app1.length);
  out.set(base.subarray(0, insertAt), 0);
  out.set(app1, insertAt);
  out.set(base.subarray(insertAt), insertAt + app1.length);
  return out;
}

// ---------------------------------------------------------------------------
// 2. Fingerprints (pure — testable without a canvas)
// ---------------------------------------------------------------------------

/** dHash: resize to 9×8 grayscale, compare each pixel to its right neighbour
 *  → 64 bits. Survives resize and re-compression, so "the same photo filed
 *  twice" is caught even when the file bytes differ. */
export function dhashFromGray(gray, width = 9, height = 8) {
  let bits = "";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      bits += gray[y * width + x] < gray[y * width + x + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Downsample RGBA pixels to the 9×8 grayscale grid dHash needs. */
export function gray9x8(rgba, width, height) {
  const gray = new Float64Array(81);
  const counts = new Float64Array(81);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(7, Math.floor((y / height) * 8));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(8, Math.floor((x / width) * 9));
      const i = (y * width + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      gray[gy * 9 + gx] += lum;
      counts[gy * 9 + gx] += 1;
    }
  }
  for (let i = 0; i < 81; i++) gray[i] = counts[i] ? gray[i] / counts[i] : 0;
  return gray;
}

export function dhashFromRgba(rgba, width, height) {
  return dhashFromGray(gray9x8(rgba, width, height));
}

/** Hamming distance between two 16-hex-char dHashes. 0 = identical. */
export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

export function isDuplicateHash(a, b, threshold = POLICY.duplicateHammingThreshold) {
  return hammingDistance(a, b) <= threshold;
}

// ---------------------------------------------------------------------------
// 3. Quality gate (pure math, canvas-fed)
// ---------------------------------------------------------------------------

export function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Variance of the Laplacian — the standard cheap blur detector. Returns a
 *  number on the 0–255 luminance scale: <10 is unusable, >40 is crisp. */
export function laplacianVariance(gray, width, height) {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function exposureStats(gray) {
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i];
    if (gray[i] < 32) dark++;
    if (gray[i] > 240) bright++;
  }
  const n = gray.length || 1;
  return { mean: sum / n, darkRatio: dark / n, brightRatio: bright / n };
}

/**
 * Turns measurements into a verdict the capture UI can act on.
 * Thresholds are deliberately lenient — a blurry-looking-but-real photo is
 * better evidence than no photo, so this WARNS by default and only fails when
 * the image genuinely cannot be read (which is also what the on-device
 * experience needs: no farmer should be stuck behind a picky quality check).
 */
export function assessQuality({ sharpness = 0, mean = 128, darkRatio = 0, brightRatio = 0 }) {
  const warnings = [];
  if (sharpness < 10) warnings.push("blurry");
  else if (sharpness < 25) warnings.push("soft");
  if (mean < 45 || darkRatio > 0.55) warnings.push("too_dark");
  if (mean > 215 || brightRatio > 0.35) warnings.push("too_bright");
  const blocking = sharpness < 4 || (mean < 22 && darkRatio > 0.8);
  return { verdict: blocking ? "fail" : warnings.length ? "warn" : "pass", warnings };
}

// ---------------------------------------------------------------------------
// 4. Watermark (baked into pixels, not overlaid by CSS)
// ---------------------------------------------------------------------------

/** Where the stamp goes — pure, so the layout is testable. */
export function watermarkLayout(width, height) {
  const bandHeight = Math.max(28, Math.round(height * 0.075));
  return {
    x: Math.round(width * 0.018),
    y: height - bandHeight,
    width: width - Math.round(width * 0.036),
    height: bandHeight - Math.round(height * 0.012),
    fontSize: Math.max(11, Math.round(bandHeight * 0.3)),
  };
}

export function watermarkLines({ reportCode, bookingId, istTime, gps, slotLabel }) {
  const where = gps && Number.isFinite(gps.lat) ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : "no GPS";
  return [
    `AgriRent AI · ${reportCode || "unsaved"} · Booking #${bookingId ?? "?"}`,
    `${slotLabel || ""}${slotLabel ? " · " : ""}${istTime || ""} IST`,
    where,
  ];
}

/** IST wall-clock string — the stamp must be in the same clock the user lives
 *  in (Render runs UTC; the farmer does not). */
export function formatIst(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(date)
      .replace(",", "");
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

// ---------------------------------------------------------------------------
// 5. Browser-only pieces
// ---------------------------------------------------------------------------

export async function sha256Hex(input) {
  const bytes = input instanceof Blob ? await input.arrayBuffer() : toBytes(input);
  if (typeof crypto === "undefined" || !crypto.subtle) {
    // Insecure context (http:// on a LAN IP) — the app still works, and the
    // backend recomputes the hash server-side anyway, so nothing is trusted
    // that shouldn't be.
    return null;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function haversineKm(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to <img> */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode-failed"));
    };
    img.src = url;
  });
}

/** Live GPS fix — best-effort, never blocking (docs/PHASE7: the flow must not
 *  stall because a permission prompt was dismissed). */
export async function getLiveLocation({ timeoutMs = 8000 } = {}) {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 60000,
      });
    });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  } catch {
    return null;
  }
}

const MAX_EVIDENCE_EDGE = 1600;
const EVIDENCE_QUALITY = 0.82;

/**
 * Bake the stamp into the pixels and re-attach the camera's EXIF.
 * Returns a JPEG blob — the bytes that get hashed, uploaded and kept.
 */
export async function bakeEvidencePhoto(bitmap, { reportCode, bookingId, slot, gps, capturedAt = new Date(), label }) {
  const scale = Math.min(1, MAX_EVIDENCE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);

  const lines = watermarkLines({ reportCode, bookingId, istTime: formatIst(capturedAt), gps, slotLabel: label });
  const box = watermarkLayout(width, height);
  // A slightly stronger stamp for the meter shot — that number is a fact we
  // want to be able to read back from the pixels later.
  ctx.fillStyle = "rgba(28,22,16,0.62)";
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.font = `${i === 0 ? 700 : 400} ${box.fontSize}px system-ui, sans-serif`;
    ctx.fillText(line, box.x + 8, box.y + 6 + i * (box.fontSize + 3));
  });

  // Corner code, so a cropped screenshot still carries the report identity.
  ctx.font = `700 ${Math.max(10, Math.round(width * 0.028))}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillText(reportCode || "", Math.max(8, width * 0.012), Math.max(6, height * 0.014));

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", EVIDENCE_QUALITY));
  if (!blob) throw new Error("encode-failed");
  return { blob, width, height };
}

/**
 * Full per-photo pipeline. `rawBlob` is the untouched camera/file output; the
 * returned object is exactly what gets stored, so the DB row and the pixels
 * never disagree.
 */
export async function prepareEvidencePhoto({
  rawBlob,
  slot,
  reportCode,
  bookingId,
  label,
  liveGps = null,
  reportGps = null,
}) {
  const originalBytes = await rawBlob.arrayBuffer();
  const exif = parseJpegExif(originalBytes);
  const bitmap = await decodeImage(rawBlob);

  // Quality on a small gray copy — enough signal, cheap, and it never touches
  // the bytes we keep.
  const probeCanvas = document.createElement("canvas");
  const pw = Math.min(320, bitmap.width);
  const ph = Math.max(1, Math.round((bitmap.height / bitmap.width) * pw));
  probeCanvas.width = pw;
  probeCanvas.height = ph;
  const pctx = probeCanvas.getContext("2d");
  pctx.drawImage(bitmap, 0, 0, pw, ph);
  const probe = pctx.getImageData(0, 0, pw, ph);
  const gray = new Float64Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) {
    gray[i] = luminance(probe.data[i * 4], probe.data[i * 4 + 1], probe.data[i * 4 + 2]);
  }
  const quality = {
    ...assessQuality({ sharpness: laplacianVariance(gray, pw, ph), ...exposureStats(gray) }),
    sharpness: Math.round(laplacianVariance(gray, pw, ph)),
  };

  const capturedAt = new Date();
  const { blob, width, height } = await bakeEvidencePhoto(bitmap, {
    reportCode,
    bookingId,
    slot,
    label,
    gps: exif?.gps_lat != null ? { lat: exif.gps_lat, lng: exif.gps_lng } : liveGps || reportGps,
    capturedAt,
  });
  if (typeof bitmap.close === "function") bitmap.close();

  // Keep the camera's metadata across the re-encode.
  const withExif = injectExifSegment(new Uint8Array(await blob.arrayBuffer()), extractExifSegment(originalBytes));
  const finalBlob = new Blob([withExif], { type: "image/jpeg" });

  // dHash of the FINAL pixels (the ones that will be stored) — computed from
  // the same canvas, so client and server hash the identical image.
  const hashCanvas = document.createElement("canvas");
  hashCanvas.width = 9;
  hashCanvas.height = 8;
  const hctx = hashCanvas.getContext("2d");
  hctx.drawImage(await decodeImage(finalBlob), 0, 0, 9, 8);
  const small = hctx.getImageData(0, 0, 9, 8);
  const dhash = dhashFromRgba(small.data, 9, 8);

  const sha256 = await sha256Hex(finalBlob);
  const gpsFrom = exif?.gps_lat != null ? "exif" : liveGps ? "live" : reportGps ? "report" : "none";

  return {
    slot,
    blob: finalBlob,
    bytes: finalBlob.size,
    width,
    height,
    sha256,
    dhash,
    quality,
    exif,
    gps: exif?.gps_lat != null
      ? { lat: exif.gps_lat, lng: exif.gps_lng, source: "exif" }
      : liveGps
        ? { ...liveGps, source: "live" }
        : reportGps
          ? { ...reportGps, source: "report" }
          : { lat: null, lng: null, source: "none" },
    gps_source: gpsFrom,
    captured_at_device: capturedAt.toISOString(),
    watermark_text: watermarkLines({
      reportCode,
      bookingId,
      istTime: formatIst(capturedAt),
      gps: exif?.gps_lat != null ? { lat: exif.gps_lat, lng: exif.gps_lng } : liveGps || reportGps,
      slotLabel: label,
    }).join(" | "),
    device: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : null,
  };
}

/** Upload one prepared photo to the private evidence bucket.
 *  `onProgress` is called with 0..1 so the UI can show real progress instead of
 *  a spinner (a farmer on 2 bars of signal needs to know it's moving). */
export async function uploadEvidencePhoto(supabase, { bookingId, reportId, photo, onProgress }) {
  const path = inspectionStoragePath(bookingId, reportId, photo.slot);
  const { error } = await supabase.storage
    .from("inspection-photos")
    .upload(path, photo.blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(friendlyStorageError(error));
  onProgress?.(1);
  return path;
}

/** Signed URL for reading evidence back (the bucket is private by design). */
export async function signedEvidenceUrl(supabase, path, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from("inspection-photos").createSignedUrl(path, expiresIn);
  if (error) return null;
  return data?.signedUrl || null;
}

export async function signedEvidenceUrls(supabase, paths, expiresIn = 3600) {
  if (!paths?.length) return {};
  const { data, error } = await supabase.storage.from("inspection-photos").createSignedUrls(paths, expiresIn);
  if (error || !data) return {};
  const map = {};
  for (const row of data) if (row?.path && row?.signedUrl) map[row.path] = row.signedUrl;
  return map;
}

function friendlyStorageError(error) {
  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("row-level security") || msg.includes("policy") || msg.includes("unauthorized")) {
    return "Upload blocked — you may not be a party on this booking, or the session expired.";
  }
  if (msg.includes("bucket") && msg.includes("not found")) {
    return "Evidence storage isn't set up yet (bucket missing).";
  }
  if (msg.includes("exceeded") || msg.includes("quota") || msg.includes("limit")) {
    return "The photo was too large for storage. Try retaking it.";
  }
  if (msg.includes("network") || msg.includes("fetch")) {
    return "Network dropped during upload — your photos are still here, tap retry.";
  }
  return error?.message || "Photo upload failed — please retry.";
}
