-- Settle a roster on STABILITY, not on a percentage of Instagram's own number.
--
-- PROBLEM
--   0029 settled a roster after N reads that passed the completeness gate, and
--   that gate measures the capture against the follower/following count IG
--   reports on the profile. That number is not reachable: it counts ghosts,
--   deactivated, private and blocked-from-our-bot accounts that never appear in
--   any enumeration. Measured 2026-07-15:
--
--     @complex   IG reports 1,090 following; a full enumeration returns 743 (68%)
--     @example_account  IG reports 215;       enumeration returns ~175      (81%)
--
--   Both sit below the 90% gate permanently, so complete_reads would never
--   advance, the roster would never settle, and no follow/unfollow data would
--   EVER be reported for these accounts. Correct, but useless.
--
-- FIX
--   Judge a read against what we actually hold, not against IG's number, and
--   settle once the union stops growing:
--
--     complete read = captures >= 90% of the members we already hold
--                     (the first read has nothing to compare to and seeds)
--     settled       = the union added nothing new for `stable_reads` reads
--
--   This is self-calibrating: an account whose enumerable set is 743 settles at
--   743 and starts reporting real activity, while a catastrophically short
--   capture (12 of a held 743) is still rejected as evidence of absence — which
--   was the gate's actual purpose (wire.fluid: 12 of 495 → 305 false unfollows).
ALTER TABLE roster_sync_state
  ADD COLUMN IF NOT EXISTS stable_reads integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN roster_sync_state.stable_reads IS
  'Consecutive complete reads that added no new members. Reset to 0 whenever the union grows. The roster settles once this reaches ROSTER_SETTLE_READS.';

COMMENT ON COLUMN roster_sync_state.complete_reads IS
  'Total reads that covered >=90% of the held roster. Diagnostic; settling is driven by stable_reads.';
