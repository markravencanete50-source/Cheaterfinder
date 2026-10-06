import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminFetch } from "./shared";
import AdminSidebar, {
  ADMIN_SECTIONS,
  type AdminSectionId,
} from "./AdminSidebar";

// ─── Session context ─────────────────────────────────────────────────────────

export interface AdminSession {
  id: string;
  email: string;
  role: string;
}

export const AdminSessionContext = createContext<AdminSession | null>(null);

/** Current signed-in admin, or null while the probe is in flight. */
export function useAdminSession(): AdminSession | null {
  return useContext(AdminSessionContext);
}

function parseSession(value: unknown): AdminSession | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { id?: unknown; email?: unknown; role?: unknown };
  if (typeof raw.id !== "string" || typeof raw.email !== "string") return null;
  return {
    id: raw.id,
    email: raw.email,
    role: typeof raw.role === "string" ? raw.role : "user",
  };
}

// ─── Access gate ─────────────────────────────────────────────────────────────

interface GateState {
  checked: boolean;
  forbidden: boolean;
}

/**
 * Probes an admin-only endpoint once. 401 means "not signed in" and bounces to
 * /auth; 403 means "signed in but not an admin" and renders the denied panel.
 */
function useAdminAccessGate(): GateState {
  const [, setLocation] = useLocation();
  const [state, setState] = useState<GateState>({
    checked: false,
    forbidden: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await adminFetch("/api/admin/stats", {
          signal: controller.signal,
        });
        if (res.status === 401) {
          setLocation("/auth");
          return;
        }
        setState({ checked: true, forbidden: res.status === 403 });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setState({ checked: true, forbidden: true });
      }
    })();
    return () => controller.abort();
  }, [setLocation]);

  return state;
}

function useAdminSessionProbe(): AdminSession | null {
  const [session, setSession] = useState<AdminSession | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/auth/me", {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body: unknown = await res.json().catch(() => null);
        setSession(parseSession(body));
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        // Identity is cosmetic here — the gate above already decided access.
        setSession(null);
      }
    })();
    return () => controller.abort();
  }, []);

  return session;
}

// ─── Full-screen states ──────────────────────────────────────────────────────

function BootScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <title>Admin — CheaterFinder</title>
      <div className="flex items-center gap-2.5 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading admin console
      </div>
    </div>
  );
}

function DeniedScreen({ onLeave }: { onLeave: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <title>Access denied — CheaterFinder</title>
      <div className="w-full max-w-sm rounded-2xl border border-slate-200/60 bg-white p-8 text-center shadow-[0_2px_8px_rgb(0,0,0,0.04)]">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-red-50">
          <ShieldAlert className="h-5 w-5 text-red-500" />
        </div>
        <h1 className="font-display text-xl font-bold text-slate-900">
          Access denied
        </h1>
        <p className="mt-1.5 text-sm text-slate-500">
          This console is limited to accounts with the admin role.
        </p>
        <Button onClick={onLeave} className="mt-6 h-10 rounded-xl px-5">
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to dashboard
        </Button>
      </div>
    </div>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────

interface AdminShellProps {
  section: AdminSectionId;
  onSectionChange: (id: AdminSectionId) => void;
  children: ReactNode;
}

export default function AdminShell({
  section,
  onSectionChange,
  children,
}: AdminShellProps) {
  const [, setLocation] = useLocation();
  const gate = useAdminAccessGate();
  const session = useAdminSessionProbe();

  if (!gate.checked) return <BootScreen />;
  if (gate.forbidden) {
    return <DeniedScreen onLeave={() => setLocation("/members")} />;
  }

  const meta =
    ADMIN_SECTIONS.find((entry) => entry.id === section) ?? ADMIN_SECTIONS[0];

  return (
    <AdminSessionContext.Provider value={session}>
      <div className="min-h-screen bg-slate-50 selection:bg-primary/20 md:flex">
        <title>{`${meta.title} — Admin — CheaterFinder`}</title>

        <AdminSidebar
          section={section}
          onSectionChange={onSectionChange}
          email={session?.email ?? null}
        />

        <main className="min-w-0 flex-1">
          <header className="border-b border-slate-200/70 bg-white px-5 py-6 md:px-10 md:py-7">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
              Admin
            </p>
            <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-slate-900 md:text-[27px]">
              {meta.title}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              {meta.description}
            </p>
          </header>

          <div className="px-5 py-7 pb-20 md:px-10 md:py-9">{children}</div>
        </main>
      </div>
    </AdminSessionContext.Provider>
  );
}
