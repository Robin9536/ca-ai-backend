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

// GET /api/accounting/transactions?from=&to=&type=
router.get('/transactions', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { from, to, type } = req.query;
  const conditions = ['business_id = $1'];
  const values = [businessId];

  if (from) { values.push(from); conditions.push(`occurred_on >= $${values.length}`); }
  if (to) { values.push(to); conditions.push(`occurred_on <= $${values.length}`); }
  if (type) { values.push(type); conditions.push(`type = $${values.length}`); }

  const { rows } = await query(
    `SELECT * FROM transactions WHERE ${conditions.join(' AND ')} ORDER BY occurred_on DESC LIMIT 200`,
    values
  );
  res.json(rows);
}));

// POST /api/accounting/transactions
router.post('/transactions', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { type, category, description, amountPaise, occurredOn, taxPaise } = req.body;

  if (!['income', 'expense'].includes(type)) throw new HttpError(400, 'type must be income or expense');
  if (!category) throw new HttpError(400, 'category is required');
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new HttpError(400, 'amountPaise must be a positive integer');
  if (!occurredOn) throw new HttpError(400, 'occurredOn (date) is required');

  const { rows } = await query(
    `INSERT INTO transactions (business_id, type, category, description, amount_paise, tax_paise, occurred_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [businessId, type, category, description || null, amountPaise, taxPaise || 0, occurredOn, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

// GET /api/accounting/reports/profit-loss?from=&to=
router.get('/reports/profit-loss', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { from, to } = req.query;
  if (!from || !to) throw new HttpError(400, 'from and to query params are required (YYYY-MM-DD)');

  const { rows } = await query(
    `SELECT type, category, COALESCE(SUM(amount_paise),0)::bigint AS total
     FROM transactions
     WHERE business_id = $1 AND occurred_on BETWEEN $2 AND $3
     GROUP BY type, category
     ORDER BY type, total DESC`,
    [businessId, from, to]
  );

  const income = rows.filter((r) => r.type === 'income');
  const expense = rows.filter((r) => r.type === 'expense');
  const totalIncome = income.reduce((s, r) => s + Number(r.total), 0);
  const totalExpense = expense.reduce((s, r) => s + Number(r.total), 0);

  res.json({
    period: { from, to },
    income_by_category: income,
    expense_by_category: expense,
    total_income_paise: totalIncome,
    total_expense_paise: totalExpense,
    net_profit_paise: totalIncome - totalExpense,
  });
}));

module.exports = router;
