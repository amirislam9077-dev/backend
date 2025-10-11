const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8081;

const app = express();

app.use(cors());
app.use(express.json());

// Email config
const orderNotificationEmail = process.env.ORDER_NOTIFICATION_EMAIL || 'amirislam9077@gmail.com';
const smtpFrom = process.env.SMTP_FROM || orderNotificationEmail;
const sendGridApiKey = process.env.SENDGRID_API_KEY;

let transporter = null;

if (!sendGridApiKey) {
  console.warn('⚠️ SENDGRID_API_KEY not set. Emails will not be sent.');
} else {
  transporter = nodemailer.createTransport({
    host: 'smtp.sendgrid.net',
    port: 587,
    auth: {
      user: 'apikey', // this literal string is required by SendGrid
      pass: sendGridApiKey,
    },
  });

  transporter.verify((err) => {
    if (err) {
      console.error('❌ Email transporter verification failed:', err.message);
    } else {
      console.log('✅ Email transporter is ready to send messages.');
    }
  });
}

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

  // Validate order data
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
    console.warn('⚠️ Email service is not configured. Order will not be emailed.');
    console.info('Order details (for debug):', {
      name,
      email,
      phone,
      address,
      city,
      country,
      remarks,
      shippingMethod,
      subtotal: normalizedSubtotal,
      itemCount: items.length,
    });

    return res.status(200).json({
      message:
        'Order received. Email notifications are currently disabled due to missing SENDGRID_API_KEY.',
    });
  }

  const itemsHtml = items
    .map(
      (item, index) => `
        <tr>
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

  const text = `New order from ${name} (${email}, ${phone})
Address: ${address}, ${city}, ${country || 'Pakistan'}
Subtotal: Rs.${normalizedSubtotal}
Items: ${items.map(item => `${item.quantity || 1}x ${item.title || 'Unnamed item'} (Rs.${Number(item.price || 0)})`).join(', ')}`;

  try {
    await transporter.sendMail({
      to: orderNotificationEmail,
      from: smtpFrom,
      replyTo: email,
      subject: `🛒 New Order from ${name}`,
      text,
      html,
    });

    return res.status(200).json({ message: '✅ Order email sent successfully.' });
  } catch (error) {
    console.error('❌ Failed to send order email:', error.message);
    return res.status(500).json({ message: 'Failed to send order email.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
