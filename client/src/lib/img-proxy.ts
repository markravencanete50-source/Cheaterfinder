/**
 * Proxy Instagram CDN URLs through our server to avoid CORP blocking.
 * Non-Instagram URLs pass through unchanged.
 */
export function proxyUrl(url: string | undefined | null): string {
  const value = url?.trim();
  if (!value) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const parsed = new URL(value.startsWith("//") ? `https:${value}` : value);
    const instagramHost = ["instagram.com", "cdninstagram.com", "fbcdn.net"].some(
      host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    );
    if (instagramHost) {
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
      return `/api/img-proxy?url=${encodeURIComponent(parsed.href)}`;
    }
    return ["https:", "http:", "blob:"].includes(parsed.protocol) ||
      (parsed.protocol === "data:" && value.startsWith("data:image/")) ? value : "";
  } catch {
    return "";
  }
}

/** Try only distinct sources supplied by the authorized response. A failed
 * protected asset must never fall back to an unrestricted CDN/proxy URL. */
export function mediaImageCandidates(...urls: Array<string | null | undefined>): string[] {
  const candidates = [...new Set(urls.map(proxyUrl).filter(Boolean))];
  const protectedAsset = (url: string) => {
    const path = new URL(url, "https://media.invalid").pathname;
    return path.startsWith("/api/") && path !== "/api/img-proxy";
  };
  return candidates.length && protectedAsset(candidates[0])
    ? candidates.filter(protectedAsset)
    : candidates;
}
