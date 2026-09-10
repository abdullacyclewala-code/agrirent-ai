// Phase 6 item 3 — equipment photo compression + Supabase Storage upload.
// Master doc §2: "compress client-side to ~150–200KB before upload to
// Supabase Storage (1GB free limit)".
//
// Every failure here is a typed UploadError (`.code`) so callers can show a
// precise, translated message instead of a raw exception string.

export const EQUIPMENT_PHOTOS_BUCKET = "equipment-photos";
export const MAX_PHOTOS_PER_LISTING = 4;
export const TARGET_BYTES = 200 * 1024; // ~200KB ceiling per §2
export const MAX_INPUT_BYTES = 15 * 1024 * 1024; // refuse absurd files before decoding
export const MAX_DIMENSION = 1600; // long edge after resize — plenty for listing photos
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

export class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

/**
 * Compress an image file to roughly TARGET_BYTES (default ~200KB).
 * Strategy: resize so the long edge is ≤ MAX_DIMENSION, then binary-search
 * JPEG/WebP quality until it fits. Falls back through encoders (WebP →
 * JPEG) because some browsers can't encode WebP.
 *
 * @returns {Promise<{blob: Blob, width: number, height: number, bytes: number, originalBytes: number}>}
 * @throws {UploadError} unsupported-type | too-large | decode-failed | encode-failed
 */
export async function compressImage(file, { targetBytes = TARGET_BYTES, maxDimension = MAX_DIMENSION } = {}) {
  if (!file || typeof file !== "object") {
    throw new UploadError("invalid-file", "No file provided.");
  }
  if (file.type && !ACCEPTED_TYPES.includes(file.type) && !file.type.startsWith("image/")) {
    throw new UploadError("unsupported-type", `Unsupported file type: ${file.type || "unknown"}.`);
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new UploadError("too-large", `File is ${(file.size / 1024 / 1024).toFixed(1)}MB; please pick one under 15MB.`);
  }
  if (typeof createImageBitmap === "undefined" || typeof document === "undefined") {
    throw new UploadError("unsupported-browser", "Image compression isn't available in this browser.");
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new UploadError("decode-failed", "Couldn't read that image — it may be corrupt or an unsupported format.");
  }

  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new UploadError("encode-failed", "Canvas 2D isn't available in this browser.");
    // JPEG has no alpha — flatten transparency onto white instead of black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const encode = (type, quality) =>
      new Promise((resolve) => canvas.toBlob(resolve, type, quality));

    // Small originals that already fit: still normalize through the canvas
    // (strips EXIF/GPS + flattens alpha) but keep high quality.
    if (file.size <= targetBytes && scale === 1) {
      const blob = (await encode("image/jpeg", 0.92)) || (await encode("image/png"));
      if (!blob) throw new UploadError("encode-failed", "Couldn't encode that image.");
      return { blob, width, height, bytes: blob.size, originalBytes: file.size };
    }

    // Binary-search quality for each encoder until the output fits.
    for (const type of ["image/webp", "image/jpeg"]) {
      let lo = 0.25;
      let hi = 0.92;
      let best = null;
      for (let i = 0; i < 6; i++) {
        const q = (lo + hi) / 2;
        // eslint-disable-next-line no-await-in-loop
        const blob = await encode(type, q);
        if (!blob) break; // encoder unsupported (e.g. old WebP) — try next type
        if (blob.size <= targetBytes) {
          best = blob;
          lo = q; // fits — try higher quality
        } else {
          hi = q; // too big — lower quality
        }
      }
      if (best) {
        return { blob: best, width, height, bytes: best.size, originalBytes: file.size };
      }
      // Nothing at this encoder fit — take the smallest attempt as a
      // last resort before trying the next encoder.
      const smallest = await encode(type, 0.2);
      if (smallest && smallest.size <= targetBytes * 1.5) {
        return { blob: smallest, width, height, bytes: smallest.size, originalBytes: file.size };
      }
    }

    // Extremely detailed photo that won't fit even at low quality: shrink
    // dimensions and try once more rather than failing the upload.
    const shrink = 0.6;
    canvas.width = Math.max(1, Math.round(width * shrink));
    canvas.height = Math.max(1, Math.round(height * shrink));
    const c2 = canvas.getContext("2d");
    c2.fillStyle = "#ffffff";
    c2.fillRect(0, 0, canvas.width, canvas.height);
    c2.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const last = await encode("image/jpeg", 0.55);
    if (!last) throw new UploadError("encode-failed", "Couldn't encode that image.");
    return { blob: last, width: canvas.width, height: canvas.height, bytes: last.size, originalBytes: file.size };
  } finally {
    bitmap.close();
  }
}

/** Storage path for a listing photo. Matches the RLS policy: the owner can
 *  only write under equipment/<their-uid>/. */
export function photoStoragePath(userId, listingId, ext = "jpg") {
  const rand = Math.random().toString(36).slice(2, 10);
  return `equipment/${userId}/${listingId}/${Date.now().toString(36)}-${rand}.${ext}`;
}

/** Extract the storage path back from a public URL (for deletes). Returns null if not ours. */
export function storagePathFromPublicUrl(url) {
  if (!url || typeof url !== "string") return null;
  const marker = `/storage/v1/object/public/${EQUIPMENT_PHOTOS_BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  return decodeURIComponent(url.slice(i + marker.length));
}

/**
 * Compress + upload one photo. Returns { url, path, bytes }.
 * @throws {UploadError} compress codes + upload-failed
 */
export async function uploadEquipmentPhoto(supabase, userId, listingId, file) {
  const { blob, bytes } = await compressImage(file);
  const ext = blob.type === "image/webp" ? "webp" : "jpg";
  const path = photoStoragePath(userId, listingId, ext);

  const { error } = await supabase.storage
    .from(EQUIPMENT_PHOTOS_BUCKET)
    .upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });

  if (error) {
    throw new UploadError("upload-failed", friendlyStorageError(error));
  }
  const { data } = supabase.storage.from(EQUIPMENT_PHOTOS_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, path, bytes };
}

/**
 * Best-effort delete — resolves false (never throws) so callers can fire
 * it during cleanup without breaking their main flow.
 */
export async function deleteEquipmentPhoto(supabase, pathOrUrl) {
  try {
    const path = pathOrUrl?.includes("/storage/")
      ? storagePathFromPublicUrl(pathOrUrl)
      : pathOrUrl;
    if (!path) return false;
    const { error } = await supabase.storage.from(EQUIPMENT_PHOTOS_BUCKET).remove([path]);
    if (error) {
      console.warn("[imageUpload] photo delete failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[imageUpload] photo delete failed:", err?.message || err);
    return false;
  }
}

/** Delete every photo under a listing's folder (used when a listing is deleted). */
export async function deleteListingPhotos(supabase, userId, listingId) {
  try {
    const folder = `equipment/${userId}/${listingId}`;
    const { data, error } = await supabase.storage.from(EQUIPMENT_PHOTOS_BUCKET).list(folder);
    if (error || !data?.length) return 0;
    const paths = data.map((f) => `${folder}/${f.name}`);
    const { error: rmErr } = await supabase.storage.from(EQUIPMENT_PHOTOS_BUCKET).remove(paths);
    if (rmErr) {
      console.warn("[imageUpload] listing photo cleanup failed:", rmErr.message);
      return 0;
    }
    return paths.length;
  } catch (err) {
    console.warn("[imageUpload] listing photo cleanup failed:", err?.message || err);
    return 0;
  }
}

function friendlyStorageError(error) {
  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("row-level security") || msg.includes("policy") || msg.includes("unauthorized")) {
    return "Upload blocked by permissions — please sign in again and retry.";
  }
  if (msg.includes("bucket") && msg.includes("not found")) {
    return "Photo storage isn't set up yet — please try again later.";
  }
  if (msg.includes("exceeded") || msg.includes("quota") || msg.includes("limit")) {
    return "Storage is full — please remove an old photo and retry.";
  }
  if (msg.includes("network") || msg.includes("fetch") || msg.includes("failed to fetch")) {
    return "Network error during upload — check your connection and retry.";
  }
  return error?.message || "Photo upload failed — please retry.";
}
