ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_acknowledged_at timestamptz;

CREATE TABLE IF NOT EXISTS billing_retention_offers (
  user_id varchar(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL UNIQUE,
  subscription_id text NOT NULL,
  customer_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('quoted', 'pending', 'applied')),
  fingerprint text NOT NULL,
  update_params jsonb NOT NULL,
  currency text NOT NULL,
  amount integer NOT NULL,
  regular_amount integer NOT NULL,
  trial boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  requested_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
