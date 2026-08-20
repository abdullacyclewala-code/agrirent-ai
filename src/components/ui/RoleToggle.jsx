import { useAuth } from "../../context/AuthContext.jsx";

export default function RoleToggle() {
  const { profile, toggleRole } = useAuth();

  if (!profile) return null;

  const activeRole = profile.is_owner && !profile.is_farmer ? "owner" : "farmer";

  const setRole = async (role) => {
    if (role === "farmer" && !profile.is_farmer) await toggleRole("is_farmer");
    if (role === "owner" && !profile.is_owner) await toggleRole("is_owner");
  };

  return (
    <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1 text-xs">
      <button
        onClick={() => setRole("farmer")}
        className={`px-3 py-1 rounded-full transition ${
          activeRole === "farmer" ? "bg-wheat text-ink font-medium" : "text-white/60"
        }`}
      >
        Farmer
      </button>
      <button
        onClick={() => setRole("owner")}
        className={`px-3 py-1 rounded-full transition ${
          activeRole === "owner" ? "bg-wheat text-ink font-medium" : "text-white/60"
        }`}
      >
        Owner
      </button>
    </div>
  );
}
