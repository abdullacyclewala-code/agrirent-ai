import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { MapPin, Phone, Calendar, Clock, ChevronRight } from "lucide-react";
import { bookings, equipmentList, timelineStages } from "../data/mockData.js";
import { Button, Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentArt } from "../components/ui/EquipmentArt.jsx";

export default function Booking() {
  const { id } = useParams();
  const booking = bookings.find((b) => b.id === id) || bookings[0];
  const eq = equipmentList.find((e) => e.id === booking.equipmentId);
  const currentIndex = timelineStages.findIndex((s) => s.id === booking.status);

  return (
    <main className="mx-auto max-w-5xl px-5 pb-16 pt-6 md:px-8 md:pt-10">
      <div className="mb-8">
        <span className="font-mono text-[11px] uppercase tracking-widest text-sky">Booking #{booking.id}</span>
        <h1 className="mt-1 font-display text-2xl font-bold text-paper sm:text-3xl">Tracking your equipment</h1>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.3fr_1fr]">
        <div>
          {/* route visual */}
          <Reveal>
            <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-forest-2 to-forest p-6 sm:p-8">
              <div className="mb-6 flex items-center justify-between text-sm">
                <span className="text-paper/60">{eq.owner}'s yard</span>
                <span className="text-paper/60">Your field</span>
              </div>
              <div className="relative h-1 rounded-full bg-white/10">
                <div className="absolute inset-y-0 left-0 w-2/3 rounded-full bg-wheat/60" />
                <motion.div
                  className="absolute -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-wheat text-ink shadow-[0_0_0_6px_rgba(232,179,74,0.15)]"
                  animate={{ left: ["0%", "63%"] }}
                  transition={{ duration: 2.4, repeat: Infinity, repeatType: "reverse", ease: "easeInOut" }}
                >
                  <span className="text-[10px]">🚜</span>
                </motion.div>
                <span className="absolute -left-1 -top-6 text-lg">📍</span>
                <span className="absolute -right-1 -top-6 text-lg">🏡</span>
              </div>
              <div className="mt-8 flex items-center justify-between">
                <div>
                  <div className="font-display text-xl font-bold text-wheat">18 min</div>
                  <div className="text-xs text-paper/50">estimated arrival</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm text-paper">4.2 km</div>
                  <div className="text-xs text-paper/50">remaining</div>
                </div>
              </div>
            </div>
          </Reveal>

          {/* timeline */}
          <Reveal delay={0.1} className="mt-8">
            <h2 className="mb-4 font-display text-lg font-semibold text-paper">Status</h2>
            <div className="relative rounded-2xl border border-white/10 bg-white/[0.02] p-6">
              {timelineStages.map((stage, i) => {
                const done = i < currentIndex;
                const active = i === currentIndex;
                return (
                  <div key={stage.id} className="relative flex gap-4 pb-8 last:pb-0">
                    {i < timelineStages.length - 1 && (
                      <span
                        className={`absolute left-[11px] top-6 h-full w-px ${
                          done ? "bg-wheat" : "bg-white/10"
                        }`}
                      />
                    )}
                    <span
                      className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                        done || active ? "bg-wheat text-ink" : "border border-white/20 bg-ink text-paper/30"
                      } ${active ? "ring-4 ring-wheat/20 animate-pulse" : ""}`}
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
        </div>

        {/* details card */}
        <div>
          <Reveal className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
            <div className="flex items-center gap-3">
              <div className="h-16 w-16 overflow-hidden rounded-xl">
                <EquipmentArt category={eq.category} className="h-full w-full" />
              </div>
              <div>
                <div className="font-display text-base font-semibold text-paper">{eq.name}</div>
                <div className="flex items-center gap-1 text-xs text-paper/50"><MapPin size={12} /> {booking.location}</div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 border-y border-white/10 py-4 text-sm">
              <div className="flex items-center gap-2 text-paper/60"><Calendar size={14} /> {booking.date}</div>
              <div className="flex items-center gap-2 text-paper/60"><Clock size={14} /> {booking.time}</div>
            </div>

            <div className="mt-4 space-y-2">
              {booking.breakdown.map((b) => (
                <div key={b.label} className="flex justify-between text-sm text-paper/60">
                  <span>{b.label}</span>
                  <span className="font-mono">₹{b.value.toLocaleString("en-IN")}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-white/10 pt-2 text-sm font-semibold text-paper">
                <span>Total</span>
                <span className="font-mono text-wheat">₹{booking.total.toLocaleString("en-IN")}</span>
              </div>
            </div>

            <div className="mt-6 flex gap-2">
              <Button variant="ghost" className="flex-1"><Phone size={15} /> Call owner</Button>
              <Button variant="outline" className="flex-1">Reschedule</Button>
            </div>
            <button className="mt-3 w-full text-center text-xs text-rust hover:underline">Cancel booking</button>
          </Reveal>

          <Reveal delay={0.1} className="mt-4 flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-sm text-paper/60">
            Need help with this booking?
            <span className="flex items-center gap-1 font-medium text-wheat">Support <ChevronRight size={14} /></span>
          </Reveal>
        </div>
      </div>
    </main>
  );
}
