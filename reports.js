const { getPool } = require('./db');

// Sales report for a date range (from / to as YYYY-MM-DD, both optional).
// Cancelled orders are counted per status but left out of the sales figures.
async function getReport(query) {
  const pool = getPool();
  const where = [];
  const params = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.from || '')) {
    where.push('o.created_at >= ?');
    params.push(`${query.from} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.to || '')) {
    where.push('o.created_at <= ?');
    params.push(`${query.to} 23:59:59`);
  }
  const range = where.length ? `AND ${where.join(' AND ')}` : '';
  const sold = `o.status <> 'cancelled' ${range}`;

  const [[summary]] = await pool.query(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(o.subtotal), 0) AS revenue, COALESCE(SUM(o.item_count), 0) AS items
     FROM orders o WHERE ${sold}`,
    params
  );
  const [byStatus] = await pool.query(
    `SELECT o.status, COUNT(*) AS orders, COALESCE(SUM(o.subtotal), 0) AS revenue
     FROM orders o WHERE 1 = 1 ${range} GROUP BY o.status`,
    params
  );
  const [byCity] = await pool.query(
    `SELECT o.city, COUNT(*) AS orders, COALESCE(SUM(o.subtotal), 0) AS revenue
     FROM orders o WHERE ${sold} GROUP BY o.city ORDER BY revenue DESC`,
    params
  );
  const [byCollection] = await pool.query(
    `SELECT COALESCE(oi.collection, 'Other') AS collection, SUM(oi.quantity) AS quantity,
            SUM(oi.line_total) AS revenue, COUNT(DISTINCT o.id) AS orders
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE ${sold} GROUP BY COALESCE(oi.collection, 'Other') ORDER BY revenue DESC`,
    params
  );
  const [topProducts] = await pool.query(
    `SELECT oi.title, MAX(oi.sku) AS sku, MAX(oi.collection) AS collection, MAX(oi.image_url) AS image_url,
            SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS revenue
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE ${sold} GROUP BY oi.title ORDER BY quantity DESC, revenue DESC LIMIT 15`,
    params
  );
  const [daily] = await pool.query(
    `SELECT DATE_FORMAT(o.created_at, '%Y-%m-%d') AS day, COUNT(*) AS orders, COALESCE(SUM(o.subtotal), 0) AS revenue
     FROM orders o WHERE ${sold} GROUP BY day ORDER BY day DESC LIMIT 31`,
    params
  );

  const [monthly] = await pool.query(
    `SELECT DATE_FORMAT(o.created_at, '%Y-%m') AS month, COUNT(*) AS orders, COALESCE(SUM(o.subtotal), 0) AS revenue,
            COALESCE(SUM(o.item_count), 0) AS items
     FROM orders o WHERE ${sold} GROUP BY month ORDER BY month DESC LIMIT 24`,
    params
  );

  const numbers = (rows, ...keys) =>
    rows.map((row) => ({ ...row, ...Object.fromEntries(keys.map((key) => [key, Number(row[key]) || 0])) }));
  const orders = Number(summary.orders) || 0;
  const revenue = Number(summary.revenue) || 0;

  return {
    summary: { orders, revenue, items: Number(summary.items) || 0, average: orders ? Math.round(revenue / orders) : 0 },
    byStatus: numbers(byStatus, 'orders', 'revenue'),
    byCity: numbers(byCity, 'orders', 'revenue'),
    byCollection: numbers(byCollection, 'quantity', 'revenue', 'orders'),
    topProducts: numbers(topProducts, 'quantity', 'revenue'),
    daily: numbers(daily, 'orders', 'revenue'),
    monthly: numbers(monthly, 'orders', 'revenue', 'items'),
  };
}

module.exports = { getReport };
