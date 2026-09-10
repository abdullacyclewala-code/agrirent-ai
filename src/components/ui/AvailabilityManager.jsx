import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, Plus, Trash2 } from "lucide-react";
import { supabase } from "../../lib/supabase.js";
import {
  fetchSlots,
  addOfferedSlot,
  removeOfferedSlot,
  validateOfferedRange,
  formatSlotRange,
  todayLocal,
} from "../../lib/availability.js";
import { Button, Chip } from "./Primitives.jsx";

const inputCls =
  "w-full rounded-xl border border-line bg-card px-4 py-3 text-ink focus:border-accent [color-scheme:light]";

/**
 * Owner-side availability calendar: list offered windows + booking locks,
 * add new windows, remove offered ones. Rendered inside AddEquipment's edit
 * mode (`equipmentId` is the saved listing id).
 */
export default function AvailabilityManager({ equipmentId }) {
  const { t } = useTranslation();
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [formError, setFormError] = useState("");
  const [rowError, setRowError] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const rows = await fetchSlots(supabase, equipmentId);
        if (!cancelled) setSlots(rows);
      } catch (err) {
        console.error("load availability slots:", err);
        if (!cancelled) setLoadError(t("addEquipment.slotLoadError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [equipmentId, t]);

  const handleAdd = async () => {
    const invalid = validateOfferedRange(start, end, todayLocal(), t);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setFormError("");
    setSaving(true);
    try {
      const row = await addOfferedSlot(supabase, equipmentId, start, end);
      setSlots((prev) => [...prev, row].sort((a, b) => a.start_date.localeCompare(b.start_date)));
      setStart("");
      setEnd("");
    } catch (err) {
      console.error("add availability slot:", err);
      setFormError(t("addEquipment.slotSaveError"));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id) => {
    setRowError("");
    setRemovingId(id);
    try {
      await removeOfferedSlot(supabase, id);
      setSlots((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      console.error("remove availability slot:", err);
      setRowError(t("addEquipment.slotRemoveError"));
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return <p className="text-sm text-mut2">{t("common.loading")}</p>;
  }

  if (loadError) {
    return <p className="text-sm text-accent">{loadError}</p>;
  }

  return (
    <div>
      {slots.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-mut2">
          <CalendarDays className="h-4 w-4" aria-hidden />
          {t("addEquipment.slotNone")}
        </p>
      ) : (
        <ul className="space-y-2">
          {slots.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-4 py-2.5"
            >
              <span className="text-sm font-medium text-ink">
                {formatSlotRange(s.start_date, s.end_date)}
              </span>
              <span className="flex items-center gap-2">
                <Chip selected={s.is_booked}>
                  {s.is_booked ? t("addEquipment.slotBooked") : t("addEquipment.slotOffered")}
                </Chip>
                {!s.is_booked && (
                  <button
                    type="button"
                    onClick={() => handleRemove(s.id)}
                    disabled={removingId === s.id}
                    title={t("addEquipment.slotRemove")}
                    aria-label={`${t("addEquipment.slotRemove")}: ${formatSlotRange(s.start_date, s.end_date)}`}
                    className="rounded-lg p-1.5 text-mut2 transition hover:bg-cream hover:text-accent disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {rowError && <p className="mt-2 text-sm text-accent">{rowError}</p>}

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-mut2">
            {t("addEquipment.slotStart")}
          </label>
          <input
            type="date"
            value={start}
            min={todayLocal()}
            onChange={(e) => setStart(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-mut2">
            {t("addEquipment.slotEnd")}
          </label>
          <input
            type="date"
            value={end}
            min={start || todayLocal()}
            onChange={(e) => setEnd(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>

      {formError && <p className="mt-2 text-sm text-accent">{formError}</p>}

      <Button type="button" variant="secondary" onClick={handleAdd} disabled={saving} className="mt-3">
        <Plus className="h-4 w-4" aria-hidden />
        {saving ? t("addEquipment.saving") : t("addEquipment.slotAdd")}
      </Button>
    </div>
  );
}
