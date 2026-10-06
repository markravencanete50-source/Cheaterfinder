/** A missing lease is capacity, not evidence that an owner has no fresh posts.
 * Stop this pass WITHOUT stamping unvisited owners; the unchanged scheduler
 * retries them at its next normal tick.
 */
export function isCapacityUnavailable(message: string): boolean {
  return /no (?:available|eligible) bot|no_bot|operation already in progress|hit daily cap|pool exhausted|shared scrape attempt budget exhausted|\brate[ _-]?limit|\bthrottl/i.test(message);
}

export function shouldReadLikeCandidate(
  post: { shortcode?: string; mediaId?: string | null },
  knownPositivePosts: ReadonlySet<string>,
  recentlyChecked: ReadonlySet<string>,
): boolean {
  if (post.shortcode && knownPositivePosts.has(post.shortcode)) return false;
  return !post.mediaId || !recentlyChecked.has(post.mediaId);
}
