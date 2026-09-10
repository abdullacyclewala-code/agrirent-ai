import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, MapPin, Radar, Check, LocateFixed, Sparkles, Loader2, PenLine } from "lucide-react";
import taxonomy from "../data/taxonomy.json";
import { Button } from "../components/ui/Primitives.jsx";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { runRulesFilter } from "../lib/rulesFilter.js";
import { cropLabel, operationLabel, operationDesc, priceUnitLabel } from "../lib/equipmentDisplay.js";
import { fetchSlotsForMany, dateStatusOn, todayLocal } from "../lib/availability.js";
import { parseRequirementFreeText } from "../lib/llmClient.js";
import { rankCandidates } from "../lib/rankClient.js";
import {
  getBrowserLocation,
  isValidLatLng,
  formatDistance,
  reverseGeocode,
  DEFAULT_SEARCH_RADIUS_KM,
  RADIUS_OPTIONS_KM,
} from "../lib/geo.js";

const crops = taxonomy.crops;
const operations = taxonomy.operations;

// Phase 3: "freetext" is the first step — describe the job in your own words
// and the LLM (via backend) extracts crop/operation/land/location/date. Smart
// routing (see handleFreeTextSubmit): a complete parse jumps straight to the
// review step; a core-only parse (crop+operation+land, no place/date) jumps to
// the location step; a partial parse stays here and asks follow-up questions
// for exactly the missing slots. If it's skipped, or the LLM path is
// unavailable, the rest of the wizard (Phase 2, unchanged) still works exactly
// as before — §4.5 "must always work independently of LLM uptime".
const STEP_KEYS = ["freetext", "crop", "operation", "land", "location", "date", "review"];
// Slots the AI step is responsible for — location/date keep their dedicated
// steps (GPS capture + calendar UI beat chat questions for those).
const AI_CORE_SLOTS = ["crop", "operation", "land"];

function StepShell({ title, sub, children }) {
  return (
    <motion.div
      key={title}
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <h2 className="font-display text-2xl font-semibold text-ink sm:text-3xl">{title}</h2>
      {sub && <p className="mt-2 text-sm text-mut">{sub}</p>}
      <div className="mt-8">{children}</div>
    </motion.div>
  );
}

export default function DescribeJob() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [freeText, setFreeText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseNotice, setParseNotice] = useState(null); // { ok: bool, message: string }
  // Which slots the AI step has resolved (parse result + follow-up answers).
  // null = no parse yet (or returned here from the manual steps — panel reset).
  const [aiFilled, setAiFilled] = useState(null);
  const [customLand, setCustomLand] = useState("");
  const [form, setForm] = useState({
    crop: "wheat",
    operation: "harvesting",
    land: 4.5,
    location: "",
    date: "",
    notes: "",
    llmProviderUsed: null, // set when Phase 3 free-text parse succeeded
  });

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Phase 6 item 4 — farmer coordinates for geo search. Optional: without
  // them the search behaves exactly as before (no distance filter).
  const [farmerCoords, setFarmerCoords] = useState(null); // { lat, lng } | null
  const [radiusKm, setRadiusKm] = useState(DEFAULT_SEARCH_RADIUS_KM);
  const [locating, setLocating] = useState(false);
  const [resolvingPlace, setResolvingPlace] = useState(false);
  const [osmPlace, setOsmPlace] = useState(false);
  const [geoError, setGeoError] = useState(null);

  // Reuse last search's coords (saved to the profile on submit) so the
  // farmer isn't re-prompted on every visit. Silent failure — geo is optional.
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const { data } = await supabase
          .from("users")
          .select("latitude, longitude")
          .eq("id", user.id)
          .single();
        if (data && isValidLatLng(data.latitude, data.longitude)) {
          setFarmerCoords({ lat: Number(data.latitude), lng: Number(data.longitude) });
        }
      } catch {
        /* geo is optional — ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const captureFarmerLocation = async () => {
    if (locating) return;
    setLocating(true);
    setGeoError(null);
    try {
      const { lat, lng } = await getBrowserLocation();
      setFarmerCoords({ lat, lng });
      // Fill the location box immediately so it never looks stale, then
      // upgrade the label to a real place name when the free lookup resolves.
      // The upgrade only applies if the user hasn't typed something else
      // meanwhile — never overwrite their own text.
      const coordsLabel = t("describeJob.currentLocationAt", {
        lat: lat.toFixed(4),
        lng: lng.toFixed(4),
      });
      set("location", coordsLabel);
      setOsmPlace(false);
      setResolvingPlace(true);
      const place = await reverseGeocode(lat, lng);
      setResolvingPlace(false);
      if (place) {
        setOsmPlace(true);
        setForm((f) => (f.location === coordsLabel ? { ...f, location: place } : f));
      }
    } catch (err) {
      const code = err?.code || "unavailable";
      setGeoError(
        code === "denied"
          ? t("describeJob.geoDenied")
          : code === "timeout"
            ? t("describeJob.geoTimeout")
            : t("describeJob.geoUnavailable")
      );
    } finally {
      setLocating(false);
      setResolvingPlace(false);
    }
  };

  const canNext = useMemo(() => {
    switch (STEP_KEYS[step]) {
      case "freetext": return true; // optional — "Skip, I'll fill manually" always available
      case "crop": return !!form.crop;
      case "operation": return !!form.operation;
      case "land": return form.land > 0;
      case "location": return form.location.trim().length > 1;
      case "date": return !!form.date;
      default: return true;
    }
  }, [step, form]);

  const goNext = () => {
    if (step < STEP_KEYS.length - 1) setStep(step + 1);
    else submit();
  };
  const goBack = () => {
    if (step === 0) {
      navigate("/");
      return;
    }
    if (step === 1) {
      setAiFilled(null);
      setParseNotice(null);
    }
    setStep(step - 1);
  };

  // Backend-validated YYYY-MM-DD within a sane window. Re-checked here so a
  // stale/misbehaving backend can never plant a garbage date in the form.
  const isUsableNeededDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && s >= todayLocal();

  // Phase 3: LLM free-text parse (§6.1) + smart routing. Always falls through
  // to the manual wizard on any failure — see llmClient.js and §4.5.
  const handleFreeTextSubmit = async () => {
    if (parsing) return; // both the in-card and bottom-nav buttons call here
    if (!freeText.trim()) {
      setStep(1); // nothing typed — just go to manual crop step
      return;
    }
    setParsing(true);
    setParseNotice(null);
    setAiFilled(null);
    const result = await parseRequirementFreeText(freeText.trim(), "auto");
    setParsing(false);

    if (!result) {
      setParseNotice({
        ok: false,
        message: t("describeJob.parseFailed"),
      });
      setStep(1);
      return;
    }

    const cropValid = result.crop && crops.some((c) => c.id === result.crop);
    const opValid = result.operation && operations.some((o) => o.id === result.operation);
    const landValid = result.area_acres && result.area_acres > 0;
    const locText = (result.location_text || "").trim() || null;
    const dateValid = isUsableNeededDate(result.needed_date);

    setForm((f) => ({
      ...f,
      crop: cropValid ? result.crop : f.crop,
      operation: opValid ? result.operation : f.operation,
      land: landValid ? result.area_acres : f.land,
      location: locText || f.location,
      date: dateValid ? result.needed_date : f.date,
      llmProviderUsed: result.provider_used,
    }));

    const filled = {
      crop: !!cropValid,
      operation: !!opValid,
      land: !!landValid,
      location: !!locText,
      date: dateValid,
    };
    const coreDone = AI_CORE_SLOTS.every((k) => filled[k]);
    // Everything extracted (even place + date) → straight to summary/confirm.
    if (coreDone && filled.location && filled.date) {
      setStep(6);
      return;
    }
    // Core job known, place/date unknown → straight to location fetching.
    if (coreDone) {
      setStep(4);
      return;
    }
    // Too little info → stay here and ask about the missing slots below.
    setAiFilled(filled);
    setParseNotice({
      ok: true,
      message: t(Object.values(filled).some(Boolean) ? "describeJob.aiNeedMore" : "describeJob.aiGotNone"),
    });
  };

  // --- Follow-up question helpers (AI step, shown when aiFilled is set) ---
  const firstMissingCore = aiFilled ? AI_CORE_SLOTS.find((k) => !aiFilled[k]) ?? null : null;
  const markSlotFilled = (key) => setAiFilled((f) => (f ? { ...f, [key]: true } : f));
  const answerCrop = (id) => {
    set("crop", id);
    markSlotFilled("crop");
  };
  const answerOperation = (id) => {
    set("operation", id);
    markSlotFilled("operation");
  };
  const answerLand = (v) => {
    if (v > 0) {
      set("land", v);
      markSlotFilled("land");
    }
  };
  // Core complete via follow-ups → onward, skipping answered manual steps.
  const continueFromAi = () => {
    setStep(aiFilled?.location && aiFilled?.date ? 6 : 4);
  };
  // "Fill manually" → first manual step whose slot is still missing.
  const manualStepForMissing = () => {
    if (!aiFilled) return 1;
    if (!aiFilled.crop) return 1;
    if (!aiFilled.operation) return 2;
    if (!aiFilled.land) return 3;
    return 4;
  };

  const submit = async () => {
    setSubmitError(null);
    localStorage.setItem("agrirent_job", JSON.stringify(form));
    setScanning(true);

    const cropLabelEn = crops.find((c) => c.id === form.crop)?.label || form.crop;
    const opLabelEn = operations.find((o) => o.id === form.operation)?.label || form.operation;
    const parsed_json = {
      crop: form.crop,
      area_acres: form.land,
      operation: form.operation,
    };
    // If the farmer used the Phase 3 free-text step, keep their original wording as
    // raw_text (more useful for future retraining / review) — otherwise synthesize it.
    const raw_text = (
      freeText.trim() ||
      `${opLabelEn} for ${form.land} acres of ${cropLabelEn} near ${form.location}, needed ${form.date}. ${form.notes || ""}`
    ).trim();

    try {
      // 1. Save the structured requirement (manual-form path — §6.1 fallback, always available)
      let requirementId = null;
      if (user) {
        const { data: reqRow, error: reqErr } = await supabase
          .from("requirements")
          .insert({ farmer_id: user.id, raw_text, language: "en", parsed_json })
          .select()
          .single();
        if (reqErr) throw reqErr;
        requirementId = reqRow.id;
      }

      // 2. Fetch equipment + run the rules-engine hard filter (§6.3).
      // Phase 6 item 4: when the farmer shared their location, search via
      // the nearby_equipment RPC (PostGIS ST_DWithin on BOTH the search
      // radius AND each listing's service_area_radius_km). Any RPC failure
      // falls back to the plain list — same always-works pattern as §4.5.
      let equipmentRows;
      let geoUsed = false;
      if (isValidLatLng(farmerCoords?.lat, farmerCoords?.lng)) {
        try {
          const { data: nearby, error: rpcErr } = await supabase.rpc("nearby_equipment", {
            p_lat: farmerCoords.lat,
            p_lng: farmerCoords.lng,
            p_radius_km: radiusKm,
          });
          if (rpcErr) throw rpcErr;
          // Listings whose owners haven't pinned a location yet can't be
          // distance-checked — include them (distance unknown) rather than
          // hiding the marketplace while owners migrate.
          const { data: unlocated } = await supabase
            .from("equipment")
            .select("*, users:owner_id ( name )")
            .is("location", null)
            .eq("is_available", true);
          equipmentRows = [
            ...(nearby || []),
            ...(unlocated || []).map((r) => ({ ...r, distance_km: null })),
          ];
          geoUsed = true;
        } catch (rpcErr) {
          console.warn("[DescribeJob] geo search failed, falling back to full list:", rpcErr?.message);
          const { data: fallback, error: fbErr } = await supabase
            .from("equipment")
            .select("*, users:owner_id ( name )");
          if (fbErr) throw fbErr;
          equipmentRows = fallback;
        }
      } else {
        const { data: all, error: eqErr } = await supabase
          .from("equipment")
          .select("*, users:owner_id ( name )");
        if (eqErr) throw eqErr;
        equipmentRows = all;
      }

      const normalized = (equipmentRows || []).map((row) => ({
        ...row,
        owner_name: row.owner_name || row.users?.name || t("common.owner"),
      }));

      const { results, relaxedHp } = runRulesFilter(normalized, parsed_json, user?.id, {
        distanceReason: (km) => t("recommendations.distanceAway", { d: formatDistance(km) }),
        suitedFor: (op) => t("recommendations.reasonSuited", { op: operationLabel(op) }),
        usedForCrop: (crop) => t("recommendations.reasonCrop", { crop: cropLabel(crop) }),
        hpFit: (hp, acres) => t("recommendations.reasonHpFit", { hp, acres }),
        hpOutside: (hp) => t("recommendations.reasonHpOut", { hp }),
        priceLine: (price, unit) =>
          t("recommendations.reasonPrice", { price, unit: priceUnitLabel(unit, t) }),
      });

      // Phase 4 §6.4 "availability match quality" feature — check which of
      // the filtered candidates are busy on the farmer's requested date, so
      // the ranker can prefer equipment that's actually free that day. Phase 6
      // item 5: this reads the slot calendar (one query for all candidates).
      // "Busy" means a booking lock covers the date OR the date falls outside
      // the owner's offered windows. Fail-open: if the lookup fails, every
      // candidate keeps quality 1.0 and the detail page still enforces slots.
      let candidatesForRanking = results;
      if (form.date && results.length) {
        try {
          const slotsByEq = await fetchSlotsForMany(
            supabase,
            results.map((r) => r.id)
          );
          const busyIds = new Set(
            results
              .filter((r) => {
                const status = dateStatusOn(slotsByEq.get(r.id), form.date);
                return status === "booked" || status === "unoffered";
              })
              .map((r) => r.id)
          );
          candidatesForRanking = results.map((r) => ({
            ...r,
            availability_quality: busyIds.has(r.id) ? 0.3 : 1.0,
          }));
        } catch (slotErr) {
          console.error("availability_quality slot lookup failed:", slotErr);
        }
      }

      // Phase 4 §6.4/§6.5 — replace the Phase 2 heuristic score with the real
      // LightGBM ranker's score, when the backend is reachable. If it isn't
      // (cold-start timeout, backend down, VITE_BACKEND_URL unset), keep the
      // heuristic scores `runRulesFilter` already computed — same
      // always-works fallback pattern as the Phase 3 LLM parse step.
      const rankedById = await rankCandidates(parsed_json, candidatesForRanking);
      const finalResults = rankedById
        ? results.map((r) => {
            const ranked = rankedById.get(r.id);
            if (!ranked) return r;
            return { ...r, matchScore: ranked.rank_score };
          })
        : results;
      finalResults.sort((a, b) => b.matchScore - a.matchScore);

      // Remember working coords on the profile (fire-and-forget) so the next
      // search reuses them without re-prompting for location permission.
      if (user && geoUsed) {
        supabase
          .from("users")
          .update({ latitude: farmerCoords.lat, longitude: farmerCoords.lng })
          .eq("id", user.id)
          .then(({ error: saveErr }) => {
            if (saveErr) console.warn("[DescribeJob] couldn't save farmer coords:", saveErr.message);
          });
      }

      sessionStorage.setItem(
        "agrirent_matches",
        JSON.stringify({
          requirementId,
          requirement: { ...form, parsed_json, farmerCoords, radiusKm, geoUsed },
          results: finalResults,
          relaxedHp,
          rankedBy: rankedById ? "ml" : "heuristic",
        })
      );

      setTimeout(() => navigate("/recommendations"), 1800);
    } catch (err) {
      setScanning(false);
      setSubmitError(err.message || t("describeJob.submitError"));
    }
  };

  if (scanning) return <ScanningScreen form={form} />;

  return (
    <main className="mx-auto min-h-[calc(100vh-72px)] max-w-3xl px-5 py-10 md:px-8 md:py-16">
      {/* progress */}
      <div className="mb-10 flex items-center gap-2">
        {STEP_KEYS.map((k, i) => (
          <div key={k} className="h-1 flex-1 overflow-hidden rounded-full bg-line-2">
            <motion.div
              className="h-full bg-accent"
              initial={false}
              animate={{ width: i <= step ? "100%" : "0%" }}
              transition={{ duration: 0.4 }}
            />
          </div>
        ))}
      </div>

      {submitError && (
        <div className="mb-6 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-accent">
          {submitError}
        </div>
      )}

      <AnimatePresence mode="wait">
        {STEP_KEYS[step] === "freetext" && (
          <StepShell
            key="freetext"
            title={t("describeJob.freetextTitle")}
            sub={t("describeJob.freetextSub")}
          >
            <div className="relative">
              <Sparkles className="pointer-events-none absolute left-4 top-4 text-accent" size={18} />
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder={t("describeJob.freetextPlaceholder")}
                rows={4}
                disabled={parsing}
                className="w-full resize-none rounded-xl border border-line bg-card py-4 pl-11 pr-4 text-ink placeholder:text-mut2 focus:border-accent disabled:opacity-50"
              />
            </div>

            {parseNotice && (
              <div
                className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
                  parseNotice.ok
                    ? "border-sage/30 bg-sage-soft text-sage"
                    : "border-line bg-card text-mut"
                }`}
              >
                {parseNotice.message}
              </div>
            )}

            {aiFilled && (
              <div className="mt-6 rounded-2xl border border-accent/25 bg-accent-soft/50 p-5">
                <p className="text-sm font-semibold text-ink">{t("describeJob.aiUnderstood")}</p>
                <div className="mt-3 divide-y divide-line rounded-xl border border-line bg-card text-sm">
                  {[
                    [t("describeJob.reviewCrop"), aiFilled.crop ? cropLabel(form.crop) : null],
                    [t("describeJob.reviewOperation"), aiFilled.operation ? operationLabel(form.operation) : null],
                    [t("describeJob.reviewLand"), aiFilled.land ? `${form.land} ${t("describeJob.acres")}` : null],
                    [t("describeJob.reviewLocation"), aiFilled.location ? form.location : null],
                    [t("describeJob.reviewDate"), aiFilled.date ? form.date : null],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="text-mut">{label}</span>
                      {value ? (
                        <span className="flex items-center gap-1.5 font-medium text-ink">
                          <Check size={14} className="text-sage" /> {value}
                        </span>
                      ) : (
                        <span className="text-mut2">{t("describeJob.aiUnknown")}</span>
                      )}
                    </div>
                  ))}
                </div>

                {firstMissingCore === "crop" && (
                  <div className="mt-4">
                    <p className="text-sm font-medium text-ink">{t("describeJob.aiAskCrop")}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {crops.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => answerCrop(c.id)}
                          className="flex items-center gap-2 rounded-xl border border-line bg-card p-3 text-left transition-all hover:border-accent"
                        >
                          <span className="text-xl">{c.icon}</span>
                          <span className="text-xs font-medium text-ink">{cropLabel(c.id)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {firstMissingCore === "operation" && (
                  <div className="mt-4">
                    <p className="text-sm font-medium text-ink">{t("describeJob.aiAskOperation")}</p>
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {operations.map((op) => (
                        <button
                          key={op.id}
                          onClick={() => answerOperation(op.id)}
                          className="rounded-xl border border-line bg-card p-3 text-left text-sm font-medium text-ink transition-all hover:border-accent"
                        >
                          {operationLabel(op.id)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {firstMissingCore === "land" && (
                  <div className="mt-4">
                    <p className="text-sm font-medium text-ink">{t("describeJob.aiAskLand")}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {[1, 2, 5, 10].map((acres) => (
                        <button
                          key={acres}
                          onClick={() => answerLand(acres)}
                          className="rounded-full border border-line bg-card px-4 py-2 text-sm font-medium text-ink transition-all hover:border-accent"
                        >
                          {acres} {t("describeJob.acres")}
                        </button>
                      ))}
                      <span className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0.5"
                          step="0.5"
                          value={customLand}
                          onChange={(e) => setCustomLand(e.target.value)}
                          placeholder="3.5"
                          className="w-24 rounded-full border border-line bg-card px-4 py-2 text-sm text-ink placeholder:text-mut2 focus:border-accent"
                        />
                        <button
                          onClick={() => {
                            answerLand(parseFloat(customLand));
                            setCustomLand("");
                          }}
                          disabled={!(parseFloat(customLand) > 0)}
                          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity disabled:opacity-40"
                        >
                          {t("describeJob.aiLandSet")}
                        </button>
                      </span>
                    </div>
                  </div>
                )}

                {!firstMissingCore && (
                  <Button variant="primary" onClick={continueFromAi} className="mt-4">
                    {t("describeJob.aiContinue")} <ArrowRight size={16} />
                  </Button>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={handleFreeTextSubmit} disabled={parsing}>
                {parsing ? (
                  <>
                    <Loader2 className="animate-spin" size={16} /> {t("describeJob.parsingLabel")}
                  </>
                ) : (
                  <>
                    <Sparkles size={16} /> {freeText.trim() ? t("describeJob.parseWithAi") : t("describeJob.continueBtn")}
                  </>
                )}
              </Button>
              <button
                onClick={() => setStep(aiFilled ? manualStepForMissing() : 1)}
                disabled={parsing}
                className="flex items-center gap-1.5 text-sm font-medium text-mut hover:text-ink disabled:opacity-40"
              >
                <PenLine size={14} /> {t(aiFilled ? "describeJob.aiFillManually" : "describeJob.skipManual")}
              </button>
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "crop" && (
          <StepShell key="crop" title={t("describeJob.cropTitle")} sub={t("describeJob.cropSub")}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {crops.map((c) => (
                <button
                  key={c.id}
                  onClick={() => set("crop", c.id)}
                  className={`flex flex-col items-center gap-2 rounded-2xl border p-5 transition-all ${
                    form.crop === c.id
                      ? "border-accent bg-accent-soft shadow-[0_0_0_4px_rgba(168,67,31,0.12)]"
                      : "border-line bg-card hover:border-mut2"
                  }`}
                >
                  <span className="text-3xl">{c.icon}</span>
                  <span className="text-sm font-medium text-ink">{cropLabel(c.id)}</span>
                </button>
              ))}
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "operation" && (
          <StepShell key="operation" title={t("describeJob.operationTitle")} sub={t("describeJob.operationSub")}>
            <div className="flex flex-col gap-3">
              {operations.map((op) => (
                <button
                  key={op.id}
                  onClick={() => set("operation", op.id)}
                  className={`flex items-center justify-between rounded-2xl border p-5 text-left transition-all ${
                    form.operation === op.id
                      ? "border-accent bg-accent-soft"
                      : "border-line bg-card hover:border-mut2"
                  }`}
                >
                  <div>
                    <div className="font-medium text-ink">{operationLabel(op.id)}</div>
                    <div className="mt-0.5 text-xs text-mut">{operationDesc(op.id)}</div>
                  </div>
                  {form.operation === op.id && (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white">
                      <Check size={14} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "land" && (
          <StepShell key="land" title={t("describeJob.landTitle")} sub={t("describeJob.landSub")}>
            <div className="rounded-2xl border border-line bg-card p-8 text-center">
              <div className="font-display text-6xl font-bold text-accent">
                {form.land}
                <span className="ml-2 text-2xl text-mut">{t("describeJob.acres")}</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="30"
                step="0.5"
                value={form.land}
                onChange={(e) => set("land", parseFloat(e.target.value))}
                className="mt-8 w-full accent-[#a8431f]"
              />
              <div className="mt-2 flex justify-between font-mono text-xs text-mut2">
                <span>0.5</span>
                <span>30 {t("describeJob.acres")}</span>
              </div>
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "location" && (
          <StepShell key="location" title={t("describeJob.locationTitle")} sub={t("describeJob.locationSub")}>
            <div className="relative">
              <MapPin className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-mut2" size={18} />
              <input
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
                placeholder={t("describeJob.locationPlaceholder")}
                className="w-full rounded-xl border border-line bg-card py-4 pl-11 pr-4 text-ink placeholder:text-mut2 focus:border-accent"
              />
            </div>
            <button
              onClick={captureFarmerLocation}
              disabled={locating}
              className="mt-3 flex items-center gap-2 text-sm font-medium text-accent hover:text-accent-2 disabled:opacity-60"
            >
              {locating ? <Loader2 size={15} className="animate-spin" /> : <LocateFixed size={15} />}
              {locating ? t("describeJob.locating") : t("describeJob.useCurrentLocation")}
            </button>
            {farmerCoords && (
              <div className="mt-3 rounded-xl border border-sage/30 bg-sage-soft px-4 py-3">
                <div className="flex items-center gap-1.5 text-sm font-medium text-sage">
                  <Check size={15} /> {t("describeJob.geoCaptured")}
                  <span className="font-mono text-xs">
                    ({farmerCoords.lat.toFixed(4)}, {farmerCoords.lng.toFixed(4)})
                  </span>
                </div>
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="text-xs text-mut">{t("describeJob.radiusLabel")}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {RADIUS_OPTIONS_KM.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRadiusKm(r)}
                        className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          radiusKm === r ? "bg-sage text-paper" : "bg-line-2 text-ink-2 hover:bg-line"
                        }`}
                      >
                        {r} km
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {resolvingPlace && (
              <p className="mt-2 text-xs text-mut2">{t("describeJob.detectingPlace")}</p>
            )}
            {osmPlace && !resolvingPlace && (
              <p className="mt-2 text-[11px] text-mut2">{t("describeJob.osmAttribution")}</p>
            )}
            {geoError && <p className="mt-2 text-xs text-accent">{geoError}</p>}

          </StepShell>
        )}

        {STEP_KEYS[step] === "date" && (
          <StepShell key="date" title={t("describeJob.dateTitle")} sub={t("describeJob.dateSub")}>
            <input
              type="date"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              className="w-full rounded-xl border border-line bg-card px-4 py-4 text-ink focus:border-accent [color-scheme:light]"
            />
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder={t("describeJob.notesPlaceholder")}
              rows={3}
              className="mt-6 w-full resize-none rounded-xl border border-line bg-card px-4 py-3 text-sm text-ink placeholder:text-mut2 focus:border-accent"
            />
          </StepShell>
        )}

        {STEP_KEYS[step] === "review" && (
          <StepShell key="review" title={t("describeJob.reviewTitle")} sub={t("describeJob.reviewSub")}>
            {form.llmProviderUsed && (
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-accent/20 bg-accent-soft px-4 py-2.5 text-xs text-accent">
                <Sparkles size={13} /> {t("describeJob.prefilledNotice", { provider: form.llmProviderUsed })}
              </div>
            )}
            <div className="divide-y divide-line rounded-2xl border border-line bg-card">
              {[
                [t("describeJob.reviewCrop"), cropLabel(form.crop), 1],
                [t("describeJob.reviewOperation"), operationLabel(form.operation), 2],
                [t("describeJob.reviewLand"), `${form.land} ${t("describeJob.acres")}`, 3],
                [t("describeJob.reviewLocation"), form.location || "—", 4],
                [t("describeJob.reviewDate"), form.date || "—", 5],
                [t("describeJob.reviewNotes"), form.notes || t("describeJob.reviewNone"), 5],
              ].map(([label, value, stepIdx]) => (
                <div key={label} className="flex items-center justify-between gap-3 px-5 py-4 text-sm">
                  <span className="shrink-0 text-mut">{label}</span>
                  <span className="flex min-w-0 items-center gap-2 text-right font-medium text-ink">
                    <span className="truncate">{value}</span>
                    <button
                      onClick={() => setStep(stepIdx)}
                      title={`${t("describeJob.aiEditRow")}: ${label}`}
                      aria-label={`${t("describeJob.aiEditRow")}: ${label}`}
                      className="shrink-0 rounded-lg p-1.5 text-mut2 transition hover:bg-cream hover:text-accent"
                    >
                      <PenLine size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </StepShell>
        )}
      </AnimatePresence>

      <div className="mt-10 flex items-center justify-between">
        <button onClick={goBack} className="flex items-center gap-1.5 text-sm font-medium text-mut hover:text-ink">
          <ArrowLeft size={16} /> {t("common.back")}
        </button>
        {STEP_KEYS[step] === "freetext" ? (
          <Button variant="primary" onClick={handleFreeTextSubmit} disabled={parsing}>
            {parsing ? (
              <>
                <Loader2 className="animate-spin" size={16} /> {t("describeJob.parsingLabel")}
              </>
            ) : (
              <>
                {freeText.trim() ? t("describeJob.parseWithAi") : t("describeJob.continueBtn")} <ArrowRight size={16} />
              </>
            )}
          </Button>
        ) : (
          <Button variant="primary" onClick={goNext} disabled={!canNext}>
            {step === STEP_KEYS.length - 1 ? t("describeJob.findMatches") : t("describeJob.continueBtn")} <ArrowRight size={16} />
          </Button>
        )}
      </div>
    </main>
  );
}

function ScanningScreen({ form }) {
  const { t } = useTranslation();
  const messages = [
    t("describeJob.scanningMsg1"),
    t("describeJob.scanningMsg2"),
    t("describeJob.scanningMsg3"),
    t("describeJob.scanningMsg4"),
  ];
  const [msgIndex, setMsgIndex] = useState(0);
  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i = Math.min(i + 1, messages.length - 1);
      setMsgIndex(i);
    }, 400);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-[calc(100vh-72px)] flex-col items-center justify-center px-6 text-center">
      <div className="relative flex h-40 w-40 items-center justify-center">
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-accent/30"
          animate={{ scale: [1, 1.4], opacity: [0.6, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-sage/30"
          animate={{ scale: [1, 1.7], opacity: [0.5, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut", delay: 0.5 }}
        />
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
          className="flex h-20 w-20 items-center justify-center rounded-full bg-accent-soft text-accent"
        >
          <Radar size={32} />
        </motion.div>
      </div>
      <h2 className="mt-8 font-display text-xl font-semibold text-ink">{t("describeJob.scanningTitle")}</h2>
      <p className="mt-2 font-mono text-sm text-sage">{messages[msgIndex]}</p>
      <p className="mt-6 max-w-xs text-xs text-mut2">
        {form.land} {t("describeJob.acres")} · {form.location || t("describeJob.yourArea")}
      </p>
    </main>
  );
}
