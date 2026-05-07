export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(202).json({ ok: false, skipped: true, reason: 'RESEND_API_KEY is not configured' });
  }

  const {
    to,
    candidateName = 'there',
    openingTitle = 'this role',
    openingCode = '',
    candidateCode = ''
  } = req.body || {};

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Valid recipient email is required' });
  }

  const from = process.env.RESEND_FROM || 'Nearwork <support@nearwork.co>';
  const subject = `We received your application for ${openingTitle}`;
  const safeName = escapeHtml(candidateName || 'there');
  const safeTitle = escapeHtml(openingTitle || 'this role');
  const safeCode = escapeHtml(openingCode || '');
  const safeCandidateCode = escapeHtml(candidateCode || '');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#182033;line-height:1.6">
      <p>Hi ${safeName},</p>
      <p>Thanks for applying to <strong>${safeTitle}</strong> with Nearwork.</p>
      <p>We received your application and our team will review it. You should receive more information in the next couple of hours.</p>
      ${safeCode ? `<p><strong>Opening:</strong> ${safeCode}</p>` : ''}
      ${safeCandidateCode ? `<p><strong>Candidate reference:</strong> ${safeCandidateCode}</p>` : ''}
      <p>We'll keep in touch.</p>
      <p>Nearwork Team<br><a href="mailto:support@nearwork.co">support@nearwork.co</a></p>
    </div>
  `;

  const text = [
    `Hi ${candidateName || 'there'},`,
    '',
    `Thanks for applying to ${openingTitle || 'this role'} with Nearwork.`,
    'We received your application and our team will review it.',
    'You should receive more information in the next couple of hours.',
    openingCode ? `Opening: ${openingCode}` : '',
    candidateCode ? `Candidate reference: ${candidateCode}` : '',
    '',
    "We'll keep in touch.",
    'Nearwork Team',
    'support@nearwork.co'
  ].filter(Boolean).join('\n');

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html, text })
  });

  const data = await resendResponse.json().catch(() => ({}));
  if (!resendResponse.ok) {
    return res.status(resendResponse.status).json({ error: 'Resend failed', details: data });
  }

  return res.status(200).json({ ok: true, id: data.id });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}
