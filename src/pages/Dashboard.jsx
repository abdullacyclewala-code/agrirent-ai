import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Sparkles, Tractor, Radar, MapPin, ClipboardList } from "lucide-react";
import HeroMap from "../components/ui/HeroMap.jsx";
import { Reveal, SectionLabel, StatTile } from "../components/ui/Primitives.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { supabase } from "../lib/supabase.js";

function greetingKey(hour) {
  if (hour < 12) return "greetMorning";
  if (hour < 17) return "greetAfternoon";
  return "greetEvening";
}

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const { profile, user } = useAuth();
  const isOwnerMode = profile?.is_owner && !profile?.is_farmer;
  const [stats, setStats] = useState({ equipment: "—", bookings: "—", latest: "—" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [eqRes, bkRes] = await Promise.all([
          supabase.from("equipment").select("id", { count: "exact", head: true }).eq("is_available", true),
          user
            ? supabase
                .from("bookings")
                .select("status,created_at")
                .or(`farmer_id.eq.${user.id},owner_id.eq.${user.id}`)
                .order("created_at", { ascending: false })
                .limit(20)
            : Promise.resolve({ data: [] }),
        ]);
        if (cancelled) return;
        const rows = bkRes.data || [];
        const active = rows.filter((b) => ["Requested", "Confirmed", "In Use"].includes(b.status)).length;
        setStats({
          equipment: eqRes.count ?? "—",
          bookings: user ? active : "—",
          latest: rows[0]?.status || "—",
        });
      } catch {
        /* keep fallbacks — stats must never break the dashboard */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const locale =
    i18n.resolvedLanguage === "hi" ? "hi-IN" : i18n.resolvedLanguage === "mr" ? "mr-IN" : "en-IN";
  const today = new Date().toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const displayName = profile?.name || user?.email?.split("@")[0] || "";
  const firstName = displayName.split(" ")[0];

  const steps = [
    { n: "01", title: t("dashboard.step1Title"), desc: t("dashboard.step1Desc"), icon: Sparkles },
    { n: "02", title: t("dashboard.step2Title"), desc: t("dashboard.step2Desc"), icon: Radar },
    { n: "03", title: t("dashboard.step3Title"), desc: t("dashboard.step3Desc"), icon: Tractor },
  ];

  return (
    <main className="grain">
      <div className="mx-auto max-w-7xl px-5 pt-6 md:px-8 md:pt-8">
        {/* ---------------- PAGE HEADER ---------------- */}
        <div className="flex items-center justify-between gap-3 border-b border-line pb-4">
          <h2 className="font-display text-2xl font-semibold text-ink">{t("dashboard.overview")}</h2>
          {profile?.location_label && (
            <span className="chip max-w-[55%] truncate">
              <MapPin size={12} className="shrink-0" />{" "}
              <span className="truncate">{profile.location_label}</span>
            </span>
          )}
        </div>

        {/* ---------------- HERO ---------------- */}
        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="hero hero-dash mt-6"
        >
          <div className="h-in">
            <div className="h-kicker">{today}</div>
            <h1>
              {t(`dashboard.${greetingKey(new Date().getHours())}`)}
              {firstName ? (
                <>
                  , <em>{firstName}</em>
                </>
              ) : null}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="chip">{isOwnerMode ? t("common.owner") : t("common.farmer")}</span>
              {profile?.location_label && (
                <span className="chip">
                  <MapPin size={12} /> {profile.location_label}
                </span>
              )}
            </div>
            <p>{t("dashboard.heroSubtitle")}</p>
            <div className="h-cta">
              <Link to={isOwnerMode ? "/equipment/new" : "/describe-job"} className="btn btn-solid">
                {isOwnerMode ? t("dashboard.listEquipment") : t("dashboard.describeJob")}{" "}
                <ArrowUpRight size={16} />
              </Link>
              <Link to="/bookings" className="btn btn-ghost">
                <ClipboardList size={16} /> {t("dashboard.myBookings")}
              </Link>
            </div>
          </div>
          <HeroMap caption={t("dashboard.mapCaption")} />
        </motion.div>

        {/* ---------------- STATS ---------------- */}
        <div className="mt-5 grid grid-cols-3 gap-3 sm:gap-4">
          <Reveal>
            <StatTile value={stats.equipment} label={t("dashboard.statEquipment")} />
          </Reveal>
          <Reveal delay={0.08}>
            <StatTile value={stats.bookings} label={t("dashboard.statBookings")} />
          </Reveal>
          <Reveal delay={0.16}>
            <StatTile value={stats.latest} label={t("dashboard.statLatest")} accent />
          </Reveal>
        </div>

        {/* ---------------- HOW IT WORKS ---------------- */}
        <div className="py-14 md:py-20">
          <SectionLabel eyebrow={t("dashboard.processEyebrow")} title={t("dashboard.processTitle")} />
          <div className="relative grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="absolute left-0 right-0 top-8 hidden h-px bg-line md:block" />
            {steps.map((s, i) => (
              <Reveal key={s.n} delay={i * 0.12}>
                <div className="card relative p-6">
                  <div className="mb-4 flex items-center justify-between">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <s.icon size={18} />
                    </span>
                    <span className="font-mono text-xs text-mut2">{s.n}</span>
                  </div>
                  <h3 className="font-display text-lg font-semibold text-ink">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-mut">{s.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
