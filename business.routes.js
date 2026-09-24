const express = require('express');
const { query } = require('../db/pool');
const { asyncRoute, HttpError } = require('../middleware/errorHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('business_owner'));

async function getOwnBusinessId(userId) {
  const { rows } = await query('SELECT id FROM business_profiles WHERE user_id = $1', [userId]);
  if (!rows.length) throw new HttpError(404, 'Business profile not found');
  return rows[0].id;
}

// GET /api/business/me
router.get('/me', asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT * FROM business_profiles WHERE user_id = $1', [req.user.id]);
  if (!rows.length) throw new HttpError(404, 'Business profile not found');
  res.json(rows[0]);
}));

// PATCH /api/business/me
router.patch('/me', asyncRoute(async (req, res) => {
  const fields = ['business_name', 'business_type', 'gstin', 'pan', 'address', 'city', 'state', 'currency'];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      updates.push(`${f} = $${values.length}`);
    }
  });
  if (!updates.length) throw new HttpError(400, 'No fields to update');
  values.push(req.user.id);

  const { rows } = await query(
    `UPDATE business_profiles SET ${updates.join(', ')} WHERE user_id = $${values.length} RETURNING *`,
    values
  );
  res.json(rows[0]);
}));

// GET /api/business/dashboard — summary numbers for the dashboard screen
router.get('/dashboard', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const periodStart = new Date();
  periodStart.setDate(1);

  const totals = await query(
    `SELECT type, COALESCE(SUM(amount_paise),0)::bigint AS total
     FROM transactions
     WHERE business_id = $1 AND occurred_on >= $2
     GROUP BY type`,
    [businessId, periodStart]
  );
  const revenue = Number(totals.rows.find((r) => r.type === 'income')?.total || 0);
  const expenses = Number(totals.rows.find((r) => r.type === 'expense')?.total || 0);

  const recent = await query(
    `SELECT id, type, category, description, amount_paise, occurred_on
     FROM transactions WHERE business_id = $1
     ORDER BY occurred_on DESC, created_at DESC LIMIT 5`,
    [businessId]
  );

  const pendingInvoices = await query(
    `SELECT COUNT(*)::int AS count FROM invoices WHERE business_id = $1 AND status IN ('sent','overdue')`,
    [businessId]
  );

  res.json({
    revenue_paise: revenue,
    expenses_paise: expenses,
    profit_paise: revenue - expenses,
    recent_transactions: recent.rows,
    pending_invoices: pendingInvoices.rows[0].count,
  });
}));

module.exports = router;
