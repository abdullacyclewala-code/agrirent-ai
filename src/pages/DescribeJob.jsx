import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, MapPin, Radar, Check, LocateFixed, Sparkles, Loader2, PenLine } from "lucide-react";
import taxonomy from "../data/taxonomy.json";
import { Button, Chip } from "../components/ui/Primitives.jsx";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { runRulesFilter } from "../lib/rulesFilter.js";
import { parseRequirementFreeText } from "../lib/llmClient.js";

const crops = taxonomy.crops;
const operations = taxonomy.operations;

// Phase 3: "freetext" is a new first step — describe the job in your own words
// and the LLM (via backend) pre-fills crop/operation/land. If it's skipped, or
// the LLM path is unavailable, the rest of the wizard (Phase 2, unchanged)
// still works exactly as before — §4.5 "must always work independently of LLM uptime".
const STEP_KEYS = ["freetext", "crop", "operation", "land", "location", "date", "review"];

function StepShell({ title, sub, children }) {
  return (
    <motion.div
      key={title}
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <h2 className="font-display text-2xl font-semibold text-paper sm:text-3xl">{title}</h2>
      {sub && <p className="mt-2 text-sm text-paper/55">{sub}</p>}
      <div className="mt-8">{children}</div>
    </motion.div>
  );
}

export default function DescribeJob() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [freeText, setFreeText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseNotice, setParseNotice] = useState(null); // { ok: bool, message: string }
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
  const goBack = () => (step > 0 ? setStep(step - 1) : navigate("/"));

  // Phase 3: LLM free-text parse (§6.1). Always falls through to the manual
  // wizard on any failure — see llmClient.js and §4.5.
  const handleFreeTextSubmit = async () => {
    if (!freeText.trim()) {
      setStep(1); // nothing typed — just go to manual crop step
      return;
    }
    setParsing(true);
    setParseNotice(null);
    const result = await parseRequirementFreeText(freeText.trim(), "auto");
    setParsing(false);

    if (!result) {
      setParseNotice({
        ok: false,
        message: "Couldn't reach the AI parser right now — no problem, just fill in the steps below.",
      });
      setStep(1);
      return;
    }

    const cropValid = result.crop && crops.some((c) => c.id === result.crop);
    const opValid = result.operation && operations.some((o) => o.id === result.operation);

    setForm((f) => ({
      ...f,
      crop: cropValid ? result.crop : f.crop,
      operation: opValid ? result.operation : f.operation,
      land: result.area_acres && result.area_acres > 0 ? result.area_acres : f.land,
      llmProviderUsed: result.provider_used,
    }));

    setParseNotice({
      ok: true,
      message: opValid
        ? "Got it — pre-filled below from your description. Check each step and adjust anything that's off."
        : "Understood most of it — please confirm the operation below.",
    });
    setStep(1);
  };

  const submit = async () => {
    setSubmitError(null);
    localStorage.setItem("kisan_job", JSON.stringify(form));
    setScanning(true);

    const cropLabel = crops.find((c) => c.id === form.crop)?.label || form.crop;
    const opLabel = operations.find((o) => o.id === form.operation)?.label || form.operation;
    const parsed_json = {
      crop: form.crop,
      area_acres: form.land,
      operation: form.operation,
    };
    // If the farmer used the Phase 3 free-text step, keep their original wording as
    // raw_text (more useful for future retraining / review) — otherwise synthesize it.
    const raw_text = (
      freeText.trim() ||
      `${opLabel} for ${form.land} acres of ${cropLabel} near ${form.location}, needed ${form.date}. ${form.notes || ""}`
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

      // 2. Fetch equipment + run the rules-engine hard filter (§6.3)
      const { data: equipmentRows, error: eqErr } = await supabase
        .from("equipment")
        .select("*, users:owner_id ( name )");
      if (eqErr) throw eqErr;

      const normalized = (equipmentRows || []).map((row) => ({
        ...row,
        owner_name: row.users?.name || "Owner",
      }));

      const { results, relaxedHp } = runRulesFilter(normalized, parsed_json, user?.id);

      sessionStorage.setItem(
        "kisan_matches",
        JSON.stringify({ requirementId, requirement: { ...form, parsed_json }, results, relaxedHp })
      );

      setTimeout(() => navigate("/recommendations"), 1800);
    } catch (err) {
      setScanning(false);
      setSubmitError(err.message || "Something went wrong finding matches. Please try again.");
    }
  };

  if (scanning) return <ScanningScreen form={form} />;

  return (
    <main className="mx-auto min-h-[calc(100vh-72px)] max-w-3xl px-5 py-10 md:px-8 md:py-16">
      {/* progress */}
      <div className="mb-10 flex items-center gap-2">
        {STEP_KEYS.map((k, i) => (
          <div key={k} className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
            <motion.div
              className="h-full bg-wheat"
              initial={false}
              animate={{ width: i <= step ? "100%" : "0%" }}
              transition={{ duration: 0.4 }}
            />
          </div>
        ))}
      </div>

      {submitError && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {submitError}
        </div>
      )}

      <AnimatePresence mode="wait">
        {STEP_KEYS[step] === "freetext" && (
          <StepShell
            key="freetext"
            title="Describe your job, in your own words"
            sub="English, Hindi, Marathi, or mixed — however you'd normally say it. Or skip and fill it in step by step."
          >
            <div className="relative">
              <Sparkles className="pointer-events-none absolute left-4 top-4 text-wheat/60" size={18} />
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="e.g. Mujhe 5 acre kapas ki jotai karni hai agle hafte…"
                rows={4}
                disabled={parsing}
                className="w-full resize-none rounded-xl border border-white/10 bg-white/[0.03] py-4 pl-11 pr-4 text-paper placeholder:text-paper/30 focus:border-wheat disabled:opacity-50"
              />
            </div>

            {parseNotice && (
              <div
                className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
                  parseNotice.ok
                    ? "border-moss-light/30 bg-moss-light/10 text-moss-light"
                    : "border-white/10 bg-white/[0.03] text-paper/60"
                }`}
              >
                {parseNotice.message}
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={handleFreeTextSubmit} disabled={parsing}>
                {parsing ? (
                  <>
                    <Loader2 className="animate-spin" size={16} /> Understanding your job…
                  </>
                ) : (
                  <>
                    <Sparkles size={16} /> {freeText.trim() ? "Parse with AI" : "Continue"}
                  </>
                )}
              </Button>
              <button
                onClick={() => setStep(1)}
                disabled={parsing}
                className="flex items-center gap-1.5 text-sm font-medium text-paper/50 hover:text-paper disabled:opacity-40"
              >
                <PenLine size={14} /> Skip, I'll fill it in manually
              </button>
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "crop" && (
          <StepShell key="crop" title="What are you growing?" sub="This helps us match equipment built for your crop.">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {crops.map((c) => (
                <button
                  key={c.id}
                  onClick={() => set("crop", c.id)}
                  className={`flex flex-col items-center gap-2 rounded-2xl border p-5 transition-all ${
                    form.crop === c.id
                      ? "border-wheat bg-wheat/10 shadow-[0_0_0_4px_rgba(232,179,74,0.12)]"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25"
                  }`}
                >
                  <span className="text-3xl">{c.icon}</span>
                  <span className="text-sm font-medium text-paper">{c.label}</span>
                </button>
              ))}
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "operation" && (
          <StepShell key="operation" title="What's the job?" sub="Choose the operation you need done.">
            <div className="flex flex-col gap-3">
              {operations.map((op) => (
                <button
                  key={op.id}
                  onClick={() => set("operation", op.id)}
                  className={`flex items-center justify-between rounded-2xl border p-5 text-left transition-all ${
                    form.operation === op.id
                      ? "border-wheat bg-wheat/10"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25"
                  }`}
                >
                  <div>
                    <div className="font-medium text-paper">{op.label}</div>
                    <div className="mt-0.5 text-xs text-paper/50">{op.desc}</div>
                  </div>
                  {form.operation === op.id && (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-wheat text-ink">
                      <Check size={14} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "land" && (
          <StepShell key="land" title="How much land?" sub="Drag to set the area for this job.">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
              <div className="font-display text-6xl font-bold text-wheat">
                {form.land}
                <span className="ml-2 text-2xl text-paper/50">acres</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="30"
                step="0.5"
                value={form.land}
                onChange={(e) => set("land", parseFloat(e.target.value))}
                className="mt-8 w-full accent-[#e8b34a]"
              />
              <div className="mt-2 flex justify-between font-mono text-xs text-paper/40">
                <span>0.5</span>
                <span>30 acres</span>
              </div>
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "location" && (
          <StepShell key="location" title="Where's the field?" sub="Enter your village or let us use your current location.">
            <div className="relative">
              <MapPin className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-paper/40" size={18} />
              <input
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
                placeholder="Village, district — e.g. Rurka, Ludhiana"
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] py-4 pl-11 pr-4 text-paper placeholder:text-paper/30 focus:border-wheat"
              />
            </div>
            <button
              onClick={() => set("location", "Village Rurka, Ludhiana (current location)")}
              className="mt-3 flex items-center gap-2 text-sm font-medium text-sky hover:text-sky-dim"
            >
              <LocateFixed size={15} /> Use current location
            </button>
            <div className="mt-6 flex flex-wrap gap-2">
              {["Ludhiana", "Khanna", "Doraha", "Sahnewal"].map((d) => (
                <Chip key={d} active={form.location.includes(d)} onClick={() => set("location", `${d}, Punjab`)}>
                  {d}
                </Chip>
              ))}
            </div>
          </StepShell>
        )}

        {STEP_KEYS[step] === "date" && (
          <StepShell key="date" title="When do you need it?" sub="Pick the date you'd like the work to start.">
            <input
              type="date"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-4 text-paper focus:border-wheat [color-scheme:dark]"
            />
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Anything else the owner should know? (optional)"
              rows={3}
              className="mt-6 w-full resize-none rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-paper placeholder:text-paper/30 focus:border-wheat"
            />
          </StepShell>
        )}

        {STEP_KEYS[step] === "review" && (
          <StepShell key="review" title="Review your job" sub="We'll match this against nearby equipment.">
            {form.llmProviderUsed && (
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-wheat/20 bg-wheat/5 px-4 py-2.5 text-xs text-wheat">
                <Sparkles size={13} /> Pre-filled from your description ({form.llmProviderUsed}) — double-check before continuing.
              </div>
            )}
            <div className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.03]">
              {[
                ["Crop", crops.find((c) => c.id === form.crop)?.label],
                ["Operation", operations.find((o) => o.id === form.operation)?.label],
                ["Land size", `${form.land} acres`],
                ["Location", form.location || "—"],
                ["Date", form.date || "—"],
                ["Notes", form.notes || "None"],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between px-5 py-4 text-sm">
                  <span className="text-paper/50">{label}</span>
                  <span className="font-medium text-paper">{value}</span>
                </div>
              ))}
            </div>
          </StepShell>
        )}
      </AnimatePresence>

      <div className="mt-10 flex items-center justify-between">
        <button onClick={goBack} className="flex items-center gap-1.5 text-sm font-medium text-paper/60 hover:text-paper">
          <ArrowLeft size={16} /> Back
        </button>
        <Button variant="primary" onClick={goNext} disabled={!canNext}>
          {step === STEP_KEYS.length - 1 ? "Find matches" : "Continue"} <ArrowRight size={16} />
        </Button>
      </div>
    </main>
  );
}

function ScanningScreen({ form }) {
  const messages = [
    "Reading your job details…",
    "Scanning equipment within range…",
    "Checking crop & operation fit…",
    "Ranking by fit and price…",
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
          className="absolute inset-0 rounded-full border-2 border-wheat/30"
          animate={{ scale: [1, 1.4], opacity: [0.6, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-sky/30"
          animate={{ scale: [1, 1.7], opacity: [0.5, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut", delay: 0.5 }}
        />
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
          className="flex h-20 w-20 items-center justify-center rounded-full bg-wheat/15 text-wheat"
        >
          <Radar size={32} />
        </motion.div>
      </div>
      <h2 className="mt-8 font-display text-xl font-semibold text-paper">Finding your matches</h2>
      <p className="mt-2 font-mono text-sm text-moss-light">{messages[msgIndex]}</p>
      <p className="mt-6 max-w-xs text-xs text-paper/40">
        {form.land} acres · {form.location || "your area"}
      </p>
    </main>
  );
}
