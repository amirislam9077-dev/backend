require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

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

  try {
    await resend.emails.send({
      from: 'Khurram Studio <onboarding@resend.dev>',
      to: orderNotificationEmail,
      reply_to: email,
      subject: `New Order from ${name}`,
      html,
    });

    return res.status(200).json({ message: 'Order sent successfully.' });
  } catch (err) {
    console.error('Email send failed:', err.message);
    return res.status(500).json({ message: 'Failed to send order email.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
