require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const { initDatabase, getPool } = require('./db');
const orders = require('./orders');
const { sendEmail } = require('./mail');
const { STATUSES_WITH_EMAIL, statusEmail } = require('./statusEmail');
const discounts = require('./discounts');
const reports = require('./reports');
const adminAuth = require('./adminAuth');

const PORT = process.env.PORT || 8081;
const app = express();

app.use(cors());
// Room for the deposit slip picture sent with an order
app.use(express.json({ limit: '8mb' }));

const resend = new Resend(process.env.RESEND_API_KEY);

// Customer text goes into the email HTML; escape it so it shows as plain text
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const orderNotificationEmail = process.env.ORDER_NOTIFICATION_EMAIL || 'amirislam9077@gmail.com';

app.get('/', (req, res) => {
  res.json({ message: 'Backend is running.' });
});

// Sale discount % for each collection, shown on the website
app.get('/discounts', async (req, res) => {
  try {
    res.json(await discounts.getDiscounts());
  } catch (err) {
    console.error('Reading discounts failed:', err.message);
    res.status(500).json({ message: 'Could not read discounts.' });
  }
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
    bankName,
    referenceNo,
    depositSlip,
    items,
    subtotal,
  } = req.body || {};
  const slip = orders.parseSlip(depositSlip);

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
    ${bankName ? `<p><strong>Bank:</strong> ${esc(bankName)}</p>` : ''}
    ${referenceNo ? `<p><strong>Reference No:</strong> ${esc(referenceNo)}</p>` : ''}
    <p><strong>Deposit slip:</strong> ${slip ? 'attached' : 'not provided'}</p>
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
      ...(slip
        ? {
            attachments: [{
              filename: `deposit-slip${orderId ? `-${orderId}` : ''}.${slip.type.split('/')[1].replace('jpeg', 'jpg')}`,
              content: slip.buffer.toString('base64'),
            }],
          }
        : {}),
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

  // Thank-you email to the customer (doesn't hold up or fail the order)
  if (orderId) {
    orders.getOrder(orderId)
      .then((saved) => {
        const { subject, html } = statusEmail(saved, 'received');
        return sendEmail({ to: saved.email, subject, html, replyTo: orderNotificationEmail });
      })
      .catch((err) => console.error('Customer order email failed:', err.message));
  }
  return res.status(200).json({ message: 'Order sent successfully.', orderId });
});

// ----- Admin: view and filter saved orders (needs ADMIN_EMAIL + ADMIN_PASSWORD) -----

// The password can be changed from the admin page (see adminAuth.js)
const requireAdmin = async (req, res, next) => {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ message: 'ADMIN_EMAIL and ADMIN_PASSWORD must be set on the server.' });
  }
  if (!getPool()) {
    return res.status(503).json({ message: 'Database is not connected.' });
  }
  let ok = false;
  try {
    ok = await adminAuth.checkLogin(req.get('x-admin-email'), req.get('x-admin-key'));
  } catch (err) {
    console.error('Admin login check failed:', err.message);
    return res.status(503).json({ message: 'Database is not connected.' });
  }
  if (!ok) {
    return res.status(401).json({ message: 'Wrong email or password.' });
  }
  return next();
};

app.post('/admin/password/change', adminAuth.changePassword);
app.post('/admin/password/forgot', adminAuth.forgotPassword);
app.post('/admin/password/reset', adminAuth.resetPassword);

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

app.get('/admin/reports', requireAdmin, adminRoute(async (req, res) => {
  res.json(await reports.getReport(req.query));
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

app.get('/admin/orders/:id/slip', requireAdmin, adminRoute(async (req, res) => {
  const slip = await orders.getSlip(Number(req.params.id));
  if (!slip) {
    return res.status(404).json({ message: 'No deposit slip for this order.' });
  }
  res.set('Content-Type', slip.type);
  res.set('Cache-Control', 'private, no-store');
  return res.send(slip.data);
}));

app.patch('/admin/orders/:id/status', requireAdmin, adminRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!orders.STATUSES.includes(status)) {
    return res.status(400).json({ message: `Status must be one of: ${orders.STATUSES.join(', ')}.` });
  }
  const id = Number(req.params.id);
  const before = await orders.getOrder(id);
  if (!before) {
    return res.status(404).json({ message: 'Order not found.' });
  }
  await orders.updateStatus(id, status);

  // Confirmed / shipped: tell the customer (only when the status actually changes)
  let customerEmail = null;
  if (STATUSES_WITH_EMAIL.includes(status) && before.status !== status) {
    const { subject, html } = statusEmail({ ...before, status }, status);
    customerEmail = await sendEmail({ to: before.email, subject, html, replyTo: orderNotificationEmail });
    customerEmail.to = before.email;
  }
  return res.json({ message: 'Status updated.', status, customerEmail });
}));

app.put('/admin/discounts', requireAdmin, adminRoute(async (req, res) => {
  res.json(await discounts.saveDiscounts(req.body?.discounts));
}));

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
