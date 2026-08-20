import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, MapPin, Settings, Pause, Play } from "lucide-react";
import { profile } from "../data/mockData.js";
import { Button, StatTile, Reveal } from "../components/ui/Primitives.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const tabs = ["Overview", "My Listings", "Settings"];

export default function Profile() {
  const [tab, setTab] = useState("Overview");
  const { signOut } = useAuth();

  return (
    <main className="mx-auto max-w-5xl px-5 pb-16 pt-6 md:px-8 md:pt-10">
      {/* header */}
      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-wheat to-wheat-dim font-display text-2xl font-bold text-ink">
          {profile.name.split(" ").map((n) => n[0]).join("")}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-bold text-paper">{profile.name}</h1>
            {profile.verified && <ShieldCheck size={18} className="text-sky" />}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-paper/55"><MapPin size={13} /> {profile.location}</p>
          <p className="mt-0.5 text-xs text-paper/35">Member since {profile.memberSince}</p>
        </div>
        <Button variant="ghost"><Settings size={15} /> Edit profile</Button>
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
              <StatTile label="Acres served" value={profile.stats.acresServed} />
              <StatTile label="Bookings" value={profile.stats.bookingsCompleted} />
              <StatTile label="Listed" value={profile.stats.equipmentListed} />
              <StatTile label="Saved" value={`₹${(profile.stats.totalSaved / 1000).toFixed(1)}k`} />
            </div>

            <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-2">
              <div>
                <h2 className="mb-4 font-display text-lg font-semibold text-paper">Farm details</h2>
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                  <div className="flex justify-between text-sm">
                    <span className="text-paper/50">Land size</span>
                    <span className="text-paper">{profile.landSize} acres</span>
                  </div>
                  <div className="mt-3 text-sm text-paper/50">Primary crops</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {profile.primaryCrops.map((c) => (
                      <span key={c} className="rounded-full bg-wheat/10 px-3 py-1 text-xs font-medium text-wheat">{c}</span>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <h2 className="mb-4 font-display text-lg font-semibold text-paper">Recent activity</h2>
                <div className="space-y-3">
                  {profile.activity.map((a) => (
                    <Reveal key={a.id} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-wheat" />
                      <div>
                        <div className="text-sm text-paper/80">{a.text}</div>
                        <div className="mt-0.5 text-xs text-paper/35">{a.time}</div>
                      </div>
                    </Reveal>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {tab === "My Listings" && (
          <motion.div key="listings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="mt-8 space-y-4">
            {profile.listings.map((l) => (
              <div key={l.id} className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-wheat/10 text-xl">🚜</div>
                  <div>
                    <div className="font-medium text-paper">{l.name}</div>
                    <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      l.status === "active" ? "bg-leaf/15 text-leaf" : "bg-white/10 text-paper/50"
                    }`}>
                      {l.status}
                    </span>
                  </div>
                </div>
                <div className="flex items-end gap-1">
                  {l.earnings.map((v, i) => (
                    <div key={i} className="w-3 rounded-t bg-wheat/50" style={{ height: `${8 + v * 5}px` }} />
                  ))}
                </div>
                <Button variant="ghost" className="!px-3 !py-2">
                  {l.status === "active" ? <Pause size={14} /> : <Play size={14} />}
                  {l.status === "active" ? "Pause" : "Activate"}
                </Button>
              </div>
            ))}
          </motion.div>
        )}

        {tab === "Settings" && (
          <motion.div key="settings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="mt-8 space-y-3">
            {["Notification preferences", "Payment methods", "Language: English / ਪੰਜਾਬੀ / हिंदी", "Help & support"].map((s) => (
              <button key={s} className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-5 py-4 text-left text-sm text-paper/80 hover:border-white/25">
                {s} <span className="text-paper/30">›</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
