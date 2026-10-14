import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, AlertTriangle, History } from "lucide-react";
import { Reveal } from "../ui/Primitives.jsx";
import { getEquipmentReportCount, getKnownDamage } from "../../lib/reportDb.js";

/**
 * EquipmentCondition — "has this machine been through the process before?"
 *
 * Shown on the equipment page, before anyone books. Two things make it worth
 * the query: it tells the renter that signed condition reports are normal here
 * (so they don't skip theirs), and it shows damage already on record, which is
 * the single best promise this app can make — you will not be charged for that.
 *
 * Renders nothing at all when the machine has no history and no recorded
 * damage, so a first-time listing isn't labelled "never verified".
 */
export default function EquipmentCondition({ equipmentId }) {
  const { t } = useTranslation();
  const [count, setCount] = useState(null);
  const [damage, setDamage] = useState([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [reports, entries] = await Promise.all([
          getEquipmentReportCount(equipmentId),
          getKnownDamage(equipmentId),
        ]);
        if (!alive) return;
        setCount(reports);
        setDamage(entries.filter((d) => d.status !== "resolved" && d.status !== "written_off"));
      } catch {
        if (alive) setCount(null); // history is a bonus, never a blocker
      }
    })();
    return () => {
      alive = false;
    };
  }, [equipmentId]);

  if (count === null) return null;
  if (count === 0 && damage.length === 0) return null;

  return (
    <Reveal delay={0.05} className="mt-10">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-ink">
        <History size={17} /> {t("trust.historyTitle")}
      </h2>
      <div className="mt-4 space-y-3">
        {count > 0 && (
          <p className="flex items-center gap-2 rounded-2xl border border-sage/30 bg-sage-soft px-4 py-3 text-sm text-ink-2">
            <ShieldCheck size={15} className="shrink-0 text-sage" />
            {t("trust.historyVerifiedCount", { count })}
          </p>
        )}
        {damage.length > 0 && (
          <div className="rounded-2xl border border-line bg-card p-4">
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gold">
              <AlertTriangle size={13} /> {t("trust.knownDamageTitle")}
            </p>
            <ul className="space-y-1 text-xs text-ink-2">
              {damage.slice(0, 6).map((d) => (
                <li key={d.id}>
                  <b>{d.part}</b> — {t(`trust.damage_${d.kind}`, d.kind)}
                  {d.severity ? ` · ${t(`trust.severity_${d.severity}`, d.severity)}` : ""}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-mut2">{t("trust.knownDamageNote")}</p>
          </div>
        )}
      </div>
    </Reveal>
  );
}
