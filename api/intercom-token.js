import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.INTERCOM_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'INTERCOM_SECRET not configured' });
  }

  const { userId, email } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    user_id: userId,
    ...(email ? { email } : {}),
    iat: now,
    exp: now + 86400
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const token = `${header}.${payload}.${signature}`;

  return res.status(200).json({ token });
}
