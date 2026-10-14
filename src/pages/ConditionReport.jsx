import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import {
  ArrowLeft, Loader2, Printer, Check, AlertTriangle, MapPin, Clock, Cpu, FileText, Sparkles, RefreshCw,
} from "lucide-react";
import { Button, SectionLabel } from "../components/ui/Primitives.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import GuidedCapture from "../components/inspection/GuidedCapture.jsx";
import SignaturePad from "../components/inspection/SignaturePad.jsx";
import { VerdictPill, SignalList, BeforeAfter, IntegrityBox, WearAndTearNote } from "../components/inspection/ReportBits.jsx";
import {
  getBookingContext, getReportDetail, getReportsForBooking, getKnownDamage,
  updateReportAnalysis, signReport, finalizeReport, respondToReport, setVerificationState,
  uploadSignature, logEvent,
} from "../lib/reportDb.js";
import { analyzeReport, verifyReportCode } from "../lib/trustClient.js";
import { errorText } from "../lib/errors.js";
import { translatedSummary } from "../lib/reportText.js";
import { signedEvidenceUrls, slotById, REQUIRED_SLOTS } from "../lib/inspectionCapture.js";
import { deriveVerificationState } from "../lib/trustFlow.js";
import { formatDateTime } from "../lib/format.js";
import { WEAR_AND_TEAR, POLICY } from "../lib/depositPolicy.js";
import { equipmentTypeLabel } from "../lib/equipmentDisplay.js";
import { supabase } from "../lib/supabase.js";

export default function ConditionReport() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [signatures, setSignatures] = useState([]);
  const [booking, setBooking] = useState(null);
  const [equipment, setEquipment] = useState(null);
  const [siblings, setSiblings] = useState([]);
  const [knownDamage, setKnownDamage] = useState([]);
  const [urls, setUrls] = useState({});
  const [verification, setVerification] = useState(null);
  const [analysis, setAnalysis] = useState(null);

  const role = booking && user ? (booking.owner_id === user.id ? "owner" : booking.farmer_id === user.id ? "farmer" : null) : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await getReportDetail(id);
      setReport(detail.report);
      setPhotos(detail.photos);
      setSignatures(detail.signatures);

      const bookingCtx = await getBookingContext(detail.report.booking_id);
      setBooking(bookingCtx);
      setEquipment(bookingCtx.equipment);

      const [sibs, damage] = await Promise.all([
        getReportsForBooking(detail.report.booking_id),
        getKnownDamage(detail.report.equipment_id),
      ]);
      setSiblings(sibs);
      setKnownDamage(damage);

      if (detail.photos.length) {
        const map = await signedEvidenceUrls(supabase, detail.photos.map((p) => p.storage_path));
        setUrls(map);
      }
      if (detail.report.report_code) {
        verifyReportCode(detail.report.report_code).then((v) => v && setVerification(v));
      }
    } catch (err) {
      setError(errorText(err, t, "trust.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    load();
  }, [load]);

  const iAmAuthor = report && user && report.created_by === user.id;
  const iSigned = signatures.some((s) => s.user_id === user?.id);
  const otherSigned = signatures.some((s) => s.user_id !== user?.id);
  const isDraft = report?.status === "draft";
  const isReturn = report?.kind === "return";

  // the handover report this return report is being compared against
  const handover = useMemo(() => siblings.find((r) => r.kind === "handover" && r.id !== report?.id), [siblings, report]);
  const [beforeUrls, setBeforeUrls] = useState({});
  useEffect(() => {
    if (!handover || !isReturn) return;
    (async () => {
      const { data } = await supabase.from("report_photos").select("slot, storage_path").eq("report_id", handover.id);
      if (!data?.length) return;
      setBeforeUrls(await signedEvidenceUrls(supabase, data.map((p) => p.storage_path)));
    })();
  }, [handover, isReturn]);

  /** Capture finished → ask the backend (or the browser, as a fallback) to
   *  verify and read the evidence, then persist the reading. */
  const onCaptured = useCallback(async (capturedPhotos) => {
    setBusy(true);
    setError(null);
    try {
      const beforePhotos = [];
      if (isReturn && handover) {
        const { data } = await supabase
          .from("report_photos")
          .select("slot, storage_path, dhash, ai, watermark_text, captured_at_device")
          .eq("report_id", handover.id);
        for (const p of data || []) {
          beforePhotos.push({ ...p, history: [] });
        }
      }

      const result = await analyzeReport({
        report,
        booking,
        equipment,
        photos: capturedPhotos,
        beforePhotos,
        knownDamage: knownDamage.map((d) => ({ part: d.part, kind: d.kind, severity: d.severity, notes: d.notes })),
        signedBy: 0,
        chainIntact: true,
      });

      setAnalysis(result);
      await updateReportAnalysis(report.id, {
        ...result,
        booking_id: booking.id,
        equipment_id: booking.equipment_id,
      });
      await load();
    } catch (err) {
      setError(errorText(err, t, "trust.analysisFailed"));
    } finally {
      setBusy(false);
    }
  }, [booking, equipment, handover, isReturn, knownDamage, load, report, t]);

  /** Re-run the reading on evidence that is already stored.
   *
   * Worth having for a blunt reason: Render's free tier sleeps, and if the
   * first analysis call hit a cold start the report was stuck with the
   * deterministic signals for ever — the photos are on the server, the AI just
   * wasn't awake. A draft can be re-checked as many times as you like; a signed
   * report cannot, because its reading is frozen with the evidence. */
  const reanalyze = useCallback(async () => {
    if (!booking || !photos.length) return;
    setBusy(true);
    setError(null);
    try {
      const shaped = photos.map((p) => ({
        slot: p.slot,
        storage_path: p.storage_path,
        sha256: p.sha256,
        dhash: p.dhash,
        captured_at_device: p.captured_at_device,
        exif: p.exif,
        gps: p.gps_lat != null ? { lat: p.gps_lat, lng: p.gps_lng } : null,
        watermark_text: p.watermark_text,
        quality: p.quality,
        damage_labels: p.damage_labels,
      }));
      const beforePhotos = [];
      if (isReturn && handover) {
        const { data } = await supabase
          .from("report_photos")
          .select("slot, storage_path, dhash, ai, watermark_text, captured_at_device")
          .eq("report_id", handover.id);
        for (const p of data || []) beforePhotos.push({ ...p, history: [] });
      }
      const result = await analyzeReport({
        report, booking, equipment, photos: shaped, beforePhotos,
        knownDamage: knownDamage.map((d) => ({ part: d.part, kind: d.kind, severity: d.severity, notes: d.notes })),
        signedBy: signatures.length,
        chainIntact: verification?.chain_intact ?? true,
      });
      setAnalysis(result);
      await updateReportAnalysis(report.id, { ...result, booking_id: booking.id, equipment_id: booking.equipment_id });
      await load();
    } catch (err) {
      setError(errorText(err, t, "trust.analysisFailed"));
    } finally {
      setBusy(false);
    }
  }, [booking, equipment, handover, isReturn, knownDamage, photos, report, signatures.length, t, verification, load]);

  /**
   * The counterparty's act, in ONE tap.
   *
   * They are not filing anything — they are accepting or rejecting someone
   * else's record. Asking them to draw a signature first (and then answer the
   * actual question) was two steps for one decision. Agreeing now records the
   * response AND their own attestation (statement + timestamp, the part that
   * binds) in a single call; signing by hand stays available underneath for
   * anyone who wants a mark on the page.
   */
  const countersign = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await respondToReport({ report, response: "agreed", userId: user.id, role });
      await signReport({
        report, userId: user.id, role,
        statement: report.kind === "handover"
          ? t("trust.statementHandover", { code: report.report_code })
          : t("trust.statementReturn", { code: report.report_code }),
        signaturePngPath: null, contentHash: report.report_hash || null,
      });
      await finalizeReport(report.id);
      const reports = await getReportsForBooking(booking.id);
      const state = deriveVerificationState({ booking, reports, claims: [] });
      await setVerificationState(booking.id, state);
      await load();
    } catch (err) {
      setError(errorText(err, t, "trust.actionFailed"));
    } finally {
      setBusy(false);
    }
  }, [booking, load, report, role, t, user]);

  /** A free-text objection, recorded in the audit trail next to the flag it is
   *  about — "something is wrong" on its own would be the start of a fight, not
   *  the end of one. */
  const logNote = useCallback(async (reportId, note) => {
    try {
      await logEvent(reportId, "objection_raised", { note }, role, booking?.id ?? null);
    } catch {
      /* best effort — the response itself is already recorded */
    }
  }, [booking?.id, role]);

  const disagree = useCallback(async () => {
    const reason = window.prompt(t("trust.disagreePrompt")) || "";
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await respondToReport({ report, response: "disagreed", userId: user.id, role });
      await logNote(report.id, reason);
      await setVerificationState(booking.id, "disputed");
      await load();
    } catch (err) {
      setError(errorText(err, t, "trust.actionFailed"));
    } finally {
      setBusy(false);
    }
  }, [booking, load, logNote, report, role, t, user]);

  const doSign = useCallback(async (blob) => {
    setBusy(true);
    setError(null);
    try {
      const path = blob ? await uploadSignature(supabase, user.id, report.id, blob) : null;
      const statement = report.kind === "handover"
        ? t("trust.statementHandover", { code: report.report_code })
        : t("trust.statementReturn", { code: report.report_code });
      await signReport({
        report, userId: user.id, role, statement, signaturePngPath: path,
        contentHash: report.report_hash || null,
      });
      const hash = await finalizeReport(report.id);
      const reports = await getReportsForBooking(booking.id);
      const state = deriveVerificationState({ booking, reports, claims: [] });
      const patch = {};
      if (report.kind === "handover") patch.handover_report_id = report.id;
      if (report.kind === "return") patch.return_report_id = report.id;
      await setVerificationState(booking.id, state, patch);
      setVerification((v) => ({ ...(v || {}), report_hash: hash, chain_intact: true }));
      await load();
    } catch (err) {
      setError(errorText(err, t, "trust.signFailed"));
    } finally {
      setBusy(false);
    }
  }, [booking, load, report, role, t, user]);

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-mut"><Loader2 className="animate-spin" /></div>;
  }
  if (error && !report) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center">
        <p className="text-mut">{error}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate(-1)}>{t("common.back")}</Button>
      </div>
    );
  }

  const needsCapture = isDraft && iAmAuthor && photos.length === 0;
  const missingSlots = REQUIRED_SLOTS.filter((slot) => !photos.some((p) => p.slot === slot));
  const statement = report.kind === "handover"
    ? t("trust.statementHandover", { code: report.report_code })
    : t("trust.statementReturn", { code: report.report_code });

  return (
    <main className="mx-auto max-w-5xl px-5 pb-20 pt-6 md:px-8 md:pt-10">
      <button onClick={() => navigate(`/booking/${report.booking_id}`)} className="mb-6 inline-flex items-center gap-2 text-sm text-mut hover:text-ink">
        <ArrowLeft size={15} /> {t("trust.backToBooking")}
      </button>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <SectionLabel
            eyebrow={report.kind === "handover" ? t("trust.handoverEyebrow") : t("trust.returnEyebrow")}
            title={report.kind === "handover" ? t("trust.handoverTitle") : t("trust.returnTitle")}
            sub={`${equipment?.name || ""} · ${equipmentTypeLabel(equipment?.equipment_type)} · ${t("trust.bookingLabel")} #${report.booking_id}`}
          />
        </div>
        <div className="flex flex-col items-end gap-2">
          <VerdictPill verdict={report.verdict} />
          {report.report_code && <span className="font-mono text-[11px] text-mut">{report.report_code}</span>}
        </div>
      </div>

      {error && <div className="mb-4 rounded-2xl border border-accent/30 bg-accent-soft p-3 text-sm text-ink-2">{error}</div>}

      {/* ---------- capture ---------- */}
      {needsCapture && (
        <div className="mb-6">
          <GuidedCapture
            booking={booking}
            report={report}
            role={role}
            userId={user.id}
            equipment={equipment}
            onComplete={onCaptured}
            onCancel={() => navigate(`/booking/${report.booking_id}`)}
          />
        </div>
      )}

      {busy && (
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-line bg-paper p-4 text-sm text-mut">
          <Loader2 size={15} className="animate-spin" /> {t("trust.working")}
        </div>
      )}

      {/* ---------- AI reading ---------- */}
      {(report.ai_summary || analysis) && !needsCapture && (
        <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mb-6 rounded-3xl border border-line bg-card p-5">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mut">
            <Sparkles size={13} /> {t("trust.aiReadingTitle")}
            <span className="ml-auto rounded-full bg-paper px-2 py-0.5 text-[10px] font-mono text-mut2">
              {report.ai_status === "ok"
                ? t("trust.aiOn", { provider: report.ai_provider || "" })
                : report.ai_status === "partial"
                  ? t("trust.aiPartial")
                  : t("trust.aiOff")}
            </span>
          </div>
          <p className="text-sm text-ink-2">
            {translatedSummary(t, {
              aiSummary: report.ai_summary || analysis?.summary || null,
              photos,
              hourMeter: report.hour_meter,
              // The backend's own English sentence stays as the fallback for
              // reports analysed before this screen existed.
              fallbackText: report.ai_summary?.text || analysis?.summary?.text || null,
            }) || t("trust.aiNoSummary")}
          </p>
          {(report.ai_summary?.damage_found?.length || analysis?.summary?.damage_found?.length) ? (
            <ul className="mt-3 space-y-1">
              {(report.ai_summary?.damage_found || analysis.summary.damage_found).slice(0, 8).map((d, i) => (
                <li key={i} className="flex gap-2 text-xs text-mut">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
                  <span>
                    <span className="font-medium text-ink-2">{d.part}</span> — {d.description || d.kind}
                    {typeof d.confidence === "number" && (
                      <span className="text-mut2"> · {Math.round(d.confidence * 100)}%</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-mut2">
            {report.hour_meter != null && (
              <span className="inline-flex items-center gap-1"><Cpu size={11} /> {t("trust.hourMeter")}: <b className="text-ink-2">{report.hour_meter}</b></span>
            )}
            <span>{t("trust.aiDisclaimer")}</span>
          </div>
          {isDraft && iAmAuthor && (
            <div className="mt-3 border-t border-line pt-3">
              <Button variant="ghost" className="!py-2 text-xs" onClick={reanalyze} disabled={busy}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {t("trust.recheck")}
              </Button>
              <p className="mt-1 text-[11px] text-mut2">{t("trust.recheckHint")}</p>
            </div>
          )}
        </motion.section>
      )}

      {/* ---------- before / after ---------- */}
      {isReturn && handover && Object.keys(beforeUrls).length > 0 && photos.length > 0 && (
        <section className="mb-6">
          <h3 className="mb-3 font-display text-lg font-semibold text-ink">{t("trust.compareTitle")}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {REQUIRED_SLOTS.map((slot) => {
              const after = photos.find((p) => p.slot === slot);
              const beforePath = Object.keys(beforeUrls).find((path) => path.includes(`/${slot}-`));
              if (!after || !beforePath) return null;
              const slotVerdict = report.ai_summary?.compare?.slots?.find?.((s) => s.slot === slot);
              return (
                <BeforeAfter
                  key={slot}
                  beforeUrl={beforeUrls[beforePath]}
                  afterUrl={urls[after.storage_path]}
                  label={`${t(slotById(slot).titleKey, slotById(slot).fallbackTitle)}${
                    slotVerdict?.reused_handover_photo ? ` · ${t("trust.reusedEvidence")}` : ""
                  }`}
                />
              );
            })}
          </div>
          <div className="mt-3">
            <WearAndTearNote items={WEAR_AND_TEAR} />
          </div>
        </section>
      )}

      {/* ---------- evidence ---------- */}
      <section className="mb-6">
        <h3 className="mb-3 font-display text-lg font-semibold text-ink">{t("trust.evidenceTitle", { count: photos.length })}</h3>
        {missingSlots.length > 0 && !isDraft && (
          <p className="mb-3 flex items-center gap-2 rounded-xl bg-gold-soft px-3 py-2 text-xs text-gold">
            <AlertTriangle size={13} /> {t("trust.missingViews", { slots: missingSlots.map((s) => t(slotById(s).titleKey, s)).join(", ") })}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((p) => (
            <figure key={p.id} className="overflow-hidden rounded-2xl border border-line bg-paper">
              {urls[p.storage_path] ? (
                <a href={urls[p.storage_path]} target="_blank" rel="noreferrer">
                  <img src={urls[p.storage_path]} alt="" className="aspect-[4/3] w-full object-cover" />
                </a>
              ) : (
                <div className="flex aspect-[4/3] items-center justify-center text-[11px] text-mut2">{t("trust.photoUnavailable")}</div>
              )}
              <figcaption className="space-y-1 p-2.5 text-[10px] text-mut">
                <div className="font-semibold text-ink-2">{t(slotById(p.slot).titleKey, slotById(p.slot).fallbackTitle)}</div>
                {p.captured_at_device && (
                  <div className="flex items-center gap-1"><Clock size={9} /> {formatDateTime(p.captured_at_device)}</div>
                )}
                {p.gps_lat != null ? (
                  <div className="flex items-center gap-1"><MapPin size={9} /> {p.gps_lat.toFixed(4)}, {p.gps_lng.toFixed(4)}</div>
                ) : (
                  <div className="text-mut2">{t("trust.noLocation")}</div>
                )}
                {p.exif?.model && <div className="truncate">{p.exif.make} {p.exif.model}</div>}
                <div className="truncate font-mono text-[9px] text-mut2">sha {(p.sha256 || "").slice(0, 10)}…</div>
                {p.flags?.length > 0 && (
                  <div className="flex items-center gap-1 text-accent"><AlertTriangle size={9} /> {p.flags.length} {t("trust.flagsShort")}</div>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* ---------- signals ---------- */}
      <section className="mb-6 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-3 font-display text-lg font-semibold text-ink">{t("trust.signalsTitle")}</h3>
          <SignalList flags={report.signals?.flags || []} checks={report.signals?.checks || []} />
        </div>
        <div className="space-y-4">
          <IntegrityBox report={report} verification={verification} />
          <div className="rounded-2xl border border-line bg-paper p-4 text-xs text-mut">
            <div className="mb-2 flex items-center gap-2 font-semibold uppercase tracking-wide">
              <FileText size={13} /> {t("trust.attestationsTitle")}
            </div>
            {signatures.length === 0 && <p>{t("trust.noSignatures")}</p>}
            <ul className="space-y-2">
              {signatures.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-ink-2">
                  <Check size={12} className="mt-0.5 shrink-0 text-sage" />
                  <span>
                    <b>{s.role === "owner" ? t("common.owner") : t("common.farmer")}</b> — {formatDateTime(s.signed_at)}
                    <div className="text-[11px] text-mut">“{s.statement_text}”</div>
                  </span>
                </li>
              ))}
            </ul>
            {report.unilateral && report.finalized_at && (
              <p className="mt-3 rounded-xl bg-gold-soft px-3 py-2 text-[11px] text-gold">
                {t("trust.unilateralNote", { hours: POLICY.countersignWindowHours })}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ---------- the counterparty's decision ---------- */}
      {!iSigned && !iAmAuthor && otherSigned && report.status !== "cancelled" && (
        <section className="mb-6 flex flex-wrap gap-3">
          <Button onClick={countersign} disabled={busy}>
            <Check size={15} /> {t("trust.agreeButton")}
          </Button>
          <Button variant="ghost" onClick={disagree} disabled={busy}>
            <AlertTriangle size={15} /> {t("trust.disagreeButton")}
          </Button>
        </section>
      )}

      {/* ---------- sign ---------- */}
      {!iSigned && !needsCapture && report.status !== "cancelled" && (
        <section className="mb-6">
          {!iAmAuthor && !otherSigned && (
            <p className="mb-3 text-sm text-mut">{t("trust.otherPartyNotSigned")}</p>
          )}
          {!iAmAuthor && otherSigned && (
            <p className="mb-2 text-xs text-mut2">{t("trust.orSignByHand")}</p>
          )}
          <SignaturePad statement={statement} onSigned={doSign} busy={busy} signLabel={iAmAuthor ? t("trust.signFile") : t("trust.signAgree")} />
        </section>
      )}

      {iAmAuthor && iSigned && (
        <section className="mb-6 rounded-2xl border border-sage/30 bg-sage-soft p-4 text-sm text-ink-2">
          {t("trust.signedByYou")}
          {report.unilateral && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="ghost" className="!py-2 text-xs" onClick={() => navigate(`/booking/${report.booking_id}`)}>
                {t("trust.backToBooking")}
              </Button>
            </div>
          )}
        </section>
      )}

      {/* Printed on the page, and therefore on the paper: a third party can
          check this report without an account. (No QR image yet — the code and
          the URL are the honest version of the same thing; a QR encoder is a
          dependency this feature didn't need.) */}
      {report.report_code && (
        <p className="mb-4 rounded-2xl border border-line bg-paper px-4 py-3 text-center text-[11px] text-mut">
          {t("trust.verifyUrlLabel")}{" "}
          <span className="break-all font-mono text-[11px] text-ink-2">
            {typeof window !== "undefined" ? window.location.origin : ""}/verify/{report.report_code}
          </span>
        </p>
      )}

      <div className="flex flex-wrap gap-3 border-t border-line pt-5">
        <Button variant="ghost" onClick={() => window.print()}>
          <Printer size={15} /> {t("trust.printReport")}
        </Button>
        <Button variant="ghost" onClick={() => navigate(`/booking/${report.booking_id}`)}>
          {t("trust.backToBooking")}
        </Button>
        {report.report_code && (
          <Button variant="outline" onClick={() => navigate(`/verify/${report.report_code}`)}>
            {t("trust.openVerification")}
          </Button>
        )}
      </div>
    </main>
  );
}
