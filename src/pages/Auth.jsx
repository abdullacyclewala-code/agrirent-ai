import { useState } from "react";
import { motion } from "framer-motion";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
    <div className="min-h-screen flex items-center justify-center px-4 bg-ink">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl p-6"
      >
        <h1 className="text-2xl font-semibold text-white mb-1">
          {mode === "signin" ? t("auth.welcomeBack") : t("auth.createAccount")}
        </h1>
        <p className="text-sm text-white/60 mb-6">
          {mode === "signin" ? t("auth.signInSubtitle") : t("auth.signUpSubtitle")}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "signup" && (
            <div>
              <label className="text-xs text-white/50 mb-1 block">{t("auth.fullName")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full rounded-lg bg-white/10 border border-white/10 px-3 py-2 text-white outline-none focus:border-wheat"
                placeholder={t("auth.fullNamePlaceholder")}
              />
            </div>
          )}
          <div>
            <label className="text-xs text-white/50 mb-1 block">{t("auth.email")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg bg-white/10 border border-white/10 px-3 py-2 text-white outline-none focus:border-wheat"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">{t("auth.password")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full rounded-lg bg-white/10 border border-white/10 px-3 py-2 text-white outline-none focus:border-wheat"
              placeholder="••••••••"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-wheat text-ink font-medium py-2.5 disabled:opacity-50"
          >
            {busy ? t("auth.pleaseWait") : mode === "signin" ? t("auth.signIn") : t("auth.signUp")}
          </button>
        </form>

        <button
          onClick={() => {
            setError("");
            setMode(mode === "signin" ? "signup" : "signin");
          }}
          className="mt-4 text-sm text-white/60 hover:text-white w-full text-center"
        >
          {mode === "signin" ? t("auth.noAccount") : t("auth.haveAccount")}
        </button>
      </motion.div>
    </div>
  );
}
