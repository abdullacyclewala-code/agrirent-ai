import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ShieldAlert, Camera, PenLine, IndianRupee, ArrowRight, Loader2, Scale, Clock } from "lucide-react";
import { Button } from "../ui/Primitives.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { VerdictPill } from "./ReportBits.jsx";
import {
  getReportsForBooking, getClaimsForBooking, getSettlement, ensureConditionReport, setVerificationState,
} from "../../lib/reportDb.js";
import { deriveVerificationState, nextAction, VSTATE, VSTATE_LABEL_KEY, claimWindowState } from "../../lib/trustFlow.js";
import { suggestDeposit } from "../../lib/depositPolicy.js";

/**
 * TrustPanel — the one place on the booking page that deals with condition
 * evidence. It answers exactly two questions for the person looking at it:
 * "where does this rental stand?" and "what, if anything, do I do now?".
 *
 * One primary button, deliberately. The alternative — showing every possible
 * action and letting people guess — is how disputes start.
 */
export default function TrustPanel({ booking }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [reports, setReports] = useState([]);
  const [claims, setClaims] = useState([]);
  const [settlement, setSettlement] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!booking?.id) return;
    setLoading(true);
    try {
      const [rpts, clms, settle] = await Promise.all([
        getReportsForBooking(booking.id),
        getClaimsForBooking(booking.id),
        getSettlement(booking.id),
      ]);
      setReports(rpts);
      setClaims(clms);
      setSettlement(settle);
    } finally {
      setLoading(false);
    }
  }, [booking?.id]);

  useEffect(() => { load(); }, [load]);

  if (loading || !booking) return null;

  const role = booking.owner_id === user?.id ? "owner" : booking.farmer_id === user?.id ? "farmer" : null;
  const state = deriveVerificationState({ booking, reports, claims });
  const { primary, note } = nextAction({ booking, reports, claims, role, userId: user?.id });
  const deposit = Number(booking.deposit_amount) || suggestDeposit(booking.price);
  const handover = reports.find((r) => r.kind === "handover");
  const ret = reports.find((r) => r.kind === "return");
  const window = ret ? claimWindowState(ret) : null;

  const startReport = async (kind) => {
    setBusy(true);
    try {
      const report = await ensureConditionReport({ booking, kind, userId: user.id, role });
      await setVerificationState(booking.id, kind === "handover" ? VSTATE.handoverDue : VSTATE.returnDue);
      navigate(`/report/${report.id}`);
    } catch (err) {
      console.error(err);
      setBusy(false);
    }
  };

  const ACTIONS = {
    startHandoverReport: { label: t("trust.actionStartHandover"), icon: Camera, run: () => startReport("handover") },
    finishHandoverReport: { label: t("trust.actionFinishHandover"), icon: Camera, run: () => navigate(`/report/${primary?.reportId}`) },
    startReturnReport: { label: t("trust.actionStartReturn"), icon: Camera, run: () => startReport("return") },
    countersign: { label: t("trust.actionCountersign"), icon: PenLine, run: () => navigate(`/report/${primary?.reportId}`) },
    fileDamageClaim: { label: t("trust.actionFileClaim"), icon: Scale, run: () => navigate(`/claim/${booking.id}`) },
    markNoClaim: { label: t("trust.actionNoClaim"), icon: ShieldCheck, run: () => navigate(`/claim/${booking.id}`) },
    respondToClaim: { label: t("trust.actionRespondClaim"), icon: Scale, run: () => navigate(`/claim/${booking.id}`) },
    resolveDispute: { label: t("trust.actionResolveDispute"), icon: Scale, run: () => navigate(`/claim/${booking.id}`) },
    // Nothing for THIS person to do — the answer is with the other party. The
    // panel still shows the state so nobody sits waiting without knowing why.
    awaitClaimResponse: { label: t("trust.actionClaims"), icon: Clock, run: () => navigate(`/claim/${booking.id}`) },
    releaseDeposit: { label: t("trust.actionRelease"), icon: IndianRupee, run: () => navigate(`/claim/${booking.id}`) },
    viewReport: { label: t("trust.actionViewReport"), icon: ShieldCheck, run: () => navigate(`/report/${primary?.reportId}`) },
  };
  const action = primary ? ACTIONS[primary.action] : null;

  const stateTone =
    state === VSTATE.settled || state === VSTATE.closedClean || state === VSTATE.handoverSigned
      ? "sage"
      : state === VSTATE.disputed || state === VSTATE.claimOpen
        ? "accent"
        : "gold";

  return (
    <div className="rounded-3xl border border-line bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mut">
          <ShieldCheck size={13} /> {t("trust.panelTitle")}
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${
            stateTone === "sage" ? "bg-sage-soft text-sage" : stateTone === "accent" ? "bg-accent-soft text-accent" : "bg-gold-soft text-gold"
          }`}
        >
          {t(VSTATE_LABEL_KEY[state], state)}
        </span>
      </div>

      {/* deposit line — the number people actually care about */}
      <div className="mb-3 flex items-center justify-between border-y border-line py-3 text-sm">
        <span className="flex items-center gap-2 text-mut"><IndianRupee size={13} /> {t("trust.depositLabel")}</span>
        <span className="font-mono text-ink">
          ₹{deposit}
          {settlement && Number(settlement.released_amount) > 0 && (
            <span className="ml-2 text-xs text-sage">({t("trust.releasedShort", { amount: settlement.released_amount })})</span>
          )}
        </span>
      </div>

      {/* the two reports, side by side */}
      <div className="mb-4 space-y-2">
        {[
          { kind: "handover", report: handover, label: t("trust.handoverEyebrow") },
          { kind: "return", report: ret, label: t("trust.returnEyebrow") },
        ].map(({ kind, report, label }) => (
          <button
            key={kind}
            onClick={() => report && navigate(`/report/${report.id}`)}
            disabled={!report}
            className={`flex w-full items-center justify-between rounded-2xl border px-3 py-2.5 text-left transition-all ${
              report ? "border-line bg-paper hover:border-accent/40" : "border-dashed border-line-2 bg-transparent"
            }`}
          >
            <span className="flex items-center gap-2 text-xs">
              {report ? (
                report.finalized_at ? <ShieldCheck size={13} className="text-sage" /> : <Clock size={13} className="text-gold" />
              ) : (
                <Camera size={13} className="text-mut2" />
              )}
              <span className={report ? "font-semibold text-ink" : "text-mut2"}>{label}</span>
              {report?.unilateral && report.finalized_at && (
                <span className="rounded-full bg-gold-soft px-1.5 py-0.5 text-[9px] font-semibold text-gold">{t("trust.unilateralBadge")}</span>
              )}
            </span>
            {report ? <VerdictPill verdict={report.verdict} size="sm" /> : <span className="text-[10px] text-mut2">{t("trust.notFiled")}</span>}
          </button>
        ))}
      </div>

      {note && <p className="mb-3 text-xs text-mut">{t(`trust.note_${note}`, "")}</p>}
      {window?.open && !window.expired && role === "owner" && (
        <p className="mb-3 text-xs text-gold">{t("trust.claimWindowOpen", { hours: Math.max(0, Math.round((window.endsAt - new Date()) / 3600000)) })}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {action && (
          <Button onClick={action.run} disabled={busy} className="!py-2.5 text-sm">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <action.icon size={15} />} {action.label}
          </Button>
        )}
        {/* The return report is the renter-side job once the machine is out.
            Shown as a secondary action while the rental is running, so it is
            reachable without being pushed at someone who has nothing to do yet. */}
        {handover?.finalized_at && !ret && ["In Use", "Completed"].includes(booking.status) && (
          <Button variant="ghost" className="!py-2.5 text-sm" onClick={() => startReport("return")} disabled={busy}>
            <Camera size={14} /> {t("trust.actionStartReturn")}
          </Button>
        )}
        <Button variant="ghost" className="!py-2.5 text-sm" onClick={() => navigate(`/claim/${booking.id}`)}>
          <Scale size={14} /> {t("trust.actionClaims")} <ArrowRight size={13} />
        </Button>
      </div>

      {state === VSTATE.handoverUnilateral && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-gold-soft px-3 py-2 text-[11px] text-gold">
          <ShieldAlert size={12} className="mt-0.5 shrink-0" />
          {t("trust.unilateralPanelNote")}
        </p>
      )}
    </div>
  );
}
