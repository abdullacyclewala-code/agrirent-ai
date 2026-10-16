import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, ShieldCheck, ShieldX, ShieldAlert, QrCode } from "lucide-react";
import { verifyReportCode, getVerificationConfig } from "../lib/trustClient.js";
import { supabase } from "../lib/supabase.js";
import { formatDate, formatDateTime } from "../lib/format.js";

/**
 * VerifyReport — the public page behind the QR code on a printed report.
 *
 * Deliberately NOT behind auth, and deliberately boring: it answers one
 * question — "is this report the same record it was when it was signed, and
 * who attested to it?" — and shows nothing else. No photos, no phone numbers,
 * no addresses. A bank clerk, an insurer, a panchayat officer or a judge should
 * be able to check a report without an account, and without the app handing
 * out anyone's personal data to a stranger holding a piece of paper.
 *
 * Integrity is recomputed in the database (verify_report), so this page cannot
 * be fooled by a doctored client: if a single historical event were edited, the
 * walk of the hash chain would fail and say so.
 */
export default function VerifyReport() {
  const { t } = useTranslation();
  const { code } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null, via: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const config = await getVerificationConfig();
        let data = null;
        let via = "backend";
        if (config.reachable) {
          data = await verifyReportCode(code);
        }
        if (!data) {
          // Direct RPC fallback: the anon key can call verify_report, so this
          // page keeps working even if the Render service is asleep or retired.
          const { data: rpcData, error } = await supabase.rpc("verify_report", { p_code: code });
          if (error) throw new Error(error.message);
          data = rpcData;
          via = "database";
        }
        if (alive) setState({ loading: false, data, error: null, via });
      } catch (err) {
        // `error` is a flag, not copy: the page renders its own translated
        // "not found" panel, so the raw (English) message stays in the console.
        console.warn("[agrirent] verify failed:", err?.message || err);
        if (alive) setState({ loading: false, data: null, error: true, via: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  if (state.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper text-mut">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const { data } = state;
  const found = data?.found === true;
  const intact = data?.chain_intact === true;
  const integrityCopy = data?.finalized_at ? "trust.verifyIntactSub" : "trust.verifyIntactDraftSub";
  const integrityCopyOptions = data?.finalized_at
    ? { count: data.event_count, date: formatDate(data.finalized_at) }
    : { count: data?.event_count ?? 0 };

  return (
    <main className="mx-auto max-w-2xl px-5 py-14">
      <div className="mb-8 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mut">
          <QrCode size={13} /> {t("trust.verifyEyebrow")}
        </div>
        <h1 className="font-display text-2xl font-bold text-ink sm:text-3xl">{t("trust.verifyTitle")}</h1>
        <p className="mt-2 font-mono text-sm text-mut">{code}</p>
      </div>

      {!found && (
        <div className="rounded-3xl border border-line bg-card p-8 text-center">
          <ShieldX size={32} className="mx-auto mb-3 text-mut2" />
          <h2 className="font-display text-lg font-semibold text-ink">{t("trust.verifyNotFound")}</h2>
          <p className="mt-2 text-sm text-mut">{t("trust.verifyNotFoundSub")}</p>
        </div>
      )}

      {found && (
        <>
          <div className={`mb-6 rounded-3xl border p-6 text-center ${intact ? "border-sage/30 bg-sage-soft" : "border-accent/30 bg-accent-soft"}`}>
            {intact ? (
              <ShieldCheck size={34} className="mx-auto mb-3 text-sage" />
            ) : (
              <ShieldAlert size={34} className="mx-auto mb-3 text-accent" />
            )}
            <h2 className="font-display text-xl font-semibold text-ink">
              {intact ? t("trust.verifyIntact") : t("trust.verifyBroken")}
            </h2>
            <p className="mt-2 text-sm text-ink-2">
              {intact
                ? t(integrityCopy, integrityCopyOptions)
                : t("trust.verifyBrokenSub")}
            </p>
          </div>

          <dl className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-card">
            <Row label={t("trust.verifyKind")} value={data.kind === "handover" ? t("trust.handoverEyebrow") : t("trust.returnEyebrow")} />
            <Row label={t("trust.verifyVerdict")} value={t(`trust.verdict_${data.verdict}`, data.verdict)} />
            <Row label={t("trust.verifyPhotos")} value={String(data.photo_count ?? 0)} />
            {data.hour_meter != null && <Row label={t("trust.hourMeter")} value={String(data.hour_meter)} />}
            <Row
              label={t("trust.verifyAttestations")}
              value={(data.signers || []).length
                // The role comes from the database as "owner"/"farmer" — an id, not
                // copy. It has to be looked up, or a Hindi reader sees the English word.
                ? data.signers
                    .map((s) => `${t(`common.${s.role}`, s.role)} · ${formatDateTime(s.signed_at)}`)
                    .join("  •  ")
                : t("trust.noSignatures")}
            />
            <Row label={t("trust.verifyFinalized")} value={formatDateTime(data.finalized_at)} />
            <Row label={t("trust.reportHash")} value={`${(data.report_hash || "").slice(0, 40)}…`} mono />
            <Row label={t("trust.verifyChainHead")} value={`${(data.chain_head || "").slice(0, 40)}…`} mono />
          </dl>

          {(data.signals?.flags || []).length > 0 && (
            <div className="mt-6 rounded-2xl border border-gold/30 bg-gold-soft/60 p-4 text-xs text-ink-2">
              <div className="mb-1 font-semibold">{t("trust.verifyFlagsTitle")}</div>
              <ul className="list-inside list-disc space-y-0.5">
                {data.signals.flags.map((f) => (
                  <li key={f}>{t(`trust.flag_${f}`, f)}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-6 text-center text-[11px] text-mut2">
            {t("trust.verifyFooter", { source: state.via === "database" ? t("trust.viaDatabase") : t("trust.viaBackend") })}
          </p>
        </>
      )}
    </main>
  );
}

function Row({ label, value, mono = false }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-mut">{label}</dt>
      <dd className={`text-right text-sm text-ink ${mono ? "font-mono text-[11px] break-all" : ""}`}>{value}</dd>
    </div>
  );
}
