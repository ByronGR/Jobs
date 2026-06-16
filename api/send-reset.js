// POST /api/send-reset
// Proxies the reset request to Talent's /api/send-reset, which already has
// Firebase Admin (WIF) credentials and handles the branded email delivery.
// The continueUrl is set to jobs.nearwork.co/reset-password so the link in
// the email lands on Jobs' own reset page, not Talent's.

const TALENT_SEND_RESET = 'https://talent.nearwork.co/api/send-reset';
const JOBS_RESET_PAGE   = 'https://jobs.nearwork.co/reset-password';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ ok: false, error: 'Email is required' });
  }

  try {
    const upstream = await fetch(TALENT_SEND_RESET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, continueUrl: JOBS_RESET_PAGE }),
    });
    const data = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json(data);
  } catch {
    return res.status(502).json({ ok: false, error: 'Reset service unavailable. Please try again.' });
  }
}
