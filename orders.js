const { getPool } = require('./db');

const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];

const toMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const SLIP_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SLIP_BYTES = 5 * 1024 * 1024;

// 'data:image/jpeg;base64,...' -> { type, buffer }; null if missing or not a picture
function parseSlip(dataUrl) {
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match || !SLIP_TYPES.includes(match[1])) {
    return null;
  }
  const buffer = Buffer.from(match[2], 'base64');
  return buffer.length > 0 && buffer.length <= MAX_SLIP_BYTES ? { type: match[1], buffer } : null;
}

// Every orders column except the slip picture itself (kept out of lists to stay light)
const ORDER_COLUMNS = `o.id, o.customer_name, o.email, o.phone, o.address, o.city, o.country, o.remarks,
  o.bank_name, o.reference_no, o.deposit_slip_type, (o.deposit_slip IS NOT NULL) AS has_slip,
  o.shipping_method, o.subtotal, o.item_count, o.status, o.wants_emails, o.email_sent, o.created_at, o.updated_at`;

// Saves the order and its items in one transaction and returns the new order id.
async function saveOrder(order) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const slip = parseSlip(order.depositSlip);

  const items = order.items.map((item) => {
    const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
    const unitPrice = toMoney(item.price);
    return {
      title: String(item.title || 'Unnamed item').slice(0, 255),
      sku: item.sku ? String(item.sku).slice(0, 100) : null,
      size: item.size ? String(item.size).slice(0, 50) : null,
      collection: item.collection ? String(item.collection).slice(0, 100) : null,
      // Only web links (no data: pictures) so the table stays small
      imageUrl: /^https?:\/\/|^\//.test(String(item.image || '')) ? String(item.image).slice(0, 600) : null,
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
        (customer_name, email, phone, address, city, country, remarks,
         bank_name, reference_no, deposit_slip, deposit_slip_type, shipping_method,
         subtotal, item_count, wants_emails)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(order.name).slice(0, 150),
        String(order.email).slice(0, 190),
        String(order.phone).slice(0, 30),
        String(order.address).slice(0, 500),
        String(order.city).slice(0, 100),
        String(order.country || 'Pakistan').slice(0, 100),
        order.remarks || null,
        order.bankName ? String(order.bankName).slice(0, 100) : null,
        order.referenceNo ? String(order.referenceNo).slice(0, 100) : null,
        slip ? slip.buffer : null,
        slip ? slip.type : null,
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
          (order_id, title, sku, size, collection, image_url, quantity, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, item.title, item.sku, item.size, item.collection, item.imageUrl, item.quantity, item.unitPrice, item.lineTotal]
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
    where.push('(o.customer_name LIKE ? OR o.email LIKE ? OR o.phone LIKE ? OR o.reference_no LIKE ?' + (asId ? ' OR o.id = ?' : '') + ')');
    params.push(term, term, term, term);
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
    `SELECT ${ORDER_COLUMNS},
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
  const [[order]] = await pool.query(`SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = ?`, [id]);
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

// The deposit slip picture of one order: { type, data } or null
async function getSlip(id) {
  const pool = getPool();
  const [[row]] = await pool.query('SELECT deposit_slip, deposit_slip_type FROM orders WHERE id = ?', [id]);
  return row && row.deposit_slip ? { type: row.deposit_slip_type || 'image/jpeg', data: row.deposit_slip } : null;
}

module.exports = { STATUSES, parseSlip, saveOrder, markEmailSent, listOrders, getOrder, getSlip, updateStatus, getFilterOptions };
