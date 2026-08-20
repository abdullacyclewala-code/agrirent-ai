import { useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";

export default function RoleToggle({ className = "" }) {
  const { profile, toggleRole } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!profile) return null;

  const activeRole = profile.is_owner && !profile.is_farmer ? "owner" : "farmer";

  const setRole = async (role) => {
    if (busy) return;
    if (role === activeRole) return;
    setBusy(true);
    setError(null);
    const roleField = role === "farmer" ? "is_farmer" : "is_owner";
    const { error: err } = await toggleRole(roleField);
    setBusy(false);
    if (err) setError(err.message || "Couldn't switch roles. Try again.");
  };

  return (
    <div className={`relative ${className}`}>
      <div
        className={`inline-flex rounded-full border border-white/10 bg-white/5 p-1 text-xs ${
          busy ? "opacity-60" : ""
        }`}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => setRole("farmer")}
          className={`px-3 py-1 rounded-full transition disabled:cursor-wait ${
            activeRole === "farmer" ? "bg-wheat text-ink font-medium" : "text-white/60"
          }`}
        >
          Farmer
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setRole("owner")}
          className={`px-3 py-1 rounded-full transition disabled:cursor-wait ${
            activeRole === "owner" ? "bg-wheat text-ink font-medium" : "text-white/60"
          }`}
        >
          Owner
        </button>
      </div>
      {error && (
        <div className="absolute right-0 top-full z-50 mt-2 w-48 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
