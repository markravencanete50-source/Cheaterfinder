CREATE TYPE "public"."access_status" AS ENUM('public', 'pending_access', 'has_access', 'access_denied');--> statement-breakpoint
CREATE TYPE "public"."bot_status" AS ENUM('available', 'in_use', 'cooldown', 'disabled', 'banned');--> statement-breakpoint
CREATE TYPE "public"."follow_request_status" AS ENUM('queued', 'pending', 'accepted', 'rejected', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('profile', 'likes', 'follows', 'report');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('new_like', 'new_follow', 'new_unfollow', 'report_ready', 'subscription_updated', 'trial_ending', 'payment_failed', 'access_granted', 'access_pending');--> statement-breakpoint
CREATE TYPE "public"."post_type" AS ENUM('photo', 'video', 'reel', 'carousel', 'story');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('generating', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_type" AS ENUM('weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."subscription_plan" AS ENUM('weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TABLE "bot_accounts" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ig_username" text NOT NULL,
	"ig_user_id" text,
	"display_name" text,
	"session_data" text NOT NULL,
	"proxy_url" text,
	"status" "bot_status" DEFAULT 'available' NOT NULL,
	"max_follows" integer DEFAULT 5 NOT NULL,
	"current_follows" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_accounts_ig_username_unique" UNIQUE("ig_username")
);
--> statement-breakpoint
CREATE TABLE "bot_follow_requests" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_account_id" varchar(36) NOT NULL,
	"tracked_account_id" varchar(36) NOT NULL,
	"status" "follow_request_status" DEFAULT 'queued' NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "collection_jobs" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" varchar(36) NOT NULL,
	"job_type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "follow_events" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" varchar(36) NOT NULL,
	"followed_username" text NOT NULL,
	"followed_display_name" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "like_events" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" varchar(36) NOT NULL,
	"post_id" text NOT NULL,
	"owner_username" text NOT NULL,
	"post_type" "post_type" DEFAULT 'photo' NOT NULL,
	"caption" text,
	"thumbnail_url" text,
	"post_url" text,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token" varchar(64) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "profile_snapshots" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" varchar(36) NOT NULL,
	"ig_username" text NOT NULL,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"following_count" integer DEFAULT 0 NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" varchar(36) NOT NULL,
	"type" "report_type" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "report_status" DEFAULT 'generating' NOT NULL,
	"total_likes" integer DEFAULT 0 NOT NULL,
	"total_follows" integer DEFAULT 0 NOT NULL,
	"total_unfollows" integer DEFAULT 0 NOT NULL,
	"top_niche" text,
	"peak_activity_hour" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" text NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"plan" "subscription_plan",
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "subscriptions_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "tracked_accounts" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"ig_username" text NOT NULL,
	"display_name" text,
	"profile_pic_url" text,
	"follower_count" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"access_status" "access_status" DEFAULT 'public' NOT NULL,
	"tracking_started" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unfollow_events" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" varchar(36) NOT NULL,
	"unfollowed_username" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"hashed_password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "bot_follow_requests" ADD CONSTRAINT "bot_follow_requests_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_follow_requests" ADD CONSTRAINT "bot_follow_requests_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_jobs" ADD CONSTRAINT "collection_jobs_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_events" ADD CONSTRAINT "follow_events_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "like_events" ADD CONSTRAINT "like_events_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD CONSTRAINT "tracked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unfollow_events" ADD CONSTRAINT "unfollow_events_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bot_accounts_status" ON "bot_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_bfr_bot_account_id" ON "bot_follow_requests" USING btree ("bot_account_id");--> statement-breakpoint
CREATE INDEX "idx_bfr_tracked_account_id" ON "bot_follow_requests" USING btree ("tracked_account_id");--> statement-breakpoint
CREATE INDEX "idx_bfr_status" ON "bot_follow_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bfr_bot_tracked_unique" ON "bot_follow_requests" USING btree ("bot_account_id","tracked_account_id");--> statement-breakpoint
CREATE INDEX "idx_collection_jobs_tracked_account_id" ON "collection_jobs" USING btree ("tracked_account_id");--> statement-breakpoint
CREATE INDEX "idx_collection_jobs_status" ON "collection_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_follow_events_tracked_account_id" ON "follow_events" USING btree ("tracked_account_id");--> statement-breakpoint
CREATE INDEX "idx_follow_events_detected_at" ON "follow_events" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "idx_follow_events_account_detected" ON "follow_events" USING btree ("tracked_account_id","detected_at");--> statement-breakpoint
CREATE INDEX "idx_like_events_tracked_account_id" ON "like_events" USING btree ("tracked_account_id");--> statement-breakpoint
CREATE INDEX "idx_like_events_detected_at" ON "like_events" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "idx_like_events_post_id" ON "like_events" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_like_events_account_detected" ON "like_events" USING btree ("tracked_account_id","detected_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_id" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_is_read" ON "notifications" USING btree ("is_read");--> statement-breakpoint
CREATE INDEX "idx_notifications_created_at" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_profile_snapshots_tracked_account_id" ON "profile_snapshots" USING btree ("tracked_account_id");--> statement-breakpoint
CREATE INDEX "idx_profile_snapshots_snapshot_at" ON "profile_snapshots" USING btree ("snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_reports_tracked_account_id" ON "reports" USING btree ("tracked_account_id");--> statement-breakpoint
CREATE INDEX "idx_reports_created_at" ON "reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "session" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_user_id" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_stripe_customer_id" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "idx_tracked_accounts_user_id" ON "tracked_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_tracked_accounts_ig_username" ON "tracked_accounts" USING btree ("ig_username");--> statement-breakpoint
CREATE INDEX "idx_tracked_accounts_user_active" ON "tracked_accounts" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_unfollow_events_tracked_account_id" ON "unfollow_events" USING btree ("tracked_account_id");--> statement-breakpoint
CREATE INDEX "idx_unfollow_events_detected_at" ON "unfollow_events" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "idx_unfollow_events_account_detected" ON "unfollow_events" USING btree ("tracked_account_id","detected_at");