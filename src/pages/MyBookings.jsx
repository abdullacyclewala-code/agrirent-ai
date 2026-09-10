import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MapPin, Calendar } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentPhoto } from "../components/ui/EquipmentPhoto.jsx";
import { subscribeToUserBookings } from "../lib/realtime.js";
import { expireStaleRequests } from "../lib/bookingLifecycle.js";

const STATUS_TONE = {
  Requested: "bg-gold-soft text-gold",
  Confirmed: "bg-accent-soft text-accent",
  "In Use": "bg-sage-soft text-sage",
  Completed: "bg-line text-mut",
  Rejected: "bg-line text-mut",
  Cancelled: "bg-line text-mut",
  Expired: "bg-line text-mut",
  Conflicted: "bg-line text-mut",
};

export default function MyBookings() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [bookings, setBookings] = useState(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("*, equipment:equipment_id ( name, equipment_type, location_label, images ), owner:owner_id ( name ), farmer:farmer_id ( name )")
        .or(`farmer_id.eq.${user.id},owner_id.eq.${user.id}`)
        .order("created_at", { ascending: false });
      if (error) {
        setBookings([]);
        return;
      }
      const rows = data || [];

      // §4.5 "owner doesn't respond -> auto-expire" — checked lazily
      // whenever this list is opened, same as Booking.jsx's single-booking
      // load. Patch the ids that got expired into local state so the list
      // reflects it immediately without a full refetch.
      const expiredIds = await expireStaleRequests(rows);
      setBookings(
        expiredIds.length ? rows.map((b) => (expiredIds.includes(b.id) ? { ...b, status: "Expired" } : b)) : rows
      );
    })();
  }, [user]);

  // Phase 4 §2 "Realtime for booking updates" — keep this list live so an
  // owner sees a new request the moment a farmer books, and a farmer sees a
  // status change the moment the owner responds, with no manual refresh.
  useEffect(() => {
    if (!user) return undefined;
    const unsubscribe = subscribeToUserBookings(user.id, (newRow, eventType) => {
      if (eventType === "UPDATE") {
        // Merge the changed columns into the existing (already-joined) row.
        setBookings((prev) => (prev ? prev.map((b) => (b.id === newRow.id ? { ...b, ...newRow } : b)) : prev));
      } else if (eventType === "INSERT") {
        // A brand-new booking needs the equipment/owner/farmer joins this
        // event doesn't carry — simplest correct fix is to re-fetch the
        // one new row with its joins and prepend it.
        (async () => {
          const { data } = await supabase
            .from("bookings")
            .select("*, equipment:equipment_id ( name, equipment_type, location_label, images ), owner:owner_id ( name ), farmer:farmer_id ( name )")
            .eq("id", newRow.id)
            .single();
          if (data) setBookings((prev) => (prev ? [data, ...prev] : [data]));
        })();
      }
    });
    return unsubscribe;
  }, [user]);

  return (
    <main className="mx-auto max-w-4xl px-5 py-10 md:px-8 md:py-14">
      <h1 className="font-display text-2xl font-bold text-ink sm:text-3xl">{t("myBookings.title")}</h1>
      <p className="mt-1 text-sm text-mut">{t("myBookings.subtitle")}</p>

      {bookings === null ? (
        <div className="py-16 text-center text-sm text-mut2">{t("common.loading")}</div>
      ) : bookings.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-line bg-card py-16 text-center">
          <p className="text-mut">{t("myBookings.empty")}</p>
          <Link to="/describe-job" className="mt-3 inline-block text-sm font-medium text-accent hover:text-accent-2">
            {t("myBookings.emptyCta")}
          </Link>
        </div>
      ) : (
        <div className="mt-8 space-y-3">
          {bookings.map((b) => {
            const isOwner = b.owner_id === user.id;
            return (
              <Reveal key={b.id}>
                <Link
                  to={`/booking/${b.id}`}
                  className="flex items-center gap-4 rounded-2xl border border-line bg-card p-4 transition-colors hover:border-mut2"
                >
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl">
                    <EquipmentPhoto images={b.equipment?.images} equipmentType={b.equipment?.equipment_type} alt="" className="h-full w-full" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="truncate font-display text-sm font-semibold text-ink">{b.equipment?.name}</h4>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_TONE[b.status] || "bg-line text-mut"}`}>
                        {b.status}
                      </span>
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mut">
                      <span className="flex items-center gap-1"><Calendar size={11} /> {b.start_date} → {b.end_date}</span>
                      {b.equipment?.location_label && (
                        <span className="flex items-center gap-1"><MapPin size={11} /> {b.equipment.location_label}</span>
                      )}
                      <span>{isOwner ? t("myBookings.farmerLabel", { name: b.farmer?.name || "—" }) : t("myBookings.ownerLabel", { name: b.owner?.name || "—" })}</span>
                    </p>
                  </div>
                </Link>
              </Reveal>
            );
          })}
        </div>
      )}
    </main>
  );
}
