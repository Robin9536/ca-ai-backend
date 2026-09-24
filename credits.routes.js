const express = require('express');
const { query, pool } = require('../db/pool');
const { asyncRoute, HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { grantCredits } = require('../utils/credits');

const router = express.Router();

// GET /api/credits/packages (public)
router.get('/packages', asyncRoute(async (req, res) => {
  const { rows } = await query(
    'SELECT id, name, credits, price_paise, currency FROM credit_packages WHERE active = TRUE ORDER BY sort_order'
  );
  res.json(rows);
}));

router.use(requireAuth);

// POST /api/credits/purchase — starts a checkout. This does NOT grant credits.
// In production this is also where you'd call your payment provider's API to
// create a checkout session and return its redirect URL to the client.
router.post('/purchase', asyncRoute(async (req, res) => {
  const { packageId } = req.body;
  const pkg = await query('SELECT * FROM credit_packages WHERE id = $1 AND active = TRUE', [packageId]);
  if (!pkg.rows.length) throw new HttpError(404, 'Credit package not found');

  const { rows } = await query(
    `INSERT INTO credit_purchases (user_id, package_id, credits, price_paise, currency, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
    [req.user.id, packageId, pkg.rows[0].credits, pkg.rows[0].price_paise, pkg.rows[0].currency]
  );
  res.status(201).json(rows[0]);
}));

// GET /api/credits/purchase/:id — client polls this to see if the webhook has settled it yet
router.get('/purchase/:id', asyncRoute(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM credit_purchases WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!rows.length) throw new HttpError(404, 'Purchase not found');
  res.json(rows[0]);
}));

// GET /api/credits/purchases — history
router.get('/purchases', asyncRoute(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM credit_purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// POST /api/credits/webhook — called ONLY by your payment gateway's servers,
// never by the browser. This is the single place credits get added for a
// purchase, and it is the enforcement point for "never trust the frontend
// with payment success" from the spec. Protect it with your gateway's own
// signature verification in production (Razorpay/Stripe both sign webhook
// bodies) — the shared-secret header below is a minimal stand-in for that.
// ---------------------------------------------------------------------------
router.post('/webhook', asyncRoute(async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!process.env.PAYMENT_WEBHOOK_SECRET || secret !== process.env.PAYMENT_WEBHOOK_SECRET) {
    throw new HttpError(401, 'Invalid webhook signature');
  }

  const { purchaseId, providerRef, provider, status } = req.body;
  if (!purchaseId || !['succeeded', 'failed'].includes(status)) {
    throw new HttpError(400, 'purchaseId and a valid status are required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Only settle a purchase that is still pending — this UPDATE's WHERE clause
    // is the idempotency guard: a duplicate webhook delivery for an
    // already-settled purchase simply updates zero rows.
    const purchase = await client.query(
      `UPDATE credit_purchases SET status = $1, provider = $2, provider_ref = $3, settled_at = now()
       WHERE id = $4 AND status = 'pending' RETURNING *`,
      [status, provider || null, providerRef || null, purchaseId]
    );

    if (!purchase.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, note: 'Already settled or not found — no action taken.' });
    }

    if (status === 'succeeded') {
      await grantCredits(client, {
        userId: purchase.rows[0].user_id,
        amount: purchase.rows[0].credits,
        type: 'purchase',
        description: `Credit purchase (${purchase.rows[0].credits} credits)`,
        referenceId: purchaseId, // same key as the purchase row — can't double-credit a retried webhook
      });
    }

    await client.query('COMMIT');
    res.json({ ok: true, purchase: purchase.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
