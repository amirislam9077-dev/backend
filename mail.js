const { Resend } = require('resend');

// Sends an email and reports what happened instead of throwing.
// - Brevo (BREVO_API_KEY + BREVO_SENDER_EMAIL): can email any customer after
//   verifying just the sender address in Brevo.
// - Otherwise Resend: needs a verified domain (EMAIL_FROM) to email customers;
//   without one Resend only delivers to the account owner's own address.
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendWithBrevo({ to, subject, html, replyTo }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_SENDER_NAME || 'Khurram Studio', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      subject,
      htmlContent: html,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Brevo error ${response.status}`);
  }
}

async function sendWithResend({ to, subject, html, replyTo }) {
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || 'Khurram Studio <onboarding@resend.dev>',
    to,
    ...(replyTo ? { reply_to: replyTo } : {}),
    subject,
    html,
  });
  if (error) {
    throw new Error(error.message || 'Resend rejected the email');
  }
}

async function sendEmail(message) {
  try {
    if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) {
      await sendWithBrevo(message);
    } else {
      await sendWithResend(message);
    }
    return { sent: true };
  } catch (err) {
    console.error('Customer email failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendEmail };
