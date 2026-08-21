import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "../../i18n/index.js";

// Phase 6 item 1 — language toggle. Persists via i18next-browser-languagedetector
// (localStorage key "kisan_lang", set in src/i18n/index.js).
export default function LanguageSwitcher({ className = "" }) {
  const { i18n, t } = useTranslation();

  return (
    <div className={`inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 text-xs ${className}`}>
      <Languages size={13} className="ml-1.5 text-paper/40" aria-hidden="true" />
      {SUPPORTED_LANGUAGES.map((lng) => (
        <button
          key={lng}
          type="button"
          onClick={() => i18n.changeLanguage(lng)}
          aria-label={t("language.switchLabel")}
          className={`rounded-full px-2.5 py-1 transition ${
            i18n.resolvedLanguage === lng ? "bg-wheat text-ink font-medium" : "text-paper/60 hover:text-paper"
          }`}
        >
          {t(`language.${lng}`)}
        </button>
      ))}
    </div>
  );
}
