import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowUpRight, MapPin, Clock, Sparkles, Tractor, Wheat, Radar } from "lucide-react";
import FieldScene from "../three/FieldScene.jsx";
import { Button, Reveal, SectionLabel, StatTile } from "../components/ui/Primitives.jsx";
import { equipmentList, bookings } from "../data/mockData.js";

const steps = [
  {
    n: "01",
    title: "Describe your job",
    desc: "Tell us your crop, operation, land size, location and date — guided, not a form.",
    icon: Sparkles,
  },
  {
    n: "02",
    title: "Get matched by the model",
    desc: "Our ML model ranks nearby equipment by fit, availability, distance and price.",
    icon: Radar,
  },
  {
    n: "03",
    title: "Book and track",
    desc: "Confirm in a tap, then track your equipment from dispatch to field.",
    icon: Tractor,
  },
];

export default function Dashboard() {
  const activeBooking = bookings[0];
  const activeEquipment = equipmentList.find((e) => e.id === activeBooking.equipmentId);

  return (
    <main className="grain">
      {/* ---------------- HERO ---------------- */}
      <section className="relative overflow-hidden border-b border-white/5">
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-6 px-5 pb-10 pt-8 md:grid-cols-[1.05fr_0.95fr] md:gap-4 md:px-8 md:pb-0 md:pt-0">
          {/* Text side */}
          <div className="relative z-10 order-2 min-w-0 md:order-1 md:py-24">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-moss-light"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-leaf animate-pulse" />
              Live across 38 districts
            </motion.div>
            <motion.h1
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.05 }}
              className="font-display text-4xl font-bold leading-[1.05] text-paper sm:text-5xl lg:text-6xl"
            >
              The right machine
              <br />
              for the right <span className="text-wheat">field</span>,
              <br />
              at the right time.
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.15 }}
              className="mt-5 max-w-md text-base text-paper/60"
            >
              Kisan Match connects farmers with nearby tractors, harvesters and implements —
              matched by a model that understands your crop, land and schedule.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.25 }}
              className="mt-8 flex flex-wrap gap-3"
            >
              <Link to="/describe-job">
                <Button variant="primary">
                  Describe your job <ArrowUpRight size={16} />
                </Button>
              </Link>
              <Link to="/describe-job">
                <Button variant="ghost">List your equipment</Button>
              </Link>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.4 }}
              className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-white/10 pt-6 font-mono text-xs text-paper/50"
            >
              <span><strong className="text-paper">1,240+</strong> machines listed</span>
              <span><strong className="text-paper">92%</strong> match accuracy</span>
              <span><strong className="text-paper">4.7★</strong> avg. owner rating</span>
            </motion.div>
          </div>

          {/* 3D side */}
          <div className="relative order-1 -mx-5 h-[360px] min-w-0 overflow-hidden sm:h-[440px] md:order-2 md:mx-0 md:h-[640px]">
            <FieldScene className="h-full w-full" interactive={true} cameraDistance={15} />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink via-transparent to-transparent md:bg-gradient-to-l" />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-5 py-14 md:px-8 md:py-20">
        {/* ---------------- HOW IT WORKS ---------------- */}
        <SectionLabel eyebrow="Process" title="Three steps from field to finish" />
        <div className="relative grid grid-cols-1 gap-6 md:grid-cols-3">
          <div className="absolute left-0 right-0 top-8 hidden h-px bg-white/10 md:block" />
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.12}>
              <div className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                <div className="mb-4 flex items-center justify-between">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-wheat/15 text-wheat">
                    <s.icon size={18} />
                  </span>
                  <span className="font-mono text-xs text-paper/30">{s.n}</span>
                </div>
                <h3 className="font-display text-lg font-semibold text-paper">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-paper/55">{s.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>

        {/* ---------------- BENTO: activity ---------------- */}
        <div className="mt-16 grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Active booking - large panel */}
          <Reveal className="lg:col-span-2">
            <Link
              to={`/booking/${activeBooking.id}`}
              className="group block h-full rounded-2xl border border-white/10 bg-gradient-to-br from-forest-2 to-forest p-6 transition-colors hover:border-wheat/30 sm:p-8"
            >
              <div className="flex items-start justify-between">
                <div>
                  <span className="font-mono text-[11px] uppercase tracking-widest text-sky">Active booking</span>
                  <h3 className="mt-2 font-display text-xl font-semibold text-paper sm:text-2xl">
                    {activeEquipment.name}
                  </h3>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-paper/50">
                    <MapPin size={14} /> {activeBooking.location}
                  </p>
                </div>
                <ArrowUpRight className="text-paper/30 transition-transform group-hover:translate-x-1 group-hover:-translate-y-1 group-hover:text-wheat" />
              </div>

              <div className="mt-6 flex items-center gap-3">
                {["Requested", "Confirmed", "Dispatched", "In field", "Completed"].map((stage, i) => (
                  <div key={stage} className="flex flex-1 items-center gap-3">
                    <div
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        i <= 3 ? "bg-wheat" : "bg-white/15"
                      } ${i === 3 ? "animate-pulse ring-4 ring-wheat/20" : ""}`}
                    />
                    {i < 4 && <div className={`h-px flex-1 ${i < 3 ? "bg-wheat/50" : "bg-white/10"}`} />}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex justify-between font-mono text-[11px] text-paper/40">
                <span>Requested</span>
                <span className="text-wheat">In field</span>
                <span>Completed</span>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 pt-5 text-sm">
                <span className="flex items-center gap-1.5 text-paper/60">
                  <Clock size={14} /> {activeBooking.time}
                </span>
                <span className="text-paper/60">{activeBooking.date}</span>
                <span className="ml-auto font-mono text-wheat">₹{activeBooking.total.toLocaleString("en-IN")}</span>
              </div>
            </Link>
          </Reveal>

          {/* stat stack */}
          <Reveal delay={0.1} className="grid grid-cols-2 gap-5 lg:grid-cols-1">
            <StatTile label="Saved equipment" value="6" sub="3 available today" />
            <StatTile label="Nearby machines" value="24" sub="within 10 km" />
          </Reveal>
        </div>

        {/* ---------------- RECOMMENDED STRIP ---------------- */}
        <div className="mt-16 min-w-0">
          <div className="mb-6 flex items-end justify-between">
            <SectionLabel eyebrow="For your farm" title="Recommended near you" sub={undefined} />
            <Link to="/recommendations" className="hidden shrink-0 items-center gap-1 text-sm font-medium text-wheat sm:flex">
              View all <ArrowUpRight size={14} />
            </Link>
          </div>
          <div className="-mx-5 flex w-[calc(100%+2.5rem)] gap-4 overflow-x-auto px-5 pb-3 md:mx-0 md:w-full md:px-0" style={{ scrollSnapType: "x mandatory" }}>
            {equipmentList.slice(0, 4).map((eq, i) => (
              <Reveal key={eq.id} delay={i * 0.06} className="shrink-0" y={16}>
                <Link
                  to={`/equipment/${eq.id}`}
                  className="group flex w-64 flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-wheat/30"
                  style={{ scrollSnapAlign: "start" }}
                >
                  <div className="flex items-center justify-between">
                    <span className="rounded-full bg-white/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-moss-light">
                      {eq.category}
                    </span>
                    <span className="font-mono text-xs font-semibold text-wheat">{eq.matchScore}% fit</span>
                  </div>
                  <Wheat className="my-4 text-wheat/70 transition-transform group-hover:scale-110" size={28} />
                  <h4 className="font-display text-sm font-semibold text-paper">{eq.name}</h4>
                  <p className="mt-1 text-xs text-paper/45">{eq.distance} km · {eq.location.split(",")[0]}</p>
                  <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3">
                    <span className="font-mono text-sm text-paper">₹{eq.price}<span className="text-paper/40">/{eq.priceUnit}</span></span>
                    <span className="text-xs text-leaf">{eq.availableFrom}</span>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
