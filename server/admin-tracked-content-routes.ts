import type { Express, Request, Response } from "express";
import { isAuthenticated, isAdmin } from "./auth.js";
import { logger } from "./observability/logger.js";
import {
  adminContentScope, readAdminContent, readAdminPostEngagement, readAdminPosts,
  readAdminRoster, readAdminTrackedActivity, type AdminContentScope, type AdminPostType,
} from "./services/admin-tracked-content.js";

const prefix = "/api/admin/tracked-accounts/:id";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const postTypes = new Set(["all", "photo", "video", "reel", "carousel"]);

function pagination(req: Request, res: Response) {
  const limit = req.query.limit === undefined ? 24 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0) {
    res.status(400).json({ message: "Invalid pagination" });
    return null;
  }
  return { offset, limit };
}

export function registerAdminTrackedContentRoutes(app: Express) {
  function get(suffix: string, handler: (scope: AdminContentScope, req: Request, res: Response) => Promise<void>) {
    app.get(prefix + suffix, isAuthenticated, isAdmin, async (req: Request, res: Response) => {
      try {
        const id = typeof req.params.id === "string" ? req.params.id : "";
        if (!uuid.test(id)) { res.status(400).json({ message: "Invalid ID format" }); return; }
        const scope = await adminContentScope(id);
        if (!scope) { res.status(404).json({ message: "Tracked account not found" }); return; }
        res.setHeader("Cache-Control", "private, no-store");
        if (suffix !== "/content" && !scope.access.allowed) {
          res.status(403).json({ message: "Private account content is unavailable", code: scope.access.reason });
          return;
        }
        await handler(scope, req, res);
      } catch (err) {
        logger.error({ module: "admin-tracked-content", route: suffix, err }, "Admin content read failed");
        res.status(500).json({ message: "Unable to load collected account data" });
      }
    });
  }
  get("/content", async (scope, _req, res) => { res.json(await readAdminContent(scope)); });
  get("/posts", async (scope, req, res) => {
    const page = pagination(req, res);
    if (!page) return;
    const type = req.query.postType ?? "all";
    if (typeof type !== "string" || !postTypes.has(type)) { res.status(400).json({ message: "Invalid post type" }); return; }
    res.json(await readAdminPosts(scope, page.offset, page.limit, type as AdminPostType));
  });
  for (const dimension of ["comments", "likers"] as const) {
    get("/posts/:shortcode/" + dimension, async (scope, req, res) => {
      const shortcode = typeof req.params.shortcode === "string" ? req.params.shortcode : "";
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(shortcode)) { res.status(400).json({ message: "Invalid post ID" }); return; }
      const data = await readAdminPostEngagement(scope, shortcode, dimension);
      if (!data) { res.status(404).json({ message: "Post not found for this account" }); return; }
      res.json(data);
    });
  }
  get("/roster", async (scope, req, res) => {
    const page = pagination(req, res);
    if (!page) return;
    const dimension = req.query.dimension;
    if (dimension !== "follower" && dimension !== "following") { res.status(400).json({ message: "Invalid roster dimension" }); return; }
    res.json(await readAdminRoster(scope, dimension, page.offset, page.limit));
  });
  get("/activity", async (scope, req, res) => {
    const page = pagination(req, res);
    if (page) res.json(await readAdminTrackedActivity(scope, page.offset, page.limit));
  });
}
