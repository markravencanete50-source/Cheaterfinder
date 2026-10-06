-- Financial reconciliation survives account deletion without retaining email/name.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_payment_policy text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_cancellation_policy text;
ALTER TABLE billing_retention_offers ADD COLUMN IF NOT EXISTS regular_invoice_total integer;
ALTER TABLE billing_retention_offers ADD COLUMN IF NOT EXISTS offer_credit_applied integer;
CREATE TABLE IF NOT EXISTS billing_trial_payments (
  id uuid PRIMARY KEY,
  user_id varchar(36) REFERENCES users(id) ON DELETE SET NULL,
  customer_id text NOT NULL,
  subscription_id text NOT NULL UNIQUE,
  checkout_session_id text NOT NULL UNIQUE,
  invoice_id text NOT NULL UNIQUE,
  payment_intent_id text NOT NULL UNIQUE,
  policy_version text NOT NULL,
  cancellation_policy text NOT NULL CHECK (cancellation_policy IN ('refund_during_trial', 'retain_credit')),
  trial_ends_at timestamptz NOT NULL,
  currency text NOT NULL CHECK (currency = 'usd'),
  amount integer NOT NULL CHECK (amount = 99),
  state text NOT NULL CHECK (state IN ('paid', 'credit_pending', 'credited', 'refund_pending', 'refunded', 'reversal_pending', 'compensation_pending', 'manual_review')),
  credit_params jsonb NOT NULL,
  credit_requested_at timestamptz,
  credit_transaction_id text UNIQUE,
  credit_reversal_transaction_id text UNIQUE,
  credit_reversal_params jsonb,
  credit_reversal_requested_at timestamptz,
  credit_compensation_params jsonb,
  credit_compensation_requested_at timestamptz,
  credit_compensation_transaction_id text UNIQUE,
  refund_requested_at timestamptz,
  refund_params jsonb,
  refund_id text UNIQUE,
  paid_at timestamptz NOT NULL,
  credited_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_trial_payments_user_id ON billing_trial_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_trial_payments_customer_id ON billing_trial_payments(customer_id);
