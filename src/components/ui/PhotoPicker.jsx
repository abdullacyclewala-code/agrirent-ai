import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Camera, X, Loader2, AlertTriangle } from "lucide-react";
import { compressImage, MAX_PHOTOS_PER_LISTING } from "../../lib/imageUpload.js";

// Controlled multi-photo picker with staged (not yet uploaded) files.
// A photo item is:
//   { key, kind: "existing", url }                       — already on the listing
//   { key, kind: "new", file, previewUrl, bytes?, error? } — picked, compressed client-side,
//                                                            uploaded by the parent on save

function formatKB(bytes) {
  if (bytes == null) return "";
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function PhotoPicker({ photos, onChange, disabled = false }) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const atMax = photos.length >= MAX_PHOTOS_PER_LISTING;

  const updateItem = (key, patch) =>
    onChange(photos.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const handleFiles = async (fileList) => {
    const files = [...(fileList || [])].filter((f) => f && f.size > 0);
    if (!files.length) return;
    const room = MAX_PHOTOS_PER_LISTING - photos.length;
    if (room <= 0) return;

    const staged = files.slice(0, room).map((file, i) => ({
      key: `new-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "new",
      file,
      previewUrl: URL.createObjectURL(file),
      bytes: null, // filled in once compression finishes
      originalBytes: file.size,
      error: null,
      compressing: true,
    }));
    const next = [...photos, ...staged];
    onChange(next);

    // Compress eagerly so size/validity problems surface NOW (with a clear
    // per-photo message) instead of mysteriously failing at save time.
    for (const item of staged) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { bytes } = await compressImage(item.file);
        updateItemRef.current?.(item.key, { bytes, compressing: false });
      } catch (err) {
        updateItemRef.current?.(item.key, {
          compressing: false,
          error:
            err?.code === "too-large"
              ? t("addEquipment.photoTooLarge")
              : err?.code === "unsupported-type" || err?.code === "invalid-file"
                ? t("addEquipment.photoInvalidType")
                : t("addEquipment.photoUnreadable"),
        });
      }
    }
    if (inputRef.current) inputRef.current.value = ""; // allow re-picking the same file
  };

  // `photos` in the closure above goes stale across awaits — always patch the latest.
  const updateItemRef = useRef(updateItem);
  updateItemRef.current = updateItem;

  const remove = (item) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    onChange(photos.filter((p) => p.key !== item.key));
  };

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {photos.map((p) => (
          <div
            key={p.key}
            className="relative aspect-square overflow-hidden rounded-xl border border-line bg-line-2"
          >
            {(p.kind === "existing" ? p.url : p.previewUrl) && !p.error ? (
              <img
                src={p.kind === "existing" ? p.url : p.previewUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
                <AlertTriangle size={18} className="text-accent" />
                <span className="text-[11px] leading-tight text-accent">{p.error}</span>
              </div>
            )}
            {p.compressing && (
              <div className="absolute inset-0 flex items-center justify-center bg-ink/40">
                <Loader2 size={20} className="animate-spin text-paper" />
              </div>
            )}
            {!p.error && !p.compressing && p.kind === "new" && p.bytes != null && (
              <span className="absolute bottom-1.5 left-1.5 rounded-md bg-ink/70 px-1.5 py-0.5 font-mono text-[10px] text-paper">
                {formatKB(p.originalBytes)} → {formatKB(p.bytes)}
              </span>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(p)}
                aria-label={t("addEquipment.photoRemove")}
                className="absolute right-1.5 top-1.5 rounded-full bg-ink/70 p-1.5 text-paper hover:bg-ink"
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}

        {!atMax && !disabled && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-mut2 text-mut transition-colors hover:border-accent hover:text-accent"
          >
            <Camera size={22} />
            <span className="px-2 text-center text-xs">{t("addEquipment.photoAdd")}</span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <p className="mt-2 text-xs text-mut2">
        {atMax
          ? t("addEquipment.photoMaxReached", { max: MAX_PHOTOS_PER_LISTING })
          : t("addEquipment.photosHint", { max: MAX_PHOTOS_PER_LISTING })}
      </p>
    </div>
  );
}
