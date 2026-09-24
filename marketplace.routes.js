const express = require('express');
const { query } = require('../db/pool');
const { asyncRoute, HttpError } = require('../middleware/errorHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/marketplace/cas?service=&city=&q=  (public search, no auth required)
router.get('/cas', asyncRoute(async (req, res) => {
  const { service, city, q } = req.query;
  const conditions = ['cp.is_listed = TRUE'];
  const values = [];

  if (city) { values.push(`%${city}%`); conditions.push(`cp.city ILIKE $${values.length}`); }
  if (q) { values.push(`%${q}%`); conditions.push(`(u.full_name ILIKE $${values.length} OR cp.headline ILIKE $${values.length})`); }
  if (service) {
    values.push(service);
    conditions.push(`EXISTS (
      SELECT 1 FROM ca_services cs JOIN services s ON s.id = cs.service_id
      WHERE cs.ca_id = cp.id AND s.slug = $${values.length}
    )`);
  }

  const { rows } = await query(
    `SELECT cp.id, u.full_name, cp.headline, cp.city, cp.years_experience, cp.remote_ok,
            cp.base_consultation_fee_paise, cp.is_verified,
            COALESCE(AVG(r.rating),0)::float AS avg_rating, COUNT(r.id)::int AS review_count
     FROM ca_profiles cp
     JOIN users u ON u.id = cp.user_id
     LEFT JOIN reviews r ON r.ca_id = cp.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY cp.id, u.full_name
     ORDER BY review_count DESC, cp.years_experience DESC
     LIMIT 40`,
    values
  );
  res.json(rows);
}));

// GET /api/marketplace/cas/:id  (public profile)
router.get('/cas/:id', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT cp.*, u.full_name,
       (SELECT json_agg(json_build_object('service', s.name, 'price_paise', cs.price_paise, 'unit', cs.price_unit))
        FROM ca_services cs JOIN services s ON s.id = cs.service_id WHERE cs.ca_id = cp.id) AS services
     FROM ca_profiles cp JOIN users u ON u.id = cp.user_id
     WHERE cp.id = $1 AND cp.is_listed = TRUE`,
    [req.params.id]
  );
  if (!rows.length) throw new HttpError(404, 'CA profile not found');
  res.json(rows[0]);
}));

// ---- Hire flow (auth required from here down) ----
router.use(requireAuth);

async function getOwnBusinessId(userId) {
  const { rows } = await query('SELECT id FROM business_profiles WHERE user_id = $1', [userId]);
  if (!rows.length) throw new HttpError(404, 'Business profile not found');
  return rows[0].id;
}
async function getOwnCaId(userId) {
  const { rows } = await query('SELECT id FROM ca_profiles WHERE user_id = $1', [userId]);
  if (!rows.length) throw new HttpError(404, 'CA profile not found');
  return rows[0].id;
}

// POST /api/marketplace/requests — business owner sends a hire request
router.post('/requests', requireRole('business_owner'), asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { caId, serviceId, message } = req.body;
  if (!caId) throw new HttpError(400, 'caId is required');

  const { rows } = await query(
    `INSERT INTO ca_requests (business_id, ca_id, service_id, message)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [businessId, caId, serviceId || null, message || null]
  );

  const ca = await query('SELECT user_id FROM ca_profiles WHERE id = $1', [caId]);
  if (ca.rows.length) {
    await query(
      `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`,
      [ca.rows[0].user_id, 'New service request', 'A business owner has requested your services.']
    );
  }

  res.status(201).json(rows[0]);
}));

// GET /api/marketplace/requests — list requests for the current user (either side)
router.get('/requests', asyncRoute(async (req, res) => {
  let rows;
  if (req.user.role === 'business_owner') {
    const businessId = await getOwnBusinessId(req.user.id);
    ({ rows } = await query(
      `SELECT r.*, u.full_name AS ca_name FROM ca_requests r
       JOIN ca_profiles cp ON cp.id = r.ca_id JOIN users u ON u.id = cp.user_id
       WHERE r.business_id = $1 ORDER BY r.created_at DESC`,
      [businessId]
    ));
  } else if (req.user.role === 'ca') {
    const caId = await getOwnCaId(req.user.id);
    ({ rows } = await query(
      `SELECT r.*, bp.business_name FROM ca_requests r
       JOIN business_profiles bp ON bp.id = r.business_id
       WHERE r.ca_id = $1 ORDER BY r.created_at DESC`,
      [caId]
    ));
  } else {
    throw new HttpError(403, 'Not applicable for this role');
  }
  res.json(rows);
}));

// PATCH /api/marketplace/requests/:id/status — CA accepts/rejects/progresses a request
const ALLOWED_TRANSITIONS = {
  pending: ['accepted', 'rejected'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['waiting_client', 'completed', 'cancelled'],
  waiting_client: ['in_progress', 'completed', 'cancelled'],
};
router.patch('/requests/:id/status', requireRole('ca'), asyncRoute(async (req, res) => {
  const caId = await getOwnCaId(req.user.id);
  const { status } = req.body;

  const current = await query('SELECT status FROM ca_requests WHERE id = $1 AND ca_id = $2', [req.params.id, caId]);
  if (!current.rows.length) throw new HttpError(404, 'Request not found');

  const from = current.rows[0].status;
  if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].includes(status)) {
    throw new HttpError(400, `Cannot move a request from "${from}" to "${status}"`);
  }

  const extra = status === 'accepted' ? ', accepted_at = now()'
    : status === 'completed' ? ', completed_at = now()' : '';
  const { rows } = await query(
    `UPDATE ca_requests SET status = $1${extra} WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  res.json(rows[0]);
}));

// POST /api/marketplace/requests/:id/reviews — business leaves one review per completed request
router.post('/requests/:id/reviews', requireRole('business_owner'), asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { rating, body } = req.body;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'rating must be 1-5');

  const request = await query(
    `SELECT id, ca_id, status FROM ca_requests WHERE id = $1 AND business_id = $2`,
    [req.params.id, businessId]
  );
  if (!request.rows.length) throw new HttpError(404, 'Request not found');
  if (request.rows[0].status !== 'completed') throw new HttpError(400, 'Only completed services can be reviewed');

  const { rows } = await query(
    `INSERT INTO reviews (request_id, business_id, ca_id, rating, body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, businessId, request.rows[0].ca_id, rating, body || null]
  ); // request_id UNIQUE constraint in schema prevents a second review for the same request
  res.status(201).json(rows[0]);
}));

module.exports = router;
