import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Loader2, IndianRupee, AlertTriangle, Check, Scale, Info, Camera, Paperclip } from "lucide-react";
import { Button, Chip, SectionLabel } from "../components/ui/Primitives.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { WearAndTearNote } from "../components/inspection/ReportBits.jsx";
import {
  getBookingContext, getReportsForBooking, getClaimsForBooking, getKnownDamage,
  fileDamageClaim, respondToClaim, withdrawClaim, recordSettlement, getSettlement,
  attachRepairEstimate, signedEvidenceUrlsFor,
} from "../lib/reportDb.js";
import { supabase } from "../lib/supabase.js";
import { claimNeedsEstimate, settlementSplit, suggestDeposit, WEAR_AND_TEAR, CHARGEABLE_DAMAGE, POLICY } from "../lib/depositPolicy.js";
import { claimWindowState, returnReport as pickReturnReport, openClaim } from "../lib/trustFlow.js";

/**
 * DamageClaim — file, answer, resolve, settle.
 *
 * The two things this screen must never do: let a claim stand on an
 * undocumented number, and let a deduction happen while it is still disputed.
 * Everything else is deliberately plain, because this is the screen people
 * reach when they are already annoyed with each other.
 */
export default function DamageClaim() {
  const { t } = useTranslation();
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [booking, setBooking] = useState(null);
  const [reports, setReports] = useState([]);
  const [claims, setClaims] = useState([]);
  const [knownDamage, setKnownDamage] = useState([]);
  const [settlement, setSettlement] = useState(null);

  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [parts, setParts] = useState([]);
  const [severity, setSeverity] = useState("moderate");
  const [counterAmount, setCounterAmount] = useState("");
  const [estimate, setEstimate] = useState(null);      // { id, previewUrl }
  const [estimateBusy, setEstimateBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ctx = await getBookingContext(bookingId);
      setBooking(ctx);
      const [rpts, clms, dmg, settle] = await Promise.all([
        getReportsForBooking(bookingId),
        getClaimsForBooking(bookingId),
        getKnownDamage(ctx.equipment_id),
        getSettlement(bookingId),
      ]);
      setReports(rpts);
      setClaims(clms);
      setKnownDamage(dmg);
      setSettlement(settle);
    } catch (err) {
      setError(err?.message);
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => { load(); }, [load]);

  const isOwner = booking && user && booking.owner_id === user.id;
  const ret = useMemo(() => pickReturnReport(reports), [reports]);
  const claim = useMemo(() => openClaim(claims), [claims]);
  const window = useMemo(() => (ret ? claimWindowState(ret) : { open: false, expired: false, endsAt: null }), [ret]);
  const deposit = Number(booking?.deposit_amount) || suggestDeposit(booking?.price);
  const preview = claim ? settlementSplit({
    deposit, claimAmount: Number(claim.amount_claimed), agreed: claim.status === "agreed" || claim.status === "resolved",
    settledAmount: claim.resolved_amount, disputed: claim.status === "disputed",
  }) : null;

  /** The repair-estimate photo. Required by policy (and now by the database)
   *  once the claim crosses ₹2000, which is why it is mandatory-looking here:
   *  a big number with no paper trail is what turns a claim into a dispute. */
  const attachEstimate = async (file) => {
    if (!file) return;
    setEstimateBusy(true);
    setError(null);
    try {
      const previewUrl = URL.createObjectURL(file);
      const role = booking.owner_id === user.id ? "owner" : "farmer";
      const id = await attachRepairEstimate({
        booking, report: ret, userId: user.id, role, rawBlob: file,
        label: t("trust.estimateLabel"),
      });
      setEstimate({ id, previewUrl });
    } catch (err) {
      setError(err?.message || t("trust.estimateUploadFailed"));
    } finally {
      setEstimateBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = Number(amount);
      if (!value || value <= 0) throw new Error(t("trust.claimAmountRequired"));
      if (!description.trim()) throw new Error(t("trust.claimDescriptionRequired"));
      if (claimNeedsEstimate(value) && !estimate?.id) {
        throw new Error(t("trust.estimateRequired"));
      }
      await fileDamageClaim({
        booking, report: ret, userId: user.id, amount: value, description: description.trim(),
        parts, severity, evidencePhotoIds: [],
        estimatePhotoId: estimate?.id || null,
        responseWindowHours: POLICY.claimWindowHours,
      });
      setAmount(""); setDescription(""); setParts([]); setEstimate(null);
      await load();
    } catch (err) {
      setError(err?.message || t("trust.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const answer = async (agree) => {
    setBusy(true);
    try {
      const settled = agree && counterAmount ? Number(counterAmount) : Number(claim.amount_claimed);
      await respondToClaim({ claim, booking, report: ret, userId: user.id, agree, amount: settled });
      // (the settlement row below records who decided and under which policy)
      const split = settlementSplit({ deposit, claimAmount: Number(claim.amount_claimed), agreed: agree, settledAmount: settled });
      await recordSettlement({
        booking, claimId: claim.id, depositAmount: deposit,
        released: split.released, withheld: split.withheld, status: split.status,
        reason: agree ? "agreed_claim" : "dispute_hold", userId: user.id,
      });
      await load();
    } catch (err) {
      setError(err?.message || t("trust.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setBusy(true);
    try {
      await withdrawClaim({ claim, booking, report: ret, note: t("trust.withdrawnNote") });
      await recordSettlement({
        booking, claimId: claim.id, depositAmount: deposit,
        released: deposit, withheld: 0, status: deposit > 0 ? "released" : "no_deposit",
        reason: "no_claim", userId: user.id,
      });
      await load();
    } catch (err) {
      setError(err?.message || t("trust.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  /** Close the window with no claim: the honest, boring, most common path. */
  const release = async () => {
    setBusy(true);
    try {
      await recordSettlement({
        booking, depositAmount: deposit, released: deposit, withheld: 0,
        status: deposit > 0 ? "released" : "no_deposit", reason: "no_claim", userId: user.id,
      });
      await load();
    } catch (err) {
      setError(err?.message || t("trust.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="flex min-h-[60vh] items-center justify-center text-mut"><Loader2 className="animate-spin" /></div>;
  if (!booking || (!isOwner && booking.farmer_id !== user?.id)) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center text-mut">
        <p>{t("booking.noAccess")}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/")}>{t("common.goHome")}</Button>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-5 pb-20 pt-6 md:px-8 md:pt-10">
      <button onClick={() => navigate(`/booking/${bookingId}`)} className="mb-6 inline-flex items-center gap-2 text-sm text-mut hover:text-ink">
        <ArrowLeft size={15} /> {t("trust.backToBooking")}
      </button>

      <SectionLabel
        eyebrow={t("trust.claimEyebrow")}
        title={t("trust.claimTitle")}
        sub={t("trust.claimSub", { equipment: booking.equipment?.name || "", deposit: deposit })}
      />

      {error && <div className="mb-4 rounded-2xl border border-accent/30 bg-accent-soft p-3 text-sm text-ink-2">{error}</div>}

      {/* deposit summary */}
      <div className="mb-6 rounded-3xl border border-line bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <IndianRupee size={15} className="text-accent" />
            {t("trust.depositLabel")}: <span className="font-mono">₹{deposit}</span>
          </div>
          {settlement && (
            <span className="rounded-full bg-sage-soft px-3 py-1 text-xs font-semibold text-sage">
              {t(`trust.settlement_${settlement.status}`, settlement.status)}
            </span>
          )}
        </div>
        {claim && preview && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat label={t("trust.statClaimed")} value={`₹${claim.amount_claimed}`} />
            <Stat label={t("trust.statHeld")} value={`₹${preview.held || preview.withheld}`} tone={preview.held || preview.withheld ? "warn" : "ok"} />
            <Stat label={t("trust.statReleased")} value={`₹${preview.released}`} tone="ok" />
          </div>
        )}
        {claim && (
          <p className="mt-3 text-xs text-mut">
            {claim.status === "disputed" ? t("trust.disputeHoldNote") : claim.status === "open" ? t("trust.claimOpenNote", { hours: POLICY.claimWindowHours }) : t("trust.policyVersionNote", { version: settlement?.policy_version || POLICY.version })}
          </p>
        )}
      </div>

      {/* ---- no claim yet: owner can file, renter waits ---- */}
      {!claim && ret?.finalized_at && isOwner && window.open && !window.expired && (
        <div className="rounded-3xl border border-line bg-card p-5">
          <h3 className="mb-1 font-display text-lg font-semibold text-ink">{t("trust.fileClaimTitle")}</h3>
          <p className="mb-4 text-xs text-mut">{t("trust.fileClaimSub", { hours: POLICY.claimWindowHours })}</p>

          <WearAndTearNote items={WEAR_AND_TEAR} />

          <div className="mt-4 space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-mut">{t("trust.amountLabel")}</span>
              <input
                type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 1500"
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
              {claimNeedsEstimate(Number(amount)) && (
                <span className="mt-1 flex items-center gap-1 text-[11px] text-gold">
                  <AlertTriangle size={11} /> {t("trust.estimateRequired")}
                </span>
              )}
            </label>

            {claimNeedsEstimate(Number(amount)) && (
              <div className="rounded-2xl border border-dashed border-line-2 bg-paper p-3">
                <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mut">
                  <Paperclip size={12} /> {t("trust.estimateLabel")}
                </span>
                {estimate ? (
                  <div className="flex items-center gap-3">
                    <img src={estimate.previewUrl} alt="" className="h-16 w-16 rounded-xl object-cover" />
                    <span className="text-xs text-sage">{t("trust.estimateAttached")}</span>
                    <button onClick={() => setEstimate(null)} className="ml-auto text-xs text-mut underline">
                      {t("trust.estimateRemove")}
                    </button>
                  </div>
                ) : (
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
                    <Camera size={14} className="text-accent" />
                    {estimateBusy ? t("trust.working") : t("trust.estimateHint")}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      disabled={estimateBusy}
                      onChange={(e) => attachEstimate(e.target.files?.[0])}
                    />
                  </label>
                )}
                <p className="mt-2 text-[11px] text-mut2">{t("trust.estimateWhy")}</p>
              </div>
            )}

            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-mut">{t("trust.partsLabel")}</span>
              <div className="flex flex-wrap gap-2">
                {CHARGEABLE_DAMAGE.map((item) => (
                  <Chip
                    key={item.key}
                    active={parts.includes(item.key)}
                    onClick={() => setParts((prev) => (prev.includes(item.key) ? prev.filter((p) => p !== item.key) : [...prev, item.key]))}
                  >
                    {t(`trust.damageItem_${item.key}`, item.label)}
                  </Chip>
                ))}
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-mut">{t("trust.severityLabel")}</span>
              <div className="flex gap-2">
                {["minor", "moderate", "major"].map((s) => (
                  <Chip key={s} active={severity === s} onClick={() => setSeverity(s)}>{t(`trust.severity_${s}`, s)}</Chip>
                ))}
              </div>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-mut">{t("trust.descriptionLabel")}</span>
              <textarea
                value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                placeholder={t("trust.descriptionPlaceholder")}
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={submit} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : null}{t("trust.submitClaim")}</Button>
              <Button variant="ghost" onClick={release} disabled={busy}>{t("trust.noClaimRelease")}</Button>
            </div>
            <p className="text-[11px] text-mut2">{t("trust.claimEvidenceNote", { code: ret.report_code })}</p>
          </div>
        </div>
      )}

      {/* ---- claim open: the renter answers ---- */}
      {claim?.status === "open" && !isOwner && (
        <div className="rounded-3xl border border-accent/30 bg-card p-5">
          <h3 className="mb-1 flex items-center gap-2 font-display text-lg font-semibold text-ink">
            <Scale size={18} className="text-accent" /> {t("trust.respondTitle")}
          </h3>
          <p className="text-sm text-ink-2">{claim.description}</p>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-mut">
            <span className="font-mono text-accent">₹{claim.amount_claimed}</span>
            <span>{t("trust.severityLabel")}: {t(`trust.severity_${claim.severity}`, claim.severity)}</span>
            <span>{t("trust.claimEvidenceNote", { code: ret?.report_code || "" })}</span>
          </div>

          {claim.repair_estimate_photo_id ? (
            <EstimatePreview photoId={claim.repair_estimate_photo_id} />
          ) : (
            <p className="mt-3 flex items-start gap-2 rounded-xl bg-paper px-3 py-2 text-[11px] text-mut">
              <Info size={12} className="mt-0.5 shrink-0" /> {t("trust.noEstimateAttached")}
            </p>
          )}

          <div className="mt-4">
            <p className="mb-2 text-xs text-mut">{t("trust.negotiateHint")}</p>
            <input
              type="number" inputMode="numeric" value={counterAmount} onChange={(e) => setCounterAmount(e.target.value)}
              placeholder={t("trust.counterPlaceholder", { amount: claim.amount_claimed })}
              className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={() => answer(true)} disabled={busy}>
              <Check size={15} /> {t("trust.agreeClaim")}
            </Button>
            <Button variant="ghost" onClick={() => answer(false)} disabled={busy}>
              <AlertTriangle size={15} /> {t("trust.disputeClaim")}
            </Button>
          </div>
          <p className="mt-3 text-[11px] text-mut2">{t("trust.disputeConsequence", { days: POLICY.claimWindowHours })}</p>
        </div>
      )}

      {/* ---- disputed: nothing withheld, resolution options ---- */}
      {claim?.status === "disputed" && (
        <div className="rounded-3xl border border-gold/30 bg-gold-soft/50 p-5">
          <h3 className="mb-2 font-display text-lg font-semibold text-ink">{t("trust.disputedTitle")}</h3>
          <p className="text-sm text-ink-2">{t("trust.disputedBody")}</p>
          <ul className="mt-3 space-y-1 text-xs text-mut">
            <li>{t("trust.disputedStep1")}</li>
            <li>{t("trust.disputedStep2")}</li>
            <li>{t("trust.disputedStep3")}</li>
          </ul>
          <div className="mt-4 flex flex-wrap gap-3">
            {isOwner ? (
              <>
                <Button onClick={() => { setCounterAmount(String(Math.round(Number(claim.amount_claimed) * 0.5))); answer(true); }} disabled={busy}>
                  {t("trust.resolveHalf")}
                </Button>
                <Button variant="ghost" onClick={withdraw} disabled={busy}>{t("trust.withdrawClaim")}</Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => navigate(`/report/${ret?.id}`)}>{t("trust.reviewEvidence")}</Button>
            )}
          </div>
        </div>
      )}

      {/* ---- settled ---- */}
      {(claim?.status === "agreed" || claim?.status === "resolved" || settlement) && (
        <div className="mt-4 rounded-3xl border border-sage/30 bg-sage-soft p-5">
          <h3 className="mb-2 font-display text-lg font-semibold text-ink">{t("trust.settledTitle")}</h3>
          {settlement ? (
            <div className="space-y-1 text-sm text-ink-2">
              <div>{t("trust.releasedLine", { amount: settlement.released_amount })}</div>
              {Number(settlement.withheld_amount) > 0 && <div>{t("trust.withheldLine", { amount: settlement.withheld_amount })}</div>}
              <div className="text-xs text-mut">{t("trust.policyVersionNote", { version: settlement.policy_version })}</div>
              <div className="text-xs text-mut">{t("trust.offlinePaymentNote")}</div>
            </div>
          ) : (
            <p className="text-sm text-ink-2">{t("trust.settledPending")}</p>
          )}
        </div>
      )}

      {/* ---- window open, renter's view ---- */}
      {!claim && ret?.finalized_at && !isOwner && (
        <div className="rounded-3xl border border-line bg-card p-5 text-sm text-mut">
          {window.expired ? t("trust.windowClosedRenter") : t("trust.windowOpenRenter", { hours: POLICY.claimWindowHours })}
        </div>
      )}

      {!ret?.finalized_at && (
        <div className="rounded-3xl border border-line bg-card p-5 text-sm text-mut">{t("trust.needReturnFirst")}</div>
      )}

      {knownDamage.length > 0 && (
        <div className="mt-6 rounded-3xl border border-line bg-paper p-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-mut">{t("trust.knownDamageTitle")}</h3>
          <ul className="space-y-1 text-xs text-ink-2">
            {knownDamage.map((d) => (
              <li key={d.id}>
                <b>{d.part}</b> — {t(`trust.damage_${d.kind}`, d.kind)} · {d.status}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-mut2">{t("trust.knownDamageNote")}</p>
        </div>
      )}
    </main>
  );
}

/** The owner's repair estimate, shown to the person who has to answer it. */
function EstimatePreview({ photoId }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from("report_photos").select("storage_path").eq("id", photoId).maybeSingle();
      if (!data?.storage_path) return;
      const map = await signedEvidenceUrlsFor([data.storage_path]);
      if (alive) setUrl(map[data.storage_path] || null);
    })();
    return () => { alive = false; };
  }, [photoId]);

  return (
    <div className="mt-3 flex items-center gap-3 rounded-2xl border border-line bg-paper p-3">
      <Paperclip size={14} className="shrink-0 text-accent" />
      <div className="min-w-0 text-xs">
        <div className="font-semibold text-ink-2">{t("trust.estimateLabel")}</div>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="text-accent underline">{t("trust.estimateView")}</a>
        ) : (
          <span className="text-mut2">{t("trust.working")}</span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "ok" }) {
  return (
    <div className={`rounded-2xl border p-3 ${tone === "warn" ? "border-gold/30 bg-gold-soft/50" : "border-line bg-paper"}`}>
      <div className="text-[10px] uppercase tracking-wide text-mut">{label}</div>
      <div className="font-mono text-lg text-ink">{value}</div>
    </div>
  );
}
