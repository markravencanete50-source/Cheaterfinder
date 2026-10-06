import type { Request, RequestHandler, Response } from "express";
import { sanitizeTrialPreview, unwrapPreviewCursor, type TrialPreviewKind } from "./trial-preview.js";

type PreviewRoute = { kind?: TrialPreviewKind; report?: boolean; media?: boolean; trackedAccountId?: string; dimension?: "followers" | "following" };

/** Explicit customer routes only. Admin routes and billing/auth responses are never transformed. */
export function trialPreviewRoute(method: string, pathname: string): PreviewRoute | null {
  if (!["GET", "HEAD", "POST"].includes(method)) return null;
  const path = pathname.replace(/\/$/, "");
  const lower = path.toLowerCase(); // Express static route segments are case-insensitive.
  if ((method === "POST" && /^\/api\/tracking\/accounts\/[^/]+\/report\/generate$/i.test(path)) ||
      (["GET", "HEAD"].includes(method) && /^\/api\/reports\/[^/]+\/(pdf|csv)$/i.test(path))) return { report: true };
  if (lower === "/api/tracking/accounts" && ["GET", "HEAD", "POST"].includes(method)) return { kind: method === "POST" ? "account" : "accounts" };
  if (!["GET", "HEAD"].includes(method)) return null;
  if (/^\/api\/viewer\/[^/]+$/i.test(path)) return { kind: "viewer" };
  const account = path.match(/^\/api\/tracking\/accounts\/([^/]+)\/(report|feed|posts|followers\/roster|following\/roster)$/i);
  if (account) {
    const trackedAccountId = decodeURIComponent(account[1]);
    const surface = account[2].toLowerCase();
    if (surface.endsWith("/roster")) return { kind: "roster", trackedAccountId, dimension: surface.startsWith("followers") ? "followers" : "following" };
    return { kind: surface === "report" ? "account" : surface as "feed" | "posts", trackedAccountId };
  }
  const engagement = lower.match(/^\/api\/tracking\/posts\/[^/]+\/(likers|comments)$/);
  if (engagement) return { kind: engagement[1] as "likers" | "comments" };
  if (lower === "/api/reports") return { kind: "reports" };
  if (lower === "/api/notifications") return { kind: "notifications" };
  if (lower === "/api/img-proxy" || /^\/api\/media\/[^/]+$/.test(lower)) return { media: true };
  return null;
}

export interface PreviewHttpDependencies {
  isPreview(userId: string): Promise<boolean>;
  isAvatar(userId: string, request: Request): Promise<boolean>;
  sendPlaceholder(response: Response): void;
}

/** Installed after authentication and the unchanged subscription gate. */
export function createTrialPreviewMiddleware(deps: PreviewHttpDependencies): RequestHandler {
  return async (req, res, next) => {
    try {
      const route = trialPreviewRoute(req.method, req.path);
      if (!route || !req.user || (route.media && req.user.role === "admin")) return next();
      if (!await deps.isPreview(req.user.id)) return next();
      res.locals.trialPreview = true;
      res.setHeader("Cache-Control", "private, no-store");
      if (route.report) {
        res.status(402).json({ code: "trial_preview", message: "Activate subscription to generate reports" });
        return;
      }
      if (route.media) {
        if (await deps.isAvatar(req.user.id, req)) return next();
        deps.sendPlaceholder(res);
        return;
      }
      if (route.kind === "roster" && req.query.cursor) {
        try {
          if (typeof req.query.cursor !== "string") throw new Error("Invalid preview cursor");
          // Keep opaque cursor handling out of the collection/roster implementation.
          res.locals.trialPreviewCursor = unwrapPreviewCursor(req.query.cursor, {
            userId: req.user.id, trackedAccountId: route.trackedAccountId!, dimension: route.dimension!,
          });
        } catch {
          res.status(400).json({ message: "Invalid preview cursor" });
          return;
        }
      }
      const sendJson = res.json.bind(res);
      res.json = (body: unknown) => sendJson(res.statusCode < 400
        ? sanitizeTrialPreview(route.kind!, body, req.user!.id, route)
        : body);
      next();
    } catch (error) { next(error); }
  };
}
