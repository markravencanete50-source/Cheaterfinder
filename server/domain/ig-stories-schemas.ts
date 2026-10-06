// ─── Zod validation for IG stories + highlights endpoint responses ──────────
//
// Wave 3b (Agent B): keeps ig-schemas.ts lean. These parsers are only used
// by the public-data scraper path and map raw IG JSON into the domain shapes
// declared in ig-client-port.ts.
//
// Design follows the same conventions as ig-schemas.ts:
// - permissive on individual fields IG occasionally omits
// - strict on structural roots so a genuine breaking change is detected
// - passthrough on each node so unknown future fields are ignored, not fatal
// - every parse failure is surfaced as IGSchemaError so the circuit breaker
//   counts it as an outbound failure
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import {
  IGSchemaError,
  type IGHighlightReel,
  type IGHighlightsTray,
  type IGReelItem,
  type IGStoriesTray,
} from "./ig-client-port.js";

// ── Primitive coercers ──────────────────────────────────────────────────────

const looseNum = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? v : Number(v)))
  .pipe(z.number().finite())
  .catch(0);

const optionalString = z.string().nullable().optional();
const optionalBool = z.boolean().optional();

function fail(endpoint: string, issues: ReadonlyArray<z.ZodIssue>): never {
  const detail = issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  throw new IGSchemaError(
    endpoint,
    `[ig-schema] ${endpoint} response failed validation: ${detail}`,
  );
}

function assertSuccessfulEnvelope(raw: unknown, endpoint: string): void {
  if (raw && typeof raw === 'object' && (raw as { status?: unknown }).status === 'fail') {
    throw new IGSchemaError(endpoint, `[ig-schema] ${endpoint} returned a failed envelope`);
  }
}

// ── Shared image/video version shapes ──────────────────────────────────────

const ImageCandidateSchema = z
  .object({
    url: optionalString,
    width: looseNum.optional(),
    height: looseNum.optional(),
  })
  .passthrough();

const ImageVersionsSchema = z
  .object({
    candidates: z.array(ImageCandidateSchema).optional(),
  })
  .passthrough();

const VideoVersionSchema = z
  .object({
    url: optionalString,
    width: looseNum.optional(),
    height: looseNum.optional(),
    type: looseNum.optional(),
  })
  .passthrough();

// ── Reel item (story / highlight media) ────────────────────────────────────

const ReelItemSchema = z
  .object({
    id: optionalString,
    pk: optionalString,
    media_type: looseNum.optional(),
    taken_at: looseNum.optional(),
    expiring_at: looseNum.optional(),
    image_versions2: ImageVersionsSchema.nullable().optional(),
    video_versions: z.array(VideoVersionSchema).nullable().optional(),
  })
  .passthrough();

function mapReelItem(raw: z.infer<typeof ReelItemSchema>): IGReelItem {
  const id = raw.id ?? raw.pk ?? "";
  const candidates = raw.image_versions2?.candidates ?? [];
  // IG lists candidates best-quality-first.
  const bestImage = candidates.find((c) => typeof c.url === "string" && c.url);
  const imageUrl = bestImage?.url ?? null;
  // Last candidate is typically the lowest-res thumbnail.
  const thumbCandidate =
    candidates.length > 0 ? candidates[candidates.length - 1] : null;
  const thumbnailUrl = thumbCandidate?.url ?? imageUrl;
  const videoVersions = raw.video_versions ?? [];
  const bestVideo = videoVersions.find(
    (v) => typeof v.url === "string" && v.url,
  );
  return {
    id,
    mediaType: raw.media_type ?? 1,
    imageUrl,
    thumbnailUrl,
    videoUrl: bestVideo?.url ?? null,
    takenAt: raw.taken_at ?? 0,
    expiringAt: raw.expiring_at ?? 0,
  };
}

// ── Stories tray (reel_media) ──────────────────────────────────────────────
//
// Response shape can vary: sometimes top-level `items`, sometimes wrapped in
// `reel.items` or `user_story.reel.items`. We probe each known location.

const StoriesResponseSchema = z
  .object({
    items: z.array(ReelItemSchema).optional(),
    reel: z
      .object({
        items: z.array(ReelItemSchema).optional(),
      })
      .partial()
      .nullable()
      .optional(),
    user_story: z
      .object({
        reel: z
          .object({
            items: z.array(ReelItemSchema).optional(),
          })
          .partial()
          .nullable()
          .optional(),
      })
      .partial()
      .nullable()
      .optional(),
  })
  .passthrough();

export function parseStoriesResponse(raw: unknown): IGStoriesTray {
  assertSuccessfulEnvelope(raw, 'feed/user/reel_media');
  const result = StoriesResponseSchema.safeParse(raw);
  if (!result.success) fail("feed/user/reel_media", result.error.issues);
  const d = result.data;
  const items =
    d.items ??
    d.reel?.items ??
    d.user_story?.reel?.items;
  if (!items) throw new IGSchemaError('feed/user/reel_media', '[ig-schema] story items missing from response');
  return { items: items.map(mapReelItem) };
}

// ── Highlights tray (highlights_tray) ──────────────────────────────────────

const HighlightTrayNodeSchema = z
  .object({
    id: optionalString,
    title: optionalString,
    media_count: looseNum.optional(),
    cover_media: z
      .object({
        cropped_image_version: z
          .object({ url: optionalString })
          .partial()
          .nullable()
          .optional(),
        thumbnail_url: optionalString,
      })
      .partial()
      .nullable()
      .optional(),
  })
  .passthrough();

const HighlightsTrayResponseSchema = z
  .object({
    tray: z.array(HighlightTrayNodeSchema).optional(),
  })
  .passthrough();

export function parseHighlightsTrayResponse(
  raw: unknown,
): IGHighlightsTray {
  assertSuccessfulEnvelope(raw, 'highlights/tray');
  const result = HighlightsTrayResponseSchema.safeParse(raw);
  if (!result.success) fail("highlights/tray", result.error.issues);
  const tray = result.data.tray;
  if (!tray) throw new IGSchemaError('highlights/tray', '[ig-schema] highlight tray missing from response');
  const items = tray.map((n) => {
    const cropped = n.cover_media?.cropped_image_version?.url ?? null;
    const thumb = n.cover_media?.thumbnail_url ?? null;
    return {
      id: n.id ?? "",
      title: n.title ?? "",
      coverUrl: cropped ?? thumb,
      mediaCount: n.media_count ?? 0,
    };
  });
  return { items };
}

// ── Highlight reels (reels_media) ──────────────────────────────────────────

const HighlightReelNodeSchema = z
  .object({
    id: optionalString,
    items: z.array(ReelItemSchema).optional(),
  })
  .passthrough();

const HighlightReelsResponseSchema = z
  .object({
    reels: z.record(z.string(), HighlightReelNodeSchema).optional(),
    reels_media: z.array(HighlightReelNodeSchema).optional(),
  })
  .passthrough();

export function parseHighlightReelsResponse(
  raw: unknown,
): ReadonlyArray<IGHighlightReel> {
  assertSuccessfulEnvelope(raw, 'feed/reels_media');
  const result = HighlightReelsResponseSchema.safeParse(raw);
  if (!result.success) fail("feed/reels_media", result.error.issues);
  const d = result.data;
  if (!d.reels && !d.reels_media) throw new IGSchemaError('feed/reels_media', '[ig-schema] reels collection missing from response');
  const out: IGHighlightReel[] = [];

  if (d.reels_media && d.reels_media.length > 0) {
    for (const reel of d.reels_media) {
      if (!reel.id || !reel.items) throw new IGSchemaError('feed/reels_media', '[ig-schema] reel identity or items missing');
      out.push({
        id: reel.id ?? "",
        items: (reel.items ?? []).map(mapReelItem),
      });
    }
  }

  if (d.reels) {
    for (const [key, reel] of Object.entries(d.reels)) {
      if (!key || !reel.items || (reel.id && reel.id !== key)) throw new IGSchemaError('feed/reels_media', '[ig-schema] reel identity or items missing');
      // Avoid duplicates if IG echoed the same reel in both collections.
      if (out.some((r) => r.id === (reel.id ?? key))) continue;
      out.push({
        id: reel.id ?? key,
        items: (reel.items ?? []).map(mapReelItem),
      });
    }
  }

  return out;
}

// Kept exported for unit tests and potential reuse.
export const __internals = {
  mapReelItem,
  ReelItemSchema,
  HighlightTrayNodeSchema,
  HighlightReelNodeSchema,
  ImageVersionsSchema,
  VideoVersionSchema,
} as const;

// Ensure silent re-export paths type-check even if _optionalBool is unused.
void optionalBool;
