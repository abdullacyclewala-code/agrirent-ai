import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
        setError("Couldn't load this listing. It may have been deleted.");
      } else if (data.owner_id !== user?.id) {
        setError("You can only edit your own listings.");
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
      setError(err.message || "Couldn't save this listing. Try again.");
      return;
    }
    navigate("/profile");
  };

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-paper/50">Loading…</div>;
  }

  return (
    <main className="mx-auto min-h-[calc(100vh-72px)] max-w-2xl px-5 py-10 md:px-8 md:py-16">
      <button onClick={() => navigate(-1)} className="mb-6 flex items-center gap-1.5 text-sm text-paper/50 hover:text-paper">
        <ArrowLeft size={16} /> Back
      </button>

      <h1 className="font-display text-2xl font-bold text-paper sm:text-3xl">
        {isEdit ? "Edit listing" : "List your equipment"}
      </h1>
      <p className="mt-2 text-sm text-paper/55">Farmers will find this using their crop, operation and land size.</p>

      {error && (
        <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-8 space-y-7">
        <Field label="Equipment name">
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Mahindra 575 DI Tractor"
            className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper placeholder:text-paper/30 focus:border-wheat"
          />
        </Field>

        <Field label="Equipment type">
          <div className="flex flex-wrap gap-2">
            {taxonomy.equipment_types.map((t) => (
              <Chip key={t.id} active={form.equipment_type === t.id} onClick={() => set("equipment_type", t.id)}>
                {t.label}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Operations it performs" hint="Select all that apply — used to match farmer requests.">
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

        <Field label="Crops it's suited for" hint="Leave empty if it works for any crop.">
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
          <Field label="Horsepower (HP)">
            <input
              type="number"
              min="0"
              value={form.hp}
              onChange={(e) => set("hp", e.target.value)}
              placeholder="e.g. 45"
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper placeholder:text-paper/30 focus:border-wheat"
            />
          </Field>
          <Field label="Service radius (km)">
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
          <Field label="Price">
            <input
              type="number"
              min="0"
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              placeholder="e.g. 850"
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper placeholder:text-paper/30 focus:border-wheat"
            />
          </Field>
          <Field label="Per">
            <div className="flex gap-2">
              {["hour", "day", "acre"].map((u) => (
                <Chip key={u} active={form.price_unit === u} onClick={() => set("price_unit", u)}>
                  {u}
                </Chip>
              ))}
            </div>
          </Field>
        </div>

        <Field label="Location" hint="Village or area name — shown to farmers.">
          <input
            value={form.location_label}
            onChange={(e) => set("location_label", e.target.value)}
            placeholder="e.g. Khanna, Ludhiana"
            className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-paper placeholder:text-paper/30 focus:border-wheat"
          />
        </Field>

        {isEdit && (
          <Field label="Availability">
            <div className="flex gap-2">
              <Chip active={form.is_available} onClick={() => set("is_available", true)}>Available</Chip>
              <Chip active={!form.is_available} onClick={() => set("is_available", false)}>Paused</Chip>
            </div>
          </Field>
        )}
      </div>

      <Button variant="primary" className="mt-10 w-full" onClick={save} disabled={!canSave || saving}>
        {saving ? "Saving…" : isEdit ? "Save changes" : "Publish listing"}
      </Button>
      {!canSave && (
        <p className="mt-3 text-center text-xs text-paper/40">
          Name, equipment type, price and at least one operation are required.
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
