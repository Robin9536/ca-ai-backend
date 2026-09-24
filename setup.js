/**
 * Applies schema.sql (and optionally seed.sql) to the database
 * pointed at by DATABASE_URL. Run with: npm run db:setup
 * Add --seed to also load demo data: node src/db/setup.js --seed
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Applying schema.sql ...');
  await pool.query(schema);
  console.log('Schema applied.');

  const creditsSchema = fs.readFileSync(path.join(__dirname, 'credits_schema.sql'), 'utf8');
  console.log('Applying credits_schema.sql ...');
  await pool.query(creditsSchema);
  console.log('Credit system schema applied.');

  if (process.argv.includes('--seed')) {
    const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
    console.log('Applying seed.sql ...');
    await pool.query(seed);
    console.log('Seed data loaded.');
  }

  await pool.end();
}

run().catch((err) => {
  console.error('DB setup failed:', err.message);
  process.exit(1);
});
