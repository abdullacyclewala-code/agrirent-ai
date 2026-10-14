import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ShieldAlert, ShieldX, AlertTriangle, Check, Info, MoveHorizontal } from "lucide-react";
import { FLAG_COPY, isFatalFlag } from "../../lib/depositPolicy.js";

/**
 * Small shared pieces of the trust UI.
 *
 * One rule runs through all of them: the evidence is never presented as a
 * verdict on a person. A flag explains what the app noticed and why it matters,
 * and the reader decides. That is the difference between "verified report" and
 * "lie detector", and the UI has to keep it.
 */

const VERDICT_STYLE = {
  verified: { icon: ShieldCheck, cls: "bg-sage-soft text-sage border-sage/30" },
  verified_with_flags: { icon: ShieldAlert, cls: "bg-gold-soft text-gold border-gold/30" },
  unverified: { icon: ShieldX, cls: "bg-accent-soft text-accent border-accent/30" },
};

export function VerdictPill({ verdict = "unverified", size = "md" }) {
  const { t } = useTranslation();
  const style = VERDICT_STYLE[verdict] || VERDICT_STYLE.unverified;
  const Icon = style.icon;
  const label = t(`trust.verdict_${verdict}`, verdict.replace(/_/g, " "));
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${style.cls} ${
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs"
      }`}
    >
      <Icon size={size === "sm" ? 10 : 13} />
      {label}
    </span>
  );
}

/** Every signal, in the user's language, with the failing ones first. */
export function SignalList({ flags = [], checks = [], max = 40 }) {
  const { t } = useTranslation();
  if (!flags.length && !checks.length) return null;
  const failed = checks.filter((c) => !c.pass).slice(0, max);
  const passed = checks.filter((c) => c.pass).slice(0, max);

  return (
    <div className="space-y-3">
      {flags.length > 0 && (
        <div className="rounded-2xl border border-gold/30 bg-gold-soft/60 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gold">
            <AlertTriangle size={13} /> {t("trust.flagsTitle", { count: flags.length })}
          </div>
          <ul className="space-y-1.5">
            {flags.map((flag) => (
              <li key={flag} className="flex gap-2 text-xs text-ink-2">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${isFatalFlag(flag) ? "bg-accent" : "bg-gold"}`} />
                <span>
                  {t(`trust.flag_${flag}`, FLAG_COPY[flag] || flag)}
                  {isFatalFlag(flag) && <span className="ml-1 font-semibold text-accent">{t("trust.flagSerious")}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {failed.length > 0 && (
        <details className="rounded-2xl border border-line bg-paper p-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-mut">
            {t("trust.checksFailed", { count: failed.length })}
          </summary>
          <ul className="mt-3 space-y-1.5">
            {failed.map((c, i) => (
              <li key={`${c.code}-${i}`} className="flex gap-2 text-xs text-ink-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span>
                  <span className="font-medium">{t(`trust.check_${c.code}`, c.code)}</span>
                  {c.detail ? <span className="text-mut"> — {c.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {passed.length > 0 && (
        <details className="rounded-2xl border border-line bg-paper p-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-sage">
            {t("trust.checksPassed", { count: passed.length })}
          </summary>
          <ul className="mt-3 space-y-1.5">
            {passed.map((c, i) => (
              <li key={`${c.code}-ok-${i}`} className="flex gap-2 text-xs text-mut">
                <Check size={12} className="mt-0.5 shrink-0 text-sage" />
                <span>
                  <span className="font-medium text-ink-2">{t(`trust.check_${c.code}`, c.code)}</span>
                  {c.detail ? <span> — {c.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Drag-the-divider before/after. This is the artefact a dispute actually
 *  turns on, so it gets the space. */
export function BeforeAfter({ beforeUrl, afterUrl, label }) {
  const { t } = useTranslation();
  const [pos, setPos] = useState(50);
  if (!beforeUrl || !afterUrl) return null;
  return (
    <figure className="overflow-hidden rounded-2xl border border-line bg-paper">
      <div className="relative aspect-[4/3] select-none overflow-hidden">
        <img src={afterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 overflow-hidden" style={{ width: `${pos}%` }}>
          <img src={beforeUrl} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ width: `${(100 / pos) * 100}%`, maxWidth: "none" }} />
        </div>
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${pos}%` }} />
        <div className="pointer-events-none absolute left-2 top-2 rounded-full bg-night/70 px-2 py-0.5 text-[10px] font-semibold text-white">
          {t("trust.before")}
        </div>
        <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-night/70 px-2 py-0.5 text-[10px] font-semibold text-white">
          {t("trust.after")}
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label={t("trust.compareSlider")}
          className="absolute inset-x-0 bottom-2 mx-auto w-[90%] accent-white"
        />
      </div>
      <figcaption className="flex items-center gap-2 px-3 py-2 text-[11px] text-mut">
        <MoveHorizontal size={12} /> {label}
      </figcaption>
    </figure>
  );
}

/** The "watch out" line shown before anyone files a claim. */
export function WearAndTearNote({ items = [] }) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return (
    <div className="rounded-2xl border border-line bg-paper p-4 text-xs text-mut">
      <div className="mb-1 flex items-center gap-2 font-semibold text-ink-2">
        <Info size={13} /> {t("trust.wearTitle")}
      </div>
      <p className="mb-2">{t("trust.wearSub")}</p>
      <ul className="list-inside list-disc space-y-0.5">
        {items.map((item) => (
          <li key={item.key}>{t(`trust.wear_${item.key}`, item.label)}</li>
        ))}
      </ul>
    </div>
  );
}

/** Integrity box — the thing that turns a screenshot into a record. */
export function IntegrityBox({ report, verification = null }) {
  const { t } = useTranslation();
  const intact = verification?.chain_intact;
  return (
    <div className="rounded-2xl border border-line bg-paper p-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mut">
        <ShieldCheck size={13} /> {t("trust.integrityTitle")}
      </div>
      <div className="space-y-1 font-mono text-[11px] text-ink-2">
        <div>
          <span className="text-mut">{t("trust.reportCode")}: </span>
          <span className="font-semibold">{report?.report_code || "—"}</span>
        </div>
        {report?.report_hash && (
          <div className="break-all">
            <span className="text-mut">{t("trust.reportHash")}: </span>
            {report.report_hash.slice(0, 32)}…
          </div>
        )}
        {verification && (
          <div className={intact === false ? "text-accent" : "text-sage"}>
            {intact === false ? t("trust.chainBroken") : t("trust.chainIntact", { count: verification.event_count ?? 0 })}
          </div>
        )}
      </div>
      {report?.report_code && (
        <a
          href={`/verify/${report.report_code}`}
          className="mt-3 inline-block text-xs font-semibold text-accent hover:underline"
        >
          {t("trust.openVerification")} →
        </a>
      )}
    </div>
  );
}
