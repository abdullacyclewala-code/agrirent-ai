import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "../../i18n/index.js";

// Phase 6 item 1 — language toggle. Persists via i18next-browser-languagedetector
// (localStorage key "agrirent_lang", set in src/i18n/index.js).
// Compact on mobile (short codes), full names on sm+ screens.
const SHORT_LABELS = { en: "EN", hi: "हिं", mr: "मरा" };

export default function LanguageSwitcher({ className = "" }) {
  const { i18n, t } = useTranslation();

  return (
    <div className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-card p-1 text-[11px] sm:gap-1 sm:text-xs ${className}`}>
      <Languages size={13} className="ml-1 hidden text-mut2 sm:block" aria-hidden="true" />
      {SUPPORTED_LANGUAGES.map((lng) => (
        <button
          key={lng}
          type="button"
          onClick={() => i18n.changeLanguage(lng)}
          aria-label={t("language.switchLabel")}
          className={`rounded-full px-2 py-1 transition sm:px-2.5 ${
            i18n.resolvedLanguage === lng ? "bg-accent-soft text-accent font-semibold" : "text-mut hover:text-ink"
          }`}
        >
          <span className="sm:hidden">{SHORT_LABELS[lng]}</span>
          <span className="hidden sm:inline">{t(`language.${lng}`)}</span>
        </button>
      ))}
    </div>
  );
}
