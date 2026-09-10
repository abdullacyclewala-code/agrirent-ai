import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { MapPin, SlidersHorizontal, Pencil, ChevronDown, Star, Info } from "lucide-react";
import taxonomy from "../data/taxonomy.json";
import { Button, MatchRing, Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentArt } from "../components/ui/EquipmentArt.jsx";
import { artCategoryFor, equipmentTypeLabel } from "../lib/equipmentDisplay.js";

export default function Recommendations() {
  const { t } = useTranslation();
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
    const raw = sessionStorage.getItem("agrirent_matches");
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
    return <div className="flex min-h-[60vh] items-center justify-center text-mut">{t("recommendations.loadingMatches")}</div>;
  }

  return (
    <main className="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14">
      {/* recap */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-card px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <span className="font-display font-semibold text-ink">{cropLabel} · {opLabel}</span>
          <span className="text-mut2">·</span>
          <span>{job?.land} {t("describeJob.acres")}</span>
          <span className="text-mut2">·</span>
          <span className="flex items-center gap-1"><MapPin size={13} /> {job?.location || t("recommendations.yourArea")}</span>
        </div>
        <Link to="/describe-job" className="flex items-center gap-1.5 text-sm font-medium text-accent hover:text-accent-2">
          <Pencil size={14} /> {t("recommendations.edit")}
        </Link>
      </div>

      {relaxedHp && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-sage/30 bg-sage-soft px-4 py-3 text-sm text-sage">
          <Info size={16} className="mt-0.5 shrink-0" />
          <span>{t("recommendations.relaxedHpNotice")}</span>
        </div>
      )}

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink sm:text-3xl">
            {t("recommendations.matchesFound", { count: sorted.length })}
          </h1>
          <p className="mt-1 text-sm text-mut">
            {rankedBy === "ml" ? t("recommendations.rankedByMl") : t("recommendations.rankedByRules")}
          </p>
        </div>
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className="flex items-center gap-2 rounded-xl border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink hover:border-mut2 md:hidden"
        >
          <SlidersHorizontal size={15} /> {t("recommendations.sort")}
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-card py-16 text-center">
          <p className="text-mut">{t("recommendations.noMatches")}</p>
          <p className="mt-1 text-sm text-mut2">{t("recommendations.noMatchesHint")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[200px_1fr]">
          {/* sort rail */}
          <aside className={`${filtersOpen ? "block" : "hidden"} md:block`}>
            <div className="sticky top-24">
              <div className="mb-3 font-mono text-xs uppercase tracking-wide text-mut2">{t("recommendations.sortBy")}</div>
              <div className="flex flex-col gap-1">
                {[
                  ["match", t("recommendations.sortMatch")],
                  ["price", t("recommendations.sortPrice")],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setSort(k)}
                    className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      sort === k ? "bg-accent-soft text-accent" : "text-mut hover:bg-card"
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
                  className="group mb-6 grid grid-cols-1 gap-6 overflow-hidden rounded-3xl border border-accent/30 bg-card p-6 transition-shadow hover:shadow-[0_0_0_1px_rgba(168,67,31,0.35)] sm:grid-cols-[1.1fr_1.4fr] sm:p-2"
                >
                  <div className="relative h-48 overflow-hidden rounded-2xl sm:h-full">
                    <EquipmentArt category={artCategoryFor(top.equipment_type)} className="h-full w-full" />
                  </div>
                  <div className="flex flex-col justify-center p-2 sm:p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <span className="font-mono text-[11px] uppercase tracking-wide text-sage">
                          {equipmentTypeLabel(top.equipment_type)}{top.hp ? ` · ${top.hp} HP` : ""}
                        </span>
                        <h3 className="mt-1 font-display text-xl font-bold text-ink sm:text-2xl">{top.name}</h3>
                      </div>
                      <MatchRing score={top.matchScore} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {top.reasons.slice(0, 3).map((r) => (
                        <span key={r} className="rounded-full bg-line-2 px-2.5 py-1 text-[11px] text-ink-2">{r}</span>
                      ))}
                    </div>
                    <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-4 text-sm">
                      {top.location_label && (
                        <span className="flex items-center gap-1 text-mut"><MapPin size={13} /> {top.location_label}</span>
                      )}
                      <span className="ml-auto font-mono text-lg text-accent">₹{top.price}<span className="text-sm text-mut2">/{top.price_unit}</span></span>
                    </div>
                  </div>
                </Link>
              </Reveal>
            )}

            {/* rest as expandable rows */}
            {rest.length > 0 && (
              <div className="divide-y divide-line rounded-2xl border border-line bg-card">
                {rest.map((eq) => (
                  <div key={eq.id}>
                    <button
                      onClick={() => setExpanded(expanded === eq.id ? null : eq.id)}
                      className="flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-card sm:px-5"
                    >
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl">
                        <EquipmentArt category={artCategoryFor(eq.equipment_type)} className="h-full w-full" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="truncate font-display text-sm font-semibold text-ink sm:text-base">{eq.name}</h4>
                        <p className="mt-0.5 truncate text-xs text-mut">
                          {equipmentTypeLabel(eq.equipment_type)} · ₹{eq.price}/{eq.price_unit}
                        </p>
                      </div>
                      <div className="hidden items-center gap-1 font-mono text-xs text-accent sm:flex">
                        <Star size={12} fill="currentColor" /> {eq.matchScore}%
                      </div>
                      <ChevronDown
                        size={18}
                        className={`shrink-0 text-mut2 transition-transform ${expanded === eq.id ? "rotate-180" : ""}`}
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
                                  <span key={r} className="rounded-full bg-line-2 px-2.5 py-1 text-[11px] text-mut">{r}</span>
                                ))}
                              </div>
                              <div className="mt-3 flex items-center gap-3">
                                <Link to={requirementId ? `/equipment/${eq.id}?requirementId=${requirementId}` : `/equipment/${eq.id}`}>
                                  <Button variant="outline" className="!px-4 !py-2 text-xs">{t("recommendations.viewDetails")}</Button>
                                </Link>
                                <span className="text-xs text-mut2">{t("recommendations.owner", { name: eq.owner_name })}</span>
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
