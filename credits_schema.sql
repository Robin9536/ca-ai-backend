-- ============================================================
-- CA & AI — AI credit / wallet system (additive migration)
-- Run after schema.sql. Does not modify any existing table.
-- ============================================================

CREATE TYPE credit_tx_type AS ENUM (
  'signup_bonus', 'subscription_allocation', 'purchase',
  'ai_usage', 'refund', 'promotional', 'admin_adjustment', 'expiration'
);
CREATE TYPE purchase_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

-- One wallet per user. Balance is the single source of truth for "how many
-- credits does this user have" — it is written to ONLY by chargeCredits() /
-- refundCredits() / settlePurchase(), each inside a DB transaction, never
-- directly by a route handler.
CREATE TABLE wallets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance      INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The full ledger. Every balance change — up or down — is a row here.
-- reference_id doubles as an idempotency key: a UNIQUE constraint means a
-- retried request (same key) can never be double-counted.
CREATE TABLE credit_transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id      UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  type           credit_tx_type NOT NULL,
  amount         INTEGER NOT NULL,             -- positive for credit, negative for debit
  balance_after  INTEGER NOT NULL,
  description    TEXT,
  reference_id   TEXT UNIQUE,                  -- idempotency key: ai request id, purchase id, admin action id
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_tx_user ON credit_transactions(user_id, created_at DESC);

-- Configurable credit cost per AI feature (admin-editable, never hardcoded in route code).
CREATE TABLE ai_feature_costs (
  feature_key    TEXT PRIMARY KEY,             -- 'basic_question','financial_analysis','document_analysis', etc.
  label          TEXT NOT NULL,
  credit_cost    INTEGER NOT NULL CHECK (credit_cost >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ai_feature_costs (feature_key, label, credit_cost) VALUES
  ('basic_question',        'Basic AI question',            5),
  ('financial_analysis',    'Financial analysis',          15),
  ('document_analysis',     'Document analysis',           25),
  ('invoice_analysis',      'Invoice analysis',            10),
  ('report_generation',     'Financial report generation', 30),
  ('business_analysis',     'Business analysis',           25),
  ('advanced_analysis',     'Advanced AI analysis',        50);

-- Records every AI request that actually consumed credits (analytics + audit trail,
-- separate from ai_messages which stores the conversation content itself).
CREATE TABLE ai_usage (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key    TEXT NOT NULL REFERENCES ai_feature_costs(feature_key),
  credits_used   INTEGER NOT NULL,
  request_id     TEXT NOT NULL UNIQUE,         -- same idempotency key as the credit_transactions row
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_usage_user ON ai_usage(user_id, created_at DESC);

-- Purchasable credit packages (admin-editable pricing).
CREATE TABLE credit_packages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  credits        INTEGER NOT NULL CHECK (credits > 0),
  price_paise    BIGINT NOT NULL CHECK (price_paise > 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

INSERT INTO credit_packages (name, credits, price_paise, sort_order) VALUES
  ('Starter',   500,    9900, 1),
  ('Growth',   2000,   29900, 2),
  ('Pro',      5000,   59900, 3),
  ('Business', 15000, 149900, 4);

-- A purchase in flight. Starts 'pending' the moment checkout is created;
-- ONLY a verified gateway webhook (never a browser request) is allowed to
-- move it to 'succeeded', and that's the one moment credits get added —
-- see settlePurchase() in src/utils/credits.js.
CREATE TABLE credit_purchases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id     UUID NOT NULL REFERENCES credit_packages(id),
  credits        INTEGER NOT NULL,
  price_paise    BIGINT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'INR',
  status         purchase_status NOT NULL DEFAULT 'pending',
  provider       TEXT,
  provider_ref   TEXT UNIQUE,                  -- gateway's own transaction id, also enforces one settle per charge
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at     TIMESTAMPTZ
);
CREATE INDEX idx_credit_purchases_user ON credit_purchases(user_id, created_at DESC);

-- Signup bonus amount, editable by admin like everything else in admin_settings.
INSERT INTO admin_settings (key, value) VALUES ('signup_bonus_credits', '100')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO admin_settings (key, value) VALUES ('low_credit_warning_threshold', '50')
  ON CONFLICT (key) DO NOTHING;

CREATE TRIGGER trg_wallets_updated_at BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
