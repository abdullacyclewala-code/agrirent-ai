import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ShieldCheck, MapPin, Pause, Play, Plus, Pencil, Trash2, Bell, BellOff, Languages } from "lucide-react";
import { Button, StatTile, Reveal } from "../components/ui/Primitives.jsx";
import LanguageSwitcher from "../components/ui/LanguageSwitcher.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { supabase } from "../lib/supabase.js";
import { equipmentTypeLabel } from "../lib/equipmentDisplay.js";
import { enablePushNotifications } from "../lib/push.js";

export default function Profile() {
  const { t } = useTranslation();
  const tabs = [t("profile.tabOverview"), t("profile.tabListings"), t("profile.tabSettings")];
  const [tab, setTab] = useState(tabs[0]);
  const { profile, user, signOut } = useAuth();
  const [listings, setListings] = useState([]);
  const [loadingListings, setLoadingListings] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushResult, setPushResult] = useState(null); // { ok: bool, message: string }

  const handleEnableNotifications = async () => {
    setPushBusy(true);
    setPushResult(null);
    const result = await enablePushNotifications(user?.id);
    setPushResult(result);
    setPushBusy(false);
  };

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
    if (!window.confirm(t("profile.confirmDelete", { name: item.name }))) return;
    setBusyId(item.id);
    const { error } = await supabase.from("equipment").delete().eq("id", item.id);
    if (!error) fetchListings();
    setBusyId(null);
  };

  const displayName = profile?.name || user?.email || t("profile.tabOverview");
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
        <Button variant="ghost" onClick={signOut}>{t("profile.signOut")}</Button>
      </div>

      {/* tabs */}
      <div className="mt-8 flex gap-1 border-b border-white/10">
        {tabs.map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`relative px-4 py-3 text-sm font-medium transition-colors ${
              tab === tb ? "text-wheat" : "text-paper/50 hover:text-paper"
            }`}
          >
            {tb}
            {tab === tb && (
              <motion.div layoutId="profile-tab" className="absolute inset-x-0 -bottom-px h-0.5 bg-wheat" />
            )}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {tab === tabs[0] && (
          <motion.div key="overview" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}>
            <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile label={t("profile.statListed")} value={listings.length} />
              <StatTile label={t("profile.statActive")} value={listings.filter((l) => l.is_available).length} />
              <StatTile label={t("profile.statRole")} value={profile?.is_owner && !profile?.is_farmer ? t("common.owner") : t("common.farmer")} />
              <StatTile label={t("profile.statBookings")} value="—" sub={t("profile.statBookingsSub")} />
            </div>

            <div className="mt-10">
              <h2 className="mb-4 font-display text-lg font-semibold text-paper">{t("profile.accountTitle")}</h2>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm">
                <div className="flex justify-between py-1.5">
                  <span className="text-paper/50">{t("profile.email")}</span>
                  <span className="text-paper">{user?.email}</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-paper/50">{t("profile.currentMode")}</span>
                  <span className="text-paper">{profile?.is_owner && !profile?.is_farmer ? t("common.owner") : t("common.farmer")}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {tab === tabs[1] && (
          <motion.div key="listings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="mt-8">
            <div className="mb-5 flex items-center justify-between">
              <p className="text-sm text-paper/50">{t("profile.listingsSubtitle")}</p>
              <Link to="/equipment/new">
                <Button variant="primary" className="!px-4 !py-2.5 text-sm"><Plus size={15} /> {t("profile.addEquipment")}</Button>
              </Link>
            </div>

            {loadingListings ? (
              <div className="py-10 text-center text-sm text-paper/40">{t("profile.loadingListings")}</div>
            ) : listings.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] py-14 text-center">
                <p className="text-sm text-paper/50">{t("profile.noListings")}</p>
                <Link to="/equipment/new" className="mt-4 inline-block">
                  <Button variant="outline" className="!px-4 !py-2 text-sm">{t("profile.listFirst")}</Button>
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
                          {l.is_available ? t("profile.active") : t("profile.paused")}
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
                        {l.is_available ? t("profile.pause") : t("profile.activate")}
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

        {tab === tabs[2] && (
          <motion.div key="settings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="mt-8 space-y-3">
            <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.02] px-5 py-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-paper">
                  <Bell size={15} className="text-wheat" /> {t("profile.notificationsTitle")}
                </div>
                <p className="mt-1 text-xs text-paper/50">
                  {t("profile.notificationsDesc")}
                </p>
                {pushResult && (
                  <p className={`mt-2 flex items-center gap-1 text-xs ${pushResult.ok ? "text-leaf" : "text-rust"}`}>
                    {pushResult.ok ? <Bell size={12} /> : <BellOff size={12} />} {pushResult.message}
                  </p>
                )}
              </div>
              <Button variant="outline" className="!px-4 !py-2 text-xs" disabled={pushBusy} onClick={handleEnableNotifications}>
                {pushBusy ? t("profile.enabling") : t("profile.turnOn")}
              </Button>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.02] px-5 py-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-paper">
                  <Languages size={15} className="text-wheat" /> {t("profile.languageTitle")}
                </div>
                <p className="mt-1 text-xs text-paper/50">
                  {t("profile.languageDesc")}
                </p>
              </div>
              <LanguageSwitcher />
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-5 py-4 text-sm text-paper/50">
              {t("profile.paymentNote")}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
