import { useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { ImageOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { mediaImageCandidates } from "@/lib/img-proxy";
import { cn } from "@/lib/utils";

export interface MediaImageProps {
  src?: string | null;
  fallbackSrc?: string | null;
  alt: string;
  /** Container dimensions/position; the image fills this box. */
  className?: string;
  imageClassName?: string;
  loading?: "lazy" | "eager";
  fallback?: ReactNode;
  onLoad?: ImgHTMLAttributes<HTMLImageElement>["onLoad"];
}

/** Same-origin image requests carry the current session cookie automatically.
 * Keep app-owned signed URLs intact; never manufacture authorization tokens. */
export default function MediaImage(props: MediaImageProps) {
  const candidates = mediaImageCandidates(props.src, props.fallbackSrc);
  return <ImageAttempt key={JSON.stringify(candidates)} {...props} candidates={candidates} />;
}

function ImageAttempt({ candidates, alt, className = "", imageClassName = "object-cover",
  loading = "lazy", fallback, onLoad }: MediaImageProps & { candidates: string[] }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = candidates[index];
  const state = !candidates.length ? "missing" : !src ? "error" : loaded ? "loaded" : "loading";
  const label = state === "missing"
    ? t("media.imageMissing", "Image not captured")
    : t("media.imageUnavailable", "Image unavailable");
  return (
    <span className={cn("relative block overflow-hidden bg-slate-100", className)}
      data-media-state={state} aria-busy={state === "loading"}>
      {state === "loading" && <span aria-hidden="true" className="absolute inset-0 animate-pulse bg-slate-200/70" />}
      {src ? <img key={src} src={src} alt={alt} loading={loading} decoding="async"
        className={`h-full w-full ${imageClassName} ${loaded ? "" : "opacity-0"}`}
        onLoad={event => { setLoaded(true); onLoad?.(event); }}
        onError={() => { setLoaded(false); setIndex(current => current === index ? index + 1 : current); }} />
        : <span role="img" aria-label={`${label}${alt ? `: ${alt}` : ""}`} title={label}
            className="flex h-full w-full items-center justify-center text-slate-400">
            {fallback ?? <ImageOff className="h-5 w-5" aria-hidden="true" />}
          </span>}
    </span>
  );
}
