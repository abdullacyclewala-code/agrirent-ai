import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import taxonomy from "../data/taxonomy.json";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button, Chip } from "../components/ui/Primitives.jsx";

const emptyForm = {
  name: "",
  equipment_type: "",
  hp: "",
  compatible_operations: [],
  compatible_crops: [],
  price: "",
  price_unit: "hour",
  location_label: "",
  service_area_radius_km: 15,
  is_available: true,
};

export default function AddEquipment() {
  const { t } = useTranslation();
  const { id } = useParams(); // present when editing
  const isEdit = !!id;
  const navigate = useNavigate();
  const { user } = useAuth();

  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isEdit) return;
    (async () => {
      const { data, error: err } = await supabase.from("equipment").select("*").eq("id", id).single();
      if (err) {
        setError(t("addEquipment.loadFailed"));
      } else if (data.owner_id !== user?.id) {
        setError(t("addEquipment.notYourListing"));
      } else {
        setForm({
          name: data.name || "",
          equipment_type: data.equipment_type || "",
          hp: data.hp ?? "",
          compatible_operations: data.compatible_operations || [],
          compatible_crops: data.compatible_crops || [],
          price: data.price ?? "",
          price_unit: data.price_unit || "hour",
          location_label: data.location_label || "",
          service_area_radius_km: data.service_area_radius_km ?? 15,
          is_available: data.is_available,
        });
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isEdit, user?.id]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleInArray = (k, val) =>
    setForm((f) => ({
      ...f,
      [k]: f[k].includes(val) ? f[k].filter((x) => x !== val) : [...f[k], val],
    }));

  const canSave =
    form.name.trim() &&
    form.equipment_type &&
    form.price !== "" &&
    form.compatible_operations.length > 0;

  const save = async () => {
    if (!canSave || !user) return;
    setSaving(true);
    setError(null);

    const payload = {
      owner_id: user.id,
      name: form.name.trim(),
      equipment_type: form.equipment_type,
      hp: form.hp === "" ? null : Number(form.hp),
      compatible_operations: form.compatible_operations,
      compatible_crops: form.compatible_crops,
      price: Number(form.price),
      price_unit: form.price_unit,
      location_label: form.location_label.trim() || null,
      service_area_radius_km: Number(form.service_area_radius_km) || 15,
      is_available: form.is_available,
    };

    const query = isEdit
      ? supabase.from("equipment").update(payload).eq("id", id)
      : supabase.from("equipment").insert(payload);

    const { error: err } = await query;
    setSaving(false);

    if (err) {
      setError(err.message || t("addEquipment.saveFailed"));
      return;
    }
    navigate("/profile");
  };

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-paper/50">{t("common.loading")}</div>;
  }

  return (
    <main className="mx-auto min-h-[calc(100vh-72px)] max-w-2xl px-5 py-10 md:px-8 md:py-16">
      <button onClick={() => navigate(-1)} className="mb-6 flex items-center gap-1.5 text-sm text-paper/50 hover:text-paper">
        <ArrowLeft size={16} /> {t("common.back")}
      </button>

      <h1 className="font-display text-2xl font-bold text-paper sm:text-3xl">
        {isEdit ? t("addEquipment.editTitle") : t("addEquipment.newTitle")}
      </h1>
      <p className="mt-2 text-sm text-paper/55">{t("addEquipment.subtitle")}</p>

      {error && (
        <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-8 space-y-7">
        <Field label={t("addEquipment.nameLabel")}>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("addEquipment.namePlaceholder")}
            className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper placeholder:text-paper/30 focus:border-wheat"
          />
        </Field>

        <Field label={t("addEquipment.typeLabel")}>
          <div className="flex flex-wrap gap-2">
            {taxonomy.equipment_types.map((t2) => (
              <Chip key={t2.id} active={form.equipment_type === t2.id} onClick={() => set("equipment_type", t2.id)}>
                {t2.label}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label={t("addEquipment.operationsLabel")} hint={t("addEquipment.operationsHint")}>
          <div className="flex flex-wrap gap-2">
            {taxonomy.operations.map((o) => (
              <Chip
                key={o.id}
                active={form.compatible_operations.includes(o.id)}
                onClick={() => toggleInArray("compatible_operations", o.id)}
              >
                {o.label}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label={t("addEquipment.cropsLabel")} hint={t("addEquipment.cropsHint")}>
          <div className="flex flex-wrap gap-2">
            {taxonomy.crops.map((c) => (
              <Chip
                key={c.id}
                active={form.compatible_crops.includes(c.id)}
                onClick={() => toggleInArray("compatible_crops", c.id)}
                icon={c.icon}
              >
                {c.label}
              </Chip>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t("addEquipment.hpLabel")}>
            <input
              type="number"
              min="0"
              value={form.hp}
              onChange={(e) => set("hp", e.target.value)}
              placeholder={t("addEquipment.hpPlaceholder")}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper placeholder:text-paper/30 focus:border-wheat"
            />
          </Field>
          <Field label={t("addEquipment.radiusLabel")}>
            <input
              type="number"
              min="1"
              value={form.service_area_radius_km}
              onChange={(e) => set("service_area_radius_km", e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper focus:border-wheat"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t("addEquipment.priceLabel")}>
            <input
              type="number"
              min="0"
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              placeholder={t("addEquipment.pricePlaceholder")}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper placeholder:text-paper/30 focus:border-wheat"
            />
          </Field>
          <Field label={t("addEquipment.perLabel")}>
            <div className="flex gap-2">
              {[
                ["hour", t("addEquipment.perHour")],
                ["day", t("addEquipment.perDay")],
                ["acre", t("addEquipment.perAcre")],
              ].map(([u, label]) => (
                <Chip key={u} active={form.price_unit === u} onClick={() => set("price_unit", u)}>
                  {label}
                </Chip>
              ))}
            </div>
          </Field>
        </div>

        <Field label={t("addEquipment.locationLabel")} hint={t("addEquipment.locationHint")}>
          <input
            value={form.location_label}
            onChange={(e) => set("location_label", e.target.value)}
            placeholder={t("addEquipment.locationPlaceholder")}
            className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper placeholder:text-paper/30 focus:border-wheat"
          />
        </Field>

        {isEdit && (
          <Field label={t("addEquipment.availabilityLabel")}>
            <div className="flex gap-2">
              <Chip active={form.is_available} onClick={() => set("is_available", true)}>{t("addEquipment.available")}</Chip>
              <Chip active={!form.is_available} onClick={() => set("is_available", false)}>{t("addEquipment.paused")}</Chip>
            </div>
          </Field>
        )}
      </div>

      <Button variant="primary" className="mt-10 w-full" onClick={save} disabled={!canSave || saving}>
        {saving ? t("addEquipment.saving") : isEdit ? t("addEquipment.saveChanges") : t("addEquipment.publishListing")}
      </Button>
      {!canSave && (
        <p className="mt-3 text-center text-xs text-paper/40">
          {t("addEquipment.requiredHint")}
        </p>
      )}
    </main>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <label className="text-sm font-medium text-paper/80">{label}</label>
        {hint && <span className="text-xs text-paper/35">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
