// Emails to the customer: order received, confirmed and shipped.

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (value) => `Rs.${Math.round(Number(value) || 0).toLocaleString('en-PK')}`;

const MESSAGES = {
  received: {
    subject: (id) => `We received your order #${id} — Khurram Studio`,
    heading: 'Thank you for your order',
    text: 'We have received your order and payment details. Our team will check your payment and confirm your order shortly. You will get another email when it is confirmed and when it is shipped.',
  },
  confirmed: {
    subject: (id) => `Your order #${id} is confirmed — Khurram Studio`,
    heading: 'Your order is confirmed',
    text: 'Thank you for shopping with Khurram Studio! We have received your payment details and confirmed your order. We will let you know as soon as your parcel is shipped.',
  },
  shipped: {
    subject: (id) => `Your order #${id} has been shipped — Khurram Studio`,
    heading: 'Your parcel is on its way',
    text: 'Good news! Your parcel has been shipped and is on its way to you. It usually arrives within 3–5 working days.',
  },
};

// "received" is sent when the order is placed; the rest when the admin changes the status
const STATUSES_WITH_EMAIL = Object.keys(MESSAGES).filter((key) => key !== 'received');

function statusEmail(order, status) {
  const m = MESSAGES[status];
  const rows = (order.items || [])
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee">${esc(item.title)}${item.size ? ` <span style="color:#888">(${esc(item.size)})</span>` : ''}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center">${esc(item.quantity)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${money(item.line_total)}</td>
        </tr>`
    )
    .join('');

  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;color:#222">
    <div style="background:#000;color:#fff;padding:18px 24px;letter-spacing:4px;font-size:18px">KHURRAM STUDIO</div>
    <div style="padding:24px">
      <h2 style="margin:0 0 6px;font-size:20px">${m.heading}</h2>
      <p style="margin:0 0 16px;color:#666">Order #${esc(order.id)}</p>
      <p style="margin:0 0 18px;line-height:1.5">Dear ${esc(order.customer_name)},<br>${m.text}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="color:#888;font-size:12px;text-align:left">
            <th style="padding-bottom:6px">Product</th><th style="padding-bottom:6px;text-align:center">Qty</th><th style="padding-bottom:6px;text-align:right">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:14px 0 0;text-align:right;font-size:16px"><strong>Total: ${money(order.subtotal)}</strong></p>
      <p style="margin:20px 0 0;line-height:1.5;color:#555;font-size:13px">
        Delivery address:<br>${esc(order.address)}, ${esc(order.city)}, ${esc(order.country)}<br>Phone: ${esc(order.phone)}
      </p>
      <p style="margin:20px 0 0;color:#555;font-size:13px">Questions? Just reply to this email.</p>
    </div>
  </div>`;

  return { subject: m.subject(order.id), html };
}

module.exports = { STATUSES_WITH_EMAIL, statusEmail };
