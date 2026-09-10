import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Download, X } from "lucide-react";
import { isInstallable, promptInstall } from "../../lib/pwa.js";
import { Button } from "./Primitives.jsx";

const DISMISSED_KEY = "agrirent_install_dismissed";

/**
 * Dismissible "install the app" banner. Appears only after the browser fires
 * `beforeinstallprompt` (i.e. the app genuinely qualifies as installable)
 * and the user hasn't dismissed it before. Rendered on the Dashboard.
 */
export default function InstallBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      dismissed = false;
    }
    if (dismissed) return;
    if (isInstallable()) {
      setVisible(true);
      return;
    }
    const onInstallable = () => setVisible(true);
    window.addEventListener("agrirent:installable", onInstallable);
    return () => window.removeEventListener("agrirent:installable", onInstallable);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* private mode — banner just reappears next visit */
    }
    setVisible(false);
  };

  const install = async () => {
    const accepted = await promptInstall();
    if (accepted) dismiss();
  };

  return (
    <div className="mb-6 flex items-center gap-3 rounded-2xl border border-line bg-card p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Download className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{t("pwa.installTitle")}</p>
        <p className="truncate text-xs text-mut">{t("pwa.installBody")}</p>
      </div>
      <Button variant="primary" onClick={install} className="!px-4 !py-2 text-xs">
        {t("pwa.install")}
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("pwa.dismiss")}
        className="shrink-0 rounded-lg p-1.5 text-mut2 transition hover:bg-cream hover:text-ink"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
