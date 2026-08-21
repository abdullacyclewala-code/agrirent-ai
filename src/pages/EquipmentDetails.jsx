import { useState, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { MapPin, ChevronLeft } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button, Badge, Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentArt } from "../components/ui/EquipmentArt.jsx";
import { artCategoryFor, equipmentTypeLabel, operationLabel, cropLabel } from "../lib/equipmentDisplay.js";
import { datesOverlap } from "../lib/bookingLifecycle.js";

export default function EquipmentDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  // Phase 5 — carried over from Recommendations.jsx so the booking this
  // creates can be linked back to the requirement that produced it (see
  // the insert below). Absent when someone lands here without going through
  // the search flow (e.g. browsing equipment directly) — that's fine, the
  // column is nullable for exactly that reason.
  const [searchParams] = useSearchParams();
  const requirementId = searchParams.get("requirementId");

  const [eq, setEq] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("equipment")
        .select("*, users:owner_id ( name )")
        .eq("id", id)
        .single();
      if (error || !data) {
        setNotFound(true);
      } else {
        setEq(data);
      }
      setLoading(false);
    })();
  }, [id]);

  const isOwnListing = eq && user && eq.owner_id === user.id;

  const requestBooking = async () => {
    if (!startDate || !endDate) {
      setBookError("Pick a start and end date.");
      return;
    }
    if (new Date(endDate) < new Date(startDate)) {
      setBookError("End date can't be before the start date.");
      return;
    }
    setBooking(true);
    setBookError(null);

    // Edge case §4.5: re-check availability + overlapping confirmed/in-use bookings
    // right before confirming, not just at search time.
    const { data: freshEq, error: freshErr } = await supabase
      .from("equipment")
      .select("is_available")
      .eq("id", id)
      .single();
    if (freshErr || !freshEq?.is_available) {
      setBookError("This equipment is no longer available.");
      setBooking(false);
      return;
    }

    const { data: conflicts, error: conflictErr } = await supabase
      .from("bookings")
      .select("id, start_date, end_date, status")
      .eq("equipment_id", id)
      .in("status", ["Confirmed", "In Use"]);
    if (conflictErr) {
      setBookError("Couldn't check availability. Try again.");
      setBooking(false);
      return;
    }
    const overlap = (conflicts || []).some(
      (b) => datesOverlap(b.start_date, b.end_date, startDate, endDate)
    );
    if (overlap) {
      setBookError("Those dates are already booked. Pick different dates.");
      setBooking(false);
      return;
    }

    const { data: newBooking, error: bookErr } = await supabase
      .from("bookings")
      .insert({
        equipment_id: eq.id,
        farmer_id: user.id,
        owner_id: eq.owner_id,
        status: "Requested",
        start_date: startDate,
        end_date: endDate,
        price: eq.price,
        requirement_id: requirementId || null,
      })
      .select()
      .single();

    setBooking(false);
    if (bookErr) {
      setBookError(bookErr.message || "Couldn't create the booking. Try again.");
      return;
    }
    navigate(`/booking/${newBooking.id}`);
  };

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-paper/50">Loading…</div>;
  }
  if (notFound || !eq) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-paper/60">This listing doesn't exist or was removed.</p>
        <Button variant="outline" onClick={() => navigate("/recommendations")}>Back to matches</Button>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-5 pb-28 pt-6 md:px-8 md:pb-16 md:pt-10">
      <button onClick={() => navigate(-1)} className="mb-6 flex items-center gap-1.5 text-sm text-paper/50 hover:text-paper">
        <ChevronLeft size={16} /> Back
      </button>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-[1.3fr_1fr]">
        {/* gallery */}
        <div className="min-w-0">
          <div className="relative aspect-[4/3] overflow-hidden rounded-3xl border border-white/10">
            <EquipmentArt category={artCategoryFor(eq.equipment_type)} className="h-full w-full" />
            <div className="absolute left-4 top-4 flex gap-2">
              <Badge tone={eq.is_available ? "leaf" : "rust"}>{eq.is_available ? "Available" : "Paused"}</Badge>
            </div>
          </div>

          <Reveal className="mt-10">
            <h2 className="font-display text-lg font-semibold text-paper">Specifications</h2>
            <div className="mt-4 divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.02] font-mono text-sm">
              <div className="flex justify-between px-5 py-3">
                <span className="text-paper/45">Type</span>
                <span className="text-paper">{equipmentTypeLabel(eq.equipment_type)}</span>
              </div>
              {eq.hp != null && (
                <div className="flex justify-between px-5 py-3">
                  <span className="text-paper/45">Horsepower</span>
                  <span className="text-paper">{eq.hp} HP</span>
                </div>
              )}
              <div className="flex justify-between px-5 py-3">
                <span className="text-paper/45">Operations</span>
                <span className="text-paper text-right">
                  {(eq.compatible_operations || []).map(operationLabel).join(", ") || "—"}
                </span>
              </div>
              <div className="flex justify-between px-5 py-3">
                <span className="text-paper/45">Crops</span>
                <span className="text-paper text-right">
                  {(eq.compatible_crops || []).map(cropLabel).join(", ") || "Any crop"}
                </span>
              </div>
              <div className="flex justify-between px-5 py-3">
                <span className="text-paper/45">Service radius</span>
                <span className="text-paper">{eq.service_area_radius_km} km</span>
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.1} className="mt-10">
            <h2 className="font-display text-lg font-semibold text-paper">Owner</h2>
            <div className="mt-4 flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-wheat/20 font-display text-lg font-bold text-wheat">
                {(eq.users?.name || "O").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="font-medium text-paper">{eq.users?.name || "Owner"}</div>
                {eq.location_label && (
                  <div className="flex items-center gap-1 text-xs text-paper/50"><MapPin size={12} /> {eq.location_label}</div>
                )}
              </div>
            </div>
          </Reveal>
        </div>

        {/* booking panel */}
        <div>
          <div className="sticky top-24 rounded-3xl border border-white/10 bg-white/[0.03] p-6">
            <span className="font-mono text-[11px] uppercase tracking-wide text-moss-light">
              {equipmentTypeLabel(eq.equipment_type)}{eq.hp ? ` · ${eq.hp} HP` : ""}
            </span>
            <h1 className="mt-1 font-display text-2xl font-bold text-paper">{eq.name}</h1>
            {eq.location_label && (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-paper/55">
                <MapPin size={14} /> {eq.location_label}
              </p>
            )}

            <div className="mt-5 flex items-baseline gap-1 border-y border-white/10 py-5">
              <span className="font-display text-3xl font-bold text-wheat">₹{eq.price}</span>
              <span className="text-paper/50">/ {eq.price_unit}</span>
            </div>

            {isOwnListing ? (
              <p className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-center text-sm text-paper/50">
                This is your own listing.
              </p>
            ) : !eq.is_available ? (
              <p className="mt-6 rounded-xl border border-rust/30 bg-rust/10 px-4 py-3 text-center text-sm text-rust">
                Currently paused by the owner.
              </p>
            ) : (
              <>
                <div className="mt-5 space-y-3">
                  <div>
                    <label className="mb-1 block text-xs uppercase tracking-wide text-paper/40">Start date</label>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper focus:border-wheat [color-scheme:dark]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs uppercase tracking-wide text-paper/40">End date</label>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper focus:border-wheat [color-scheme:dark]"
                    />
                  </div>
                </div>

                {bookError && <p className="mt-3 text-sm text-red-400">{bookError}</p>}

                <Button variant="primary" className="mt-6 w-full" onClick={requestBooking} disabled={booking}>
                  {booking ? "Sending request…" : "Request to book"}
                </Button>
                <p className="mt-3 text-center text-xs text-paper/40">Owner will accept or reject your request.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
