CA & AI — Backend
Node/Express + PostgreSQL API for the CA & AI prototype (auth, accounting, GST,
documents, CA marketplace, payments, subscriptions, admin, AI conversation storage).
This is real, runnable server code — it just isn't running here, since this
chat has no server or database process. Deploy it anywhere that runs Node 18+
and has a PostgreSQL 14+ instance (Render, Railway, Fly.io, a VPS, etc.).
What's genuinely implemented vs. stubbed
Implemented: auth (signup/login/JWT), role-based access, business profile,
accounting transactions + P&L report, GST record tracking, document upload +
manual-review extraction, CA search + hire-request state machine, messages,
one-review-per-completed-service, payment records with commission split,
subscriptions, admin analytics/user management, AI conversation storage with
a monthly usage cap.
Deliberately stubbed, with a comment at the exact line to fill in:
`src/routes/documents.routes.js` — real OCR/document-AI extraction (needs a
vision-capable model or a service like Textract/Document AI)
`src/routes/payments.routes.js` — an actual payment gateway (Razorpay/Stripe)
webhook to flip a payment from `pending` to `succeeded`
`src/routes/ai.routes.js` — the actual LLM call for the finance assistant
These are stubbed because they need real third-party credentials this
environment doesn't have — wiring them in is mechanical once you have keys.
Setup
```bash
cp .env.example .env      # fill in DATABASE_URL and a real JWT_SECRET
npm install
npm run db:setup          # applies schema.sql
npm run db:setup -- --seed  # optional: also loads demo data from seed.sql
npm run dev                # starts on http://localhost:4000
```
Before loading seed data, regenerate the password hashes (the file ships
with placeholders):
```bash
node -e "require('bcrypt').hash('password123', 12).then(console.log)"
```
and paste the result into `src/db/seed.sql` in place of the placeholder hashes.
Auth
All authenticated routes expect `Authorization: Bearer <token>`, where the
token comes from `POST /api/auth/signup` or `POST /api/auth/login`.
Endpoint map
Method	Path	Auth	Notes
POST	/api/auth/signup	—	role: business_owner | ca
POST	/api/auth/login	—	
GET	/api/auth/me	✓	
GET	/api/business/dashboard	business_owner	revenue/expenses/profit/recent tx
GET/PATCH	/api/business/me	business_owner	
GET/POST	/api/accounting/transactions	business_owner	
GET	/api/accounting/reports/profit-loss	business_owner	?from=&to=
GET/POST	/api/gst/records	business_owner	
PATCH	/api/gst/records/:id/mark-filed	business_owner	app-side flag only, not a real filing
GET/POST	/api/documents	✓	multipart upload, field `file`
PATCH	/api/documents/:id/extraction	✓	human-reviewed fields
GET	/api/marketplace/cas	—	search: ?service=&city=&q=
GET	/api/marketplace/cas/:id	—	public profile
POST	/api/marketplace/requests	business_owner	hire request
PATCH	/api/marketplace/requests/:id/status	ca	pending→accepted→in_progress→completed
POST	/api/marketplace/requests/:id/reviews	business_owner	one per completed request
POST	/api/payments	business_owner	computes commission split
PATCH	/api/payments/:id/settle	—	call from your gateway webhook
GET	/api/payments/history	✓	
GET	/api/subscriptions/plans	—	?audience=business_owner|ca
POST/DELETE	/api/subscriptions	✓	
GET	/api/admin/analytics	admin	
GET	/api/admin/users	admin	
PATCH	/api/admin/settings/commission	admin	changes the platform-wide fee %
POST	/api/ai/conversations/:id?/messages	✓	requires `Idempotency-Key` header; credit-gated, LLM call stubbed
AI credit / wallet system
Every user gets a wallet, a configurable signup bonus, and every AI feature
has a configurable credit cost. This is enforced entirely server-side —
the frontend never decides a balance, a cost, or whether a payment
succeeded (see `src/utils/credits.js` for the mechanism).
Method	Path	Auth	Notes
GET	/api/wallet/me	✓	balance, totals, low/zero flags
GET	/api/wallet/transactions	✓	full ledger
GET	/api/wallet/ai-costs	✓	current price of each AI feature
GET	/api/credits/packages	—	purchasable packages
POST	/api/credits/purchase	✓	creates a pending purchase — grants nothing
GET	/api/credits/purchase/:id	✓	poll for settlement
POST	/api/credits/webhook	webhook secret, not user JWT	the ONLY place credits are added for a purchase
PATCH	/api/admin/credits/packages/:id	admin	
PATCH	/api/admin/credits/ai-costs/:featureKey	admin	
PATCH	/api/admin/credits/signup-bonus	admin	
POST	/api/admin/credits/adjust	admin	manual grant/removal, always audit-logged
GET	/api/admin/credits/summary	admin	sold vs. consumed, revenue
Why `/api/credits/webhook` doesn't take a user token: the spec is explicit
that a browser saying "my payment succeeded" must never be trusted. This
route is meant to be called by your payment gateway's servers (or a small
relay you control), authenticated with `PAYMENT_WEBHOOK_SECRET`, exactly the
way Stripe/Razorpay webhooks work. There is deliberately no code path
anywhere that lets an authenticated user request mark their own purchase
as paid.
Idempotency, two ways:
AI usage: the client sends an `Idempotency-Key` header per logical request.
`credit_transactions.reference_id` has a UNIQUE constraint on that key, so
a retried request is detected and returned as "already processed" instead
of being charged twice.
Purchases: `credit_purchases` only moves out of `pending` via a `WHERE status = 'pending'` update, so a webhook delivered twice (which all major
gateways do occasionally, by design) settles once and no-ops the second
time.
Atomicity: crediting and debiting both happen with a single conditional
`UPDATE ... WHERE balance >= cost` inside a transaction — there's no
read-balance-then-write-balance window for two concurrent requests to both
pass the check and take the wallet negative.

Design decisions worth knowing about
All money is stored as integer paise/cents (`amount_paise`), never
floating point, to avoid rounding errors.
The original spec's separate `income`/`expenses`/`sales`/`purchases`
tables are unified into one `transactions` table with a `type` column —
fewer tables to keep consistent, same information.
`financial_reports` isn't a stored table; P&L is computed by query
(`/api/accounting/reports/profit-loss`) so it's always correct against the
live ledger instead of going stale.
`ca_profiles.is_verified` defaults to `false` and nothing in this codebase
sets it to `true` automatically — that flag should only ever be flipped by
an actual verification process, per the original brief's instruction not to
imply verification that didn't happen.
