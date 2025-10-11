const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8081;

const app = express();

app.use(cors());
app.use(express.json());

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'Laptop@123',
  database: process.env.DB_NAME || 'shopname',
};

const pool = mysql.createPool(dbConfig);
const orderNotificationEmail = process.env.ORDER_NOTIFICATION_EMAIL || 'amirislam9077@gmail.com';

const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const smtpSecure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : smtpPort === 465;
const smtpUser = process.env.SMTP_USER || 'amirislam9077@gmail.com';
const smtpPass = process.env.SMTP_PASS || 'vvnqiprwfksanior';

let transporter = null;

if (!smtpUser || !smtpPass) {
  console.warn('Email service not configured. Missing SMTP user or password.');
} else {
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  transporter.verify((verifyErr) => {
    if (verifyErr) {
      console.error('Mail transporter verification failed:', verifyErr.message);
    } else {
      console.log('Mail transporter ready to send messages');
    }
  });
}

pool.getConnection((err, connection) => {
  if (err) {
    console.error('MySQL connection failed:', err.message);
    return;
  }

  console.log('MySQL connection established');
  connection.release();
});

app.get('/', (req, res) => {
  res.json('from backend side');
});

app.post('/value', (req, res) => {
  const { name, email, phone, salePur, ttype } = req.body;
  if (!name || !email || !phone || !salePur || !ttype) {
    return res.status(400).json({ message: 'Missing required fields.' });
  }

  const normalizedPhone = String(phone).trim();
  const digitsOnly = normalizedPhone.replace(/\D/g, '');

  if (digitsOnly.length < 7 || digitsOnly.length > 20) {
    return res.status(400).json({
      message: 'Phone must contain 7 to 20 digits.',
    });
  }

  const insertQuery =
    'INSERT INTO value (enrolled_date, name, email, phone, salePur, ttype) VALUES (CURRENT_DATE, ?, ?, ?, ?, ?)';

  pool.query(
    insertQuery,
    [name, email, normalizedPhone, salePur, ttype],
    (err, result) => {
      if (err) {
        console.error('Failed to insert valuation record:', err.message);
        return res.status(500).json({ message: 'Failed to save data.' });
      }

      return res.status(201).json({
        message: 'Valuation saved successfully.',
        id: result.insertId,
      });
    }
  );
});

app.post('/orders', async (req, res) => {
  const { name, email, phone, address, city, country, remarks, shippingMethod, items, subtotal } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Cart is empty.' });
  }

  if (!name || !email || !phone || !address || !city) {
    return res.status(400).json({
      message: 'Missing required customer fields (name, email, phone, address, city).',
    });
  }

  const normalizedSubtotal = Number(subtotal) || 0;

  if (!transporter) {
    console.warn('Email service not configured. Skipping email dispatch for order.');
    console.info('Order details (notification suppressed):', {
      name,
      email,
      phone,
      address,
      city,
      country: country || 'Pakistan',
      remarks,
      shippingMethod,
      subtotal: normalizedSubtotal,
      itemCount: Array.isArray(items) ? items.length : 0,
    });

    return res.status(200).json({
      message:
        'Order received. Email notifications are currently disabled because SMTP credentials are missing.',
    });
  }

  const itemsHtml = items
    .map(
      (item, index) =>
        `<tr>
          <td style="padding:4px 8px;border:1px solid #e5e7eb;">${index + 1}</td>
          <td style="padding:4px 8px;border:1px solid #e5e7eb;">${item.title || 'Unnamed item'}</td>
          <td style="padding:4px 8px;border:1px solid #e5e7eb;">${item.size || '-'}</td>
          <td style="padding:4px 8px;border:1px solid #e5e7eb;text-align:center;">${item.quantity || 1}</td>
          <td style="padding:4px 8px;border:1px solid #e5e7eb;">${item.collection || '-'}</td>
          <td style="padding:4px 8px;border:1px solid #e5e7eb;">${item.sku || '-'}</td>
          <td style="padding:4px 8px;border:1px solid #e5e7eb;">Rs.${Number(item.price || 0).toLocaleString('en-IN')}</td>
        </tr>`
    )
    .join('');

  const html = `
    <h2>New Order Received</h2>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Phone:</strong> ${phone}</p>
    <p><strong>Address:</strong> ${address}, ${city}, ${country || 'Pakistan'}</p>
    ${shippingMethod ? `<p><strong>Preferred Shipping:</strong> ${shippingMethod}</p>` : ''}
    ${remarks ? `<p><strong>Remarks:</strong> ${remarks}</p>` : ''}
    <p><strong>Subtotal:</strong> Rs.${normalizedSubtotal.toLocaleString('en-IN')}</p>
    <table style="border-collapse:collapse;font-family:Arial, sans-serif;margin-top:16px;">
      <thead>
        <tr>
          <th style="padding:6px 8px;border:1px solid #e5e7eb;background:#f1f5f9;">#</th>
          <th style="padding:6px 8px;border:1px solid #e5e7eb;background:#f1f5f9;">Product</th>
          <th style="padding:6px 8px;border:1px solid #e5e7eb;background:#f1f5f9;">Size</th>
          <th style="padding:6px 8px;border:1px solid #e5e7eb;background:#f1f5f9;">Qty</th>
          <th style="padding:6px 8px;border:1px solid #e5e7eb;background:#f1f5f9;">Collection</th>
          <th style="padding:6px 8px;border:1px solid #e5e7eb;background:#f1f5f9;">SKU</th>
          <th style="padding:6px 8px;border:1px solid #e5e7eb;background:#f1f5f9;">Price</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
  `;

  const text = `New order received from ${name} (${email}, ${phone}).\nAddress: ${address}, ${city}, ${country || 'Pakistan'}\nSubtotal: Rs.${normalizedSubtotal.toLocaleString('en-IN')}\nItems: ${items
    .map((item) => `${item.quantity || 1}x ${item.title || 'Unnamed item'} (Rs.${Number(item.price || 0)})`)
    .join('; ')}`;

  try {
    await transporter.sendMail({
      to: orderNotificationEmail,
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      replyTo: email,
      subject: `New Order from ${name}`,
      text,
      html,
    });

    return res.status(200).json({ message: 'Order sent successfully.' });
  } catch (error) {
    console.error('Failed to send order email:', error.message);
    return res.status(500).json({ message: 'Failed to send order email.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});