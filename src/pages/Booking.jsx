import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MapPin, Calendar } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button, Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentArt } from "../components/ui/EquipmentArt.jsx";
import { artCategoryFor, equipmentTypeLabel } from "../lib/equipmentDisplay.js";

// Matches the `status` enum used in supabase/schema.sql `bookings` table.
const STAGES = [
  { id: "Requested", label: "Requested", desc: "Sent to the owner, waiting for a response" },
  { id: "Confirmed", label: "Confirmed", desc: "Owner accepted — slot is locked in" },
  { id: "In Use", label: "In Use", desc: "Work is currently in progress" },
  { id: "Completed", label: "Completed", desc: "Job done" },
];
const TERMINAL_NEGATIVE = ["Rejected", "Cancelled"];

export default function Booking() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("bookings")
      .select("*, equipment:equipment_id ( name, equipment_type, price, price_unit, location_label ), owner:owner_id ( name ), farmer:farmer_id ( name )")
      .eq("id", id)
      .single();
    if (error || !data) {
      setNotFound(true);
    } else {
      setBooking(data);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const isOwner = booking && user && booking.owner_id === user.id;
  const isFarmer = booking && user && booking.farmer_id === user.id;

  const setStatus = async (status) => {
    setBusy(true);
    setActionError(null);
    const { error } = await supabase.from("bookings").update({ status }).eq("id", id);
    setBusy(false);
    if (error) {
      setActionError(error.message || "Couldn't update the booking.");
      return;
    }
    load();
  };

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-paper/50">Loading…</div>;
  }
  if (notFound || !booking) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-paper/60">This booking doesn't exist.</p>
        <Button variant="outline" onClick={() => navigate("/")}>Go home</Button>
      </div>
    );
  }
  if (!isOwner && !isFarmer) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-paper/60">You don't have access to this booking.</p>
        <Button variant="outline" onClick={() => navigate("/")}>Go home</Button>
      </div>
    );
  }

  const eq = booking.equipment;
  const isNegative = TERMINAL_NEGATIVE.includes(booking.status);
  const currentIndex = STAGES.findIndex((s) => s.id === booking.status);

  return (
    <main className="mx-auto max-w-5xl px-5 pb-16 pt-6 md:px-8 md:pt-10">
      <div className="mb-8">
        <span className="font-mono text-[11px] uppercase tracking-widest text-sky">Booking #{booking.id}</span>
        <h1 className="mt-1 font-display text-2xl font-bold text-paper sm:text-3xl">
          {isNegative ? `Booking ${booking.status.toLowerCase()}` : "Tracking your booking"}
        </h1>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.3fr_1fr]">
        <div>
          {isNegative ? (
            <Reveal>
              <div className="rounded-3xl border border-rust/30 bg-rust/10 p-6 text-center">
                <p className="text-paper/80">This booking was {booking.status.toLowerCase()}.</p>
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
                  <Button variant="primary" disabled={busy} onClick={() => setStatus("Confirmed")}>Accept</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setStatus("Rejected")}>Reject</Button>
                </>
              )}
              {booking.status === "Confirmed" && (
                <Button variant="primary" disabled={busy} onClick={() => setStatus("In Use")}>Mark in use</Button>
              )}
              {booking.status === "In Use" && (
                <Button variant="primary" disabled={busy} onClick={() => setStatus("Completed")}>Mark completed</Button>
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
                Cancel booking
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
                <span>{isOwner ? "Farmer" : "Owner"}</span>
                <span className="text-paper">{isOwner ? booking.farmer?.name : booking.owner?.name}</span>
              </div>
              <div className="flex justify-between border-t border-white/10 pt-2 font-semibold text-paper">
                <span>Price</span>
                <span className="font-mono text-wheat">₹{booking.price}<span className="text-xs text-paper/40">/{eq?.price_unit}</span></span>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </main>
  );
}
