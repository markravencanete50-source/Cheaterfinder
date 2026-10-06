import crypto from "crypto";
import { sql, relations } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  bigint,
  bigserial,
  jsonb,
  pgEnum,
  index,
  foreignKey,
  uniqueIndex,
  date,
  primaryKey,
  check,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
]);

export const subscriptionPlanEnum = pgEnum("subscription_plan", [
  "weekly",
  "monthly",
  "starter",
  "standard",
  "pro",
]);

export const postTypeEnum = pgEnum("post_type", [
  "photo",
  "video",
  "reel",
  "carousel",
  "story",
  // Wave 4: posts where the tracked user has been *tagged* by other accounts.
  "tagged_post",
]);

export const reportTypeEnum = pgEnum("report_type", ["weekly", "monthly"]);

export const reportStatusEnum = pgEnum("report_status", [
  "generating",
  "ready",
  "failed",
]);

export const notificationTypeEnum = pgEnum("notification_type", [
  "new_like",
  "new_follow",
  "new_unfollow",
  "report_ready",
  "subscription_updated",
  "trial_ending",
  "payment_failed",
  "access_granted",
  "access_pending",
]);

export const jobTypeEnum = pgEnum("job_type", [
  "profile",
  "likes",
  "follows",
  "report",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const botStatusEnum = pgEnum("bot_status", [
  "available",
  "in_use",
  "cooldown",
  "disabled",
  "banned",
  // Wave 2: distinct from "banned" — the bot's Playwright session has
  // expired and the admin needs to upload a fresh sessionData blob. Bot is
  // excluded from assignment while in this state. See PATCH /api/admin/bots/:id/session.
  "session_expired",
]);

export const followRequestStatusEnum = pgEnum("follow_request_status", [
  "queued",
  "pending",
  "accepted",
  "rejected",
  "expired",
  "failed",
]);

export const accessStatusEnum = pgEnum("access_status", [
  "public",
  "pending_access",
  "has_access",
  "access_denied",
]);

export const mediaAssetStatusEnum = pgEnum("media_asset_status", [
  "pending",
  "cached",
  "failed",
]);

// Wave 6: bot tier system. Limits blast radius by sending experimental
// traffic to canary bots first; workers only run pool-approved endpoints.
//   canary  - probes new endpoints on behalf of the worker pool
//   worker  - main rotation, only runs pool-approved endpoints
//   reserve - warmed but inactive (NEVER picked by assignment logic)
//   retired - permanently disabled (banned, irrecoverable session, etc.)
export const botTierEnum = pgEnum("bot_tier", [
  "canary",
  "worker",
  "reserve",
  "retired",
]);

// Wave 9: bot role. Separates the default scraper/follow-rotation pool from the
// dedicated "liked-by inference" WATCHERS. Watchers follow tracked users and
// poll their own home-feed / reels feeds for the "people you follow who liked
// this" facepile, which is matched back to tracked accounts. Default 'scraper'
// so existing bots keep their current behaviour; ops promotes watchers via
// server/scripts/assign-liked-by-roles.ts.
//   scraper       - normal public-data / follow-rotation bot (default)
//   feed_watcher  - polls POST /api/v1/feed/timeline/ for liked-by facepiles
//   reels_watcher - polls POST /api/v1/clips/discover/ for liked-by facepiles
export const botRoleEnum = pgEnum("bot_role", [
  "scraper",
  "feed_watcher",
  "reels_watcher",
]);

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: varchar("id", { length: 36 })
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  hashedPassword: text("hashed_password"),
  trialUsedAt: timestamp("trial_used_at", { withTimezone: true }),
  rescueDiscountOfferedAt: timestamp("rescue_discount_offered_at", { withTimezone: true }),
  sessionVersion: integer("session_version").notNull().default(0),
  // C2: authorization role. Admin access is granted by this column, never by
  // matching a (user-editable) email against ADMIN_EMAIL. Values: 'user' | 'admin'.
  role: varchar("role", { length: 16 }).notNull().default("user"),
  // Notification preferences (migration 0032). Defaults match the historical
  // client defaults so existing users see no change: email on, push off.
  emailAlerts: boolean("email_alerts").notNull().default(true),
  pushNotifications: boolean("push_notifications").notNull().default(false),
  onboardingAcknowledgedAt: timestamp("onboarding_acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const transactionalEmails = pgTable("transactional_emails", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  skippedAt: timestamp("skipped_at", { withTimezone: true }),
  providerId: text("provider_id"),
  lastError: text("last_error"),
}, table => [index("transactional_emails_pending_idx").on(table.nextAttemptAt).where(sql`${table.acceptedAt} IS NULL AND ${table.skippedAt} IS NULL`)]);

// ─── Sessions (connect-pg-simple standard schema) ────────────────────────────

export const sessions = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: text("sess").notNull(),
    expire: timestamp("expire", { withTimezone: false }).notNull(),
  },
  (table) => [
    index("IDX_session_expire").on(table.expire),
    index("idx_session_legacy_user").on(sql`(${table.sess}::jsonb #>> '{passport,user}')`),
    index("idx_session_versioned_user").on(sql`(${table.sess}::jsonb #>> '{passport,user,id}')`),
  ],
);

// ─── Subscriptions ────────────────────────────────────────────────────────────

export const customerBillingLinks = pgTable("customer_billing_links", {
  userId: varchar("user_id", { length: 36 }).primaryKey().references(() => users.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const billingRetentionOffers = pgTable("billing_retention_offers", {
  userId: varchar("user_id", { length: 36 }).primaryKey().references(() => users.id, { onDelete: "cascade" }),
  offerId: uuid("offer_id").notNull().unique(),
  subscriptionId: text("subscription_id").notNull(),
  customerId: text("customer_id").notNull(),
  state: text("state").notNull(),
  fingerprint: text("fingerprint").notNull(),
  updateParams: jsonb("update_params").notNull(),
  currency: text("currency").notNull(),
  amount: integer("amount").notNull(),
  regularAmount: integer("regular_amount").notNull(),
  regularInvoiceTotal: integer("regular_invoice_total"),
  offerCreditApplied: integer("offer_credit_applied"),
  trial: boolean("trial").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [check("billing_retention_offers_state_check", sql`${table.state} IN ('quoted', 'pending', 'applied')`)]);

export const billingTrialPayments = pgTable("billing_trial_payments", {
  id: uuid("id").primaryKey(),
  userId: varchar("user_id", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
  customerId: text("customer_id").notNull(),
  subscriptionId: text("subscription_id").notNull().unique(),
  checkoutSessionId: text("checkout_session_id").notNull().unique(),
  invoiceId: text("invoice_id").notNull().unique(),
  paymentIntentId: text("payment_intent_id").notNull().unique(),
  policyVersion: text("policy_version").notNull(),
  cancellationPolicy: text("cancellation_policy").notNull(),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }).notNull(),
  currency: text("currency").notNull(),
  amount: integer("amount").notNull(),
  state: text("state").notNull(),
  creditParams: jsonb("credit_params").notNull(),
  creditRequestedAt: timestamp("credit_requested_at", { withTimezone: true }),
  creditTransactionId: text("credit_transaction_id").unique(),
  creditReversalTransactionId: text("credit_reversal_transaction_id").unique(),
  creditReversalParams: jsonb("credit_reversal_params"),
  creditReversalRequestedAt: timestamp("credit_reversal_requested_at", { withTimezone: true }),
  creditCompensationParams: jsonb("credit_compensation_params"),
  creditCompensationRequestedAt: timestamp("credit_compensation_requested_at", { withTimezone: true }),
  creditCompensationTransactionId: text("credit_compensation_transaction_id").unique(),
  refundRequestedAt: timestamp("refund_requested_at", { withTimezone: true }),
  refundParams: jsonb("refund_params"),
  refundId: text("refund_id").unique(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
  creditedAt: timestamp("credited_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("idx_billing_trial_payments_user_id").on(table.userId),
  index("idx_billing_trial_payments_customer_id").on(table.customerId),
  check("billing_trial_payments_amount_check", sql`${table.amount} = 99`),
  check("billing_trial_payments_currency_check", sql`${table.currency} = 'usd'`),
  check("billing_trial_payments_cancellation_policy_check", sql`${table.cancellationPolicy} IN ('refund_during_trial', 'retain_credit')`),
  check("billing_trial_payments_state_check", sql`${table.state} IN ('paid', 'credit_pending', 'credited', 'refund_pending', 'refunded', 'reversal_pending', 'compensation_pending', 'manual_review')`),
]);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    status: subscriptionStatusEnum("status").notNull().default("trialing"),
    plan: subscriptionPlanEnum("plan"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    trialPaymentPolicy: text("trial_payment_policy"),
    trialCancellationPolicy: text("trial_cancellation_policy"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_subscriptions_user_id").on(table.userId),
    index("idx_subscriptions_stripe_customer_id").on(table.stripeCustomerId),
  ],
);

// ─── Tracked Accounts ─────────────────────────────────────────────────────────

export const trackedAccounts = pgTable(
  "tracked_accounts",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    igUsername: text("ig_username").notNull(),
    displayName: text("display_name"),
    profilePicUrl: text("profile_pic_url"),
    biography: text("biography"),
    externalUrl: text("external_url"),
    isVerified: boolean("is_verified").default(false),
    isBusinessAccount: boolean("is_business_account").default(false),
    followerCount: integer("follower_count").default(0),
    isActive: boolean("is_active").notNull().default(true),
    isPrivate: boolean("is_private").notNull().default(false),
    accessStatus: accessStatusEnum("access_status").notNull().default("public"),
    // IG numeric user PK — required for followers/following/stories/highlights endpoints
    igUserId: text("ig_user_id"),
    // Last time the profile (bio/counts/avatar) was refreshed. Anchors the
    // per-dimension refresh sweep so a profile is re-scraped once this goes
    // older than the profile TTL. Backs idx_tracked_accounts_last_profile_refresh.
    // Column pre-exists in the live DB (created via runtime/manual DDL).
    lastProfileRefreshAt: timestamp("last_profile_refresh_at", {
      withTimezone: true,
    }),
    // Last time the tracked user's OWN content (posts/stories/highlights) was
    // refreshed. Anchors the content refresh sweep. Backs
    // idx_tracked_accounts_last_content_refresh. Column pre-exists in the live DB.
    lastContentRefreshAt: timestamp("last_content_refresh_at", {
      withTimezone: true,
    }),
    // Last time the follow graph (followers/following) was actually enumerated.
    // Anchors the diff-aware force-full valve: a stable account is re-enumerated
    // once this goes older than the TTL, and this advances on EVERY successful
    // enumeration (even no-op ones that write no new events), so the valve can
    // settle instead of firing every cycle. Column pre-exists in the DB.
    lastGraphRefreshAt: timestamp("last_graph_refresh_at", { withTimezone: true }),
    // Per-roster enumeration anchors (migration 0025). The two rosters are
    // INDEPENDENT: an un-enumerable followers list must never make the following
    // roster look un-synced. lastGraphRefreshAt above only advances when BOTH
    // sides complete, so relying on it for a single roster's trust hid real
    // unfollow events (see computeRosterSyncState / isUnfollowRosterTrusted).
    // Each of these advances when THAT roster's own walk completes.
    lastFollowingRefreshAt: timestamp("last_following_refresh_at", {
      withTimezone: true,
    }),
    lastFollowersRefreshAt: timestamp("last_followers_refresh_at", {
      withTimezone: true,
    }),
    // When the FOLLOWING roster was first completely enumerated (migration 0027).
    // Before this instant, follow_events are roster DISCOVERY (one per already-
    // followed account); after it we hold the whole roster, so each event is a
    // genuinely new follow. Used to keep "Recently followed" honest instead of
    // dumping 16k discovery rows for an account that follows 1k.
    followingFirstCompleteAt: timestamp("following_first_complete_at", {
      withTimezone: true,
    }),
    // Cursor-based older-post pagination for the on-demand "Load more" path.
    // postsNextCursor = IG next_max_id to continue paging OLDER posts from (so a
    // click fetches only the next page, not re-paging from the top);
    // postsPaginationDone = true once IG has no more older posts to return.
    postsNextCursor: text("posts_next_cursor"),
    postsPaginationDone: boolean("posts_pagination_done")
      .notNull()
      .default(false),
    // Persistent cursor for relationship-based liked-post evidence scans.
    // Without it every job re-scanned the same newest following accounts, so
    // the liked-post count stalled even though the worker kept running.
    likeEvidenceCursor: integer("like_evidence_cursor")
      .notNull()
      .default(20),
    lastLikeEvidenceScanAt: timestamp("last_like_evidence_scan_at", {
      withTimezone: true,
    }),
    trackingStarted: timestamp("tracking_started", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_tracked_accounts_user_id").on(table.userId),
    index("idx_tracked_accounts_ig_username").on(table.igUsername),
    index("idx_tracked_accounts_user_active").on(table.userId, table.isActive),
    index("idx_tracked_accounts_ig_user_id").on(table.igUserId),
    // Per-dimension refresh-sweep anchors. These three indexes pre-exist in the
    // live DB (created via runtime/manual DDL); declared here so drizzle-kit
    // push does not propose dropping them.
    index("idx_tracked_accounts_last_profile_refresh").on(
      table.lastProfileRefreshAt,
    ),
    index("idx_tracked_accounts_last_content_refresh").on(
      table.lastContentRefreshAt,
    ),
    index("idx_tracked_accounts_last_graph_refresh").on(
      table.lastGraphRefreshAt,
    ),
    index("idx_tracked_accounts_last_following_refresh").on(table.lastFollowingRefreshAt),
    index("idx_tracked_accounts_last_followers_refresh").on(table.lastFollowersRefreshAt),
    index("idx_tracked_accounts_following_first_complete").on(table.followingFirstCompleteAt),
  ],
);

// ─── Profile Snapshots ────────────────────────────────────────────────────────

export const profileSnapshots = pgTable(
  "profile_snapshots",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    igUsername: text("ig_username").notNull(),
    followerCount: integer("follower_count").notNull().default(0),
    followingCount: integer("following_count").notNull().default(0),
    postCount: integer("post_count").notNull().default(0),
    // Rich profile fields captured at snapshot time
    fullName: text("full_name"),
    biography: text("biography"),
    profilePicUrl: text("profile_pic_url"),
    profilePicUrlHd: text("profile_pic_url_hd"),
    externalUrl: text("external_url"),
    isVerified: boolean("is_verified").default(false),
    isBusinessAccount: boolean("is_business_account").default(false),
    isPrivate: boolean("is_private").default(false),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_profile_snapshots_tracked_account_id").on(
      table.trackedAccountId,
    ),
    index("idx_profile_snapshots_snapshot_at").on(table.snapshotAt),
  ],
);

// ─── Like Events ──────────────────────────────────────────────────────────────

export const likeEvents = pgTable(
  "like_events",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    postId: text("post_id").notNull(),
    ownerUsername: text("owner_username").notNull(),
    postType: postTypeEnum("post_type").notNull().default("photo"),
    caption: text("caption"),
    thumbnailUrl: text("thumbnail_url"),
    postUrl: text("post_url"),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    likesCount: integer("likes_count"),
    commentsCount: integer("comments_count"),
    videoViewCount: integer("video_view_count"),
    locationName: text("location_name"),
    /**
     * When we INFERRED the like — not when the post was published. Ordering
     * surfaces by this put a week-old post above one published this morning
     * purely because we noticed it later. Use postTakenAt for post recency.
     */
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * When the liked POST was published (IG `taken_at`). NULL for rows captured
     * before migration 0030 — readers COALESCE to detectedAt.
     */
    postTakenAt: timestamp("post_taken_at", { withTimezone: true }),
    evidenceSource: jsonb("evidence_source").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("idx_like_events_tracked_account_id").on(table.trackedAccountId),
    index("idx_like_events_detected_at").on(table.detectedAt),
    // Backs the newest-post-first ordering (migration 0030).
    index("idx_like_events_account_post_taken").on(
      table.trackedAccountId,
      table.postTakenAt,
    ),
    index("idx_like_events_post_id").on(table.postId),
    index("idx_like_events_account_detected").on(table.trackedAccountId, table.detectedAt),
    // D15: a like_event is unique per (tracked account, post) — an account can
    // like a post at most once. Matches the like_events_tracked_post_unique
    // constraint added in migration 0021 and arbitrated by the ON CONFLICT
    // DO NOTHING inserts in server/workers.ts.
    uniqueIndex("like_events_tracked_post_unique").on(
      table.trackedAccountId,
      table.postId,
    ),
  ],
);

// ─── Follow Events ────────────────────────────────────────────────────────────

export const followEvents = pgTable(
  "follow_events",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    followedUsername: text("followed_username").notNull(),
    followedDisplayName: text("followed_display_name"),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_follow_events_tracked_account_id").on(table.trackedAccountId),
    index("idx_follow_events_detected_at").on(table.detectedAt),
    index("idx_follow_events_account_detected").on(table.trackedAccountId, table.detectedAt),
    // Backs the SQL known-set reconstruction + case-insensitive lookups
    // (migration 0019_event_dedupe_unique.sql).
    index("idx_follow_events_account_lower_username").on(
      table.trackedAccountId,
      sql`lower(${table.followedUsername})`,
      table.detectedAt,
    ),
  ],
);

// ─── Unfollow Events ──────────────────────────────────────────────────────────

export const unfollowEvents = pgTable(
  "unfollow_events",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    unfollowedUsername: text("unfollowed_username").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_unfollow_events_tracked_account_id").on(table.trackedAccountId),
    index("idx_unfollow_events_detected_at").on(table.detectedAt),
    index("idx_unfollow_events_account_detected").on(table.trackedAccountId, table.detectedAt),
    // Backs the SQL known-set reconstruction (migration 0019).
    index("idx_unfollow_events_account_lower_username").on(
      table.trackedAccountId,
      sql`lower(${table.unfollowedUsername})`,
      table.detectedAt,
    ),
  ],
);

// ─── Inbound Follower Events (someone followed the tracked user) ─────────────

export const followerEvents = pgTable(
  "follower_events",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    followerUsername: text("follower_username").notNull(),
    followerDisplayName: text("follower_display_name"),
    followerIgUserId: text("follower_ig_user_id"),
    followerPfpUrl: text("follower_pfp_url"),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_follower_events_tracked_account_id").on(table.trackedAccountId),
    index("idx_follower_events_detected_at").on(table.detectedAt),
    index("idx_follower_events_account_detected").on(
      table.trackedAccountId,
      table.detectedAt,
    ),
    // Backs the SQL known-set reconstruction + the case-insensitive
    // unfollower-detail lookup (D12) — migration 0019.
    index("idx_follower_events_account_lower_username").on(
      table.trackedAccountId,
      sql`lower(${table.followerUsername})`,
      table.detectedAt,
    ),
  ],
);

// ─── Inbound Follower Unfollow Events (someone unfollowed the tracked user) ──

export const followerUnfollowEvents = pgTable(
  "follower_unfollow_events",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    unfollowerUsername: text("unfollower_username").notNull(),
    unfollowerDisplayName: text("unfollower_display_name"),
    unfollowerIgUserId: text("unfollower_ig_user_id"),
    unfollowerPfpUrl: text("unfollower_pfp_url"),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_follower_unfollow_events_tracked_account_id").on(
      table.trackedAccountId,
    ),
    index("idx_follower_unfollow_events_detected_at").on(table.detectedAt),
    index("idx_follower_unfollow_events_account_detected").on(
      table.trackedAccountId,
      table.detectedAt,
    ),
    // Backs the SQL known-set reconstruction (migration 0019).
    index("idx_follower_unfollow_events_account_lower_username").on(
      table.trackedAccountId,
      sql`lower(${table.unfollowerUsername})`,
      table.detectedAt,
    ),
  ],
);

// ─── Posts Cache (tracked user's OWN posts, not their liked posts) ───────────

// Ordered child media for carousel/sidecar posts. NULL on single-media posts.
export type CarouselMediaChild = {
  mediaId?: string;
  type: "photo" | "video";
  displayUrl: string;
  videoUrl: string | null;
};

export const postsCache = pgTable(
  "posts_cache",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    shortcode: text("shortcode").notNull(),
    mediaId: text("media_id"),
    postType: postTypeEnum("post_type").notNull().default("photo"),
    thumbnailUrl: text("thumbnail_url"),
    displayUrl: text("display_url"),
    videoUrl: text("video_url"),
    caption: text("caption"),
    likeCount: integer("like_count").default(0),
    commentCount: integer("comment_count").default(0),
    videoViewCount: integer("video_view_count"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    locationName: text("location_name"),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    isPinned: boolean("is_pinned").notNull().default(false),
    carouselMedia: jsonb("carousel_media").$type<CarouselMediaChild[]>(),
    cachedAt: timestamp("cached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_posts_cache_tracked_account_id").on(table.trackedAccountId),
    index("idx_posts_cache_account_taken").on(
      table.trackedAccountId,
      table.takenAt,
    ),
    uniqueIndex("idx_posts_cache_account_shortcode").on(
      table.trackedAccountId,
      table.shortcode,
    ),
  ],
);

// ─── Stories Cache (active stories, 24h TTL) ─────────────────────────────────

export const storiesCache = pgTable(
  "stories_cache",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull(),
    mediaType: text("media_type").notNull(),
    mediaUrl: text("media_url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_stories_cache_tracked_account_id").on(table.trackedAccountId),
    index("idx_stories_cache_expires_at").on(table.expiresAt),
    uniqueIndex("idx_stories_cache_account_story").on(
      table.trackedAccountId,
      table.storyId,
    ),
  ],
);

// ─── Highlights Cache ────────────────────────────────────────────────────────

export const highlightsCache = pgTable(
  "highlights_cache",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    highlightId: text("highlight_id").notNull(),
    title: text("title").notNull(),
    coverUrl: text("cover_url"),
    mediaCount: integer("media_count").default(0),
    cachedAt: timestamp("cached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_highlights_cache_tracked_account_id").on(table.trackedAccountId),
    uniqueIndex("idx_highlights_cache_account_highlight").on(
      table.trackedAccountId,
      table.highlightId,
    ),
  ],
);

// ─── Highlight Items Cache (inner items of a highlight) ──────────────────────

export const highlightItemsCache = pgTable(
  "highlight_items_cache",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    highlightCacheId: varchar("highlight_cache_id", { length: 36 })
      .notNull()
      .references(() => highlightsCache.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull(),
    mediaType: text("media_type").notNull(),
    mediaUrl: text("media_url"),
    thumbnailUrl: text("thumbnail_url"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    cachedAt: timestamp("cached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_highlight_items_cache_highlight").on(table.highlightCacheId),
  ],
);

// ─── Media Assets Cache ──────────────────────────────────────────────────────
//
// Stores the server-owned copy of Instagram CDN media referenced by profiles,
// posts, stories, and highlights. Instagram CDN URLs are signed and expire, so
// viewer routes should prefer these stable cached assets whenever available.

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    originalUrl: text("original_url").notNull(),
    cacheKey: text("cache_key").notNull(),
    localPath: text("local_path"),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    status: mediaAssetStatusEnum("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_media_assets_original_url").on(table.originalUrl),
    uniqueIndex("idx_media_assets_cache_key").on(table.cacheKey),
    index("idx_media_assets_status").on(table.status),
    index("idx_media_assets_updated_at").on(table.updatedAt),
  ],
);

// ─── Comments Cache (actual comment text on tracked posts) ───────────────────
//
// Wave 5: comments_cache stores the comment objects scraped from
// /api/v1/media/<media_id>/comments/. Keyed by (post_shortcode, ig_comment_pk)
// so re-scrapes are idempotent — ON CONFLICT DO NOTHING preserves the
// original cached_at instead of overwriting historical timestamps.
//
// Note: this table is NOT FK-bound to posts_cache because the same
// post_shortcode can appear in posts_cache for multiple tracked accounts
// (e.g. a tagged post). The route handler enforces ownership via a join.

export const commentsCache = pgTable(
  "comments_cache",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    postShortcode: text("post_shortcode").notNull(),
    igCommentPk: text("ig_comment_pk").notNull(),
    authorUsername: text("author_username").notNull(),
    authorDisplayName: text("author_display_name"),
    authorPfpUrl: text("author_pfp_url"),
    text: text("text").notNull(),
    likeCount: integer("like_count").notNull().default(0),
    createdAtIg: timestamp("created_at_ig", { withTimezone: true }),
    cachedAt: timestamp("cached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_comments_post").on(table.postShortcode, table.createdAtIg),
    uniqueIndex("comments_cache_post_shortcode_ig_comment_pk_key").on(
      table.postShortcode,
      table.igCommentPk,
    ),
  ],
);

export type CommentRow = typeof commentsCache.$inferSelect;

// ─── Likers Cache (users who liked a tracked post) ───────────────────────────
//
// Wave 5: likers_cache stores the users surfaced by
// /api/v1/media/<media_id>/likers/. Keyed by (post_shortcode, liker_username)
// so re-scrapes are idempotent — ON CONFLICT DO NOTHING preserves the
// original cached_at instead of overwriting historical timestamps.
//
// IG caps the likers endpoint at roughly 100 users and exposes no pagination
// cursor, so we persist whatever we receive in a single page. Like
// commentsCache, this table is intentionally not FK-bound to posts_cache:
// the same post_shortcode can appear under multiple tracked_accounts (e.g.
// tagged posts). Ownership is enforced at the route layer via a join.

export const likersCache = pgTable(
  "likers_cache",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    postShortcode: text("post_shortcode").notNull(),
    likerUsername: text("liker_username").notNull(),
    likerDisplayName: text("liker_display_name"),
    likerPfpUrl: text("liker_pfp_url"),
    likerIgUserId: text("liker_ig_user_id"),
    isVerified: boolean("is_verified").default(false),
    cachedAt: timestamp("cached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_likers_post").on(table.postShortcode, table.cachedAt),
    index("idx_likers_cache_lower_username").on(sql`lower(${table.likerUsername})`),
    uniqueIndex("likers_cache_post_shortcode_liker_username_key").on(
      table.postShortcode,
      table.likerUsername,
    ),
  ],
);

export type LikerRow = typeof likersCache.$inferSelect;

// ─── Reports ──────────────────────────────────────────────────────────────────

export const reports = pgTable(
  "reports",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    type: reportTypeEnum("type").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: reportStatusEnum("status").notNull().default("generating"),
    totalLikes: integer("total_likes").notNull().default(0),
    totalFollows: integer("total_follows").notNull().default(0),
    totalUnfollows: integer("total_unfollows").notNull().default(0),
    topNiche: text("top_niche"),
    peakActivityHour: integer("peak_activity_hour"),
    // Rich, HONEST payload from buildReportData (migration 0028). The total_*
    // columns above come from event tables that record roster DISCOVERY, so they
    // can read wildly wrong (a 674-follower account showed "+3,251 new
    // followers"). `metrics` derives growth from profile snapshots and carries
    // trust flags — prefer it everywhere; total_* are legacy.
    metrics: jsonb("metrics"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_reports_tracked_account_id").on(table.trackedAccountId),
    index("idx_reports_created_at").on(table.createdAt),
    index("idx_reports_account_created").on(table.trackedAccountId, table.createdAt.desc()),
  ],
);

// ─── Notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    isRead: boolean("is_read").notNull().default(false),
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_notifications_user_id").on(table.userId),
    uniqueIndex("idx_notifications_dedupe_key").on(table.dedupeKey),
    index("idx_notifications_is_read").on(table.isRead),
    index("idx_notifications_created_at").on(table.createdAt),
    // Partial index backing the unread-inbox hot path (migration
    // 0001_wave1_hardening). Pre-exists in the live DB.
    index("idx_notifications_user_unread")
      .on(table.userId, table.isRead, table.createdAt.desc())
      .where(sql`${table.isRead} = false`),
  ],
);

// ─── Device Tokens (push notifications) ──────────────────────────────────────
//
// One row per installed app instance. A user can have several (phone + tablet,
// or a reinstall before the old token expires), so this is one-to-many and the
// token itself is the natural key — Expo re-issues the same token to the same
// install, and a token can migrate between users if a device is shared, which
// the unique constraint plus an upsert on conflict handles correctly.

export const devicePlatformEnum = pgEnum("device_platform", [
  "ios",
  "android",
]);

export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /**
     * No FK to users.id: the application role owns public.users but its ACL is
     * {cheaterfinder=arwd/cheaterfinder} — REFERENCES was deliberately revoked, so the
     * constraint cannot be created without widening privileges on a production
     * database. Rows are instead deleted alongside the account (see the
     * DELETE /api/account handler). Migration 0036 documents how a DBA can add
     * the constraint later.
     */
    userId: varchar("user_id", { length: 36 }).notNull(),
    /** Expo push token, e.g. ExponentPushToken[xxxxxxxx]. */
    token: text("token").notNull().unique(),
    platform: devicePlatformEnum("platform").notNull(),
    /** Bumped on every re-register so stale installs can be pruned. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_device_tokens_user_id").on(table.userId),
  ],
);

// ─── Collection Jobs ──────────────────────────────────────────────────────────

export const collectionJobs = pgTable(
  "collection_jobs",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    jobType: jobTypeEnum("job_type").notNull(),
    status: jobStatusEnum("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    index("idx_collection_jobs_tracked_account_id").on(table.trackedAccountId),
    index("idx_collection_jobs_status").on(table.status),
  ],
);

// ─── Password Reset Tokens ───────────────────────────────────────────────────

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).notNull().unique(),
    // Fix #17: timestamptz columns to match every other table in the schema.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_prt_user_id").on(table.userId)],
);

// ─── Bot Accounts ────────────────────────────────────────────────────────────

export const botAccounts = pgTable(
  "bot_accounts",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    igUsername: text("ig_username").notNull().unique(),
    igUserId: text("ig_user_id"),
    displayName: text("display_name"),
    // sessionData is empty until the auto-login worker establishes cookies for
    // the first time. Store as encrypted envelope (server/crypto/session-envelope).
    sessionData: text("session_data"),
    // Python-owned Firefox identity.  This is minted once by the local FastAPI
    // service and persisted per bot; TypeScript treats it as opaque JSON and
    // never replaces its UA/TLS fields with the legacy device-fingerprint pool.
    automationIdentity: jsonb("automation_identity"),
    // Explicit ops-assigned fixed-IP account lane. Short provider leases live
    // in proxyEndpoint/proxyExpiresAt and must never be written here.
    proxyUrl: text("proxy_url"),
    // ─── Wave 4: auto-login credentials ──────────────────────────────────────
    // Encrypted via AES-256-GCM envelope (server/crypto/credentials.ts). The
    // worker decrypts these only inside the login routine and never logs them.
    igPasswordEncrypted: text("ig_password_encrypted"),
    emailAddress: text("email_address"),
    emailPasswordEncrypted: text("email_password_encrypted"),
    imapHost: text("imap_host").default("imap.rambler.ru"),
    imapPort: integer("imap_port").default(993),
    // ─── Wave 7: TOTP / Google Authenticator-style 2FA ───────────────────────
    // AES-256-GCM credential envelope for new imports; legacy Base32 accepted.
    // Shared secret captured at bot provisioning time. Used by
    // the auto-login worker (server/services/totp.ts) to generate the current
    // 6-digit code when IG presents a 2FA prompt. NULL means this bot either
    // uses the email-OTP path or has no 2FA configured. Whitespace in the
    // value is tolerated — bot-login normalizes before generating codes.
    totpSecret: text("totp_secret"),
    // ─── Wave 4: sticky proxy assignment ─────────────────────────────────────
    // proxyEndpoint is "host:port" form fetched from the rotating provider API.
    // It expires every proxyExpiresAt window (default 30 min sticky upstream).
    proxyEndpoint: text("proxy_endpoint"),
    proxySessionId: text("proxy_session_id"),
    proxyExpiresAt: timestamp("proxy_expires_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginError: text("last_login_error"),
    loginAttemptCount: integer("login_attempt_count").notNull().default(0),
    // Migration 0044: retain failure escalation across process restarts.
    consecutiveHardFailures: integer("consecutive_hard_failures").notNull().default(0),
    lastHardFailureAt: timestamp("last_hard_failure_at", { withTimezone: true }),
    status: botStatusEnum("status").notNull().default("available"),
    maxFollows: integer("max_follows").notNull().default(5),
    currentFollows: integer("current_follows").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    // Wave 3: per-bot persistent device fingerprint. Generated deterministically
    // from the username the first time the bot is used so it survives restarts
    // and looks like a real, consistent browser install.
    deviceId: text("device_id"),
    deviceUserAgent: text("device_user_agent"),
    igAppId: text("ig_app_id").default("936619743392459"),
    timezone: text("timezone").default("America/New_York"),
    locale: text("locale").default("en-US"),
    // Wave 3: circadian awake window in the bot's own timezone.
    awakeHourStart: integer("awake_hour_start").default(10),
    awakeHourEnd: integer("awake_hour_end").default(23),
    // Wave 3: daily caps below IG's soft limits. Reset each UTC-day rollover.
    dailyFollowsUsed: integer("daily_follows_used").default(0),
    dailyProfileViewsUsed: integer("daily_profile_views_used").default(0),
    dailyCountersResetAt: timestamp("daily_counters_reset_at", {
      withTimezone: true,
    }).defaultNow(),
    // Wave 6: bot account warming. Fresh bot accounts get checkpoint-blocked
    // by IG on stories/highlights/reels/tagged endpoints; warming_day tracks
    // how many low-volume daily sessions the bot has completed (0..7).
    // Capped at 7 = fully warmed; the scheduler stops enqueueing warm jobs.
    warmingDay: integer("warming_day").notNull().default(0),
    lastWarmingAt: timestamp("last_warming_at", { withTimezone: true }),
    warmFailureStreak: integer("warm_failure_streak").notNull().default(0),
    // Wave 6: blast-radius control. Defaults to 'reserve' so freshly seeded
    // bots never enter rotation by accident — ops promotes to 'worker' or
    // 'canary' explicitly via setBotTier(). See server/bot-manager.ts.
    tier: botTierEnum("tier").notNull().default("reserve"),
    // Wave 9: liked-by inference squad role. Defaults to 'scraper' so existing
    // bots keep their current behaviour. Promote watchers via
    // server/scripts/assign-liked-by-roles.ts. See migration 0024.
    role: botRoleEnum("role").notNull().default("scraper"),
    // Read transport discriminator (migration 0038). 'web' (default) drives the
    // Playwright/Firefox web session; 'mobile' drives a pre-authenticated
    // Bearer IGT:2 session via server/ig-mobile-read-client.ts. Mobile bots need
    // no automation_identity and no csrftoken.
    transport: text("transport").notNull().default("web"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_bot_accounts_status").on(table.status),
    index("idx_bot_accounts_tier").on(table.tier),
    // Wave 9: watcher-squad lookup (role = feed_watcher / reels_watcher).
    index("idx_bot_accounts_role").on(table.role),
    // Migration 0038: mobile vs web transport routing.
    index("idx_bot_accounts_transport").on(table.transport),
    // Partial index for the bot-assignment hot path (migration
    // 0001_wave1_hardening). Only indexes assignable bots. Pre-exists live.
    index("idx_bot_accounts_assignment")
      .on(table.status, table.cooldownUntil)
      .where(sql`${table.status} = 'available'`),
    // Partial index for the proxy-rotation sweep — only bots with an active
    // sticky proxy window. Pre-exists in the live DB (runtime/manual DDL).
    index("idx_bot_accounts_proxy_expires")
      .on(table.proxyExpiresAt)
      .where(sql`${table.proxyExpiresAt} IS NOT NULL`),
    // Partial index for the warming scheduler — only not-yet-fully-warmed
    // bots (warming_day < 7). Pre-exists in the live DB.
    index("idx_bot_accounts_warming_day")
      .on(table.warmingDay)
      .where(sql`${table.warmingDay} < 7`),
  ],
);

// ─── Endpoint Canary State (Wave 6) ──────────────────────────────────────────
//
// Tracks how the canary tier has fared on a given Instagram endpoint. Workers
// refuse to call endpoints where pool_approved=false. The canary protocol
// flips pool_approved=true once the canary has tested an endpoint at least 3
// times in the last 24h with >= 80% success rate. See
// server/services/canary-protocol.ts.

export const endpointCanaryState = pgTable(
  "endpoint_canary_state",
  {
    endpoint: text("endpoint").primaryKey(),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    poolApproved: boolean("pool_approved").notNull().default(false),
    poolApprovedAt: timestamp("pool_approved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_endpoint_canary_pool_approved").on(table.poolApproved),
  ],
);

export type EndpointCanaryStateRow = typeof endpointCanaryState.$inferSelect;

// ─── Endpoint Strikes / Auto-Disable (Wave 6) ────────────────────────────────
//
// Records auth-class failures (401/403/checkpoint_required/auth_rejected/CSRF)
// per (endpoint, bot). When the same endpoint accumulates strikes from 3
// distinct bots within a rolling 1-hour window, server/services/endpoint-
// strikes.ts inserts a row into endpoint_disabled with enabled_again_at =
// now() + 24h. The scrape path consults isEndpointDisabled() before each call
// and fails fast with EndpointDisabledError to prevent cascading bans.

export const endpointStrikes = pgTable(
  "endpoint_strikes",
  {
    endpoint: text("endpoint").notNull(),
    botId: varchar("bot_id", { length: 36 }).notNull(),
    failedAt: timestamp("failed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_endpoint_strikes_endpoint_at").on(
      table.endpoint,
      table.failedAt,
    ),
  ],
);

export type EndpointStrikeRow = typeof endpointStrikes.$inferSelect;

export const endpointDisabled = pgTable("endpoint_disabled", {
  endpoint: text("endpoint").primaryKey(),
  disabledAt: timestamp("disabled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  enabledAgainAt: timestamp("enabled_again_at", {
    withTimezone: true,
  }).notNull(),
  reason: text("reason"),
});

export type EndpointDisabledRow = typeof endpointDisabled.$inferSelect;

// ─── Bot Daily Call Budgets (Wave 6) ─────────────────────────────────────────
//
// One row per (bot, UTC-day, normalized endpoint). Atomically incremented on
// every public-data scrape via INSERT ... ON CONFLICT ... WHERE count < cap so
// the upsert RETURNING-no-rows path == budget exhausted. The natural day key
// implies rollover: new day → new row at count=0. See
// server/behavior/daily-budget.ts for the age-based cap schedule.

export const botDailyCalls = pgTable(
  "bot_daily_calls",
  {
    botId: varchar("bot_id", { length: 36 })
      .notNull()
      .references(() => botAccounts.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    endpoint: text("endpoint").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.botId, table.day, table.endpoint] }),
    index("idx_bot_daily_calls_bot_day").on(table.botId, table.day),
  ],
);

export type BotDailyCallsRow = typeof botDailyCalls.$inferSelect;

// ─── Bot Follow Requests ─────────────────────────────────────────────────────

export const botFollowRequests = pgTable(
  "bot_follow_requests",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    botAccountId: varchar("bot_account_id", { length: 36 })
      .notNull()
      .references(() => botAccounts.id, { onDelete: "cascade" }),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    status: followRequestStatusEnum("status").notNull().default("queued"),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_bfr_bot_account_id").on(table.botAccountId),
    index("idx_bfr_tracked_account_id").on(table.trackedAccountId),
    index("idx_bfr_status").on(table.status),
    uniqueIndex("idx_bfr_bot_tracked_unique").on(
      table.botAccountId,
      table.trackedAccountId,
    ),
    // Composite for the per-tracked-account request lookup (migration
    // 0001_wave1_hardening). Pre-exists in the live DB.
    index("idx_bfr_tracked_status").on(table.trackedAccountId, table.status),
    // Partial index for the pending-request expiry sweep (migration
    // 0001_wave1_hardening). Pre-exists in the live DB.
    index("idx_bfr_pending_expires")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

// ─── Bandwidth Log (runtime-DDL table) ───────────────────────────────────────
//
// Per (user, tracked profile, endpoint) scrape transfer, time-bucketed by the
// flush window. Powers the admin bandwidth panel. This table is created lazily
// at runtime by server/services/bandwidth-meter.ts via CREATE TABLE IF NOT
// EXISTS (and also by migration 0017_bandwidth_log.sql), so it can exist in the
// live DB before drizzle ever sees it. Declared here so drizzle-kit push does
// not propose dropping it. Bot/user/account ids are deliberately NOT FK-bound
// — the meter is a fire-and-forget sink that must never block a scrape, and
// rows are allowed to outlive the rows they reference. Keep this definition in
// exact sync with the CREATE TABLE in bandwidth-meter.ts.

export const bandwidthLog = pgTable(
  "bandwidth_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deliveryId: uuid("delivery_id"),
    userId: varchar("user_id", { length: 36 }),
    trackedAccountId: varchar("tracked_account_id", { length: 36 }),
    igUsername: text("ig_username"),
    endpoint: text("endpoint").notNull(),
    bytesIn: bigint("bytes_in", { mode: "number" }).notNull().default(0),
    bytesOut: bigint("bytes_out", { mode: "number" }).notNull().default(0),
    requests: integer("requests").notNull().default(0),
    byteSource: text("byte_source").notNull().default("legacy_mixed"),
    botId: varchar("bot_id", { length: 36 }),
    transport: text("transport"),
    failures: integer("failures").notNull().default(0),
    resourceBytes: jsonb("resource_bytes").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_bandwidth_log_occurred_at").on(table.occurredAt),
    uniqueIndex("bandwidth_log_delivery_id_key").on(table.deliveryId),
    index("idx_bandwidth_log_user").on(table.userId, table.occurredAt),
    index("idx_bandwidth_log_account").on(
      table.trackedAccountId,
      table.occurredAt,
    ),
  ],
);

export type BandwidthLogRow = typeof bandwidthLog.$inferSelect;

// ─── Proxy Wire Samples (runtime-DDL table) ──────────────────────────────────
//
// Kernel-measured billable traffic to the proxy gateway. `bandwidth_log` above
// answers "who consumed it" from inside Node (decoded payload, per request);
// this table answers "what does the provider bill" from outside Node (encoded
// TCP bytes, counted by pure-counter iptables rules on the gateway IPs). The
// two never match by construction: a browser-lane read loads a whole
// instagram.com page that Node never sees, and JSON is gzipped ~5-8x on the
// wire. Rows are DELTAS between consecutive counter reads, not running totals,
// so a windowed SUM is the transfer in that window; span_seconds exposes how
// much of the window is actually covered.
//
// Created by migration 0047_proxy_wire_samples.sql AND lazily at runtime by
// server/services/proxy-wire-sampler.ts (CREATE TABLE IF NOT EXISTS), so it can
// exist in the live DB before drizzle sees it. Declared here so drizzle-kit
// push does not propose dropping it. Keep this in exact sync with the CREATE
// TABLE in proxy-wire-sampler.ts.

export const proxyWireSamples = pgTable(
  "proxy_wire_samples",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sampleKey: uuid("sample_key"),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    bytesIn: bigint("bytes_in", { mode: "number" }).notNull().default(0),
    bytesOut: bigint("bytes_out", { mode: "number" }).notNull().default(0),
    spanSeconds: integer("span_seconds").notNull().default(0),
  },
  (table) => [
    index("proxy_wire_samples_sampled_at_idx").on(table.sampledAt),
    uniqueIndex("proxy_wire_samples_sample_key_key").on(table.sampleKey),
  ],
);

export type ProxyWireSampleRow = typeof proxyWireSamples.$inferSelect;

// ─── Scrape Outcome Log (runtime-DDL table) ──────────────────────────────────
//
// Append-only history of every IG scrape attempt, backing long-window success
// rates and per-bot failure clustering on the admin /health endpoint. Created
// by migration 0007_scrape_outcome_log.sql; the observability code inserts via
// fire-and-forget recordOutcome() so a flaky DB never blocks the scrape path.
// bot_id is nullable + ON DELETE SET NULL because login failures can occur
// before any bot is leased, and the log must survive bot deletion. outcome is
// constrained to ('success','failure') in the live DDL — the CHECK is enforced
// by Postgres; drizzle has no first-class CHECK-on-text here so it is documented
// rather than redeclared (drizzle-kit push leaves unknown CHECKs in place).

export const scrapeOutcomeLog = pgTable(
  "scrape_outcome_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    botId: varchar("bot_id", { length: 36 }).references(() => botAccounts.id, {
      onDelete: "set null",
    }),
    endpoint: text("endpoint").notNull(),
    // 'success' | 'failure' — enforced by a live CHECK constraint
    // (scrape_outcome_log_outcome_check).
    outcome: text("outcome").notNull(),
    errorKind: text("error_kind"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_scrape_outcome_log_occurred_at").on(table.occurredAt.desc()),
    index("idx_scrape_outcome_log_endpoint_occurred_at").on(
      table.endpoint,
      table.occurredAt.desc(),
    ),
    index("idx_scrape_outcome_log_bot_id_occurred_at").on(
      table.botId,
      table.occurredAt.desc(),
    ),
  ],
);

export type ScrapeOutcomeLogRow = typeof scrapeOutcomeLog.$inferSelect;

// ─── System Settings (runtime-DDL table) ─────────────────────────────────────
//
// Generic JSONB key/value store for operator-tunable settings (scraper
// transport config, refresh cadence under key 'scraper.refreshIntervalSec',
// etc.). Created lazily at runtime by server/services/refresh-config.ts and
// server/services/scraper-transport-config.ts via CREATE TABLE IF NOT EXISTS.
// Declared here so drizzle-kit push does not propose dropping it. updated_by is
// the admin user id (nullable, not FK-bound — settings outlive admin accounts).

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: varchar("updated_by", { length: 36 }),
});

export type SystemSettingsRow = typeof systemSettings.$inferSelect;

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ one, many }) => ({
  subscription: one(subscriptions, {
    fields: [users.id],
    references: [subscriptions.userId],
  }),
  trackedAccounts: many(trackedAccounts),
  notifications: many(notifications),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));

export const trackedAccountsRelations = relations(
  trackedAccounts,
  ({ one, many }) => ({
    user: one(users, {
      fields: [trackedAccounts.userId],
      references: [users.id],
    }),
    profileSnapshots: many(profileSnapshots),
    likeEvents: many(likeEvents),
    followEvents: many(followEvents),
    unfollowEvents: many(unfollowEvents),
    followerEvents: many(followerEvents),
    followerUnfollowEvents: many(followerUnfollowEvents),
    postsCache: many(postsCache),
    storiesCache: many(storiesCache),
    highlightsCache: many(highlightsCache),
    reports: many(reports),
    collectionJobs: many(collectionJobs),
    botFollowRequests: many(botFollowRequests),
  }),
);

export const followerEventsRelations = relations(followerEvents, ({ one }) => ({
  trackedAccount: one(trackedAccounts, {
    fields: [followerEvents.trackedAccountId],
    references: [trackedAccounts.id],
  }),
}));

export const followerUnfollowEventsRelations = relations(
  followerUnfollowEvents,
  ({ one }) => ({
    trackedAccount: one(trackedAccounts, {
      fields: [followerUnfollowEvents.trackedAccountId],
      references: [trackedAccounts.id],
    }),
  }),
);

export const postsCacheRelations = relations(postsCache, ({ one }) => ({
  trackedAccount: one(trackedAccounts, {
    fields: [postsCache.trackedAccountId],
    references: [trackedAccounts.id],
  }),
}));

export const storiesCacheRelations = relations(storiesCache, ({ one }) => ({
  trackedAccount: one(trackedAccounts, {
    fields: [storiesCache.trackedAccountId],
    references: [trackedAccounts.id],
  }),
}));

export const highlightsCacheRelations = relations(
  highlightsCache,
  ({ one, many }) => ({
    trackedAccount: one(trackedAccounts, {
      fields: [highlightsCache.trackedAccountId],
      references: [trackedAccounts.id],
    }),
    items: many(highlightItemsCache),
  }),
);

export const highlightItemsCacheRelations = relations(
  highlightItemsCache,
  ({ one }) => ({
    highlight: one(highlightsCache, {
      fields: [highlightItemsCache.highlightCacheId],
      references: [highlightsCache.id],
    }),
  }),
);

export const profileSnapshotsRelations = relations(
  profileSnapshots,
  ({ one }) => ({
    trackedAccount: one(trackedAccounts, {
      fields: [profileSnapshots.trackedAccountId],
      references: [trackedAccounts.id],
    }),
  }),
);

export const likeEventsRelations = relations(likeEvents, ({ one }) => ({
  trackedAccount: one(trackedAccounts, {
    fields: [likeEvents.trackedAccountId],
    references: [trackedAccounts.id],
  }),
}));

export const followEventsRelations = relations(followEvents, ({ one }) => ({
  trackedAccount: one(trackedAccounts, {
    fields: [followEvents.trackedAccountId],
    references: [trackedAccounts.id],
  }),
}));

// ─── Materialized rosters (migration 0029) ──────────────────────────────────
//
// The roster used to have no table: "who does this account currently follow?"
// was reconstructed from follow_events minus newer unfollow_events. That made
// the append-only event log serve as mutable state, and the diff consumed its
// own output — one short read corrupted the baseline permanently and every
// later read "repaired" it by emitting the gap as fresh activity. Live proof:
// @example_account's following sat unchanged at 215 for hours while the derived
// set held 170 and the system reported ~45 follows + ~32 unfollows every cycle
// (860/859 over 7 days, all fabricated).
//
// These tables hold the roster; follow_events/unfollow_events are demoted to a
// derived audit trail of CONFIRMED transitions. Never rebuild roster state from
// them again.
export const rosterMembers = pgTable(
  "roster_members",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    /** "following" = accounts this profile follows; "follower" = its followers. */
    dimension: text("dimension").notNull(),
    /** Case-insensitive match key; `username` keeps the display form. */
    usernameLower: text("username_lower").notNull(),
    username: text("username").notNull(),
    displayName: text("display_name"),
    /**
     * Serving fields, stored here rather than joined back out of
     * follower_events: a silently-seeded member has no event row, so the old
     * enrichment join would return an empty roster for every settled account.
     * Only the follower dimension populates these.
     */
    igUserId: text("ig_user_id"),
    pfpUrl: text("pfp_url"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Consecutive COMPLETE reads in which this member was absent; reset to 0 on
     * every sighting. Instagram's paginated enumeration returns a slightly
     * different subset each pass, so absence from ONE read is meaningless —
     * this is the hysteresis that turns pagination churn into a non-event.
     */
    missingStreak: integer("missing_streak").notNull().default(0),
    isCurrent: boolean("is_current").notNull().default(true),
    leftAt: timestamp("left_at", { withTimezone: true }),
    // Migration 0040: owner posting activity, used to prioritise the
    // liked-post scan toward accounts that actually publish.
    lastPostAt: timestamp("last_post_at", { withTimezone: true }),
    postsCheckedAt: timestamp("posts_checked_at", { withTimezone: true }),
    ownerIsPrivate: boolean("owner_is_private"),
    ownerProfileCheckedAt: timestamp("owner_profile_checked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("roster_members_account_dim_username").on(
      table.trackedAccountId,
      table.dimension,
      table.usernameLower,
    ),
    index("idx_roster_members_account_dim_current").on(
      table.trackedAccountId,
      table.dimension,
      table.isCurrent,
    ),
    index("idx_roster_members_account_dim_first_seen").on(
      table.trackedAccountId,
      table.dimension,
      table.isCurrent,
      table.firstSeenAt,
    ),
    index("idx_roster_members_post_activity")
      .on(table.trackedAccountId, table.dimension, table.lastPostAt.desc().nullsFirst())
      .where(sql`${table.isCurrent} = true`),
  ],
);

// Migration 0041: which posts the liked-post scan has already read likers for.
//
// Without this the scan re-read the same top-N recent posts of each owner every
// cycle, burning scarce liker reads on posts already known not to contain the
// tracked user, and never reaching owners deeper in the following list.
export const likeEvidencePostChecks = pgTable(
  "like_evidence_post_checks",
  {
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    /** IG media id (stable); shortcode is not unique enough to key on. */
    mediaId: text("media_id").notNull(),
    ownerUsername: text("owner_username"),
    postTakenAt: timestamp("post_taken_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.trackedAccountId, table.mediaId] }),
    index("idx_like_evidence_checks_account_checked").on(
      table.trackedAccountId,
      table.checkedAt,
    ),
    index("idx_like_evidence_checks_checked_at").on(table.checkedAt),
  ],
);

/** The two independent IG calls the per-post engagement scrape makes. */
export type PostEngagementCheckKind = "likers" | "comments";

// Migration 0042: which posts the per-post engagement scrape (likers +
// comments) has already read, and when.
//
// collectPostEngagement re-scraped the same top-N posts on EVERY profile refresh
// (8x/day at the current 3h cadence). 88% of those calls inserted nothing.
// Engagement on a RECENT post really does keep growing, so the skip is
// age-tiered: posts younger than ENGAGEMENT_FRESH_POST_HOURS ignore this table
// entirely, older posts are re-scraped at most once per ENGAGEMENT_RECHECK_HOURS.
//
// Unlike likeEvidencePostChecks (0041) this is keyed on (mediaId, kind) with NO
// tracked account in the key: likers_cache / comments_cache are keyed by
// post_shortcode alone, so the scraped engagement is shared across every
// customer tracking that IG user. `kind` is in the key because likers and
// comments fail independently and must be retried independently.
export const postEngagementChecks = pgTable(
  "post_engagement_checks",
  {
    /** IG media id (stable); shortcode is not unique enough to key on. */
    mediaId: text("media_id").notNull(),
    /** "likers" | "comments" — see PostEngagementCheckKind. */
    kind: text("kind").$type<PostEngagementCheckKind>().notNull(),
    postShortcode: text("post_shortcode"),
    /**
     * Informational: which tracked account's cycle last scraped this post.
     * NOT part of the key, and SET NULL (not CASCADE) on delete — removing one
     * customer's tracked account must not erase memory another customer's
     * account still relies on.
     */
    trackedAccountId: varchar("tracked_account_id", { length: 36 }).references(
      () => trackedAccounts.id,
      { onDelete: "set null" },
    ),
    postTakenAt: timestamp("post_taken_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.mediaId, table.kind] }),
    index("idx_post_engagement_checks_checked_at").on(table.checkedAt),
    index("idx_post_engagement_checks_tracked_account_id").on(table.trackedAccountId),
  ],
);

export const rosterSyncState = pgTable(
  "roster_sync_state",
  {
    trackedAccountId: varchar("tracked_account_id", { length: 36 })
      .notNull()
      .references(() => trackedAccounts.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    /**
     * When the first COMPLETE read established the baseline. Members present at
     * seed are pre-existing, not new follows, so seeding emits NO events. While
     * this is null we cannot tell discovery from activity and stay silent.
     */
    seededAt: timestamp("seeded_at", { withTimezone: true }),
    /**
     * COMPLETE reads absorbed so far. The completeness gate accepts a read at
     * >=90% of IG's reported count, and that reported number itself overshoots
     * the enumerable set, so a single read is not a trustworthy baseline — its
     * missing tail would resurface later as fake "new follows". The first
     * ROSTER_SETTLE_READS complete reads are unioned into the baseline silently.
     */
    completeReads: integer("complete_reads").notNull().default(0),
    /**
     * Consecutive complete reads that added NO new members. Reset whenever the
     * union grows. The roster settles on this rather than on a percentage of
     * IG's reported count, which is unreachable (it counts ghosts/deactivated:
     * @complex reports 1,090 following but enumerates to 743). See 0031.
     */
    stableReads: integer("stable_reads").notNull().default(0),
    /** Set once the baseline settles; only then are additions/removals real. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    lastCompleteReadAt: timestamp("last_complete_read_at", {
      withTimezone: true,
    }),
    // Read epochs (migration 0046): a resumed multi-leg walk is judged as ONE
    // logical read — departures and last_complete_read_at move only when the
    // epoch that began at cursor NULL reaches the end of the list.
    epochStartedAt: timestamp("epoch_started_at", { withTimezone: true }),
    epochCompletedAt: timestamp("epoch_completed_at", { withTimezone: true }),
    epochStartMemberCount: integer("epoch_start_member_count"),
    epochLegs: integer("epoch_legs").notNull().default(0),
    lastMemberCount: integer("last_member_count"),
    /** Latest graph fetch attempt/success and target-specific failure backoff. */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    failureKind: text("failure_kind"),
    lastError: text("last_error"),
    // Migration 0039: resumable pagination. IG blocks deep walks on large
    // rosters, so we persist where the walk stopped and resume next cycle
    // instead of restarting at page 1 and re-reading the same first 200.
    nextCursor: text("next_cursor"),
    viewerBotId: varchar("viewer_bot_id", { length: 36 }),
    cursorUpdatedAt: timestamp("cursor_updated_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.trackedAccountId, table.dimension] }),
    index("idx_roster_sync_state_next_retry").on(table.nextRetryAt)
      .where(sql`${table.nextRetryAt} IS NOT NULL`),
  ],
);

/** Durable bounded roster progress. The cursor/viewer/epoch stays in rosterSyncState. */
export const rosterBackgroundSync = pgTable("roster_background_sync", {
  trackedAccountId:varchar("tracked_account_id",{length:36}).notNull().references(()=>trackedAccounts.id,{onDelete:"cascade"}),
  dimension:text("dimension").notNull(),source:text("source").notNull().default("auto"),
  status:text("status").notNull().default("pending"),
  baselineCompleteAt:timestamp("baseline_complete_at",{withTimezone:true}),
  nextRunAt:timestamp("next_run_at",{withTimezone:true}).notNull().defaultNow(),
  nextHeadRunAt:timestamp("next_head_run_at",{withTimezone:true}).notNull().defaultNow(),
  lastHeadReadAt:timestamp("last_head_read_at",{withTimezone:true}),
  lastHeadCount:integer("last_head_count").notNull().default(0),
  headStatus:text("head_status").notNull().default("pending"),
  epochExpectedCount:integer("epoch_expected_count"),epochSeenCount:integer("epoch_seen_count").notNull().default(0),
  pagesCompleted:integer("pages_completed").notNull().default(0),lastBatchCount:integer("last_batch_count").notNull().default(0),
  lastStartedAt:timestamp("last_started_at",{withTimezone:true}),lastProgressAt:timestamp("last_progress_at",{withTimezone:true}),lastError:text("last_error"),
},table=>[
  primaryKey({columns:[table.trackedAccountId,table.dimension]}),index("idx_roster_background_due").on(table.nextRunAt),
  check("roster_background_sync_dimension_check",sql`${table.dimension} IN ('follower','following')`),
  check("roster_background_sync_source_check",sql`${table.source} IN ('auto','graphql')`),
]);

export const unfollowEventsRelations = relations(unfollowEvents, ({ one }) => ({
  trackedAccount: one(trackedAccounts, {
    fields: [unfollowEvents.trackedAccountId],
    references: [trackedAccounts.id],
  }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  trackedAccount: one(trackedAccounts, {
    fields: [reports.trackedAccountId],
    references: [trackedAccounts.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export const collectionJobsRelations = relations(collectionJobs, ({ one }) => ({
  trackedAccount: one(trackedAccounts, {
    fields: [collectionJobs.trackedAccountId],
    references: [trackedAccounts.id],
  }),
}));

export const botAccountsRelations = relations(botAccounts, ({ many }) => ({
  botFollowRequests: many(botFollowRequests),
}));

export const botFollowRequestsRelations = relations(
  botFollowRequests,
  ({ one }) => ({
    botAccount: one(botAccounts, {
      fields: [botFollowRequests.botAccountId],
      references: [botAccounts.id],
    }),
    trackedAccount: one(trackedAccounts, {
      fields: [botFollowRequests.trackedAccountId],
      references: [trackedAccounts.id],
    }),
  }),
);

// ─── Insert / Select Zod Schemas & Types ──────────────────────────────────────

export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  name: true,
  hashedPassword: true,
});

export const insertSubscriptionSchema = createInsertSchema(subscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTrackedAccountSchema = createInsertSchema(
  trackedAccounts,
).omit({ id: true, trackingStarted: true, updatedAt: true });

export const insertProfileSnapshotSchema = createInsertSchema(
  profileSnapshots,
).omit({ id: true, snapshotAt: true });

export const insertLikeEventSchema = createInsertSchema(likeEvents).omit({
  id: true,
  detectedAt: true,
});

export const insertFollowEventSchema = createInsertSchema(followEvents).omit({
  id: true,
  detectedAt: true,
});

export const insertUnfollowEventSchema = createInsertSchema(
  unfollowEvents,
).omit({ id: true, detectedAt: true });

export const insertReportSchema = createInsertSchema(reports).omit({
  id: true,
  createdAt: true,
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});

export const insertCollectionJobSchema = createInsertSchema(
  collectionJobs,
).omit({ id: true });

export const insertBotAccountSchema = createInsertSchema(botAccounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertBotFollowRequestSchema = createInsertSchema(
  botFollowRequests,
).omit({ id: true, queuedAt: true });

export const insertFollowerEventSchema = createInsertSchema(followerEvents).omit({
  id: true,
  detectedAt: true,
});

export const insertFollowerUnfollowEventSchema = createInsertSchema(
  followerUnfollowEvents,
).omit({ id: true, detectedAt: true });

export const insertPostCacheSchema = createInsertSchema(postsCache).omit({
  id: true,
  cachedAt: true,
});

export const insertStoryCacheSchema = createInsertSchema(storiesCache).omit({
  id: true,
  cachedAt: true,
});

export const insertHighlightCacheSchema = createInsertSchema(
  highlightsCache,
).omit({ id: true, cachedAt: true });

export const insertHighlightItemCacheSchema = createInsertSchema(
  highlightItemsCache,
).omit({ id: true, cachedAt: true });

export const insertMediaAssetSchema = createInsertSchema(mediaAssets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Subscription = typeof subscriptions.$inferSelect;
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;

export type TrackedAccount = typeof trackedAccounts.$inferSelect;
export type InsertTrackedAccount = z.infer<typeof insertTrackedAccountSchema>;

export type ProfileSnapshot = typeof profileSnapshots.$inferSelect;
export type InsertProfileSnapshot = z.infer<typeof insertProfileSnapshotSchema>;

export type LikeEvent = typeof likeEvents.$inferSelect;
export type InsertLikeEvent = z.infer<typeof insertLikeEventSchema>;

export type FollowEvent = typeof followEvents.$inferSelect;
export type InsertFollowEvent = z.infer<typeof insertFollowEventSchema>;

export type UnfollowEvent = typeof unfollowEvents.$inferSelect;
export type InsertUnfollowEvent = z.infer<typeof insertUnfollowEventSchema>;

export type Report = typeof reports.$inferSelect;
export type InsertReport = z.infer<typeof insertReportSchema>;

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;

export type CollectionJob = typeof collectionJobs.$inferSelect;
export type InsertCollectionJob = z.infer<typeof insertCollectionJobSchema>;

export type BotAccount = typeof botAccounts.$inferSelect;
export type InsertBotAccount = z.infer<typeof insertBotAccountSchema>;

export type BotFollowRequest = typeof botFollowRequests.$inferSelect;
export type InsertBotFollowRequest = z.infer<typeof insertBotFollowRequestSchema>;

export type FollowerEvent = typeof followerEvents.$inferSelect;
export type InsertFollowerEvent = z.infer<typeof insertFollowerEventSchema>;

export type FollowerUnfollowEvent = typeof followerUnfollowEvents.$inferSelect;
export type InsertFollowerUnfollowEvent = z.infer<
  typeof insertFollowerUnfollowEventSchema
>;

export type PostCache = typeof postsCache.$inferSelect;
export type InsertPostCache = z.infer<typeof insertPostCacheSchema>;

export type StoryCache = typeof storiesCache.$inferSelect;
export type InsertStoryCache = z.infer<typeof insertStoryCacheSchema>;

export type HighlightCache = typeof highlightsCache.$inferSelect;
export type InsertHighlightCache = z.infer<typeof insertHighlightCacheSchema>;

export type HighlightItemCache = typeof highlightItemsCache.$inferSelect;
export type InsertHighlightItemCache = z.infer<
  typeof insertHighlightItemCacheSchema
>;

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type InsertMediaAsset = z.infer<typeof insertMediaAssetSchema>;

// ─── Liked-by watcher follow state (migration 0045) ──────────────────────────

/**
 * What a liked-by watcher bot last observed about its relationship with a
 * tracked target. 'unavailable' = the friendship probe failed with a hard,
 * non-checkpoint error (e.g. a plain 400); it is retried after the re-verify
 * window rather than every sweep.
 */
export type WatcherFollowStateValue =
  | "following"
  | "requested"
  | "not_following"
  | "unavailable";

// Migration 0045: per-(watcher bot, tracked target) follow relationship, so
// ensureWatcherFollows() stops re-probing friendships/show for every target on
// every 25-minute sweep (measured: 100% of 1,456 probes/day re-confirmed a
// state observed 25 minutes earlier, unmetered, on the six web watchers).
//
// Deliberately NO foreign key to bot_accounts: the migration is applied by a
// role that may lack REFERENCES, and the harvester only ever reads rows keyed
// by a live bot id, so an orphan row is inert. Keep this definition in sync
// with migrations/0045_watcher_follow_state.sql.
export const watcherFollowState = pgTable(
  "watcher_follow_state",
  {
    botId: varchar("bot_id", { length: 36 }).notNull(),
    /** IG numeric pk of the tracked target (what friendships/show is keyed on). */
    targetIgUserId: text("target_ig_user_id").notNull(),
    /** Username at the time of the probe; refreshed on every upsert. */
    targetUsername: text("target_username").notNull(),
    /** See WatcherFollowStateValue; CHECK-constrained in SQL. */
    state: text("state").$type<WatcherFollowStateValue>().notNull(),
    /** When this state was last confirmed against IG (or last attempted). */
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Last probe/follow error for this pair; null once a probe succeeds. */
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.botId, table.targetIgUserId] }),
    index("idx_watcher_follow_state_target").on(table.targetIgUserId),
  ],
);

export type WatcherFollowState = typeof watcherFollowState.$inferSelect;
export type InsertWatcherFollowState = typeof watcherFollowState.$inferInsert;

// Additive safety state (0048). Expiring ownership never holds a DB transaction
// open across Instagram/Stripe network calls.
export const backendOperationLeases = pgTable("backend_operation_leases", {
  key: text("key").primaryKey(),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("idx_backend_operation_leases_expiry").on(t.expiresAt)]);

export const interactiveRefreshState = pgTable("interactive_refresh_state", {
  mediaId: text("media_id").notNull(),
  kind: text("kind").notNull(),
  succeededAt: timestamp("succeeded_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.mediaId, t.kind] })]);

export const mobileAuthSessions = pgTable("mobile_auth_sessions", {
  id: text("id").primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  refreshDigest: text("refresh_digest").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("idx_mobile_auth_sessions_user").on(t.userId), index("idx_mobile_auth_sessions_expiry").on(t.expiresAt)]);

export const mobileLegacyRevocations = pgTable("mobile_legacy_revocations", {
  userId: varchar("user_id", { length: 36 }).primaryKey().references(() => users.id, { onDelete: "cascade" }),
  revokedBefore: timestamp("revoked_before", { withTimezone: true }).notNull(),
});

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scrapeCapacityLog = pgTable("scrape_capacity_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  endpoint: text("endpoint").notNull(),
  reason: text("reason").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("idx_scrape_capacity_log_time").on(t.occurredAt)]);
