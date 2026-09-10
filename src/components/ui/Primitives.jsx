import { motion } from "framer-motion";

export function Chip({ active, children, onClick, icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-all duration-200 ${
        active
          ? "border-accent bg-accent text-white shadow-[0_0_0_4px_rgba(168,67,31,0.15)]"
          : "border-line bg-card text-mut hover:border-mut2 hover:text-ink"
      }`}
    >
      {icon && <span className="text-base leading-none">{icon}</span>}
      {children}
    </button>
  );
}

export function Button({ children, variant = "primary", className = "", ...props }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-all duration-200 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none";
  const variants = {
    primary: "bg-accent text-white hover:bg-accent-2 shadow-[0_8px_24px_-8px_rgba(168,67,31,0.6)]",
    ghost: "bg-card text-ink border border-line hover:border-mut2",
    outline: "bg-transparent text-accent border border-accent/50 hover:bg-accent-soft",
    dark: "bg-ink text-paper border border-ink hover:bg-ink-2",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Badge({ tone = "leaf", children }) {
  const tones = {
    leaf: "bg-sage-soft text-sage border-sage/30",
    wheat: "bg-gold-soft text-gold border-gold/30",
    sky: "bg-sage-soft text-sage border-sage/30",
    rust: "bg-accent-soft text-accent border-accent/30",
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
        <div className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-accent">{eyebrow}</div>
      )}
      <h2 className="font-display text-2xl font-semibold text-ink sm:text-3xl">{title}</h2>
      {sub && <p className="mt-2 max-w-xl text-sm text-mut">{sub}</p>}
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
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(37,28,17,0.12)" strokeWidth={stroke} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="#b98523"
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
        <span className="font-display text-sm font-bold text-ink">{score}%</span>
      </div>
    </div>
  );
}

export function StatTile({ label, value, sub, accent = false }) {
  const long = typeof value === "string" && value.length > 6;
  return (
    <div className="card min-w-0 p-4 sm:p-5">
      <div className={`font-display font-semibold leading-tight break-words ${long ? "text-xl sm:text-4xl" : "text-2xl sm:text-4xl"} ${accent ? "text-accent" : "text-ink"}`}>{value}</div>
      <div className="mt-1 text-[11px] leading-tight text-mut sm:text-sm sm:leading-normal">{label}</div>
      {sub && <div className="mt-2 text-xs text-sage">{sub}</div>}
    </div>
  );
}
