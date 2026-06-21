// Same-origin proxy for Talent's auth-handoff endpoint.
// Direct cross-origin fetches from jobs.nearwork.co to talent.nearwork.co
// are silently blocked by ad blockers and browser tracking protection.
// This proxy keeps the call same-origin and forwards server-to-server.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const talentUrl = process.env.AUTH_HANDOFF_URL || 'https://talent.nearwork.co/api/auth-handoff';
    const response = await fetch(talentUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[auth-handoff] Talent returned ${response.status}:`, result);
    }
    return res.status(response.status).json(result);
  } catch (e) {
    console.error('[auth-handoff] Failed to reach Talent:', e.message);
    return res.status(502).json({ error: 'Failed to reach auth service' });
  }
}
