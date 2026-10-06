-- Lifetime exposure, independent of subscription replacement and cancellation retention.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rescue_discount_offered_at timestamptz;
