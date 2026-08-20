import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, MapPin, Radar, Check, LocateFixed } from "lucide-react";
import { crops, operations } from "../data/mockData.js";
import { Button, Chip } from "../components/ui/Primitives.jsx";

const STEP_KEYS = ["crop", "operation", "land", "location", "date", "review"];

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
  const [step, setStep] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [form, setForm] = useState({
    crop: "wheat",
    operation: "harvesting",
    land: 4.5,
    location: "",
    date: "",
    notes: "",
  });

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const canNext = useMemo(() => {
    switch (STEP_KEYS[step]) {
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

  const submit = () => {
    localStorage.setItem("kisan_job", JSON.stringify(form));
    setScanning(true);
    setTimeout(() => navigate("/recommendations"), 2600);
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

      <AnimatePresence mode="wait">
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
            <div className="mt-6 flex flex-wrap gap-2">
              {["Today", "Tomorrow", "This weekend"].map((d) => (
                <Chip key={d} active={false} onClick={() => set("date", d)}>{d}</Chip>
              ))}
            </div>
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
    "Scoring soil & crop compatibility…",
    "Ranking by fit, distance & price…",
  ];
  const [msgIndex, setMsgIndex] = useState(0);
  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i = Math.min(i + 1, messages.length - 1);
      setMsgIndex(i);
    }, 620);
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
