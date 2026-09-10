import { useState } from "react";
import { motion } from "framer-motion";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Sprout } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";

export default function Auth() {
  const { t } = useTranslation();
  const [mode, setMode] = useState("signin"); // signin | signup
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const from = location.state?.from?.pathname || "/";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    const action = mode === "signin" ? signIn({ email, password }) : signUp({ email, password, name });
    const { error: authError } = await action;
    setBusy(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    if (mode === "signup") {
      setError(t("auth.accountCreated"));
      setMode("signin");
      return;
    }
    navigate(from, { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-paper">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm card p-6"
      >
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
            <Sprout size={18} strokeWidth={2.5} />
          </span>
          <span className="font-display text-lg font-bold tracking-tight text-ink">{t("nav.brand")}</span>
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink mb-1">
          {mode === "signin" ? t("auth.welcomeBack") : t("auth.createAccount")}
        </h1>
        <p className="text-sm text-mut mb-6">
          {mode === "signin" ? t("auth.signInSubtitle") : t("auth.signUpSubtitle")}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "signup" && (
            <div>
              <label className="text-xs text-mut mb-1 block">{t("auth.fullName")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full rounded-xl bg-card border border-line px-3 py-2.5 text-ink outline-none focus:border-accent placeholder:text-mut2"
                placeholder={t("auth.fullNamePlaceholder")}
              />
            </div>
          )}
          <div>
            <label className="text-xs text-mut mb-1 block">{t("auth.email")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-xl bg-card border border-line px-3 py-2.5 text-ink outline-none focus:border-accent placeholder:text-mut2"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="text-xs text-mut mb-1 block">{t("auth.password")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full rounded-xl bg-card border border-line px-3 py-2.5 text-ink outline-none focus:border-accent placeholder:text-mut2"
              placeholder="••••••••"
            />
          </div>

          {error && <p className="text-sm text-accent">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-full bg-accent text-white font-semibold py-3 disabled:opacity-50 hover:bg-accent-2 transition-colors"
          >
            {busy ? t("auth.pleaseWait") : mode === "signin" ? t("auth.signIn") : t("auth.signUp")}
          </button>
        </form>

        <button
          onClick={() => {
            setError("");
            setMode(mode === "signin" ? "signup" : "signin");
          }}
          className="mt-4 text-sm text-mut hover:text-ink w-full text-center"
        >
          {mode === "signin" ? t("auth.noAccount") : t("auth.haveAccount")}
        </button>
      </motion.div>
    </div>
  );
}
