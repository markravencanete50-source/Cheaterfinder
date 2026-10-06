import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { proxyUrl } from "@/lib/img-proxy";

interface ProfilePhotoLightboxProps {
  /** Raw (un-proxied) profile picture URL. When falsy, nothing renders. */
  profilePicUrl?: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Full-screen lightbox for the tracked account's profile photo.
 * Mirrors the portal/overlay conventions used by PostDetailModal:
 * createPortal, framer-motion fade, Escape-to-close, and body scroll lock.
 */
export default function ProfilePhotoLightbox({
  profilePicUrl,
  open,
  onClose,
}: ProfilePhotoLightboxProps) {
  const { t } = useTranslation();
  const isOpen = open && Boolean(profilePicUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [profilePicUrl, open]);

  useEffect(() => {
    if (!isOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="profile-photo-lightbox"
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          aria-modal="true"
          role="dialog"
          aria-label={t("profile.photoLabel", "Profile photo")}
        >
          {/* Backdrop */}
          <motion.button
            type="button"
            aria-label={t("ownPosts.modalClose", "Close")}
            onClick={onClose}
            className="absolute inset-0 h-full w-full cursor-default bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Image */}
          <motion.div
            className="relative max-h-[90vh] max-w-[90vw]"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {failed ? (
              <div className="flex h-72 w-72 items-center justify-center rounded-2xl bg-slate-900 text-sm text-slate-400 shadow-2xl">
                {t("profile.photoUnavailable", "Profile photo unavailable")}
              </div>
            ) : (
              <img
                src={proxyUrl(profilePicUrl)}
                alt={t("profile.photoLabel", "Profile photo")}
                onError={() => setFailed(true)}
                className="max-h-[90vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl"
              />
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("ownPosts.modalClose", "Close")}
              className="absolute -right-3 -top-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-700 shadow-lg transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
