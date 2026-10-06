/** Known query identities shared by request construction and attribution.
 * Never infer a roster endpoint from an arbitrary GraphQL variables payload.
 */
export const GRAPHQL_FRIENDSHIP_QUERY_HASH = {
  followers: "37479f2b8209594dde7facb0d904896a",
  following: "58712303d941c6855d4e888c5f0cd22f",
} as const;

/** Larger pages require an explicit bounded caller (and target canary).
 * Ordinary web roster reads keep their existing <=50 request size. */
export function graphqlRosterPageSize(count: number): number {
  if (count === 100 || count === 200) return count;
  return Number.isFinite(count) ? Math.max(1, Math.min(50, Math.floor(count))) : 50;
}
