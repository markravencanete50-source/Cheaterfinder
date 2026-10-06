ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used_at timestamptz;
UPDATE users u SET trial_used_at = COALESCE(s.created_at, now())
FROM subscriptions s WHERE s.user_id = u.id AND u.trial_used_at IS NULL
  AND s.trial_ends_at IS NOT NULL AND s.stripe_subscription_id IS NOT NULL;
