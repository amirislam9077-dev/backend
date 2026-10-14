const { getPool } = require('./db');

const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];

const toMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Saves the order and its items in one transaction and returns the new order id.
async function saveOrder(order) {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  const items = order.items.map((item) => {
    const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
    const unitPrice = toMoney(item.price);
    return {
      title: String(item.title || 'Unnamed item').slice(0, 255),
      sku: item.sku ? String(item.sku).slice(0, 100) : null,
      size: item.size ? String(item.size).slice(0, 50) : null,
      collection: item.collection ? String(item.collection).slice(0, 100) : null,
      quantity,
      unitPrice,
      lineTotal: toMoney(unitPrice * quantity),
    };
  });

  // Totals come from the items rather than the browser's subtotal
  const subtotal = toMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO orders
        (customer_name, email, phone, address, city, country, remarks, shipping_method,
         subtotal, item_count, wants_emails)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(order.name).slice(0, 150),
        String(order.email).slice(0, 190),
        String(order.phone).slice(0, 30),
        String(order.address).slice(0, 500),
        String(order.city).slice(0, 100),
        String(order.country || 'Pakistan').slice(0, 100),
        order.remarks || null,
        order.shippingMethod ? String(order.shippingMethod).slice(0, 150) : null,
        subtotal,
        itemCount,
        order.wantsEmails ? 1 : 0,
      ]
    );
    const orderId = result.insertId;

    for (const item of items) {
      await conn.execute(
        `INSERT INTO order_items
          (order_id, title, sku, size, collection, quantity, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, item.title, item.sku, item.size, item.collection, item.quantity, item.unitPrice, item.lineTotal]
      );
    }

    await conn.commit();
    return orderId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function markEmailSent(orderId) {
  const pool = getPool();
  if (pool && orderId) {
    await pool.execute('UPDATE orders SET email_sent = 1 WHERE id = ?', [orderId]);
  }
}

// Filters: search (name/email/phone/order no.), status, city, collection,
// from/to (YYYY-MM-DD), minTotal/maxTotal, page, pageSize, sort.
async function listOrders(query) {
  const pool = getPool();
  const where = [];
  const params = [];

  if (query.search) {
    const term = `%${String(query.search).trim()}%`;
    const asId = parseInt(String(query.search).replace(/\D/g, ''), 10);
    where.push('(o.customer_name LIKE ? OR o.email LIKE ? OR o.phone LIKE ?' + (asId ? ' OR o.id = ?' : '') + ')');
    params.push(term, term, term);
    if (asId) params.push(asId);
  }
  if (query.status && STATUSES.includes(query.status)) {
    where.push('o.status = ?');
    params.push(query.status);
  }
  if (query.city) {
    where.push('o.city = ?');
    params.push(query.city);
  }
  if (query.collection) {
    where.push('EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.collection = ?)');
    params.push(query.collection);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.from || '')) {
    where.push('o.created_at >= ?');
    params.push(`${query.from} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.to || '')) {
    where.push('o.created_at <= ?');
    params.push(`${query.to} 23:59:59`);
  }
  if (query.minTotal !== undefined && query.minTotal !== '') {
    where.push('o.subtotal >= ?');
    params.push(Number(query.minTotal) || 0);
  }
  if (query.maxTotal !== undefined && query.maxTotal !== '') {
    where.push('o.subtotal <= ?');
    params.push(Number(query.maxTotal) || 0);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sorts = {
    newest: 'o.created_at DESC, o.id DESC',
    oldest: 'o.created_at ASC, o.id ASC',
    highest: 'o.subtotal DESC',
    lowest: 'o.subtotal ASC',
  };
  const orderBy = sorts[query.sort] || sorts.newest;
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 20));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const offset = (page - 1) * pageSize;

  const [[summary]] = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(o.subtotal), 0) AS revenue FROM orders o ${whereSql}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT o.*,
       (SELECT GROUP_CONCAT(DISTINCT oi.collection SEPARATOR ', ') FROM order_items oi WHERE oi.order_id = o.id) AS collections
     FROM orders o ${whereSql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return {
    orders: rows,
    total: summary.total,
    revenue: Number(summary.revenue),
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(summary.total / pageSize)),
  };
}

async function getOrder(id) {
  const pool = getPool();
  const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
  if (!order) {
    return null;
  }
  const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [id]);
  return { ...order, items };
}

async function updateStatus(id, status) {
  const pool = getPool();
  const [result] = await pool.execute('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
  return result.affectedRows > 0;
}

// Values for the filter dropdowns and the status counts
async function getFilterOptions() {
  const pool = getPool();
  const [cities] = await pool.query('SELECT DISTINCT city FROM orders ORDER BY city');
  const [collections] = await pool.query(
    'SELECT DISTINCT collection FROM order_items WHERE collection IS NOT NULL ORDER BY collection'
  );
  const [statusCounts] = await pool.query('SELECT status, COUNT(*) AS count FROM orders GROUP BY status');
  return {
    statuses: STATUSES,
    cities: cities.map((row) => row.city),
    collections: collections.map((row) => row.collection),
    statusCounts: Object.fromEntries(statusCounts.map((row) => [row.status, row.count])),
  };
}

module.exports = { STATUSES, saveOrder, markEmailSent, listOrders, getOrder, updateStatus, getFilterOptions };
