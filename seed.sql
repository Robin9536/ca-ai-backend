-- Demo seed data — matches the demo content shown in the CA & AI prototype UI.
-- Run after schema.sql. All passwords below are the bcrypt hash of "password123".

INSERT INTO services (name, slug, category) VALUES
  ('GST Filing', 'gst-filing', 'compliance'),
  ('Bookkeeping', 'bookkeeping', 'accounting'),
  ('Startup Accounting', 'startup-accounting', 'accounting'),
  ('Audit', 'audit', 'compliance'),
  ('Tax Planning', 'tax-planning', 'tax');

INSERT INTO plans (code, name, audience, price_paise, billing_period, features) VALUES
  ('business_free', 'Starter', 'business_owner', 0, 'monthly', '["Core accounting tools","Limited AI credits/month","Browse CA profiles"]'),
  ('business_pro', 'Business', 'business_owner', 149900, 'monthly', '["Unlimited AI Finance Assistant","Full financial reports","Document AI extraction","Priority CA matching"]'),
  ('ca_listed', 'CA / Firm', 'ca', 99900, 'monthly', '["Marketplace listing","Client & request management","Earnings dashboard"]');

-- Demo users (bcrypt hash placeholder — regenerate with `node src/db/hash.js password123`)
INSERT INTO users (id, email, password_hash, role, full_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner@demo.ca-ai.app', '$2b$12$replace.with.real.bcrypt.hash', 'business_owner', 'Rhea Studio Owner'),
  ('22222222-2222-2222-2222-222222222222', 'rhea.nair@demo.ca-ai.app', '$2b$12$replace.with.real.bcrypt.hash', 'ca', 'Rhea Nair'),
  ('33333333-3333-3333-3333-333333333333', 'admin@demo.ca-ai.app', '$2b$12$replace.with.real.bcrypt.hash', 'admin', 'Platform Admin');

INSERT INTO business_profiles (user_id, business_name, city, gstin) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Rhea''s Studio', 'Bengaluru', '29ABCDE1234F1Z5');

INSERT INTO ca_profiles (user_id, headline, years_experience, city, specializations, base_consultation_fee_paise, is_verified) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Individual practice · Bengaluru', 9, 'Bengaluru', ARRAY['GST filing','Bookkeeping'], 80000, FALSE);
