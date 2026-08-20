import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowUpRight, Sparkles, Tractor, Radar } from "lucide-react";
import FieldScene from "../three/FieldScene.jsx";
import { Button, Reveal, SectionLabel } from "../components/ui/Primitives.jsx";

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
  return (
    <main className="grain">
      {/* ---------------- HERO ---------------- */}
      <section className="relative overflow-hidden border-b border-white/5">
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-6 px-5 pb-10 pt-8 md:grid-cols-[1.05fr_0.95fr] md:gap-4 md:px-8 md:pb-0 md:pt-0">
          {/* Text side */}
          <div className="relative z-10 order-2 min-w-0 md:order-1 md:py-24">
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

      </div>
    </main>
  );
}
