/** Use only an explicit first-party production origin, never a request Host. */
export function emailAppUrl(path: string): string {
  const configured = new URL(process.env.APP_URL ?? "https://cheaterfinder.com");
  const production = process.env.NODE_ENV === "production";
  if (!["https:", "http:"].includes(configured.protocol) || configured.username || configured.password ||
    (production && (configured.protocol !== "https:" || !["cheaterfinder.com", "www.cheaterfinder.com"].includes(configured.hostname) || configured.port))) {
    throw new Error("Invalid application email origin");
  }
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid application email path");
  const url = new URL(path, configured.origin);
  if (url.origin !== configured.origin) throw new Error("Invalid application email path");
  return url.href;
}

/** Domain verification belongs to deployment; all application mail shares its sender. */
export function applicationEmailFrom(): string {
  const from = process.env.EMAIL_FROM ?? "CheaterFinder <notifications@cheaterfinder.com>";
  const address = from.includes("<") ? from.match(/^[^<>\r\n]+ <([^<>\s@]+@[^<>\s@]+)>$/)?.[1]
    : (/^[^<>\s@]+@[^<>\s@]+$/.test(from) ? from : undefined);
  if (!address || /[\r\n]/.test(from) ||
    (process.env.NODE_ENV === "production" && address.split("@")[1].toLowerCase() !== "cheaterfinder.com")) {
    throw new Error("Invalid application email sender");
  }
  return from;
}
