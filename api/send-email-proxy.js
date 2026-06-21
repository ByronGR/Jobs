// Same-origin proxy for Admin's branded email API.
//
// Browser fetches straight to https://admin.nearwork.co/api/send-email from
// jobs.nearwork.co are cross-origin and can be silently dropped by ad
// blockers / browser tracking protection. Routing through this serverless
// function keeps the call same-origin from the browser's perspective and
// forwards it server-to-server instead.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ALLOWED_TEMPLATES = new Set(['account_created', 'job_applied']);
  const { to, templateId, data } = req.body || {};
  if (!to || !templateId) {
    return res.status(400).json({ error: 'Missing required fields: to, templateId' });
  }
  if (!ALLOWED_TEMPLATES.has(templateId)) {
    return res.status(400).json({ error: 'Invalid templateId' });
  }

  try {
    const adminApiUrl = process.env.EMAIL_API_URL || 'https://admin.nearwork.co/api/send-email';
    const emailSecret = process.env.INTERNAL_EMAIL_SECRET || '';
    const response = await fetch(adminApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(emailSecret ? { 'X-Internal-Secret': emailSecret } : {}),
      },
      body: JSON.stringify({ to, templateId, data: data || {} })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[send-email-proxy] Admin returned ${response.status} for ${templateId} to ${to}:`, result);
    }
    return res.status(response.status).json(result);
  } catch (e) {
    console.error(`[send-email-proxy] Failed to reach Admin for ${templateId} to ${to}:`, e.message);
    return res.status(502).json({ ok: false, error: e.message || 'Failed to reach email service' });
  }
}
