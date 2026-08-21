import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MapPin, Calendar, Radio } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button, Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentArt } from "../components/ui/EquipmentArt.jsx";
import { artCategoryFor, equipmentTypeLabel } from "../lib/equipmentDisplay.js";
import { subscribeToBooking } from "../lib/realtime.js";
import { datesOverlap, expireStaleRequests, conflictOutOverlappingRequests } from "../lib/bookingLifecycle.js";

// Matches the `status` values used in supabase/schema.sql `bookings` table.
const TERMINAL_NEGATIVE = ["Rejected", "Cancelled", "Expired", "Conflicted"];
// A farmer can search again straight from a dead-end booking instead of
// having to find their way back manually.
const SUGGEST_RETRY = ["Expired", "Conflicted", "Rejected"];

export default function Booking() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  // §4.5 edge cases — a farmer should understand WHY a booking ended up here,
  // since "Expired"/"Conflicted" aren't a decision either party made.
  const NEGATIVE_COPY = {
    Rejected: t("booking.negRejected"),
    Cancelled: t("booking.negCancelled"),
    Expired: t("booking.negExpired"),
    Conflicted: t("booking.negConflicted"),
  };
  const STAGES = [
    { id: "Requested", label: t("booking.stageRequestedLabel"), desc: t("booking.stageRequestedDesc") },
    { id: "Confirmed", label: t("booking.stageConfirmedLabel"), desc: t("booking.stageConfirmedDesc") },
    { id: "In Use", label: t("booking.stageInUseLabel"), desc: t("booking.stageInUseDesc") },
    { id: "Completed", label: t("booking.stageCompletedLabel"), desc: t("booking.stageCompletedDesc") },
  ];

  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [liveUpdate, setLiveUpdate] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("bookings")
      .select("*, equipment:equipment_id ( name, equipment_type, price, price_unit, location_label ), owner:owner_id ( name ), farmer:farmer_id ( name )")
      .eq("id", id)
      .single();
    if (error || !data) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    // §4.5 "owner doesn't respond -> auto-expire" — checked lazily right
    // here, the moment either party actually looks at this booking.
    if (data.status === "Requested") {
      const expiredIds = await expireStaleRequests([data]);
      if (expiredIds.includes(data.id)) {
        data.status = "Expired";
      }
    }

    setBooking(data);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Phase 4 §2 "Realtime for booking updates" — live-update this page the
  // moment the owner (or farmer) changes status, no polling/refresh needed.
  // The realtime payload only carries `bookings`' own columns, so we merge
  // it over the existing joined row rather than discarding the joins.
  useEffect(() => {
    if (!id) return undefined;
    const unsubscribe = subscribeToBooking(id, (newRow) => {
      setBooking((prev) => (prev ? { ...prev, ...newRow } : prev));
      setLiveUpdate(true);
      setTimeout(() => setLiveUpdate(false), 4000);
    });
    return unsubscribe;
  }, [id]);

  const isOwner = booking && user && booking.owner_id === user.id;
  const isFarmer = booking && user && booking.farmer_id === user.id;

  const setStatus = async (status) => {
    setBusy(true);
    setActionError(null);

    // §4.5 double-booking conflict: re-check right before locking in an
    // Accept, not just at original booking-creation time — another request
    // for these same dates could have been confirmed since this page loaded.
    if (status === "Confirmed") {
      const { data: conflicts, error: conflictErr } = await supabase
        .from("bookings")
        .select("id, start_date, end_date")
        .eq("equipment_id", booking.equipment_id)
        .in("status", ["Confirmed", "In Use"])
        .neq("id", booking.id);
      if (conflictErr) {
        setActionError(t("booking.verifyFailed"));
        setBusy(false);
        return;
      }
      const hasConflict = (conflicts || []).some((b) =>
        datesOverlap(b.start_date, b.end_date, booking.start_date, booking.end_date)
      );
      if (hasConflict) {
        setActionError(t("booking.alreadyConfirmed"));
        setBusy(false);
        return;
      }
    }

    const { error } = await supabase.from("bookings").update({ status }).eq("id", id);
    if (error) {
      setActionError(error.message || t("booking.updateFailed"));
      setBusy(false);
      return;
    }

    // §4.5: accepting one request auto-resolves any other still-pending
    // requests that overlap the same equipment/dates — see
    // conflictOutOverlappingRequests()'s docstring for why "Conflicted"
    // rather than silently leaving them as "Requested".
    if (status === "Confirmed") {
      await conflictOutOverlappingRequests(booking);
    }

    setBusy(false);
    load();
  };

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-paper/50">{t("common.loading")}</div>;
  }
  if (notFound || !booking) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-paper/60">{t("booking.notFound")}</p>
        <Button variant="outline" onClick={() => navigate("/")}>{t("common.goHome")}</Button>
      </div>
    );
  }
  if (!isOwner && !isFarmer) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-paper/60">{t("booking.noAccess")}</p>
        <Button variant="outline" onClick={() => navigate("/")}>{t("common.goHome")}</Button>
      </div>
    );
  }

  const eq = booking.equipment;
  const isNegative = TERMINAL_NEGATIVE.includes(booking.status);
  const currentIndex = STAGES.findIndex((s) => s.id === booking.status);

  return (
    <main className="mx-auto max-w-5xl px-5 pb-16 pt-6 md:px-8 md:pt-10">
      <div className="mb-8">
        <span className="font-mono text-[11px] uppercase tracking-widest text-sky">{t("booking.bookingNumber", { id: booking.id })}</span>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-paper sm:text-3xl">
            {isNegative ? t("booking.statusTitle", { status: booking.status.toLowerCase() }) : t("booking.trackingTitle")}
          </h1>
          {liveUpdate && (
            <span className="flex items-center gap-1 rounded-full bg-leaf/15 px-2.5 py-1 text-[11px] font-medium text-leaf">
              <Radio size={11} /> {t("booking.updatedJustNow")}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.3fr_1fr]">
        <div>
          {isNegative ? (
            <Reveal>
              <div className="rounded-3xl border border-rust/30 bg-rust/10 p-6 text-center">
                <p className="text-paper/80">{NEGATIVE_COPY[booking.status] || t("booking.negGeneric", { status: booking.status.toLowerCase() })}</p>
                {isFarmer && SUGGEST_RETRY.includes(booking.status) && (
                  <Button variant="outline" className="mt-4 !px-5 !py-2 text-sm" onClick={() => navigate("/describe-job")}>
                    {t("booking.searchAgain")}
                  </Button>
                )}
              </div>
            </Reveal>
          ) : (
            <Reveal>
              <div className="relative rounded-2xl border border-white/10 bg-white/[0.02] p-6">
                {STAGES.map((stage, i) => {
                  const done = i < currentIndex;
                  const active = i === currentIndex;
                  return (
                    <div key={stage.id} className="relative flex gap-4 pb-8 last:pb-0">
                      {i < STAGES.length - 1 && (
                        <span className={`absolute left-[11px] top-6 h-full w-px ${done ? "bg-wheat" : "bg-white/10"}`} />
                      )}
                      <span
                        className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                          done || active ? "bg-wheat text-ink" : "border border-white/20 bg-ink text-paper/30"
                        } ${active ? "ring-4 ring-wheat/20" : ""}`}
                      >
                        {done ? "✓" : i + 1}
                      </span>
                      <div>
                        <div className={`text-sm font-semibold ${done || active ? "text-paper" : "text-paper/40"}`}>
                          {stage.label}
                        </div>
                        <div className="text-xs text-paper/40">{stage.desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Reveal>
          )}

          {actionError && <p className="mt-4 text-sm text-red-400">{actionError}</p>}

          {/* Owner actions */}
          {isOwner && !isNegative && (
            <Reveal delay={0.1} className="mt-6 flex flex-wrap gap-2">
              {booking.status === "Requested" && (
                <>
                  <Button variant="primary" disabled={busy} onClick={() => setStatus("Confirmed")}>{t("booking.accept")}</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setStatus("Rejected")}>{t("booking.reject")}</Button>
                </>
              )}
              {booking.status === "Confirmed" && (
                <Button variant="primary" disabled={busy} onClick={() => setStatus("In Use")}>{t("booking.markInUse")}</Button>
              )}
              {booking.status === "In Use" && (
                <Button variant="primary" disabled={busy} onClick={() => setStatus("Completed")}>{t("booking.markCompleted")}</Button>
              )}
            </Reveal>
          )}

          {/* Farmer actions */}
          {isFarmer && ["Requested", "Confirmed"].includes(booking.status) && (
            <Reveal delay={0.1} className="mt-6">
              <button
                disabled={busy}
                onClick={() => setStatus("Cancelled")}
                className="text-sm text-rust hover:underline disabled:opacity-40"
              >
                {t("booking.cancelBooking")}
              </button>
            </Reveal>
          )}
        </div>

        {/* details card */}
        <div>
          <Reveal className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
            <div className="flex items-center gap-3">
              <div className="h-16 w-16 overflow-hidden rounded-xl">
                <EquipmentArt category={artCategoryFor(eq?.equipment_type)} className="h-full w-full" />
              </div>
              <div>
                <div className="font-display text-base font-semibold text-paper">{eq?.name}</div>
                <div className="text-xs text-paper/50">{equipmentTypeLabel(eq?.equipment_type)}</div>
                {eq?.location_label && (
                  <div className="flex items-center gap-1 text-xs text-paper/50"><MapPin size={12} /> {eq.location_label}</div>
                )}
              </div>
            </div>

            <div className="mt-5 flex items-center gap-2 border-y border-white/10 py-4 text-sm text-paper/60">
              <Calendar size={14} /> {booking.start_date} → {booking.end_date}
            </div>

            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between text-paper/60">
                <span>{isOwner ? t("booking.farmerLabel") : t("booking.ownerLabel")}</span>
                <span className="text-paper">{isOwner ? booking.farmer?.name : booking.owner?.name}</span>
              </div>
              <div className="flex justify-between border-t border-white/10 pt-2 font-semibold text-paper">
                <span>{t("booking.priceLabel")}</span>
                <span className="font-mono text-wheat">₹{booking.price}<span className="text-xs text-paper/40">/{eq?.price_unit}</span></span>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </main>
  );
}
