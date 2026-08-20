import { NavLink } from "react-router-dom";
import { LayoutDashboard, Sparkles, ClipboardList, UserRound, Sprout } from "lucide-react";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/describe-job", label: "Find Equipment", icon: Sparkles },
  { to: "/booking/bk-1042", label: "Bookings", icon: ClipboardList },
  { to: "/profile", label: "Profile", icon: UserRound },
];

export default function NavBar() {
  return (
    <>
      {/* Desktop top nav */}
      <header className="sticky top-0 z-40 hidden border-b border-white/5 bg-ink/80 backdrop-blur-xl md:block">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-8 py-4">
          <NavLink to="/" className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-wheat text-ink">
              <Sprout size={18} strokeWidth={2.5} />
            </span>
            <span className="font-display text-lg font-bold tracking-tight text-paper">Kisan Match</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                    isActive ? "bg-white/10 text-wheat" : "text-paper/60 hover:text-paper"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <NavLink
            to="/describe-job"
            className="rounded-xl bg-wheat px-4 py-2.5 text-sm font-semibold text-ink shadow-[0_8px_24px_-8px_rgba(232,179,74,0.6)] transition-transform hover:scale-[1.03]"
          >
            List / Rent Equipment
          </NavLink>
        </div>
      </header>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-white/5 bg-ink/90 px-5 py-4 backdrop-blur-xl md:hidden">
        <NavLink to="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-wheat text-ink">
            <Sprout size={16} strokeWidth={2.5} />
          </span>
          <span className="font-display text-base font-bold text-paper">Kisan Match</span>
        </NavLink>
      </header>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-white/10 bg-ink/95 px-2 py-2 backdrop-blur-xl md:hidden">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 rounded-xl px-3 py-1.5 text-[10px] font-medium transition-colors ${
                  isActive ? "text-wheat" : "text-paper/50"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
                  {item.label.split(" ")[0]}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
    </>
  );
}
