-- ============================================================
-- CA & AI — Database schema (PostgreSQL 14+)
--
-- Design notes:
--   * income/expenses/sales/purchases from the original spec are
--     unified into one `transactions` table (type + category)
--     instead of separate tables, to avoid duplicated referential
--     logic. Reports are computed by query, not stored as a
--     separate `financial_reports` table.
--   * All money columns are stored in the smallest currency unit
--     (paise/cents) as BIGINT to avoid floating point error.
--   * UUID primary keys throughout for safe client-side generation
--     and to avoid leaking row counts.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";   -- case-insensitive email column

-- ---------- ENUMS ----------
CREATE TYPE user_role AS ENUM ('business_owner', 'ca', 'admin');
CREATE TYPE tx_type AS ENUM ('income', 'expense');
CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'paid', 'overdue', 'cancelled');
CREATE TYPE doc_status AS ENUM ('uploaded', 'processing', 'needs_review', 'reviewed', 'failed');
CREATE TYPE gst_status AS ENUM ('pending', 'filed', 'late');
CREATE TYPE request_status AS ENUM ('pending', 'accepted', 'in_progress', 'waiting_client', 'completed', 'cancelled', 'rejected');
CREATE TYPE booking_status AS ENUM ('scheduled', 'completed', 'cancelled', 'no_show');
CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled', 'trialing');
CREATE TYPE notification_channel AS ENUM ('in_app', 'email', 'sms');

-- ---------- USERS & PROFILES ----------
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             CITEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  role              user_role NOT NULL,
  full_name         TEXT NOT NULL,
  phone             TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Note: CITEXT requires `CREATE EXTENSION citext;` — if unavailable, use TEXT + a
-- unique index on lower(email) instead.

CREATE TABLE business_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  business_name   TEXT NOT NULL,
  business_type   TEXT,
  gstin           TEXT,
  pan             TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  country         TEXT DEFAULT 'IN',
  currency        TEXT NOT NULL DEFAULT 'INR',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ca_firms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_name     TEXT NOT NULL,
  registration_number TEXT,
  city          TEXT,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ca_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  firm_id         UUID REFERENCES ca_firms(id) ON DELETE SET NULL,
  membership_no   TEXT,                     -- ICAI membership number, self-reported
  is_verified     BOOLEAN NOT NULL DEFAULT FALSE, -- only TRUE if platform actually checked it
  headline        TEXT,
  bio             TEXT,
  years_experience INTEGER DEFAULT 0,
  city            TEXT,
  remote_ok       BOOLEAN NOT NULL DEFAULT TRUE,
  specializations TEXT[] DEFAULT '{}',
  base_consultation_fee_paise BIGINT DEFAULT 0,
  is_listed       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ca_profiles_city ON ca_profiles(city);
CREATE INDEX idx_ca_profiles_listed ON ca_profiles(is_listed) WHERE is_listed = TRUE;

CREATE TABLE services (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,       -- e.g. "GST Filing", "Startup Accounting"
  slug        TEXT NOT NULL UNIQUE,
  category    TEXT
);

CREATE TABLE ca_services (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ca_id       UUID NOT NULL REFERENCES ca_profiles(id) ON DELETE CASCADE,
  service_id  UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  price_paise BIGINT NOT NULL DEFAULT 0,
  price_unit  TEXT NOT NULL DEFAULT 'flat',  -- 'flat' | 'hourly' | 'monthly'
  UNIQUE (ca_id, service_id)
);

-- ---------- ACCOUNTING ----------
CREATE TABLE transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  type           tx_type NOT NULL,
  category       TEXT NOT NULL,              -- 'sales','rent','software','contractor', etc.
  description    TEXT,
  counterparty   TEXT,                       -- customer/vendor name (free text, not FK)
  amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  tax_paise      BIGINT NOT NULL DEFAULT 0,
  occurred_on    DATE NOT NULL,
  invoice_id     UUID,                       -- nullable FK, added after invoices table
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tx_business_date ON transactions(business_id, occurred_on DESC);
CREATE INDEX idx_tx_business_type ON transactions(business_id, type);

CREATE TABLE invoices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  customer_name  TEXT NOT NULL,
  amount_paise   BIGINT NOT NULL CHECK (amount_paise >= 0),
  tax_paise      BIGINT NOT NULL DEFAULT 0,
  status         invoice_status NOT NULL DEFAULT 'draft',
  issued_on      DATE NOT NULL DEFAULT CURRENT_DATE,
  due_on         DATE,
  paid_on        DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, invoice_number)
);
ALTER TABLE transactions
  ADD CONSTRAINT fk_tx_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

-- ---------- DOCUMENTS ----------
CREATE TABLE documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  uploaded_by    UUID NOT NULL REFERENCES users(id),
  original_name  TEXT NOT NULL,
  storage_path   TEXT NOT NULL,             -- path/key in disk or object storage
  mime_type      TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL,
  doc_type       TEXT,                      -- 'invoice','receipt','bank_statement','gst','other'
  status         doc_status NOT NULL DEFAULT 'uploaded',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_documents_business ON documents(business_id, created_at DESC);

CREATE TABLE document_extractions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  vendor         TEXT,
  invoice_number TEXT,
  extracted_date DATE,
  amount_paise   BIGINT,
  tax_paise      BIGINT,
  category       TEXT,
  raw_json       JSONB,                     -- full structured extraction payload
  confirmed_by   UUID REFERENCES users(id), -- set once a human reviews & accepts it
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- GST / TAX ----------
CREATE TABLE gst_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  period_month      DATE NOT NULL,          -- first day of the period month
  taxable_value_paise BIGINT NOT NULL DEFAULT 0,
  output_tax_paise  BIGINT NOT NULL DEFAULT 0,
  input_tax_credit_paise BIGINT NOT NULL DEFAULT 0,
  net_payable_paise BIGINT GENERATED ALWAYS AS (output_tax_paise - input_tax_credit_paise) STORED,
  status            gst_status NOT NULL DEFAULT 'pending',
  filed_at          TIMESTAMPTZ,
  UNIQUE (business_id, period_month)
);

CREATE TABLE tax_records (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  financial_year TEXT NOT NULL,             -- e.g. '2026-27'
  estimated_tax_paise BIGINT NOT NULL DEFAULT 0,
  paid_tax_paise BIGINT NOT NULL DEFAULT 0,
  notes          TEXT,
  UNIQUE (business_id, financial_year)
);

-- ---------- CA MARKETPLACE ----------
CREATE TABLE ca_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  ca_id          UUID NOT NULL REFERENCES ca_profiles(id) ON DELETE CASCADE,
  service_id     UUID REFERENCES services(id),
  status         request_status NOT NULL DEFAULT 'pending',
  message        TEXT,
  quoted_price_paise BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at    TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ
);
CREATE INDEX idx_ca_requests_business ON ca_requests(business_id, status);
CREATE INDEX idx_ca_requests_ca ON ca_requests(ca_id, status);

CREATE TABLE bookings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     UUID REFERENCES ca_requests(id) ON DELETE CASCADE,
  business_id    UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  ca_id          UUID NOT NULL REFERENCES ca_profiles(id) ON DELETE CASCADE,
  scheduled_at   TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  status         booking_status NOT NULL DEFAULT 'scheduled',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     UUID NOT NULL REFERENCES ca_requests(id) ON DELETE CASCADE,
  sender_id      UUID NOT NULL REFERENCES users(id),
  body           TEXT NOT NULL,
  read_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_request ON messages(request_id, created_at);

CREATE TABLE message_attachments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE
);

-- ---------- PAYMENTS & COMMISSION ----------
CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         UUID REFERENCES ca_requests(id) ON DELETE SET NULL,
  business_id        UUID NOT NULL REFERENCES business_profiles(id),
  ca_id              UUID NOT NULL REFERENCES ca_profiles(id),
  amount_paise       BIGINT NOT NULL CHECK (amount_paise > 0),
  platform_fee_paise BIGINT NOT NULL DEFAULT 0,
  ca_earning_paise   BIGINT GENERATED ALWAYS AS (amount_paise - platform_fee_paise) STORED,
  currency           TEXT NOT NULL DEFAULT 'INR',
  status             payment_status NOT NULL DEFAULT 'pending',
  provider           TEXT,                 -- 'razorpay' | 'stripe' | etc, set at integration time
  provider_ref       TEXT,                 -- gateway transaction id — never store raw card data
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at         TIMESTAMPTZ
);
CREATE INDEX idx_payments_business ON payments(business_id, created_at DESC);
CREATE INDEX idx_payments_ca ON payments(ca_id, created_at DESC);

CREATE TABLE commissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     UUID NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
  percent_applied NUMERIC(5,2) NOT NULL,
  amount_paise   BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- SUBSCRIPTIONS ----------
CREATE TABLE plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,        -- 'business_free','business_pro','ca_listed'
  name          TEXT NOT NULL,
  audience      user_role NOT NULL,          -- who it's for: business_owner | ca
  price_paise   BIGINT NOT NULL DEFAULT 0,
  billing_period TEXT NOT NULL DEFAULT 'monthly',
  features      JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id        UUID NOT NULL REFERENCES plans(id),
  status         subscription_status NOT NULL DEFAULT 'active',
  current_period_end TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

-- ---------- REVIEWS ----------
CREATE TABLE reviews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     UUID NOT NULL UNIQUE REFERENCES ca_requests(id) ON DELETE CASCADE, -- 1 review per completed service
  business_id    UUID NOT NULL REFERENCES business_profiles(id),
  ca_id          UUID NOT NULL REFERENCES ca_profiles(id),
  rating         SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body           TEXT,
  is_reported    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reviews_ca ON reviews(ca_id);

-- ---------- NOTIFICATIONS ----------
CREATE TABLE notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel        notification_channel NOT NULL DEFAULT 'in_app',
  title          TEXT NOT NULL,
  body           TEXT,
  read_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

-- ---------- AI ----------
CREATE TABLE ai_conversations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content        TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_messages_conv ON ai_messages(conversation_id, created_at);

CREATE TABLE ai_usage (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_month   DATE NOT NULL,
  messages_used  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, period_month)
);

-- ---------- ADMIN / PLATFORM ----------
CREATE TABLE admin_settings (
  key            TEXT PRIMARY KEY,
  value          JSONB NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- seed default commission rate
INSERT INTO admin_settings (key, value) VALUES ('platform_commission_percent', '10');

CREATE TABLE audit_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  UUID REFERENCES users(id),
  action         TEXT NOT NULL,             -- e.g. 'document.view', 'payment.create'
  entity_type    TEXT,
  entity_id      UUID,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

-- ---------- updated_at trigger helper ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_business_updated_at BEFORE UPDATE ON business_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_ca_updated_at BEFORE UPDATE ON ca_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
