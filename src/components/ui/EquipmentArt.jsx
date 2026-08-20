// Illustrated equipment art — matches the low-poly field aesthetic of the 3D hero,
// avoids external image dependencies. Swap for real photography later (see README).

const palettes = {
  Tractor: { a: "#e8b34a", b: "#c96b4a", sky: "#7fa6c9" },
  Harvester: { a: "#7fa6c9", b: "#4b7a58", sky: "#e8b34a" },
  Implement: { a: "#6fbf73", b: "#4b7a58", sky: "#7fa6c9" },
};

export function EquipmentArt({ category = "Tractor", className = "" }) {
  const p = palettes[category] || palettes.Tractor;
  return (
    <svg viewBox="0 0 400 240" className={className} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={`sky-${category}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#17301f" />
          <stop offset="100%" stopColor="#0e1f17" />
        </linearGradient>
        <radialGradient id={`sun-${category}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={p.sky} stopOpacity="0.9" />
          <stop offset="100%" stopColor={p.sky} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="240" fill={`url(#sky-${category})`} />
      <circle cx="320" cy="60" r="70" fill={`url(#sun-${category})`} />
      {/* ground */}
      <path d="M0 170 L400 170 L400 240 L0 240 Z" fill="#1a3324" />
      <path d="M0 170 Q200 150 400 172 L400 190 Q200 168 0 188 Z" fill="#20402a" />
      {/* crop rows */}
      {Array.from({ length: 10 }).map((_, i) => (
        <line key={i} x1={i * 44} y1="240" x2={i * 44 - 30} y2="175" stroke="#2c4d33" strokeWidth="2" />
      ))}

      {category === "Tractor" && (
        <g transform="translate(90,95)">
          <rect x="20" y="30" width="120" height="42" rx="6" fill={p.a} />
          <rect x="20" y="0" width="55" height="42" rx="6" fill="#17301f" fillOpacity="0.9" />
          <rect x="130" y="20" width="45" height="35" rx="6" fill={p.b} />
          <circle cx="45" cy="90" r="32" fill="#111" />
          <circle cx="45" cy="90" r="12" fill="#333" />
          <circle cx="150" cy="95" r="20" fill="#111" />
          <circle cx="150" cy="95" r="8" fill="#333" />
          <rect x="10" y="-20" width="6" height="35" fill="#333" />
        </g>
      )}

      {category === "Harvester" && (
        <g transform="translate(60,70)">
          <rect x="40" y="40" width="180" height="50" rx="8" fill={p.b} />
          <rect x="70" y="5" width="60" height="45" rx="8" fill="#17301f" fillOpacity="0.9" />
          <rect x="0" y="55" width="55" height="30" rx="4" fill={p.a} />
          <polygon points="0,55 -25,80 0,85" fill={p.a} />
          <circle cx="80" cy="105" r="26" fill="#111" />
          <circle cx="80" cy="105" r="10" fill="#333" />
          <circle cx="190" cy="105" r="26" fill="#111" />
          <circle cx="190" cy="105" r="10" fill="#333" />
        </g>
      )}

      {category === "Implement" && (
        <g transform="translate(110,110)">
          <rect x="0" y="10" width="150" height="26" rx="6" fill={p.a} />
          {Array.from({ length: 8 }).map((_, i) => (
            <rect key={i} x={8 + i * 18} y="34" width="6" height="26" fill={p.b} />
          ))}
          <circle cx="20" cy="70" r="16" fill="#111" />
          <circle cx="130" cy="70" r="16" fill="#111" />
        </g>
      )}
    </svg>
  );
}

export function CropGlyph({ crop, className = "w-6 h-6" }) {
  return <span className={className}>{crop}</span>;
}
