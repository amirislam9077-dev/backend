const crypto = require('crypto');
const { getPool } = require('./db');
const { sendEmail } = require('./mail');

// Admin login (email + password).
// Until the password is changed from the admin page, ADMIN_EMAIL + ADMIN_PASSWORD
// (Render settings) are used. After a change or a reset, the new password is
// kept (hashed) in the admin_login table and wins over ADMIN_PASSWORD.
// The Khurram Studio Accounts server reads the same table, so both stay in step.

const MIN_PASSWORD = 6;
const CODE_MINUTES = 15;
const CODE_TRIES = 5;

const sameText = (given, expected) => {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
};

const adminEmail = () => (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

const hashSecret = (secret) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
};

// Checking a scrypt hash is slow on purpose; remember the last good password
// so every admin request doesn't pay for it again.
let lastGood = { stored: '', given: null };
const matchesHash = (secret, stored) => {
  const [kind, salt, hash] = String(stored || '').split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const given = crypto.createHash('sha256').update(String(secret)).digest();
  if (lastGood.stored === stored && lastGood.given && crypto.timingSafeEqual(given, lastGood.given)) return true;
  const ok = crypto.timingSafeEqual(crypto.scryptSync(String(secret), salt, 64), Buffer.from(hash, 'hex'));
  if (ok) lastGood = { stored, given };
  return ok;
};

async function savedLogin() {
  const pool = getPool();
  if (!pool) return null;
  // Times are compared in MySQL so the server's own time zone doesn't matter
  const [rows] = await pool.query(
    `SELECT password_hash, reset_code_hash, reset_tries,
       (reset_expires IS NOT NULL AND reset_expires > NOW()) AS code_valid,
       (reset_sent_at IS NOT NULL AND reset_sent_at > NOW() - INTERVAL 1 MINUTE) AS sent_recently
     FROM admin_login WHERE id = 1`
  );
  return rows[0] || null;
}

// true when email + password are the admin's
async function checkLogin(email, password) {
  const expectedEmail = adminEmail();
  const givenEmail = String(email || '').trim().toLowerCase();
  const emailOk = sameText(givenEmail, expectedEmail);
  const row = await savedLogin();
  const passwordOk = row && row.password_hash
    ? matchesHash(password, row.password_hash)
    : sameText(String(password || ''), process.env.ADMIN_PASSWORD || '');
  return Boolean(expectedEmail && emailOk && passwordOk);
}

async function setPassword(newPassword) {
  await getPool().execute(
    `INSERT INTO admin_login (id, password_hash, reset_code_hash, reset_expires, reset_tries)
     VALUES (1, ?, NULL, NULL, 0)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), reset_code_hash = NULL, reset_expires = NULL, reset_tries = 0`,
    [hashSecret(newPassword)]
  );
}

const passwordProblem = (password) => {
  if (String(password || '').length < MIN_PASSWORD) return `The new password must be at least ${MIN_PASSWORD} characters.`;
  if (String(password).length > 100) return 'The new password is too long.';
  return '';
};

const route = (handler) => async (req, res) => {
  if (!adminEmail() || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ message: 'ADMIN_EMAIL and ADMIN_PASSWORD must be set on the server.' });
  }
  if (!getPool()) {
    return res.status(503).json({ message: 'Database is not connected. Please try again in a minute.' });
  }
  try {
    return await handler(req, res);
  } catch (err) {
    console.error('Admin password request failed:', err.message);
    return res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
};

// POST /admin/password/change  { email, currentPassword, newPassword }
const changePassword = route(async (req, res) => {
  const { email, currentPassword, newPassword } = req.body || {};
  if (!(await checkLogin(email, currentPassword))) {
    return res.status(401).json({ message: 'Wrong email or current password.' });
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ message: problem });
  await setPassword(newPassword);
  return res.json({ ok: true, message: 'Password changed.' });
});

// POST /admin/password/forgot  { email } — emails a 6-digit code to the admin email
const forgotPassword = route(async (req, res) => {
  const reply = { ok: true, message: `If that is the admin email, a code has been sent to it. It works for ${CODE_MINUTES} minutes.` };
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!sameText(email, adminEmail())) return res.json(reply);

  const row = await savedLogin();
  if (row && Number(row.sent_recently)) {
    return res.status(429).json({ message: 'A code was just sent. Please wait a minute before asking again.' });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await getPool().execute(
    `INSERT INTO admin_login (id, reset_code_hash, reset_expires, reset_tries, reset_sent_at)
     VALUES (1, ?, DATE_ADD(NOW(), INTERVAL ${CODE_MINUTES} MINUTE), 0, NOW())
     ON DUPLICATE KEY UPDATE reset_code_hash = VALUES(reset_code_hash), reset_expires = VALUES(reset_expires),
       reset_tries = 0, reset_sent_at = VALUES(reset_sent_at)`,
    [hashSecret(code)]
  );
  const result = await sendEmail({
    to: adminEmail(),
    subject: 'Khurram Studio admin: password reset code',
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">
      <p>Your Khurram Studio admin password reset code is:</p>
      <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
      <p>It works for ${CODE_MINUTES} minutes. If you did not ask for this, ignore this email; your password stays the same.</p>
    </div>`,
  });
  if (!result.sent) {
    return res.status(502).json({ message: 'The code email could not be sent. Please try again later.' });
  }
  return res.json(reply);
});

// POST /admin/password/reset  { email, code, newPassword }
const resetPassword = route(async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  const wrong = () => res.status(400).json({ message: 'Wrong or expired code. Ask for a new code.' });
  if (!sameText(String(email || '').trim().toLowerCase(), adminEmail())) return wrong();
  const row = await savedLogin();
  const expired = !row || !row.reset_code_hash || !Number(row.code_valid);
  if (expired || row.reset_tries >= CODE_TRIES) return wrong();
  if (!matchesHash(String(code || '').trim(), row.reset_code_hash)) {
    await getPool().execute('UPDATE admin_login SET reset_tries = reset_tries + 1 WHERE id = 1');
    return wrong();
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ message: problem });
  await setPassword(newPassword);
  return res.json({ ok: true, message: 'Password changed. Log in with the new password.' });
});

module.exports = { checkLogin, changePassword, forgotPassword, resetPassword };
