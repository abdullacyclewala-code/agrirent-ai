// Rules engine — Master doc §6.3 "Rules engine (hard filter)"
//
// SCOPE NOTE (Phase 2): This implements the hard-compatibility rules only.
// It does NOT do LLM parsing (Phase 3) or LightGBM ranking (Phase 4) — the
// "score" here is a simple, deterministic, rules-based heuristic used only
// to order results within this phase. It is explicitly a placeholder and is
// replaced by the real ranking model in Phase 4 per §6.4.
//
// Also NOT implemented yet (disclosed deviation from §6.3, deferred to a later
// phase): geo distance / service_area_radius_km filtering. Mapbox/PostGIS
// integration hasn't been wired up, so every equipment row currently passes
// the location check. Once geocoding exists, plug real distance in here.

import taxonomy from "../data/taxonomy.json";

/**
 * Given a taxonomy equipment_type entry, find the hp_range bucket that
 * applies to a given land size in acres.
 */
function hpRangeFor(equipmentTypeId, acres) {
  const entry = taxonomy.compatibility.find((c) => c.equipment_type === equipmentTypeId);
  if (!entry || !entry.hp_ranges?.length) return null;
  const sorted = [...entry.hp_ranges].sort((a, b) => a.max_acres - b.max_acres);
  return sorted.find((r) => acres <= r.max_acres) || sorted[sorted.length - 1];
}

/**
 * Resolve which equipment_type ids are even plausible for a given
 * operation + crop, using the taxonomy compatibility matrix.
 */
function candidateEquipmentTypes({ operation, crop }) {
  return taxonomy.compatibility
    .filter((c) => {
      const opOk = !operation || c.operations.includes(operation);
      const cropOk = !crop || c.crops.includes(crop);
      return opOk && cropOk;
    })
    .map((c) => c.equipment_type);
}

/**
 * Hard-filter a list of equipment rows (from Supabase `equipment` table)
 * against a structured requirement, then apply a simple placeholder score.
 *
 * @param {Array} equipmentRows - rows from `equipment` table (+ owner name joined in as `owner_name`)
 * @param {{crop:string|null, operation:string, area_acres:number|null}} requirement
 * @param {string} currentUserId - excludes the user's own listings (§4.5 edge case)
 * @returns {{results: Array, relaxedHp: boolean}}
 */
export function runRulesFilter(equipmentRows, requirement, currentUserId) {
  const { crop, operation, area_acres } = requirement;
  const acres = area_acres || 1;

  const candidateTypes = candidateEquipmentTypes({ operation, crop });

  const passesCore = (row) => {
    if (currentUserId && row.owner_id === currentUserId) return false; // can't book own equipment
    if (!row.is_available) return false;
    if (candidateTypes.length && !candidateTypes.includes(row.equipment_type)) return false;
    if (operation && row.compatible_operations?.length && !row.compatible_operations.includes(operation)) {
      return false;
    }
    if (crop && row.compatible_crops?.length && !row.compatible_crops.includes(crop)) {
      return false;
    }
    return true;
  };

  const withinHpRange = (row) => {
    const range = hpRangeFor(row.equipment_type, acres);
    if (!range || row.hp == null) return true; // no range data or hp not set — don't hard-fail
    return row.hp >= range.min_hp && row.hp <= range.max_hp;
  };

  let filtered = equipmentRows.filter((r) => passesCore(r) && withinHpRange(r));
  let relaxedHp = false;

  // Edge case §4.5: zero results → relax the HP filter before giving up.
  if (filtered.length === 0) {
    const coreOnly = equipmentRows.filter(passesCore);
    if (coreOnly.length > 0) {
      filtered = coreOnly;
      relaxedHp = true;
    }
  }

  const scored = filtered.map((row) => {
    const range = hpRangeFor(row.equipment_type, acres);
    let score = 75;
    const reasons = [];

    if (candidateTypes.includes(row.equipment_type)) {
      score += 10;
      reasons.push(`Suited for ${operation.replace(/_/g, " ")}`);
    }
    if (crop && row.compatible_crops?.includes(crop)) {
      score += 8;
      reasons.push(`Used for ${crop} before`);
    }
    if (range && row.hp != null) {
      if (row.hp >= range.min_hp && row.hp <= range.max_hp) {
        score += 10;
        reasons.push(`${row.hp} HP fits your ${acres} acre job`);
      } else {
        score -= 12;
        reasons.push(`${row.hp} HP — outside the typical range for this job size`);
      }
    }
    if (row.price) reasons.push(`₹${row.price} / ${row.price_unit}`);

    score = Math.max(35, Math.min(99, Math.round(score)));

    return { ...row, matchScore: score, reasons };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore);

  return { results: scored, relaxedHp };
}
