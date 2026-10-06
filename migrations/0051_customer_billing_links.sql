BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Retain ownership even before Checkout produces a subscription/webhook.
CREATE TABLE IF NOT EXISTS customer_billing_links (
  user_id varchar(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO customer_billing_links(user_id,stripe_customer_id)
  SELECT user_id,stripe_customer_id FROM subscriptions WHERE stripe_customer_id IS NOT NULL
  ON CONFLICT DO NOTHING;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_billing_links TO cheaterfinder;
COMMIT;
