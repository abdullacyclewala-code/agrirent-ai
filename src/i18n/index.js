import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import hi from "./locales/hi.json";
import mr from "./locales/mr.json";

// Phase 6 item 1 — multilingual UI (English/Hindi/Marathi + Hinglish).
// hi/mr are LLM-drafted per the master doc's decision (§ Phase 6 table,
// item 1): "Seed hi/mr via free MT / LLM draft, then have a native speaker
// review farmer-facing copy specifically". They are functional and cover
// every UI string, but have NOT been reviewed by a native speaker yet —
// that review is the manual step still required before this should be
// considered launch-ready for real farmers.
export const SUPPORTED_LANGUAGES = ["en", "hi", "mr"];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
      mr: { translation: mr },
    },
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "kisan_lang",
    },
  });

export default i18n;
