import { useState, useEffect, Suspense, lazy } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import taxonomy from "../data/taxonomy.json";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button, Chip } from "../components/ui/Primitives.jsx";
import PhotoPicker from "../components/ui/PhotoPicker.jsx";
import {
  uploadEquipmentPhoto,
  deleteEquipmentPhoto,
  MAX_PHOTOS_PER_LISTING,
} from "../lib/imageUpload.js";
import { isValidLatLng } from "../lib/geo.js";

// Lazy: leaflet (~150KB) only loads when an owner opens this page.
const LocationPicker = lazy(() => import("../components/ui/LocationPicker.jsx"));

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
  const [photos, setPhotos] = useState([]); // PhotoPicker items (existing + staged new)
  const [removedUrls, setRemovedUrls] = useState([]); // existing URLs to delete after a successful save
  const [coords, setCoords] = useState(null); // { lat, lng } | null
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [saveStep, setSaveStep] = useState(null); // "photos" | "listing" | null
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
        setPhotos(
          (Array.isArray(data.images) ? data.images : [])
            .filter(Boolean)
            .slice(0, MAX_PHOTOS_PER_LISTING)
            .map((url, i) => ({ key: `existing-${i}`, kind: "existing", url }))
        );
        if (isValidLatLng(data.latitude, data.longitude)) {
          setCoords({ lat: Number(data.latitude), lng: Number(data.longitude) });
        }
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

  const handlePhotosChange = (next) => {
    // Track removed existing URLs so their storage objects can be deleted —
    // but only after the listing save succeeds (never strand the DB row).
    const nextKeys = new Set(next.map((p) => p.key));
    for (const p of photos) {
      if (p.kind === "existing" && !nextKeys.has(p.key) && p.url) {
        setRemovedUrls((r) => (r.includes(p.url) ? r : [...r, p.url]));
      }
    }
    setPhotos(next);
  };

  const canSave =
    form.name.trim() &&
    form.equipment_type &&
    form.price !== "" &&
    form.compatible_operations.length > 0;

  const save = async () => {
    if (!canSave || !user || saving) return;

    const staged = photos.filter((p) => p.kind === "new");
    if (staged.some((p) => p.error)) {
      setError(t("addEquipment.photoHasErrors"));
      return;
    }
    if (staged.some((p) => p.compressing)) {
      setError(t("addEquipment.photoStillCompressing"));
      return;
    }

    setSaving(true);
    setError(null);

    // Phase 1 — upload staged photos FIRST, so the listing row is written
    // once with its final image URLs (no partial states, no second update).
    // New listings use a temp folder id; the public URL works the same and
    // deletes resolve per-URL, so the folder name is cosmetic only.
    const folderId = isEdit ? id : `pending-${crypto.randomUUID()}`;
    const uploadedPaths = [];
    const newUrls = [];
    if (staged.length > 0) {
      setSaveStep("photos");
      for (const item of staged) {
        setPhotos((prev) => prev.map((p) => (p.key === item.key ? { ...p, compressing: true } : p)));
        try {
          // eslint-disable-next-line no-await-in-loop
          const { url, path } = await uploadEquipmentPhoto(supabase, user.id, folderId, item.file);
          uploadedPaths.push(path);
          newUrls.push(url);
          setPhotos((prev) =>
            prev.map((p) =>
              p.key === item.key ? { ...p, compressing: false, error: null } : p
            )
          );
        } catch (err) {
          setPhotos((prev) =>
            prev.map((p) =>
              p.key === item.key ? { ...p, compressing: false, error: err?.message } : p
            )
          );
          setSaving(false);
          setSaveStep(null);
          setError(t("addEquipment.photoUploadFailed"));
          return; // listing untouched — user can retry (only failed items re-upload)
        }
      }
    }

    // Phase 2 — write the listing row.
    setSaveStep("listing");
    const keptExisting = photos.filter((p) => p.kind === "existing").map((p) => p.url);
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
      latitude: coords ? Number(coords.lat.toFixed(6)) : null,
      longitude: coords ? Number(coords.lng.toFixed(6)) : null,
      service_area_radius_km: Number(form.service_area_radius_km) || 15,
      images: [...keptExisting, ...newUrls].slice(0, MAX_PHOTOS_PER_LISTING),
      is_available: form.is_available,
    };

    const query = isEdit
      ? supabase.from("equipment").update(payload).eq("id", id)
      : supabase.from("equipment").insert(payload);

    const { error: err } = await query;
    setSaving(false);
    setSaveStep(null);

    if (err) {
      // Don't strand uploaded photos as orphans — best-effort cleanup.
      for (const path of uploadedPaths) {
        // eslint-disable-next-line no-await-in-loop
        await deleteEquipmentPhoto(supabase, path);
      }
      setError(err.message || t("addEquipment.saveFailed"));
      return;
    }

    // Listing saved — now it's safe to delete photos the user removed.
    for (const url of removedUrls) {
      // eslint-disable-next-line no-await-in-loop
      await deleteEquipmentPhoto(supabase, url);
    }
    navigate("/profile");
  };

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-mut">{t("common.loading")}</div>;
  }

  return (
    <main className="mx-auto min-h-[calc(100vh-72px)] max-w-2xl px-5 py-10 md:px-8 md:py-16">
      <button onClick={() => navigate(-1)} className="mb-6 flex items-center gap-1.5 text-sm text-mut hover:text-ink">
        <ArrowLeft size={16} /> {t("common.back")}
      </button>

      <h1 className="font-display text-2xl font-bold text-ink sm:text-3xl">
        {isEdit ? t("addEquipment.editTitle") : t("addEquipment.newTitle")}
      </h1>
      <p className="mt-2 text-sm text-mut">{t("addEquipment.subtitle")}</p>

      {error && (
        <div className="mt-6 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-accent">
          {error}
        </div>
      )}

      <div className="mt-8 space-y-7">
        <Field label={t("addEquipment.nameLabel")}>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("addEquipment.namePlaceholder")}
            className="w-full rounded-xl border border-line bg-card px-4 py-3 text-ink placeholder:text-mut2 focus:border-accent"
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

        <Field label={t("addEquipment.photosLabel")} hint={t("addEquipment.photosOptional")}>
          <PhotoPicker photos={photos} onChange={handlePhotosChange} disabled={saving} />
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
              className="w-full rounded-xl border border-line bg-card px-4 py-3 text-ink placeholder:text-mut2 focus:border-accent"
            />
          </Field>
          <Field label={t("addEquipment.radiusLabel")}>
            <input
              type="number"
              min="1"
              value={form.service_area_radius_km}
              onChange={(e) => set("service_area_radius_km", e.target.value)}
              className="w-full rounded-xl border border-line bg-card px-4 py-3 text-ink focus:border-accent"
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
              className="w-full rounded-xl border border-line bg-card px-4 py-3 text-ink placeholder:text-mut2 focus:border-accent"
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
            className="w-full rounded-xl border border-line bg-card px-4 py-3 text-ink placeholder:text-mut2 focus:border-accent"
          />
        </Field>

        <Field label={t("addEquipment.pinLabel")} hint={t("addEquipment.pinHint")}>
          <Suspense
            fallback={
              <div className="flex h-64 items-center justify-center rounded-xl border border-line bg-card text-sm text-mut">
                {t("common.loading")}
              </div>
            }
          >
            <LocationPicker value={coords} onChange={setCoords} disabled={saving} />
          </Suspense>
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
        {saving
          ? saveStep === "photos"
            ? t("addEquipment.uploadingPhotos")
            : t("addEquipment.saving")
          : isEdit
            ? t("addEquipment.saveChanges")
            : t("addEquipment.publishListing")}
      </Button>
      {!canSave && (
        <p className="mt-3 text-center text-xs text-mut2">
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
        <label className="text-sm font-medium text-ink-2">{label}</label>
        {hint && <span className="text-xs text-mut2">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
