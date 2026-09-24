const { HttpError } = require('../middleware/errorHandler');

/**
 * All balance changes go through this file. Nothing outside it should ever
 * run `UPDATE wallets SET balance = ...` directly — that's how you end up
 * with a balance that doesn't match its own ledger.
 *
 * Every function here must be called with a `client` that is already inside
 * a `BEGIN ... COMMIT` transaction (see routes for the pattern), so a crash
 * partway through can never leave the wallet and the ledger disagreeing.
 */

/** Fetches (and creates if missing) a user's wallet row. */
async function getOrCreateWallet(client, userId) {
  const existing = await client.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  if (existing.rows.length) return existing.rows[0];
  const created = await client.query(
    'INSERT INTO wallets (user_id, balance) VALUES ($1, 0) RETURNING *',
    [userId]
  );
  return created.rows[0];
}

/**
 * Adds credits (bonus, purchase, promo, admin adjustment, refund — any
 * positive movement). `referenceId` is an idempotency key: if a row with
 * that reference_id already exists, this is a no-op that returns the
 * existing state instead of crediting twice.
 */
async function grantCredits(client, { userId, amount, type, description, referenceId }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpError(400, 'Credit amount must be a positive integer');
  }

  if (referenceId) {
    const dup = await client.query('SELECT * FROM credit_transactions WHERE reference_id = $1', [referenceId]);
    if (dup.rows.length) return { transaction: dup.rows[0], alreadyProcessed: true };
  }

  const wallet = await getOrCreateWallet(client, userId);
  const updated = await client.query(
    'UPDATE wallets SET balance = balance + $1 WHERE id = $2 RETURNING balance',
    [amount, wallet.id]
  );
  const newBalance = updated.rows[0].balance;

  const tx = await client.query(
    `INSERT INTO credit_transactions (user_id, wallet_id, type, amount, balance_after, description, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, wallet.id, type, amount, newBalance, description || null, referenceId || null]
  );
  return { transaction: tx.rows[0], alreadyProcessed: false };
}

/**
 * Deducts credits for an AI feature. Uses a single conditional UPDATE
 * (`WHERE balance >= cost`) as the atomicity/race-safety mechanism — under
 * concurrent requests, at most one can succeed in taking the last credits;
 * the rest see 0 rows updated and fail cleanly with 402, never a negative
 * balance. `referenceId` (the idempotency key) prevents a retried request
 * from being charged twice.
 */
async function chargeForFeature(client, { userId, featureKey, referenceId, description }) {
  if (referenceId) {
    const dup = await client.query('SELECT * FROM credit_transactions WHERE reference_id = $1', [referenceId]);
    if (dup.rows.length) return { transaction: dup.rows[0], alreadyProcessed: true, cost: Math.abs(dup.rows[0].amount) };
  }

  const costRow = await client.query('SELECT credit_cost, label FROM ai_feature_costs WHERE feature_key = $1', [featureKey]);
  if (!costRow.rows.length) throw new HttpError(400, `Unknown AI feature "${featureKey}"`);
  const cost = costRow.rows[0].credit_cost;

  const wallet = await getOrCreateWallet(client, userId);
  const updated = await client.query(
    'UPDATE wallets SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
    [cost, wallet.id]
  );
  if (!updated.rows.length) {
    throw new HttpError(402, `Not enough AI credits for "${costRow.rows[0].label}" (needs ${cost}).`);
  }
  const newBalance = updated.rows[0].balance;

  const tx = await client.query(
    `INSERT INTO credit_transactions (user_id, wallet_id, type, amount, balance_after, description, reference_id)
     VALUES ($1,$2,'ai_usage',$3,$4,$5,$6) RETURNING *`,
    [userId, wallet.id, -cost, newBalance, description || costRow.rows[0].label, referenceId || null]
  );
  return { transaction: tx.rows[0], alreadyProcessed: false, cost };
}

/** Reverses a charge (e.g. the AI call itself failed after credits were taken). */
async function refund(client, { userId, amount, description, referenceId }) {
  return grantCredits(client, { userId, amount, type: 'refund', description, referenceId });
}

module.exports = { getOrCreateWallet, grantCredits, chargeForFeature, refund };
