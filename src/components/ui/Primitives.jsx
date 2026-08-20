import { motion } from "framer-motion";

export function Chip({ active, children, onClick, icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-all duration-200 ${
        active
          ? "border-wheat bg-wheat text-ink shadow-[0_0_0_4px_rgba(232,179,74,0.15)]"
          : "border-white/10 bg-white/5 text-paper/80 hover:border-white/25 hover:bg-white/10"
      }`}
    >
      {icon && <span className="text-base leading-none">{icon}</span>}
      {children}
    </button>
  );
}

export function Button({ children, variant = "primary", className = "", ...props }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all duration-200 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none";
  const variants = {
    primary: "bg-wheat text-ink hover:bg-[#f3c162] shadow-[0_8px_24px_-8px_rgba(232,179,74,0.6)]",
    ghost: "bg-white/5 text-paper border border-white/10 hover:bg-white/10",
    outline: "bg-transparent text-wheat border border-wheat/50 hover:bg-wheat/10",
    dark: "bg-ink text-paper border border-white/10 hover:border-white/25",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Badge({ tone = "leaf", children }) {
  const tones = {
    leaf: "bg-leaf/15 text-leaf border-leaf/30",
    wheat: "bg-wheat/15 text-wheat border-wheat/30",
    sky: "bg-sky/15 text-sky border-sky/30",
    rust: "bg-rust/15 text-rust border-rust/30",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function SectionLabel({ eyebrow, title, sub }) {
  return (
    <div className="mb-8">
      {eyebrow && (
        <div className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-wheat/80">{eyebrow}</div>
      )}
      <h2 className="font-display text-2xl font-semibold text-paper sm:text-3xl">{title}</h2>
      {sub && <p className="mt-2 max-w-xl text-sm text-paper/60">{sub}</p>}
    </div>
  );
}

export function Reveal({ children, delay = 0, className = "", y = 24 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function MatchRing({ score = 90, size = 64 }) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.1)" strokeWidth={stroke} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="#e8b34a"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          whileInView={{ strokeDashoffset: c - (c * score) / 100 }}
          viewport={{ once: true }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-sm font-bold text-wheat">{score}%</span>
      </div>
    </div>
  );
}

export function StatTile({ label, value, sub }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="font-display text-2xl font-bold text-paper sm:text-3xl">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-paper/50">{label}</div>
      {sub && <div className="mt-2 text-xs text-moss-light">{sub}</div>}
    </div>
  );
}
