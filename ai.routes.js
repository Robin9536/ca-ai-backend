const express = require('express');
const { query, pool } = require('../db/pool');
const { asyncRoute, HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { chargeForFeature, refund } = require('../utils/credits');

const router = express.Router();
router.use(requireAuth);

// GET /api/ai/conversations
router.get('/conversations', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, title, created_at FROM ai_conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
}));

// GET /api/ai/conversations/:id/messages
router.get('/conversations/:id/messages', asyncRoute(async (req, res) => {
  const owns = await query('SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!owns.rows.length) throw new HttpError(404, 'Conversation not found');
  const { rows } = await query(
    `SELECT role, content, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at`,
    [req.params.id]
  );
  res.json(rows);
}));

/**
 * POST /api/ai/conversations/:id?/messages
 *
 * Body: { content, feature }  — feature defaults to 'basic_question'.
 * Header: Idempotency-Key     — required; if the client retries the same
 *                                request (e.g. after a timeout), it's charged
 *                                at most once. Generate a fresh key per
 *                                logical request, not per retry.
 *
 * Flow (matches the spec's "check credits -> charge -> call AI -> refund on
 * failure" sequence): the credit charge and the conversation/message rows
 * are written in one DB transaction, so a crash between "charged" and
 * "message saved" is impossible -- either both happened or neither did.
 */
router.post('/conversations/:id?/messages', asyncRoute(async (req, res) => {
  const { content, feature } = req.body;
  const featureKey = feature || 'basic_question';
  const idempotencyKey = req.headers['idempotency-key'];
  if (!content || !content.trim()) throw new HttpError(400, 'content is required');
  if (!idempotencyKey) throw new HttpError(400, 'Idempotency-Key header is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Charging happens first: if the user can't afford it, nothing else runs
    // and nothing is written except (on a legitimate retry) reading the
    // already-processed transaction back out.
    const charge = await chargeForFeature(client, {
      userId: req.user.id,
      featureKey,
      referenceId: idempotencyKey,
      description: `AI: ${featureKey}`,
    });

    let conversationId = req.params.id;
    if (!conversationId) {
      const created = await client.query(
        `INSERT INTO ai_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
        [req.user.id, content.trim().slice(0, 60)]
      );
      conversationId = created.rows[0].id;
    } else {
      const owns = await client.query('SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2', [conversationId, req.user.id]);
      if (!owns.rows.length) throw new HttpError(404, 'Conversation not found');
    }

    if (!charge.alreadyProcessed) {
      await client.query(`INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,'user',$2)`, [conversationId, content.trim()]);
    }

    // --- Plug in your LLM call here ---
    // If this throws, the catch block below rolls back the whole transaction,
    // which automatically undoes the charge too -- no separate refund needed
    // for an in-transaction failure. refund() (imported above) is for
    // reversing a charge from an *earlier, already-committed* transaction,
    // e.g. an async worker that finds out later the AI call failed.
    let reply;
    try {
      reply = 'AI response placeholder -- connect this endpoint to a language model to generate real answers.';
    } catch (aiErr) {
      throw new HttpError(502, 'The AI assistant could not process that request. You have not been charged.');
    }

    const saved = await client.query(
      `INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,'assistant',$2) RETURNING id, role, content, created_at`,
      [conversationId, reply]
    );

    if (!charge.alreadyProcessed) {
      await client.query(
        `INSERT INTO ai_usage (user_id, feature_key, credits_used, request_id) VALUES ($1,$2,$3,$4)`,
        [req.user.id, featureKey, charge.cost, idempotencyKey]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      conversationId,
      message: saved.rows[0],
      credits_charged: charge.cost,
      balance_after: charge.transaction.balance_after,
      already_processed: charge.alreadyProcessed,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
