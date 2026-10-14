import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, Check, RotateCcw, AlertTriangle, Loader2, X, Info } from "lucide-react";
import { Button, Chip } from "../ui/Primitives.jsx";
import {
  SLOTS,
  REQUIRED_SLOTS,
  slotById,
  prepareEvidencePhoto,
  getLiveLocation,
  uploadEvidencePhoto,
  sha256Hex,
} from "../../lib/inspectionCapture.js";
import { insertReportPhoto } from "../../lib/reportDb.js";
import { supabase } from "../../lib/supabase.js";

/**
 * GuidedCapture — the whole "step 1" of the product, in one screen.
 *
 * Design promises (docs/PHASE7 §2): four taps, no typing, and the retake
 * prompt happens while the person is still standing next to the machine.
 * Everything technical (watermark, hashing, EXIF, upload) is invisible.
 *
 * Camera: getUserMedia when the browser allows it (an in-app capture is a
 * stronger signal than a file picker, and faster on a phone), falling back to
 * `<input capture="environment">`, which works everywhere including iOS Safari.
 */
export default function GuidedCapture({ booking, report, role, userId, equipment, onComplete, onCancel }) {
  const { t } = useTranslation();
  const [captured, setCaptured] = useState({}); // slot -> prepared photo
  const [activeSlot, setActiveSlot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progressText, setProgressText] = useState(null);
  const [gps, setGps] = useState(null);
  const [liveCamera, setLiveCamera] = useState(true);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  // One location fix per report, not per photo — a farmer should not get four
  // permission prompts, and the machine does not move mid-inspection.
  useEffect(() => {
    let alive = true;
    getLiveLocation().then((fix) => {
      if (alive && fix) setGps(fix);
    });
    return () => {
      alive = false;
    };
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setLiveCamera(false);
      fileInputRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      // Permission denied or no camera API: the file input still works, and
      // nothing about the report is weaker — just a plainer capture path.
      setLiveCamera(false);
      fileInputRef.current?.click();
    }
  }, []);

  const processRaw = useCallback(
    async (rawBlob, slot) => {
      setBusy(true);
      setError(null);
      try {
        const meta = slotById(slot);
        const prepared = await prepareEvidencePhoto({
          rawBlob,
          slot,
          reportCode: report.report_code,
          bookingId: booking.id,
          label: t(meta.titleKey, meta.fallbackTitle),
          liveGps: gps,
          reportGps: equipment?.latitude ? { lat: equipment.latitude, lng: equipment.longitude } : null,
        });
        setCaptured((prev) => ({ ...prev, [slot]: { ...prepared, slot, required: meta.required } }));
      } catch (err) {
        setError(t("trust.captureFailed", { message: err?.message || "" }));
      } finally {
        setBusy(false);
      }
    },
    [booking.id, equipment, gps, report.report_code, t],
  );

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    if (blob) await processRaw(blob, activeSlot);
  }, [activeSlot, processRaw]);

  const onFilePicked = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) await processRaw(file, activeSlot);
    },
    [activeSlot, processRaw],
  );

  const closeSlot = useCallback(() => {
    stopCamera();
    setActiveSlot(null);
  }, [stopCamera]);

  const openSlot = useCallback(
    async (slot) => {
      setActiveSlot(slot);
      if (liveCamera) await startCamera();
      else fileInputRef.current?.click();
    },
    [liveCamera, startCamera],
  );

  const remaining = REQUIRED_SLOTS.filter((slot) => !captured[slot]);
  const readyToFile = remaining.length === 0;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const photos = [];
      let index = 0;
      for (const slot of Object.keys(captured)) {
        const photo = captured[slot];
        index += 1;
        setProgressText(t("trust.uploadingPhoto", { current: index, total: Object.keys(captured).length, slot: t(slotById(slot).titleKey, slotById(slot).fallbackTitle) }));
        const path = await uploadEvidencePhoto(supabase, {
          bookingId: booking.id,
          reportId: report.id,
          photo,
        });
        if (!photo.sha256) photo.sha256 = await sha256Hex(photo.blob);
        await insertReportPhoto({ report, booking, photo, storagePath: path, userId, role });
        photos.push({ ...photo, storage_path: path });
      }
      onComplete(photos);
    } catch (err) {
      setError(err?.message || t("trust.uploadFailed"));
      setBusy(false);
      setProgressText(null);
    }
  }, [booking, captured, onComplete, report, role, t, userId]);

  return (
    <div className="rounded-3xl border border-line bg-card p-5">
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFilePicked} />

      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="font-display text-lg font-semibold text-ink">
            {report.kind === "handover" ? t("trust.captureHandoverTitle") : t("trust.captureReturnTitle")}
          </div>
          <p className="mt-1 text-xs text-mut">
            {t("trust.captureSubtitle", { count: REQUIRED_SLOTS.length })}
          </p>
        </div>
        {onCancel && (
          <button onClick={onCancel} className="rounded-full p-2 text-mut hover:bg-line-2" aria-label={t("common.back")}>
            <X size={16} />
          </button>
        )}
      </div>

      {/* The privacy sentence, in plain words, once. */}
      <div className="mb-4 flex items-start gap-2 rounded-2xl bg-paper px-3 py-2 text-[11px] text-mut">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>{t("trust.privacyNote")}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SLOTS.filter((s) => s.required).map((slot) => {
          const photo = captured[slot.id];
          const warnings = photo?.quality?.warnings || [];
          return (
            <button
              key={slot.id}
              onClick={() => openSlot(slot.id)}
              className={`relative flex flex-col items-stretch gap-2 rounded-2xl border p-3 text-left transition-all ${
                photo ? "border-sage/40 bg-sage-soft" : "border-line bg-paper hover:border-accent/40"
              }`}
            >
              <div className="flex items-center gap-2">
                {photo ? <Check size={14} className="text-sage" /> : <Camera size={14} className="text-accent" />}
                <span className="text-[11px] font-semibold text-ink">{t(slot.titleKey, slot.fallbackTitle)}</span>
              </div>
              {photo ? (
                <img src={URL.createObjectURL(photo.blob)} alt="" className="h-16 w-full rounded-lg object-cover" />
              ) : (
                <div className="flex h-16 w-full items-center justify-center rounded-lg border border-dashed border-line-2 text-[10px] text-mut2">
                  {t("trust.tapToCapture")}
                </div>
              )}
              <span className="text-[10px] leading-snug text-mut2">{t(slot.hintKey, slot.fallbackHint)}</span>
              {warnings.length > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-medium text-accent">
                  <AlertTriangle size={10} /> {t("trust.retakeSuggested")}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Damage-on-arrival chips: one tap, no typing. Handover ONLY.
          On a return report this question would be self-serving — the person
          returning the machine is exactly the person who benefits from calling
          new damage "already there". At return, the comparison against the
          handover photos is what settles it; at handover, this is what protects
          the renter. */}
      {report.kind === "handover" && (
      <div className="mt-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-mut">{t("trust.existingDamageTitle")}</div>
        <div className="flex flex-wrap gap-2">
          {["scratch", "dent", "crack", "tyre", "leak", "rust", "missing_part"].map((label) => {
            const selected = (captured.extra?.damage_labels || []).includes(label);
            return (
              <Chip
                key={label}
                active={selected}
                onClick={() =>
                  setCaptured((prev) => {
                    const current = prev.extra?.damage_labels || [];
                    const next = selected ? current.filter((l) => l !== label) : [...current, label];
                    return { ...prev, extra: { ...(prev.extra || { slot: "extra", required: false }), damage_labels: next } };
                  })
                }
              >
                {t(`trust.damage_${label}`, label)}
              </Chip>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-mut2">{t("trust.existingDamageHint")}</p>
      </div>
      )}

      {error && <p className="mt-3 text-sm text-accent">{error}</p>}
      {progressText && (
        <p className="mt-3 flex items-center gap-2 text-sm text-mut">
          <Loader2 size={14} className="animate-spin" /> {progressText}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={!readyToFile || busy}>
          {busy && !progressText ? <Loader2 size={14} className="animate-spin" /> : null}
          {readyToFile ? t("trust.submitReport") : t("trust.photosRemaining", { count: remaining.length })}
        </Button>
        <span className="text-xs text-mut2">
          {Object.keys(captured).length}/{REQUIRED_SLOTS.length} {t("trust.captured")}
        </span>
      </div>

      {/* ---- capture overlay ---- */}
      <AnimatePresence>
        {activeSlot && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex flex-col bg-night/95 p-4 text-paper"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">
                {t(slotById(activeSlot).titleKey, slotById(activeSlot).fallbackTitle)}
              </div>
              <button onClick={closeSlot} className="rounded-full p-2 hover:bg-white/10" aria-label={t("common.back")}>
                <X size={18} />
              </button>
            </div>
            <p className="mb-3 text-xs text-white/70">{t(slotById(activeSlot).hintKey, slotById(activeSlot).fallbackHint)}</p>

            <div className="relative flex-1 overflow-hidden rounded-2xl bg-black">
              {liveCamera ? (
                <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-white/70">
                  {t("trust.filePickerActive")}
                </div>
              )}
              {busy && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <Loader2 className="animate-spin" />
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-center gap-3">
              {liveCamera ? (
                <Button onClick={shoot} disabled={busy}>
                  <Camera size={16} /> {t("trust.takePhoto")}
                </Button>
              ) : (
                <Button onClick={() => fileInputRef.current?.click()} disabled={busy}>
                  <Camera size={16} /> {t("trust.choosePhoto")}
                </Button>
              )}
              <Button variant="ghost" onClick={() => { stopCamera(); setLiveCamera((v) => !v); if (!liveCamera) startCamera(); else fileInputRef.current?.click(); }}>
                <RotateCcw size={14} /> {liveCamera ? t("trust.useFileInstead") : t("trust.useCameraInstead")}
              </Button>
            </div>

            {captured[activeSlot] && (
              <div className="mt-4 rounded-2xl bg-white/10 p-3">
                <div className="flex items-center gap-3">
                  <img src={URL.createObjectURL(captured[activeSlot].blob)} alt="" className="h-16 w-24 rounded-lg object-cover" />
                  <div className="text-xs">
                    <div className="font-semibold text-white">{t("trust.photoReady")}</div>
                    <div className="text-white/70">
                      {captured[activeSlot].quality?.verdict === "pass"
                        ? t("trust.qualityGood")
                        : t("trust.qualityWarn", { issues: (captured[activeSlot].quality?.warnings || []).join(", ") })}
                    </div>
                    {captured[activeSlot].gps?.lat ? (
                      <div className="text-white/60">{t("trust.photoLocation")} ✓</div>
                    ) : (
                      <div className="text-white/60">{t("trust.photoNoLocation")}</div>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button onClick={closeSlot} className="!py-2 text-xs">
                    <Check size={13} /> {t("trust.useThisPhoto")}
                  </Button>
                  <Button variant="ghost" onClick={shoot} disabled={busy} className="!py-2 text-xs">
                    <RotateCcw size={13} /> {t("trust.retake")}
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
