import { useState } from "react";
import { EquipmentArt } from "./EquipmentArt.jsx";
import { artCategoryFor } from "../../lib/equipmentDisplay.js";

// Listing imagery with graceful degradation: real photo when the owner
// uploaded one, illustrated art otherwise (or if the photo fails to load).

export function firstPhoto(images) {
  return Array.isArray(images) && images.length > 0 ? images[0] : null;
}

export function EquipmentPhoto({ images, equipmentType, alt = "", className = "", imgClassName = "" }) {
  const [failed, setFailed] = useState(false);
  const url = firstPhoto(images);
  if (!url || failed) {
    return <EquipmentArt category={artCategoryFor(equipmentType)} className={className} />;
  }
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`h-full w-full object-cover ${imgClassName}`}
    />
  );
}

export function EquipmentGallery({ images, equipmentType, name = "" }) {
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState({});
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  const current = list[active];

  if (!current || failed[active]) {
    return <EquipmentArt category={artCategoryFor(equipmentType)} className="h-full w-full" />;
  }
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-hidden">
        <img
          src={current}
          alt={name}
          onError={() => setFailed((f) => ({ ...f, [active]: true }))}
          className="h-full w-full object-cover"
        />
      </div>
      {list.length > 1 && (
        <div className="flex shrink-0 gap-2 overflow-x-auto pb-0.5">
          {list.map((url, i) => (
            <button
              key={url}
              type="button"
              onClick={() => setActive(i)}
              className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                i === active ? "border-accent" : "border-transparent opacity-70 hover:opacity-100"
              }`}
            >
              <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
