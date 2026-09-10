import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "../../i18n/index.js";

// Phase 6 item 1 — language toggle. Persists via i18next-browser-languagedetector
// (localStorage key "agrirent_lang", set in src/i18n/index.js).
export default function LanguageSwitcher({ className = "" }) {
  const { i18n, t } = useTranslation();

  return (
    <div className={`inline-flex items-center gap-1 rounded-full border border-line bg-card p-1 text-xs ${className}`}>
      <Languages size={13} className="ml-1.5 text-mut2" aria-hidden="true" />
      {SUPPORTED_LANGUAGES.map((lng) => (
        <button
          key={lng}
          type="button"
          onClick={() => i18n.changeLanguage(lng)}
          aria-label={t("language.switchLabel")}
          className={`rounded-full px-2.5 py-1 transition ${
            i18n.resolvedLanguage === lng ? "bg-accent-soft text-accent font-semibold" : "text-mut hover:text-ink"
          }`}
        >
          {t(`language.${lng}`)}
        </button>
      ))}
    </div>
  );
}
