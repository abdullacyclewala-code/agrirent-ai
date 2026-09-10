import i18n from "../i18n/index.js";
import taxonomy from "../data/taxonomy.json";

// Localized display helpers for taxonomy + DB-driven values.
//
// Taxonomy labels live in taxonomy.json as label/label_hi/label_mr (same for
// operation descs). These helpers pick by the CURRENT i18n language, so any
// component that renders them MUST also call useTranslation() — that hook
// subscribes to language changes and re-renders, which is what makes the
// labels actually switch. (A component that never calls useTranslation won't
// re-render on language switch and will show stale labels.)
//
// Statuses and price units come back from the DB as canonical English ids
// ("Confirmed", "hour") — they are translated at render time via the t()
// passed in, never stored translated.

export function currentLang() {
  return (i18n.language || "en").split("-")[0];
}

function pick(entry, fallback) {
  if (!entry) return fallback;
  const l = currentLang();
  if (l === "hi" && entry.label_hi) return entry.label_hi;
  if (l === "mr" && entry.label_mr) return entry.label_mr;
  return entry.label || fallback;
}

function pickDesc(entry) {
  if (!entry) return "";
  const l = currentLang();
  if (l === "hi" && entry.desc_hi) return entry.desc_hi;
  if (l === "mr" && entry.desc_mr) return entry.desc_mr;
  return entry.desc || "";
}

const findIn = (list) => (id) => (list || []).find((e) => e.id === id);
export const cropEntry = findIn(taxonomy.crops);
export const operationEntry = findIn(taxonomy.operations);
export const equipmentTypeEntry = findIn(taxonomy.equipment_types);

export function equipmentTypeLabel(typeId) {
  return pick(equipmentTypeEntry(typeId), typeId);
}

export function operationLabel(opId) {
  return pick(operationEntry(opId), opId);
}

export function operationDesc(opId) {
  return pickDesc(operationEntry(opId));
}

export function cropLabel(cropId) {
  return pick(cropEntry(cropId), cropId);
}

// Booking status: canonical DB value -> translated label. Unknown values
// render as-is (never blank a status we don't recognize).
const STATUS_KEYS = {
  Requested: "booking.statusRequested",
  Confirmed: "booking.statusConfirmed",
  "In Use": "booking.statusInUse",
  Completed: "booking.statusCompleted",
  Rejected: "booking.statusRejected",
  Cancelled: "booking.statusCancelled",
  Expired: "booking.statusExpired",
  Conflicted: "booking.statusConflicted",
};

export function bookingStatusLabel(status, t) {
  const key = STATUS_KEYS[status];
  return key && t ? t(key) : status || "—";
}

// Price unit: canonical DB value ("hour"/"day"/"acre") -> translated label.
// Reuses the addEquipment.perHour/perDay/perAcre keys so the unit chips and
// every price display share one translation.
const UNIT_KEYS = { hour: "addEquipment.perHour", day: "addEquipment.perDay", acre: "addEquipment.perAcre" };

export function priceUnitLabel(unit, t) {
  const key = UNIT_KEYS[unit];
  return key && t ? t(key) : unit || "";
}

// EquipmentArt.jsx only ships 3 illustrated buckets — map every taxonomy
// equipment_type onto the closest one so real listings still render art.
const ART_CATEGORY_MAP = {
  tractor: "Tractor",
  harvester: "Harvester",
  rotavator: "Implement",
  cultivator: "Implement",
  seed_drill: "Implement",
  sprayer: "Implement",
  thresher: "Implement",
  trailer: "Implement",
  plough: "Implement",
  leveler: "Implement",
};

export function artCategoryFor(typeId) {
  return ART_CATEGORY_MAP[typeId] || "Tractor";
}
