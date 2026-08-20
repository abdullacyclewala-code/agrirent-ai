import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, MapPin, Pause, Play, Plus, Pencil, Trash2 } from "lucide-react";
import { Button, StatTile, Reveal } from "../components/ui/Primitives.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { supabase } from "../lib/supabase.js";
import { equipmentTypeLabel } from "../lib/equipmentDisplay.js";

const tabs = ["Overview", "My Listings", "Settings"];

export default function Profile() {
  const [tab, setTab] = useState("Overview");
  const { profile, user, signOut } = useAuth();
  const [listings, setListings] = useState([]);
  const [loadingListings, setLoadingListings] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const fetchListings = useCallback(async () => {
    if (!user) return;
    setLoadingListings(true);
    const { data, error } = await supabase
      .from("equipment")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false });
    if (!error) setListings(data || []);
    setLoadingListings(false);
  }, [user]);

  useEffect(() => {
    fetchListings();
  }, [fetchListings]);

  const toggleAvailability = async (item) => {
    setBusyId(item.id);
    const { error } = await supabase
      .from("equipment")
      .update({ is_available: !item.is_available })
      .eq("id", item.id);
    if (!error) fetchListings();
    setBusyId(null);
  };

  const deleteListing = async (item) => {
    if (!window.confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    setBusyId(item.id);
    const { error } = await supabase.from("equipment").delete().eq("id", item.id);
    if (!error) fetchListings();
    setBusyId(null);
  };

  const displayName = profile?.name || user?.email || "Your profile";
  const initials = displayName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join("") || "?";

  return (
    <main className="mx-auto max-w-5xl px-5 pb-16 pt-6 md:px-8 md:pt-10">
      {/* header */}
      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-wheat to-wheat-dim font-display text-2xl font-bold text-ink">
          {initials}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-bold text-paper">{displayName}</h1>
            <ShieldCheck size={18} className="text-sky" />
          </div>
          {profile?.location_label && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-paper/55">
              <MapPin size={13} /> {profile.location_label}
            </p>
          )}
        </div>
        <Button variant="ghost" onClick={signOut}>Sign out</Button>
      </div>

      {/* tabs */}
      <div className="mt-8 flex gap-1 border-b border-white/10">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`relative px-4 py-3 text-sm font-medium transition-colors ${
              tab === t ? "text-wheat" : "text-paper/50 hover:text-paper"
            }`}
          >
            {t}
            {tab === t && (
              <motion.div layoutId="profile-tab" className="absolute inset-x-0 -bottom-px h-0.5 bg-wheat" />
            )}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {tab === "Overview" && (
          <motion.div key="overview" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}>
            <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile label="Listed" value={listings.length} />
              <StatTile label="Active" value={listings.filter((l) => l.is_available).length} />
              <StatTile label="Role" value={profile?.is_owner && !profile?.is_farmer ? "Owner" : "Farmer"} />
              <StatTile label="Bookings" value="—" sub="Tracked once you book" />
            </div>

            <div className="mt-10">
              <h2 className="mb-4 font-display text-lg font-semibold text-paper">Account</h2>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm">
                <div className="flex justify-between py-1.5">
                  <span className="text-paper/50">Email</span>
                  <span className="text-paper">{user?.email}</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-paper/50">Current mode</span>
                  <span className="text-paper">{profile?.is_owner && !profile?.is_farmer ? "Owner" : "Farmer"}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {tab === "My Listings" && (
          <motion.div key="listings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="mt-8">
            <div className="mb-5 flex items-center justify-between">
              <p className="text-sm text-paper/50">Equipment you've listed for rent.</p>
              <Link to="/equipment/new">
                <Button variant="primary" className="!px-4 !py-2.5 text-sm"><Plus size={15} /> Add equipment</Button>
              </Link>
            </div>

            {loadingListings ? (
              <div className="py-10 text-center text-sm text-paper/40">Loading your listings…</div>
            ) : listings.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] py-14 text-center">
                <p className="text-sm text-paper/50">You haven't listed any equipment yet.</p>
                <Link to="/equipment/new" className="mt-4 inline-block">
                  <Button variant="outline" className="!px-4 !py-2 text-sm">List your first equipment</Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-4">
                {listings.map((l) => (
                  <Reveal key={l.id} className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-wheat/10 text-xl">🚜</div>
                      <div>
                        <div className="font-medium text-paper">{l.name}</div>
                        <div className="text-xs text-paper/45">
                          {equipmentTypeLabel(l.equipment_type)} · ₹{l.price}/{l.price_unit}
                          {l.hp ? ` · ${l.hp} HP` : ""}
                        </div>
                        <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          l.is_available ? "bg-leaf/15 text-leaf" : "bg-white/10 text-paper/50"
                        }`}>
                          {l.is_available ? "active" : "paused"}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link to={`/equipment/${l.id}/edit`}>
                        <Button variant="ghost" className="!px-3 !py-2"><Pencil size={14} /></Button>
                      </Link>
                      <Button
                        variant="ghost"
                        className="!px-3 !py-2"
                        disabled={busyId === l.id}
                        onClick={() => toggleAvailability(l)}
                      >
                        {l.is_available ? <Pause size={14} /> : <Play size={14} />}
                        {l.is_available ? "Pause" : "Activate"}
                      </Button>
                      <Button
                        variant="ghost"
                        className="!px-3 !py-2 !text-rust"
                        disabled={busyId === l.id}
                        onClick={() => deleteListing(l)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </Reveal>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {tab === "Settings" && (
          <motion.div key="settings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="mt-8 space-y-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-5 py-4 text-sm text-paper/50">
              Notification preferences, payment methods, and language settings are planned for a later phase.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
