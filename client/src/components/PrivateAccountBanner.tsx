import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface PrivateAccountBannerProps {
  isPrivate: boolean;
  accessStatus: "public" | "pending_access" | "has_access" | "access_denied";
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: string | null;
}

export function PrivateAccountBanner({ isPrivate, accessStatus, onRetry, retrying = false, retryError }: PrivateAccountBannerProps) {
  const { t } = useTranslation();

  if (!isPrivate || accessStatus === "public") return null;

  if (accessStatus === "pending_access") {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-3xl p-6 mb-8 shadow-[0_8px_30px_rgb(0,0,0,0.04)] flex items-start gap-4">
        <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center shrink-0 animate-pulse">
          <Lock className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <p className="text-amber-800 font-bold text-base">
            {t("privateAccount.gainingAccess", "This account is private.")}
          </p>
          <p className="text-amber-800 text-sm mt-1">
            {t(
              "privateAccount.gainingAccessDesc",
              "The owner must accept a follow request from a service account before private activity can be collected. The request is visible to them; acceptance and timing are not guaranteed.",
            )}
          </p>
        </div>
      </div>
    );
  }

  if (accessStatus === "has_access") {
    return (
      <div className="inline-flex items-center gap-1.5 bg-emerald-100 text-emerald-700 text-xs font-bold px-3 py-1.5 rounded-full mb-8">
        <Lock className="w-3.5 h-3.5" />
        {t("privateAccount.accessGrantedBanner", "Private - Access Granted")}
      </div>
    );
  }

  if (accessStatus === "access_denied") {
    return (
      <div className="bg-red-50 border border-red-200 rounded-3xl p-6 mb-8 shadow-[0_8px_30px_rgb(0,0,0,0.04)] flex items-start gap-4">
        <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center shrink-0">
          <Lock className="w-5 h-5 text-red-600" />
        </div>
        <div className="flex-1">
          <p className="text-red-800 font-bold text-base">
            {t(
              "privateAccount.accessDeniedDesc",
              "Private access is unavailable. The owner must accept a service account's follow request. Retrying may send another visible request; it does not guarantee access.",
            )}
          </p>
          {onRetry && (
            <Button
              onClick={onRetry}
              disabled={retrying}
              aria-busy={retrying}
              className="mt-3 bg-red-600 hover:bg-red-700 text-white rounded-xl px-5 h-10 text-sm font-bold shadow-sm"
            >
              {retrying ? t("privateAccount.requestingAccess", "Requesting access…") : t("privateAccount.retryAccess", "Retry Access")}
            </Button>
          )}
          {retryError && <p role="alert" className="mt-3 text-sm text-red-800">{retryError}</p>}
        </div>
      </div>
    );
  }

  return null;
}
