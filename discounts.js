const { getPool } = require('./db');

// Website collections (the page addresses) that can have a sale discount
const COLLECTIONS = ['new-arrival', 'sale', 'formal', 'bridal', 'wedding-formal', 'ready-to-wear', 'unstitched', 'party'];

// { 'sale': 30, 'formal': 0, ... } — every collection, 0 when not set
async function getDiscounts() {
  const result = Object.fromEntries(COLLECTIONS.map((c) => [c, 0]));
  const pool = getPool();
  if (!pool) {
    return result;
  }
  const [rows] = await pool.query('SELECT collection, percent FROM discounts');
  rows.forEach((row) => {
    if (COLLECTIONS.includes(row.collection)) {
      result[row.collection] = row.percent;
    }
  });
  return result;
}

// Accepts { collection: percent } for any of the known collections (0–90)
async function saveDiscounts(input) {
  const pool = getPool();
  const entries = Object.entries(input || {}).filter(([c]) => COLLECTIONS.includes(c));
  for (const [collection, value] of entries) {
    const percent = Math.min(90, Math.max(0, Math.round(Number(value) || 0)));
    await pool.execute(
      'INSERT INTO discounts (collection, percent) VALUES (?, ?) ON DUPLICATE KEY UPDATE percent = VALUES(percent)',
      [collection, percent]
    );
  }
  return getDiscounts();
}

module.exports = { COLLECTIONS, getDiscounts, saveDiscounts };
