import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, SlidersHorizontal, Pencil, ChevronDown, Star, Info } from "lucide-react";
import taxonomy from "../data/taxonomy.json";
import { Button, MatchRing, Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentArt } from "../components/ui/EquipmentArt.jsx";
import { artCategoryFor, equipmentTypeLabel } from "../lib/equipmentDisplay.js";

export default function Recommendations() {
  const navigate = useNavigate();
  const [job, setJob] = useState(null);
  const [requirementId, setRequirementId] = useState(null);
  const [results, setResults] = useState(null); // null = loading, [] = loaded empty
  const [relaxedHp, setRelaxedHp] = useState(false);
  const [rankedBy, setRankedBy] = useState("heuristic");
  const [expanded, setExpanded] = useState(null);
  const [sort, setSort] = useState("match");
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem("kisan_matches");
    if (!raw) {
      navigate("/describe-job");
      return;
    }
    const parsed = JSON.parse(raw);
    setJob(parsed.requirement);
    setRequirementId(parsed.requirementId ?? null);
    setResults(parsed.results || []);
    setRelaxedHp(!!parsed.relaxedHp);
    setRankedBy(parsed.rankedBy || "heuristic");
  }, [navigate]);

  const cropLabel = taxonomy.crops.find((c) => c.id === job?.crop)?.label || job?.crop;
  const opLabel = taxonomy.operations.find((o) => o.id === job?.operation)?.label || job?.operation;

  const sorted = [...(results || [])].sort((a, b) => {
    if (sort === "match") return b.matchScore - a.matchScore;
    if (sort === "price") return a.price - b.price;
    return 0;
  });

  const top = sorted[0];
  const rest = sorted.slice(1);

  if (results === null) {
    return <div className="flex min-h-[60vh] items-center justify-center text-paper/50">Loading matches…</div>;
  }

  return (
    <main className="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14">
      {/* recap */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-paper/70">
          <span className="font-display font-semibold text-paper">{cropLabel} · {opLabel}</span>
          <span className="text-paper/30">·</span>
          <span>{job?.land} acres</span>
          <span className="text-paper/30">·</span>
          <span className="flex items-center gap-1"><MapPin size={13} /> {job?.location || "your area"}</span>
        </div>
        <Link to="/describe-job" className="flex items-center gap-1.5 text-sm font-medium text-wheat hover:text-[#f3c162]">
          <Pencil size={14} /> Edit
        </Link>
      </div>

      {relaxedHp && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-sky/30 bg-sky/10 px-4 py-3 text-sm text-sky">
          <Info size={16} className="mt-0.5 shrink-0" />
          <span>No exact horsepower match nearby — showing equipment that fits your crop and operation, but HP may be outside the typical range for this job size.</span>
        </div>
      )}

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-paper sm:text-3xl">{sorted.length} matches found</h1>
          <p className="mt-1 text-sm text-paper/50">
            {rankedBy === "ml"
              ? "Ranked by our AI matching model — best fit first."
              : "Ranked by our rules-based matching — best fit first."}
          </p>
        </div>
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-paper hover:border-white/25 md:hidden"
        >
          <SlidersHorizontal size={15} /> Sort
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] py-16 text-center">
          <p className="text-paper/60">No equipment matches this job yet.</p>
          <p className="mt-1 text-sm text-paper/40">Try a different crop, operation, or check back once more owners list equipment.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[200px_1fr]">
          {/* sort rail */}
          <aside className={`${filtersOpen ? "block" : "hidden"} md:block`}>
            <div className="sticky top-24">
              <div className="mb-3 font-mono text-xs uppercase tracking-wide text-paper/40">Sort by</div>
              <div className="flex flex-col gap-1">
                {[
                  ["match", "Best match"],
                  ["price", "Lowest price"],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setSort(k)}
                    className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      sort === k ? "bg-wheat/15 text-wheat" : "text-paper/60 hover:bg-white/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          {/* results */}
          <div>
            {/* featured top match */}
            {top && (
              <Reveal>
                <Link
                  to={requirementId ? `/equipment/${top.id}?requirementId=${requirementId}` : `/equipment/${top.id}`}
                  className="group mb-6 grid grid-cols-1 gap-6 overflow-hidden rounded-3xl border border-wheat/30 bg-gradient-to-br from-forest-2 to-forest p-6 transition-shadow hover:shadow-[0_0_0_1px_rgba(232,179,74,0.4)] sm:grid-cols-[1.1fr_1.4fr] sm:p-2"
                >
                  <div className="relative h-48 overflow-hidden rounded-2xl sm:h-full">
                    <EquipmentArt category={artCategoryFor(top.equipment_type)} className="h-full w-full" />
                  </div>
                  <div className="flex flex-col justify-center p-2 sm:p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <span className="font-mono text-[11px] uppercase tracking-wide text-moss-light">
                          {equipmentTypeLabel(top.equipment_type)}{top.hp ? ` · ${top.hp} HP` : ""}
                        </span>
                        <h3 className="mt-1 font-display text-xl font-bold text-paper sm:text-2xl">{top.name}</h3>
                      </div>
                      <MatchRing score={top.matchScore} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {top.reasons.slice(0, 3).map((r) => (
                        <span key={r} className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-paper/70">{r}</span>
                      ))}
                    </div>
                    <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 pt-4 text-sm">
                      {top.location_label && (
                        <span className="flex items-center gap-1 text-paper/60"><MapPin size={13} /> {top.location_label}</span>
                      )}
                      <span className="ml-auto font-mono text-lg text-wheat">₹{top.price}<span className="text-sm text-paper/40">/{top.price_unit}</span></span>
                    </div>
                  </div>
                </Link>
              </Reveal>
            )}

            {/* rest as expandable rows */}
            {rest.length > 0 && (
              <div className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.02]">
                {rest.map((eq) => (
                  <div key={eq.id}>
                    <button
                      onClick={() => setExpanded(expanded === eq.id ? null : eq.id)}
                      className="flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-white/[0.03] sm:px-5"
                    >
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl">
                        <EquipmentArt category={artCategoryFor(eq.equipment_type)} className="h-full w-full" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="truncate font-display text-sm font-semibold text-paper sm:text-base">{eq.name}</h4>
                        <p className="mt-0.5 truncate text-xs text-paper/45">
                          {equipmentTypeLabel(eq.equipment_type)} · ₹{eq.price}/{eq.price_unit}
                        </p>
                      </div>
                      <div className="hidden items-center gap-1 font-mono text-xs text-wheat sm:flex">
                        <Star size={12} fill="currentColor" /> {eq.matchScore}%
                      </div>
                      <ChevronDown
                        size={18}
                        className={`shrink-0 text-paper/40 transition-transform ${expanded === eq.id ? "rotate-180" : ""}`}
                      />
                    </button>
                    <AnimatePresence>
                      {expanded === eq.id && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                          className="overflow-hidden"
                        >
                          <div className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-[auto_1fr] sm:items-center sm:pl-[92px]">
                            <MatchRing score={eq.matchScore} size={56} />
                            <div>
                              <div className="flex flex-wrap gap-1.5">
                                {eq.reasons.map((r) => (
                                  <span key={r} className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-paper/60">{r}</span>
                                ))}
                              </div>
                              <div className="mt-3 flex items-center gap-3">
                                <Link to={requirementId ? `/equipment/${eq.id}?requirementId=${requirementId}` : `/equipment/${eq.id}`}>
                                  <Button variant="outline" className="!px-4 !py-2 text-xs">View details</Button>
                                </Link>
                                <span className="text-xs text-paper/40">Owner: {eq.owner_name}</span>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
