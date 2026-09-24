const { query } = require('../db/pool');

/**
 * Reads the platform commission percentage from admin_settings
 * (falls back to the .env default if the setting row is missing),
 * and returns the fee/CA-earning split for a given amount.
 * Amount is in the smallest currency unit (e.g. paise).
 */
async function calculateCommission(amountPaise) {
  const { rows } = await query(
    `SELECT value FROM admin_settings WHERE key = 'platform_commission_percent'`
  );
  const percent = rows.length
    ? Number(rows[0].value)
    : Number(process.env.DEFAULT_PLATFORM_COMMISSION_PERCENT || 10);

  const feePaise = Math.round(amountPaise * (percent / 100));
  const caEarningPaise = amountPaise - feePaise;

  return { percent, feePaise, caEarningPaise };
}

module.exports = { calculateCommission };
