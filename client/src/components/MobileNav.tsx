import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { Menu, X, BarChart2, FileBarChart, Bell, Settings, type LucideIcon } from "lucide-react";

interface NavLink {
  path: string;
  Icon: LucideIcon;
  labelKey: string;
  labelDefault?: string;
}

const NAV_LINKS: ReadonlyArray<NavLink> = [
  { path: "/members", Icon: BarChart2, labelKey: "members.trackedAccounts" },
  { path: "/reports", Icon: FileBarChart, labelKey: "members.reports", labelDefault: "Reports" },
  { path: "/notifications", Icon: Bell, labelKey: "members.notifications" },
  { path: "/settings", Icon: Settings, labelKey: "members.settings" },
];

/**
 * Mobile navigation menu. Renders a hamburger button that toggles a dropdown
 * panel with the same four nav links as the desktop sidebar. Self-contained:
 * reads its own location (Wouter) and translations (react-i18next).
 *
 * Sign-out is intentionally NOT included here; pages keep their own button.
 */
export function MobileNav() {
  const [location, setLocation] = useLocation();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function navigate(path: string) {
    setOpen(false);
    if (path !== location) setLocation(path);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={t("nav.menu", { defaultValue: "Menu" })}
        aria-expanded={open}
        aria-haspopup="menu"
        className="text-slate-500"
      >
        {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("nav.menu", { defaultValue: "Menu" })}
          className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-lg"
        >
          {NAV_LINKS.map(({ path, Icon, labelKey, labelDefault }) => {
            const active = location === path;
            const label = labelDefault ? t(labelKey, labelDefault) : t(labelKey);
            return (
              <button
                key={path}
                type="button"
                role="menuitem"
                onClick={() => navigate(path)}
                aria-current={active ? "page" : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left font-medium transition-colors ${
                  active
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <Icon className="w-5 h-5" /> {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default MobileNav;
