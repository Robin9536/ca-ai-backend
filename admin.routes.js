const express = require('express');
const { query, pool } = require('../db/pool');
const { asyncRoute, HttpError } = require('../middleware/errorHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const { grantCredits } = require('../utils/credits');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/analytics
router.get('/analytics', asyncRoute(async (req, res) => {
  const [users, revenue, requests, aiUsage] = await Promise.all([
    query(`SELECT role, COUNT(*)::int AS count FROM users GROUP BY role`),
    query(`SELECT COALESCE(SUM(platform_fee_paise),0)::bigint AS commission_revenue,
                  COALESCE(SUM(amount_paise),0)::bigint AS gross_volume
           FROM payments WHERE status = 'succeeded'`),
    query(`SELECT status, COUNT(*)::int AS count FROM ca_requests GROUP BY status`),
    query(`SELECT COALESCE(SUM(messages_used),0)::int AS total FROM ai_usage
           WHERE period_month = date_trunc('month', CURRENT_DATE)`),
  ]);

  res.json({
    users_by_role: users.rows,
    commission_revenue_paise: Number(revenue.rows[0].commission_revenue),
    gross_payment_volume_paise: Number(revenue.rows[0].gross_volume),
    requests_by_status: requests.rows,
    ai_messages_this_month: aiUsage.rows[0].total,
  });
}));

// GET /api/admin/users?role=&q=
router.get('/users', asyncRoute(async (req, res) => {
  const { role, q } = req.query;
  const conditions = [];
  const values = [];
  if (role) { values.push(role); conditions.push(`role = $${values.length}`); }
  if (q) { values.push(`%${q}%`); conditions.push(`(full_name ILIKE $${values.length} OR email ILIKE $${values.length})`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT id, email, role, full_name, is_active, created_at FROM users ${where} ORDER BY created_at DESC LIMIT 200`,
    values
  );
  res.json(rows);
}));

// PATCH /api/admin/users/:id/suspend
router.patch('/users/:id/suspend', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `UPDATE users SET is_active = FALSE WHERE id = $1 RETURNING id, email, is_active`,
    [req.params.id]
  );
  if (!rows.length) throw new HttpError(404, 'User not found');
  await query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id) VALUES ($1,'user.suspend','user',$2)`,
    [req.user.id, req.params.id]
  );
  res.json(rows[0]);
}));

// PATCH /api/admin/settings/commission — update platform commission percent
router.patch('/settings/commission', asyncRoute(async (req, res) => {
  const { percent } = req.body;
  if (typeof percent !== 'number' || percent < 0 || percent > 100) {
    throw new HttpError(400, 'percent must be a number between 0 and 100');
  }
  const { rows } = await query(
    `UPDATE admin_settings SET value = $1::jsonb, updated_at = now()
     WHERE key = 'platform_commission_percent' RETURNING *`,
    [JSON.stringify(percent)]
  );
  res.json(rows[0]);
}));

// GET /api/admin/reviews/reported
router.get('/reviews/reported', asyncRoute(async (req, res) => {
  const { rows } = await query(`SELECT * FROM reviews WHERE is_reported = TRUE ORDER BY created_at DESC`);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// AI credit system management
// ---------------------------------------------------------------------------

// GET /api/admin/credits/summary — sold vs. consumed, revenue, active wallets
router.get('/credits/summary', asyncRoute(async (req, res) => {
  const [sold, used, revenue, wallets] = await Promise.all([
    query(`SELECT COALESCE(SUM(amount),0)::bigint AS total FROM credit_transactions WHERE type IN ('purchase','signup_bonus','subscription_allocation','promotional')`),
    query(`SELECT COALESCE(SUM(-amount),0)::bigint AS total FROM credit_transactions WHERE type = 'ai_usage'`),
    query(`SELECT COALESCE(SUM(price_paise),0)::bigint AS total FROM credit_purchases WHERE status = 'succeeded'`),
    query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(balance),0)::bigint AS total_balance FROM wallets`),
  ]);
  res.json({
    total_credits_granted: Number(sold.rows[0].total),
    total_credits_consumed: Number(used.rows[0].total),
    credit_revenue_paise: Number(revenue.rows[0].total),
    wallet_count: wallets.rows[0].count,
    credits_outstanding: Number(wallets.rows[0].total_balance),
  });
}));

// GET /api/admin/credits/packages
router.get('/credits/packages', asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT * FROM credit_packages ORDER BY sort_order');
  res.json(rows);
}));

// PATCH /api/admin/credits/packages/:id — edit price/credits/active state
router.patch('/credits/packages/:id', asyncRoute(async (req, res) => {
  const fields = ['name', 'credits', 'price_paise', 'currency', 'active', 'sort_order'];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f} = $${values.length}`); }
  });
  if (!updates.length) throw new HttpError(400, 'No fields to update');
  values.push(req.params.id);
  const { rows } = await query(`UPDATE credit_packages SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
  if (!rows.length) throw new HttpError(404, 'Package not found');
  res.json(rows[0]);
}));

// GET /api/admin/credits/ai-costs
router.get('/credits/ai-costs', asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT * FROM ai_feature_costs ORDER BY credit_cost');
  res.json(rows);
}));

// PATCH /api/admin/credits/ai-costs/:featureKey — retune what a feature costs
router.patch('/credits/ai-costs/:featureKey', asyncRoute(async (req, res) => {
  const { creditCost } = req.body;
  if (!Number.isInteger(creditCost) || creditCost < 0) throw new HttpError(400, 'creditCost must be a non-negative integer');
  const { rows } = await query(
    `UPDATE ai_feature_costs SET credit_cost = $1, updated_at = now() WHERE feature_key = $2 RETURNING *`,
    [creditCost, req.params.featureKey]
  );
  if (!rows.length) throw new HttpError(404, 'Unknown feature key');
  res.json(rows[0]);
}));

// PATCH /api/admin/credits/signup-bonus — change the welcome bonus amount
router.patch('/credits/signup-bonus', asyncRoute(async (req, res) => {
  const { credits } = req.body;
  if (!Number.isInteger(credits) || credits < 0) throw new HttpError(400, 'credits must be a non-negative integer');
  const { rows } = await query(
    `UPDATE admin_settings SET value = $1::jsonb, updated_at = now() WHERE key = 'signup_bonus_credits' RETURNING *`,
    [JSON.stringify(credits)]
  );
  res.json(rows[0]);
}));

// POST /api/admin/credits/adjust — manual grant or removal, always audited
router.post('/credits/adjust', asyncRoute(async (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!userId) throw new HttpError(400, 'userId is required');
  if (!Number.isInteger(amount) || amount === 0) throw new HttpError(400, 'amount must be a non-zero integer');
  if (!reason || !reason.trim()) throw new HttpError(400, 'reason is required for any manual credit adjustment');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let result;
    if (amount > 0) {
      result = await grantCredits(client, {
        userId, amount, type: 'admin_adjustment', description: reason,
        referenceId: `admin-adj-${userId}-${Date.now()}`,
      });
    } else {
      // Negative adjustment: same conditional-UPDATE pattern as chargeForFeature,
      // just not tied to an AI feature.
      const wallet = await client.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
      if (!wallet.rows.length) throw new HttpError(404, 'User has no wallet yet');
      const updated = await client.query(
        'UPDATE wallets SET balance = balance + $1 WHERE id = $2 AND balance >= $3 RETURNING balance',
        [amount, wallet.rows[0].id, -amount]
      );
      if (!updated.rows.length) throw new HttpError(400, 'Cannot remove more credits than the user has');
      const tx = await client.query(
        `INSERT INTO credit_transactions (user_id, wallet_id, type, amount, balance_after, description, reference_id)
         VALUES ($1,$2,'admin_adjustment',$3,$4,$5,$6) RETURNING *`,
        [userId, wallet.rows[0].id, amount, updated.rows[0].balance, reason, `admin-adj-${userId}-${Date.now()}`]
      );
      result = { transaction: tx.rows[0] };
    }

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1,'credits.adjust','user',$2,$3)`,
      [req.user.id, userId, JSON.stringify({ amount, reason })]
    );

    await client.query('COMMIT');
    res.status(201).json(result.transaction);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// GET /api/admin/credits/users/:userId — one user's wallet + recent ledger (support/debugging)
router.get('/credits/users/:userId', asyncRoute(async (req, res) => {
  const wallet = await query('SELECT * FROM wallets WHERE user_id = $1', [req.params.userId]);
  const tx = await query(
    'SELECT * FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.params.userId]
  );
  res.json({ wallet: wallet.rows[0] || null, recent_transactions: tx.rows });
}));

module.exports = router;
