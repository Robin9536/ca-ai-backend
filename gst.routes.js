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

// GET /api/gst/records
router.get('/records', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { rows } = await query(
    `SELECT * FROM gst_records WHERE business_id = $1 ORDER BY period_month DESC LIMIT 24`,
    [businessId]
  );
  res.json(rows);
}));

// POST /api/gst/records — create/update a period's GST figures
router.post('/records', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { periodMonth, taxableValuePaise, outputTaxPaise, inputTaxCreditPaise } = req.body;
  if (!periodMonth) throw new HttpError(400, 'periodMonth (YYYY-MM-01) is required');

  const { rows } = await query(
    `INSERT INTO gst_records (business_id, period_month, taxable_value_paise, output_tax_paise, input_tax_credit_paise)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (business_id, period_month)
     DO UPDATE SET taxable_value_paise = EXCLUDED.taxable_value_paise,
                   output_tax_paise = EXCLUDED.output_tax_paise,
                   input_tax_credit_paise = EXCLUDED.input_tax_credit_paise
     RETURNING *`,
    [businessId, periodMonth, taxableValuePaise || 0, outputTaxPaise || 0, inputTaxCreditPaise || 0]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/gst/records/:id/mark-filed
// NOTE: this only records that the business marked it as filed in the app.
// It does not actually submit anything to a government portal.
router.patch('/records/:id/mark-filed', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { rows } = await query(
    `UPDATE gst_records SET status = 'filed', filed_at = now()
     WHERE id = $1 AND business_id = $2 RETURNING *`,
    [req.params.id, businessId]
  );
  if (!rows.length) throw new HttpError(404, 'GST record not found');
  res.json(rows[0]);
}));

module.exports = router;
