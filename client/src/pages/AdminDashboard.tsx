import { useCallback, useState } from "react";
import { useSearchParams } from "wouter";
import AdminShell from "./admin/AdminShell";
import { isAdminSectionId, type AdminSectionId } from "./admin/AdminSidebar";
import AdminOverview from "./admin/AdminOverview";
import AdminUsers from "./admin/AdminUsers";
import AdminUserDetail from "./admin/AdminUserDetail";
import AdminTrackedAccounts from "./admin/AdminTrackedAccounts";
import AdminTrackedAccountDetail from "./admin/AdminTrackedAccountDetail";
import AdminActivityFeed from "./admin/AdminActivityFeed";
import AdminBots from "./admin/AdminBots";
import AdminSystem from "./admin/AdminSystem";
import AdminBandwidth from "./admin/AdminBandwidth";

/**
 * Admin console entry point. Layout, access gate and identity live in
 * AdminShell; this component only resolves the active section (kept in the
 * `?section=` search param so a reload lands back where the operator was) and
 * owns the two detail overlays.
 */
export default function AdminDashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const paramSection = searchParams.get("section");
  const section: AdminSectionId = isAdminSectionId(paramSection)
    ? paramSection
    : "overview";

  const handleSectionChange = useCallback(
    (next: AdminSectionId) => {
      setSelectedUserId(null);
      setSelectedAccountId(null);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("section", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return (
    <AdminShell section={section} onSectionChange={handleSectionChange}>
      {section === "overview" && <AdminOverview />}
      {section === "users" && <AdminUsers onSelectUser={setSelectedUserId} />}
      {section === "tracked" && (
        <AdminTrackedAccounts onSelectAccount={setSelectedAccountId} />
      )}
      {section === "activity" && <AdminActivityFeed />}
      {section === "bots" && <AdminBots />}
      {section === "bandwidth" && <AdminBandwidth />}
      {section === "system" && <AdminSystem />}

      {selectedUserId && (
        <AdminUserDetail
          userId={selectedUserId}
          onClose={() => setSelectedUserId(null)}
        />
      )}
      {selectedAccountId && (
        <AdminTrackedAccountDetail
          accountId={selectedAccountId}
          onClose={() => setSelectedAccountId(null)}
        />
      )}
    </AdminShell>
  );
}
