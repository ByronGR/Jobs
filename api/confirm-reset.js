// POST /api/confirm-reset
// Proxies to Talent's /api/confirm-reset, which holds the Firestore token
// store and the Firebase Admin credentials needed to validate + confirm
// the password reset. Jobs shares the same Firebase project, so the
// oobCode issued by Talent's send-reset works here too.

const TALENT_CONFIRM_RESET = 'https://talent.nearwork.co/api/confirm-reset';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ ok: false, error: 'token and newPassword are required.' });
  }

  try {
    const upstream = await fetch(TALENT_CONFIRM_RESET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    const data = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json(data);
  } catch {
    return res.status(502).json({ ok: false, error: 'Reset service unavailable. Please try again.' });
  }
}
