import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { MapPin, ShieldCheck, Star, ChevronLeft, PhoneCall, MessageCircle } from "lucide-react";
import { equipmentList } from "../data/mockData.js";
import { Button, Badge, Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentArt } from "../components/ui/EquipmentArt.jsx";

export default function EquipmentDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const eq = equipmentList.find((e) => e.id === id) || equipmentList[0];
  const [galleryIndex, setGalleryIndex] = useState(0);
  const similar = equipmentList.filter((e) => e.category === eq.category && e.id !== eq.id).slice(0, 3);

  const startBooking = () => navigate("/booking/bk-1042");

  return (
    <main className="mx-auto max-w-6xl px-5 pb-28 pt-6 md:px-8 md:pb-16 md:pt-10">
      <button onClick={() => navigate(-1)} className="mb-6 flex items-center gap-1.5 text-sm text-paper/50 hover:text-paper">
        <ChevronLeft size={16} /> Back to matches
      </button>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-[1.3fr_1fr]">
        {/* gallery */}
        <div className="min-w-0">
          <div className="relative aspect-[4/3] overflow-hidden rounded-3xl border border-white/10">
            <EquipmentArt category={eq.category} className="h-full w-full" />
            <div className="absolute left-4 top-4 flex gap-2">
              {eq.verified && <Badge tone="sky"><ShieldCheck size={11} /> Verified owner</Badge>}
              <Badge tone="leaf">{eq.availableFrom}</Badge>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            {eq.gallery.map((g, i) => (
              <button
                key={g + i}
                onClick={() => setGalleryIndex(i)}
                className={`h-16 w-20 shrink-0 overflow-hidden rounded-xl border transition-colors ${
                  galleryIndex === i ? "border-wheat" : "border-white/10 opacity-60 hover:opacity-100"
                }`}
              >
                <EquipmentArt category={eq.category} className="h-full w-full" />
              </button>
            ))}
          </div>

          <Reveal className="mt-10">
            <h2 className="font-display text-lg font-semibold text-paper">Specifications</h2>
            <div className="mt-4 divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.02] font-mono text-sm">
              {Object.entries(eq.specs).map(([k, v]) => (
                <div key={k} className="flex justify-between px-5 py-3">
                  <span className="text-paper/45">{k}</span>
                  <span className="text-paper">{v}</span>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal delay={0.1} className="mt-10">
            <h2 className="font-display text-lg font-semibold text-paper">Owner</h2>
            <div className="mt-4 flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-wheat/20 font-display text-lg font-bold text-wheat">
                {eq.owner.charAt(0)}
              </div>
              <div className="flex-1">
                <div className="font-medium text-paper">{eq.owner}</div>
                <div className="flex items-center gap-1 text-xs text-paper/50">
                  <Star size={12} className="text-wheat" fill="currentColor" /> {eq.ownerRating} · {eq.ownerBookings} bookings
                </div>
              </div>
              <div className="flex gap-2">
                <button className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-paper/70 hover:border-white/30">
                  <PhoneCall size={16} />
                </button>
                <button className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-paper/70 hover:border-white/30">
                  <MessageCircle size={16} />
                </button>
              </div>
            </div>
          </Reveal>

          {similar.length > 0 && (
            <Reveal delay={0.15} className="mt-10 min-w-0">
              <h2 className="font-display text-lg font-semibold text-paper">Similar equipment</h2>
              <div className="mt-4 flex w-full gap-4 overflow-x-auto pb-2">
                {similar.map((s) => (
                  <Link
                    key={s.id}
                    to={`/equipment/${s.id}`}
                    className="w-52 shrink-0 rounded-2xl border border-white/10 bg-white/[0.03] p-3 hover:border-wheat/30"
                  >
                    <div className="h-28 overflow-hidden rounded-xl">
                      <EquipmentArt category={s.category} className="h-full w-full" />
                    </div>
                    <div className="mt-2 truncate text-sm font-medium text-paper">{s.name}</div>
                    <div className="text-xs text-paper/45">₹{s.price}/{s.priceUnit} · {s.distance} km</div>
                  </Link>
                ))}
              </div>
            </Reveal>
          )}
        </div>

        {/* sticky booking panel */}
        <div className="hidden md:block">
          <div className="sticky top-24 rounded-3xl border border-white/10 bg-white/[0.03] p-6">
            <span className="font-mono text-[11px] uppercase tracking-wide text-moss-light">{eq.category} · {eq.power}</span>
            <h1 className="mt-1 font-display text-2xl font-bold text-paper">{eq.name}</h1>
            <p className="mt-2 flex items-center gap-1.5 text-sm text-paper/55">
              <MapPin size={14} /> {eq.location} · {eq.distance} km away
            </p>

            <div className="mt-5 flex items-baseline gap-1 border-y border-white/10 py-5">
              <span className="font-display text-3xl font-bold text-wheat">₹{eq.price}</span>
              <span className="text-paper/50">/ {eq.priceUnit}</span>
            </div>

            <div className="mt-5">
              <div className="mb-2 font-mono text-xs uppercase tracking-wide text-paper/40">Next available</div>
              <div className="flex flex-wrap gap-2">
                {["Today", "Tomorrow", "Oct 12", "Oct 13"].map((d, i) => (
                  <span
                    key={d}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                      i === 0 ? "bg-wheat text-ink" : "bg-white/5 text-paper/60"
                    }`}
                  >
                    {d}
                  </span>
                ))}
              </div>
            </div>

            <Button variant="primary" className="mt-6 w-full" onClick={startBooking}>
              Request to book
            </Button>
            <p className="mt-3 text-center text-xs text-paper/40">Free cancellation up to 12 hours before start</p>
          </div>
        </div>
      </div>

      {/* mobile sticky bar */}
      <motion.div
        initial={{ y: 100 }}
        animate={{ y: 0 }}
        className="fixed inset-x-0 bottom-16 z-30 flex items-center justify-between border-t border-white/10 bg-ink/95 px-5 py-3 backdrop-blur-xl md:hidden"
      >
        <div>
          <div className="font-display text-lg font-bold text-wheat">₹{eq.price}<span className="text-xs text-paper/40">/{eq.priceUnit}</span></div>
          <div className="text-[11px] text-paper/40">{eq.distance} km away</div>
        </div>
        <Button variant="primary" onClick={startBooking}>Request to book</Button>
      </motion.div>
    </main>
  );
}
