import { useLocation } from "wouter";
import {
  Activity,
  ArrowLeft,
  Bot,
  Gauge,
  HeartPulse,
  Instagram,
  LayoutDashboard,
  LogOut,
  Server,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { logoutAndClearCache } from "@/lib/logout";

// ─── Section registry ────────────────────────────────────────────────────────
// Single source of truth for the console's navigation. AdminShell reads the
// title/description for its page header; AdminDashboard switches on the id.

export type AdminSectionId =
  | "overview"
  | "users"
  | "tracked"
  | "activity"
  | "bots"
  | "bandwidth"
  | "system";

export interface AdminSection {
  id: AdminSectionId;
  label: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    title: "Overview",
    description:
      "Detection volume, pool health and billing at a glance. Refreshes every 15 seconds.",
  },
  {
    id: "users",
    label: "Users",
    icon: Users,
    title: "Users",
    description: "Every account, its plan, and what it is tracking.",
  },
  {
    id: "tracked",
    label: "Tracked Accounts",
    icon: Instagram,
    title: "Tracked accounts",
    description:
      "Instagram profiles under collection, their owner, and the events detected for each.",
  },
  {
    id: "activity",
    label: "Activity",
    icon: Activity,
    title: "Activity",
    description: "Raw like, follow and unfollow events as they are detected.",
  },
  {
    id: "bots",
    label: "Bots",
    icon: Bot,
    title: "Bot pool",
    description:
      "Scraper sessions, transports, proxies, cooldowns and bans across the fleet.",
  },
  {
    id: "bandwidth",
    label: "Bandwidth",
    icon: Gauge,
    title: "Bandwidth",
    description: "Proxy traffic per tracked profile and per user, plus refresh cadence.",
  },
  {
    id: "system",
    label: "System",
    icon: Server,
    title: "System",
    description: "Queues, workers, scraper settings and diagnostics.",
  },
] as const;

export function isAdminSectionId(value: string | null): value is AdminSectionId {
  if (!value) return false;
  return ADMIN_SECTIONS.some((section) => section.id === value);
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

const FOCUS_RING =
  "focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-white";

function useAdminSignOut(): () => Promise<void> {
  const [, setLocation] = useLocation();
  return async () => {
    try {
      await logoutAndClearCache();
    } catch {
      // A network failure still drops the operator back to the login screen;
      // the server-side session expires on its own. Nothing useful to surface.
    } finally {
      setLocation("/auth");
    }
  };
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
      <span className="font-display text-lg font-bold tracking-tight">
        <span className="text-foreground">Cheater</span><span className="text-primary">Finder</span>
      </span>
      <span className="rounded-md bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">
        Admin
      </span>
    </div>
  );
}

function NavItem({
  section,
  active,
  onSelect,
}: {
  section: AdminSection;
  active: boolean;
  onSelect: (id: AdminSectionId) => void;
}) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(section.id)}
      aria-current={active ? "page" : undefined}
      className={`group flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors duration-150 ${FOCUS_RING} ${
        active
          ? "bg-primary/10 font-semibold text-primary"
          : "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      <Icon
        className={`h-[18px] w-[18px] shrink-0 ${
          active ? "text-primary" : "text-slate-400 group-hover:text-slate-500"
        }`}
      />
      <span className="truncate">{section.label}</span>
    </button>
  );
}

function RailAction({
  icon: Icon,
  label,
  onClick,
  tone = "default",
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 ${FOCUS_RING} ${
        tone === "danger"
          ? "text-slate-600 hover:bg-red-50 hover:text-red-600"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      <Icon className="h-[18px] w-[18px] shrink-0 text-slate-400" />
      {label}
    </button>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

interface AdminSidebarProps {
  section: AdminSectionId;
  onSectionChange: (id: AdminSectionId) => void;
  email: string | null;
}

export default function AdminSidebar({
  section,
  onSectionChange,
  email,
}: AdminSidebarProps) {
  const [, setLocation] = useLocation();
  const signOut = useAdminSignOut();

  return (
    <>
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex h-16 items-center border-b border-slate-100 px-5">
          <Wordmark />
        </div>

        <nav aria-label="Admin sections" className="flex-1 overflow-y-auto p-3">
          <div className="space-y-1">
            {ADMIN_SECTIONS.map((item) => (
              <NavItem
                key={item.id}
                section={item}
                active={item.id === section}
                onSelect={onSectionChange}
              />
            ))}
          </div>

          <div className="my-3 border-t border-slate-100" />

          <button
            type="button"
            onClick={() => setLocation("/admin/health")}
            className={`group flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 ${FOCUS_RING}`}
          >
            <HeartPulse className="h-[18px] w-[18px] shrink-0 text-rose-400" />
            <span className="truncate">Live Health</span>
          </button>
        </nav>

        <div className="border-t border-slate-100 p-3">
          <div className="rounded-lg border border-slate-200/70 bg-slate-50 px-3 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400">
              Signed in
            </p>
            <p
              className="truncate text-sm font-medium text-slate-800"
              title={email ?? undefined}
            >
              {email ?? "—"}
            </p>
          </div>
          <div className="mt-2 space-y-0.5">
            <RailAction
              icon={ArrowLeft}
              label="Back to app"
              onClick={() => setLocation("/members")}
            />
            <RailAction
              icon={LogOut}
              label="Sign out"
              tone="danger"
              onClick={() => {
                void signOut();
              }}
            />
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur md:hidden">
        <div className="flex h-14 items-center gap-2 px-4">
          <Wordmark />
          <div className="ml-auto flex items-center gap-1">
            <IconButton
              label="Live Health"
              icon={HeartPulse}
              onClick={() => setLocation("/admin/health")}
            />
            <IconButton
              label="Back to app"
              icon={ArrowLeft}
              onClick={() => setLocation("/members")}
            />
            <IconButton
              label="Sign out"
              icon={LogOut}
              onClick={() => {
                void signOut();
              }}
            />
          </div>
        </div>
        <nav
          aria-label="Admin sections"
          className="flex gap-1.5 overflow-x-auto px-3 pb-2.5"
        >
          {ADMIN_SECTIONS.map((item) => {
            const active = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSectionChange(item.id)}
                aria-current={active ? "page" : undefined}
                className={`shrink-0 cursor-pointer rounded-lg px-3 py-1.5 text-xs transition-colors duration-150 ${FOCUS_RING} ${
                  active
                    ? "bg-primary/10 font-semibold text-primary"
                    : "bg-slate-100 font-medium text-slate-500 hover:text-slate-800"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>
    </>
  );
}

function IconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 ${FOCUS_RING}`}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}
