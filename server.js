require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const { initDatabase, getPool } = require('./db');
const orders = require('./orders');

const PORT = process.env.PORT || 8081;
const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);
const orderNotificationEmail = process.env.ORDER_NOTIFICATION_EMAIL || 'amirislam9077@gmail.com';

app.get('/', (req, res) => {
  res.json({ message: 'Backend is running.' });
});

app.post('/orders', async (req, res) => {
  const {
    name,
    email,
    phone,
    address,
    city,
    country,
    remarks,
    shippingMethod,
    items,
    subtotal,
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Cart is empty.' });
  }

  if (!name || !email || !phone || !address || !city) {
    return res.status(400).json({
      message: 'Missing required customer fields (name, email, phone, address, city).',
    });
  }

  const normalizedSubtotal = Number(subtotal) || 0;

  const itemsHtml = items.map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${item.title || 'Unnamed item'}</td>
      <td>${item.size || '-'}</td>
      <td>${item.quantity || 1}</td>
      <td>${item.collection || '-'}</td>
      <td>${item.sku || '-'}</td>
      <td>Rs.${Number(item.price || 0).toLocaleString('en-IN')}</td>
    </tr>`).join('');

  const html = `
    <h2>New Order Received</h2>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Phone:</strong> ${phone}</p>
    <p><strong>Address:</strong> ${address}, ${city}, ${country || 'Pakistan'}</p>
    ${shippingMethod ? `<p><strong>Shipping:</strong> ${shippingMethod}</p>` : ''}
    ${remarks ? `<p><strong>Remarks:</strong> ${remarks}</p>` : ''}
    <p><strong>Subtotal:</strong> Rs.${normalizedSubtotal.toLocaleString('en-IN')}</p>
    <table border="1" cellpadding="5" cellspacing="0" style="margin-top:10px;">
      <thead>
        <tr><th>#</th><th>Product</th><th>Size</th><th>Qty</th><th>Collection</th><th>SKU</th><th>Price</th></tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>
  `;

  // Save first so the order is kept even if the email fails
  let orderId = null;
  try {
    orderId = await orders.saveOrder(req.body);
  } catch (err) {
    console.error('Saving order failed:', err.message);
  }

  let emailed = false;
  try {
    // Resend returns { error } instead of throwing when sending fails
    const { error: sendError } = await resend.emails.send({
      from: 'Khurram Studio <onboarding@resend.dev>',
      to: orderNotificationEmail,
      reply_to: email,
      subject: orderId ? `New Order #${orderId} from ${name}` : `New Order from ${name}`,
      html: orderId ? `<p><strong>Order #:</strong> ${orderId}</p>${html}` : html,
    });
    if (sendError) {
      throw new Error(sendError.message || 'Resend rejected the email');
    }
    emailed = true;
    await orders.markEmailSent(orderId).catch(() => {});
  } catch (err) {
    console.error('Email send failed:', err.message);
  }

  if (!orderId && !emailed) {
    return res.status(500).json({ message: 'Failed to send the order. Please try again.' });
  }
  return res.status(200).json({ message: 'Order sent successfully.', orderId });
});

// ----- Admin: view and filter saved orders (needs ADMIN_EMAIL + ADMIN_PASSWORD) -----

const sameText = (given, expected) => {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
};

const requireAdmin = (req, res, next) => {
  const expectedEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const expectedPassword = process.env.ADMIN_PASSWORD || '';
  if (!expectedEmail || !expectedPassword) {
    return res.status(503).json({ message: 'ADMIN_EMAIL and ADMIN_PASSWORD must be set on the server.' });
  }
  const givenEmail = String(req.get('x-admin-email') || '').trim().toLowerCase();
  const givenPassword = String(req.get('x-admin-key') || '');
  // Check both every time so a wrong email and a wrong password take the same time
  const emailOk = sameText(givenEmail, expectedEmail);
  const passwordOk = sameText(givenPassword, expectedPassword);
  if (!emailOk || !passwordOk) {
    return res.status(401).json({ message: 'Wrong email or password.' });
  }
  if (!getPool()) {
    return res.status(503).json({ message: 'Database is not connected.' });
  }
  return next();
};

const adminRoute = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    console.error('Admin request failed:', err.message);
    res.status(500).json({ message: 'Something went wrong reading the orders.' });
  }
};

app.get('/admin/orders', requireAdmin, adminRoute(async (req, res) => {
  res.json(await orders.listOrders(req.query));
}));

app.get('/admin/orders/filters', requireAdmin, adminRoute(async (req, res) => {
  res.json(await orders.getFilterOptions());
}));

app.get('/admin/orders/:id', requireAdmin, adminRoute(async (req, res) => {
  const order = await orders.getOrder(Number(req.params.id));
  if (!order) {
    return res.status(404).json({ message: 'Order not found.' });
  }
  return res.json(order);
}));

app.patch('/admin/orders/:id/status', requireAdmin, adminRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!orders.STATUSES.includes(status)) {
    return res.status(400).json({ message: `Status must be one of: ${orders.STATUSES.join(', ')}.` });
  }
  const updated = await orders.updateStatus(Number(req.params.id), status);
  if (!updated) {
    return res.status(404).json({ message: 'Order not found.' });
  }
  return res.json({ message: 'Status updated.', status });
}));

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
