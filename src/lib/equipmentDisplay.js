import taxonomy from "../data/taxonomy.json";

export function equipmentTypeLabel(typeId) {
  return taxonomy.equipment_types.find((t) => t.id === typeId)?.label || typeId;
}

export function operationLabel(opId) {
  return taxonomy.operations.find((o) => o.id === opId)?.label || opId;
}

export function cropLabel(cropId) {
  return taxonomy.crops.find((c) => c.id === cropId)?.label || cropId;
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
