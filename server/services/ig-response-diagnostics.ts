/** Fixed diagnostic values only: no upstream text, identifiers or URL paths. */
export const RESPONSE_URL_CLASSES = [
  "login", "challenge", "suspended", "instagram_api", "instagram_home",
  "instagram_other", "external", "unknown",
] as const;
export type ResponseUrlClass = typeof RESPONSE_URL_CLASSES[number];

export interface IGResponseDiagnostics {
  responseUrlClass: ResponseUrlClass;
  responseRedirected?: boolean;
  contentType: "html" | "json" | "other" | "unknown";
  responseBytes: number;
  titleClass: "instagram" | "login" | "challenge" | "other" | "absent";
}

export function classifyInstagramResponse(
  body: string,
  headers: Record<string, string>,
  urlClass?: unknown,
  redirected?: unknown,
): IGResponseDiagnostics {
  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1]
    ?.split(";", 1)[0].trim().toLowerCase();
  // A title is diagnostic only. Bundles contain auth-related words even on
  // authenticated pages, so body substrings never decide session validity.
  const title = body.match(/<title\b[^>]*>([^<]{0,160})<\/title>/i)?.[1]?.trim();
  return {
    responseUrlClass: RESPONSE_URL_CLASSES.includes(urlClass as ResponseUrlClass) ? urlClass as ResponseUrlClass : "unknown",
    ...(typeof redirected === "boolean" ? { responseRedirected: redirected } : {}),
    contentType: !contentType ? "unknown" : contentType === "text/html" ? "html"
      : contentType === "application/json" || contentType.endsWith("+json") ? "json" : "other",
    responseBytes: Buffer.byteLength(body, "utf8"),
    titleClass: !title ? "absent" : /^Instagram$/i.test(title) ? "instagram"
      : /^(?:Log in|Login|Sign up)\s*[•|–-]\s*Instagram$/i.test(title) ? "login"
      : /^(?:Challenge|Checkpoint)\s*[•|–-]\s*Instagram$/i.test(title) ? "challenge" : "other",
  };
}
