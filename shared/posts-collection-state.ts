/** Evidence about saved posts, never a claim about the current provider account. */
export interface PostsCollectionState {
  state: "available" | "waiting_for_access" | "not_collected" | "collecting" | "delayed" | "failed" | "empty_observed" | "unavailable";
  savedTotal: number | null;
  recordedProfileCount: number | null;
  recordedProfileAt: string | null;
  lastPostsReadAt: string | null;
  lastAttemptAt: string | null;
  /** An existing scheduled check, not a promise of availability or the earliest retry. */
  nextRetryAt: string | null;
  trackingActive: boolean;
  source: "account" | "shared_public_profile";
}
