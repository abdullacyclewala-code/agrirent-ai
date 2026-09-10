import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Crosshair, Loader2 } from "lucide-react";
import { getBrowserLocation, parseCoordinate } from "../../lib/geo.js";

// Free pin-on-map picker (react-leaflet + OpenStreetMap tiles, no API key).
// Controlled: value is { lat, lng } | null.

const INDIA_CENTER = [22.0, 79.0];

const pinIcon = L.divIcon({
  className: "agrirent-pin",
  html: `<span style="display:block;width:22px;height:22px;border-radius:9999px;background:#A8431F;border:3px solid #FFF7EA;box-shadow:0 1px 6px rgba(0,0,0,.45)"></span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

function ClickSetter({ onPick }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

function FlyToValue({ value }) {
  const map = useMap();
  useEffect(() => {
    if (value) map.flyTo([value.lat, value.lng], Math.max(map.getZoom(), 12), { duration: 0.8 });
  }, [value, map]);
  return null;
}

export default function LocationPicker({ value, onChange, disabled = false }) {
  const { t } = useTranslation();
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState(null);
  const [manual, setManual] = useState({ lat: "", lng: "" });

  // Keep the manual boxes in sync when the pin moves via map/geolocate.
  useEffect(() => {
    setManual({
      lat: value ? String(Number(value.lat.toFixed(6))) : "",
      lng: value ? String(Number(value.lng.toFixed(6))) : "",
    });
  }, [value]);

  const center = useMemo(
    () => (value ? [value.lat, value.lng] : INDIA_CENTER),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value == null]
  );

  const useMyLocation = async () => {
    if (locating || disabled) return;
    setLocating(true);
    setGeoError(null);
    try {
      const { lat, lng } = await getBrowserLocation();
      onChange({ lat, lng });
    } catch (err) {
      const code = err?.code || "unavailable";
      setGeoError(
        code === "denied"
          ? t("addEquipment.locationErrorDenied")
          : code === "timeout"
            ? t("addEquipment.locationErrorTimeout")
            : code === "unsupported"
              ? t("addEquipment.locationErrorUnsupported")
              : t("addEquipment.locationErrorUnavailable")
      );
    } finally {
      setLocating(false);
    }
  };

  const applyManual = () => {
    const lat = parseCoordinate(manual.lat, -90, 90);
    const lng = parseCoordinate(manual.lng, -180, 180);
    if (lat == null || lng == null) {
      setGeoError(t("addEquipment.locationErrorInvalid"));
      return;
    }
    setGeoError(null);
    onChange({ lat, lng });
  };

  return (
    <div>
      {/* z-0 stacking context: leaflet's internal panes (z-index ≤ 1000) must
          stay under the sticky navbar / bottom nav. */}
      <div className="relative z-0 overflow-hidden rounded-xl border border-line">
        <MapContainer
          center={center}
          zoom={value ? 13 : 5}
          scrollWheelZoom={false}
          className="h-64 w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {!disabled && <ClickSetter onPick={onChange} />}
          <FlyToValue value={value} />
          {value && (
            <Marker
              position={[value.lat, value.lng]}
              icon={pinIcon}
              draggable={!disabled}
              eventHandlers={
                disabled ? {} : { dragend: (e) => {
                  const p = e.target.getLatLng();
                  onChange({ lat: p.lat, lng: p.lng });
                } }
              }
            />
          )}
        </MapContainer>
      </div>
      <p className="mt-2 text-xs text-mut2">{t("addEquipment.tapMapHint")}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={useMyLocation}
          disabled={disabled || locating}
          className="flex items-center gap-2 rounded-xl border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
        >
          {locating ? <Loader2 size={15} className="animate-spin" /> : <Crosshair size={15} />}
          {locating ? t("addEquipment.locating") : t("addEquipment.useMyLocation")}
        </button>
        {value && (
          <span className="rounded-full bg-sage-soft px-3 py-1.5 font-mono text-xs text-sage">
            {value.lat.toFixed(4)}, {value.lng.toFixed(4)}
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-mut">{t("addEquipment.latLabel")}</span>
          <input
            inputMode="decimal"
            value={manual.lat}
            disabled={disabled}
            onChange={(e) => setManual((m) => ({ ...m, lat: e.target.value }))}
            placeholder="19.0760"
            className="w-full rounded-xl border border-line bg-card px-3 py-2.5 font-mono text-sm text-ink placeholder:text-mut2 focus:border-accent disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-mut">{t("addEquipment.lngLabel")}</span>
          <input
            inputMode="decimal"
            value={manual.lng}
            disabled={disabled}
            onChange={(e) => setManual((m) => ({ ...m, lng: e.target.value }))}
            placeholder="72.8777"
            className="w-full rounded-xl border border-line bg-card px-3 py-2.5 font-mono text-sm text-ink placeholder:text-mut2 focus:border-accent disabled:opacity-60"
          />
        </label>
        <button
          type="button"
          onClick={applyManual}
          disabled={disabled}
          className="rounded-xl bg-line-2 px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-line disabled:opacity-60"
        >
          {t("addEquipment.setCoordinates")}
        </button>
      </div>

      {geoError && <p className="mt-2 text-xs text-accent">{geoError}</p>}
    </div>
  );
}
