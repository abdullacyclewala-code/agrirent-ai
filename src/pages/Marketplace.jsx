import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Search, MapPin, SlidersHorizontal, Crosshair, X, Loader2, Store, ArrowRight,
} from "lucide-react";
import { Button, Chip, Badge, Reveal } from "../components/ui/Primitives.jsx";
import { EquipmentPhoto } from "../components/ui/EquipmentPhoto.jsx";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { equipmentTypeLabel, priceUnitLabel, EQUIPMENT_TYPE_IDS } from "../lib/equipmentDisplay.js";
import { isValidLatLng, getBrowserLocation, formatDistance, RADIUS_OPTIONS_KM, DEFAULT_SEARCH_RADIUS_KM } from "../lib/geo.js";

/**
 * Marketplace — "what's near me, and what does it cost?"
 *
 * The wizard (`/describe-job`) answers "which machine should I hire for THIS
 * job?" and needs six steps to do it. This is the other half of the app: a
 * browse-and-filter list for the person who already knows what they want, or
 * who just wants to see what is available around them before committing to a
 * search.
 *
 * Two deliberate decisions:
 *  1. It reuses the location already saved on the profile (the wizard stores it)
 *     so browsing does not open with a permission prompt. A prompt appears only
 *     when someone actually presses "Show near me".
 *  2. Distance filtering is the PostGIS `nearby_equipment` RPC, the same one the
 *     wizard uses, so "nearby" means the same thing in both places — including
 *     each owner's own `service_area_radius_km`. Listings whose owner has not
 *     pinned a location are still shown, with distance unknown, rather than
 *     being hidden from the marketplace.
 */
export default function Marketplace() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [rows, setRows] = useState(null);              // null = loading
  const [coords, setCoords] = useState(null);          // { lat, lng } when known
  const [locationNote, setLocationNote] = useState(null); // 'profile' | 'live' | 'denied' | null
  const [radiusKm, setRadiusKm] = useState(DEFAULT_SEARCH_RADIUS_KM);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState(null);

  // filters
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [availableOnly, setAvailableOnly] = useState(true);
  const [sort, setSort] = useState("distance");
  const [filtersOpen, setFiltersOpen] = useState(false);

  // ---------------------------------------------------------------- location
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!user) return;
      const { data } = await supabase
        .from("users")
        .select("latitude, longitude, location_label")
        .eq("id", user.id)
        .maybeSingle();
      if (!alive || !data) return;
      if (isValidLatLng(data.latitude, data.longitude)) {
        setCoords({ lat: data.latitude, lng: data.longitude });
        setLocationNote("profile");
      }
    })();
    return () => { alive = false; };
  }, [user]);

  const useLiveLocation = async () => {
    setLocating(true);
    setError(null);
    try {
      const { lat, lng } = await getBrowserLocation();
      setCoords({ lat, lng });
      setLocationNote("live");
      // Remember it on the profile, exactly as the wizard does, so the next
      // visit is instant and the two features agree about where "here" is.
      if (user) {
        supabase.from("users").update({ latitude: lat, longitude: lng }).eq("id", user.id)
          .then(() => {}, () => {});
      }
    } catch {
      // Denied, timed out, or unsupported — all the same to the user: keep
      // browsing without distance, and say so plainly.
      setLocationNote("denied");
      setError(t("marketplace.locationFailed"));
    } finally {
      setLocating(false);
    }
  };

  // ------------------------------------------------------------------ fetch
  useEffect(() => {
    let alive = true;
    (async () => {
      setRows(null);
      try {
        if (coords) {
          const { data: nearby, error: rpcErr } = await supabase.rpc("nearby_equipment", {
            p_lat: coords.lat,
            p_lng: coords.lng,
            p_radius_km: radiusKm,
          });
          if (rpcErr) throw rpcErr;
          // Owners who haven't pinned a location can't be distance-checked.
          // Show them (distance unknown) instead of pretending they don't exist.
          const { data: unlocated } = await supabase
            .from("equipment")
            .select("*, users:owner_id ( name )")
            .is("location", null);
          const merged = [
            ...(nearby || []),
            ...(unlocated || []).map((r) => ({ ...r, distance_km: null })),
          ];
          if (alive) setRows(merged);
        } else {
          const { data, error: listErr } = await supabase
            .from("equipment")
            .select("*, users:owner_id ( name )");
          if (listErr) throw listErr;
          if (alive) setRows((data || []).map((r) => ({ ...r, distance_km: null })));
        }
      } catch (err) {
        console.warn("[marketplace] load failed:", err?.message);
        if (alive) {
          setError(t("marketplace.loadFailed"));
          setRows([]);
        }
      }
    })();
    return () => { alive = false; };
  }, [coords, radiusKm, t]);

  // ----------------------------------------------------------------- filter
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const budget = Number(maxPrice);
    const list = (rows || []).filter((r) => {
      if (availableOnly && !r.is_available) return false;
      if (type && r.equipment_type !== type) return false;
      if (maxPrice && Number.isFinite(budget) && budget > 0 && Number(r.price) > budget) return false;
      if (coords && r.distance_km != null && Number(r.distance_km) > radiusKm) return false;
      if (needle) {
        const hay = [
          r.name,
          r.location_label,
          equipmentTypeLabel(r.equipment_type),
          r.owner_name || r.users?.name,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const sorted = [...list];
    if (sort === "distance") {
      sorted.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
    } else if (sort === "priceAsc") {
      sorted.sort((a, b) => Number(a.price) - Number(b.price));
    } else if (sort === "priceDesc") {
      sorted.sort((a, b) => Number(b.price) - Number(a.price));
    }
    return sorted;
  }, [rows, q, type, maxPrice, availableOnly, sort, coords, radiusKm]);

  const hasDistances = (rows || []).some((r) => r.distance_km != null);
  const anyFilter = !!(q || type || maxPrice || !availableOnly);
  const clearAll = () => { setQ(""); setType(""); setMaxPrice(""); setAvailableOnly(true); setSort("distance"); };

  return (
    <main className="mx-auto max-w-6xl px-5 pb-28 pt-6 md:px-8 md:pb-16 md:pt-10">
      {/* header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-sage">
            <Store size={13} /> {t("marketplace.eyebrow")}
          </span>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink md:text-3xl">{t("marketplace.title")}</h1>
          <p className="mt-1 text-sm text-mut">{t("marketplace.subtitle")}</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {coords ? (
            <span className="flex items-center gap-1.5 text-xs text-sage">
              <Crosshair size={12} />
              {locationNote === "live" ? t("marketplace.usingLiveLocation") : t("marketplace.usingSavedLocation")}
            </span>
          ) : (
            <Button variant="outline" className="!py-2 text-xs" onClick={useLiveLocation} disabled={locating}>
              {locating ? <Loader2 size={13} className="animate-spin" /> : <Crosshair size={13} />}
              {t("marketplace.useMyLocation")}
            </Button>
          )}
          {rows && (
            <span className="text-xs text-mut2">
              {t("marketplace.showingCount", { shown: filtered.length, total: rows.length })}
            </span>
          )}
        </div>
      </div>

      {/* search + filters */}
      <div className="mb-5 rounded-3xl border border-line bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-[220px] flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-mut2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("marketplace.searchPlaceholder")}
              className="w-full rounded-xl border border-line bg-paper py-2.5 pl-9 pr-3 text-sm text-ink outline-none focus:border-accent"
            />
            {q && (
              <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-mut2 hover:text-ink">
                <X size={13} />
              </button>
            )}
          </label>
          <Button variant="ghost" className="!py-2.5 text-sm" onClick={() => setFiltersOpen((v) => !v)}>
            <SlidersHorizontal size={14} /> {t("marketplace.filters")}
          </Button>
          {anyFilter && (
            <Button variant="ghost" className="!py-2.5 text-sm" onClick={clearAll}>
              <X size={13} /> {t("marketplace.clearFilters")}
            </Button>
          )}
        </div>

        {filtersOpen && (
          <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-mut">{t("marketplace.filterType")}</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="">{t("marketplace.anyType")}</option>
                {EQUIPMENT_TYPE_IDS.map((tp) => (
                  <option key={tp} value={tp}>{equipmentTypeLabel(tp)}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-mut">{t("marketplace.filterMaxPrice")}</span>
              <input
                type="number"
                inputMode="numeric"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                placeholder={t("marketplace.maxPricePlaceholder")}
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
              <span className="mt-1 block text-[10px] text-mut2">{t("marketplace.pricePerUnitNote")}</span>
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-mut">{t("marketplace.filterDistance")}</span>
              <select
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
                disabled={!coords}
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
              >
                {RADIUS_OPTIONS_KM.map((km) => (
                  <option key={km} value={km}>{t("marketplace.withinKm", { km })}</option>
                ))}
              </select>
              {!coords && <span className="mt-1 block text-[10px] text-mut2">{t("marketplace.distanceNeedsLocation")}</span>}
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-mut">{t("marketplace.sortBy")}</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              >
                {hasDistances && <option value="distance">{t("marketplace.sortDistance")}</option>}
                <option value="priceAsc">{t("marketplace.sortPriceAsc")}</option>
                <option value="priceDesc">{t("marketplace.sortPriceDesc")}</option>
              </select>
            </label>

            <div className="sm:col-span-2 lg:col-span-4">
              <Chip active={availableOnly} onClick={() => setAvailableOnly((v) => !v)}>
                {t("marketplace.availableOnly")}
              </Chip>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-2xl border border-gold/30 bg-gold-soft px-4 py-3 text-sm text-ink-2">{error}</p>
      )}

      {/* results */}
      {rows === null && (
        <div className="flex min-h-[30vh] items-center justify-center text-mut">
          <Loader2 className="animate-spin" />
        </div>
      )}

      {rows !== null && filtered.length === 0 && (
        <div className="rounded-3xl border border-line bg-card p-10 text-center">
          <p className="font-display text-lg font-semibold text-ink">{t("marketplace.noResults")}</p>
          <p className="mt-2 text-sm text-mut">{t("marketplace.noResultsHint")}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            {anyFilter && <Button variant="outline" onClick={clearAll}>{t("marketplace.clearFilters")}</Button>}
            <Button variant="ghost" onClick={() => setRadiusKm(RADIUS_OPTIONS_KM[RADIUS_OPTIONS_KM.length - 1])} disabled={!coords}>
              {t("marketplace.widenSearch")}
            </Button>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((r, i) => (
            <Reveal key={r.id} delay={Math.min(i * 0.03, 0.3)}>
              <Link
                to={`/equipment/${r.id}`}
                className="group flex h-full flex-col overflow-hidden rounded-3xl border border-line bg-card transition-all hover:border-accent/40"
              >
                <div className="relative h-44 overflow-hidden">
                  <EquipmentPhoto images={r.images} equipmentType={r.equipment_type} alt={r.name} className="h-full w-full" />
                  <div className="absolute left-3 top-3 flex gap-2">
                    <Badge tone={r.is_available ? "leaf" : "rust"}>
                      {r.is_available ? t("marketplace.available") : t("marketplace.paused")}
                    </Badge>
                  </div>
                  {r.distance_km != null && (
                    <span className="absolute right-3 top-3 rounded-full bg-paper/90 px-2 py-0.5 font-mono text-[10px] text-ink-2">
                      {formatDistance(Number(r.distance_km))}
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col p-4">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-sage">
                    {equipmentTypeLabel(r.equipment_type)}{r.hp ? ` · ${r.hp} HP` : ""}
                  </span>
                  <h3 className="mt-1 font-display text-base font-semibold text-ink">{r.name}</h3>
                  {r.location_label && (
                    <span className="mt-1 flex items-center gap-1 text-xs text-mut">
                      <MapPin size={11} /> {r.location_label}
                    </span>
                  )}
                  {r.owner_name || r.users?.name ? (
                    <span className="mt-0.5 text-[11px] text-mut2">
                      {t("marketplace.owner", { name: r.owner_name || r.users?.name })}
                    </span>
                  ) : null}
                  <div className="mt-auto flex items-end justify-between gap-3 border-t border-line pt-3">
                    <span className="font-mono text-lg text-accent">
                      ₹{r.price}
                      <span className="text-xs text-mut2">/{priceUnitLabel(r.price_unit, t)}</span>
                    </span>
                    <span className="flex items-center gap-1 text-xs font-medium text-ink-2 opacity-0 transition-opacity group-hover:opacity-100">
                      {t("marketplace.view")} <ArrowRight size={13} />
                    </span>
                  </div>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      )}
    </main>
  );
}
