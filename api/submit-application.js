import admin from 'firebase-admin';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'nearwork-97e3c';

function initAdmin() {
  if (admin.apps.length) return admin.app();

  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'nearwork-97e3c.firebasestorage.app'
    });
  }

  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId: PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'nearwork-97e3c.firebasestorage.app'
    });
  }

  throw new Error('Firebase Admin credentials are not configured');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    initAdmin();
    const db = admin.firestore();
    const appData = req.body || {};
    const email = String(appData.email || '').trim().toLowerCase();
    const openingCode = String(appData.openingCode || '').trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid candidate email is required' });
    }
    if (!openingCode) {
      return res.status(400).json({ error: 'Opening code is required' });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    let candidateId = appData.candidateId || '';
    let candidateCode = appData.candidateCode || '';
    let existingCandidate = null;

    if (candidateId) {
      const snap = await db.collection('candidates').doc(candidateId).get();
      if (snap.exists) existingCandidate = { id: snap.id, ...snap.data() };
    }

    if (!existingCandidate) {
      const byEmail = await db.collection('candidates').where('email', '==', email).limit(1).get();
      if (!byEmail.empty) {
        const doc = byEmail.docs[0];
        existingCandidate = { id: doc.id, ...doc.data() };
        candidateId = doc.id;
        candidateCode = doc.data().code || doc.id;
      }
    }

    if (!candidateId) {
      candidateCode = makeCandidateCode();
      candidateId = candidateCode;
    }
    candidateCode = candidateCode || candidateId;

    const candidateProfile = {
      code: candidateCode,
      email,
      firstName: appData.firstName || '',
      lastName: appData.lastName || '',
      phone: appData.phone || '',
      city: appData.city || '',
      english: appData.english || '',
      linkedin: appData.linkedin || '',
      cvUrl: appData.cvUrl || null,
      experience: Array.isArray(appData.experience) ? appData.experience : [],
      skills: Array.isArray(appData.skills) ? appData.skills : [],
      status: 'applied',
      isMockData: false,
      source: 'jobs.nearwork.co',
      authUid: appData.authUid || null,
      lastAppliedOpeningCode: openingCode,
      lastAppliedAt: now,
      updatedAt: now
    };
    if (!existingCandidate) candidateProfile.createdAt = now;

    await db.collection('candidates').doc(candidateId).set(candidateProfile, { merge: true });

    const safeOpeningCode = openingCode.replace(/[^\w-]/g, '_');
    const appId = `${candidateId}_${safeOpeningCode}`;
    const applicationPayload = {
      candidateId,
      candidateCode,
      candidateName: [appData.firstName, appData.lastName].filter(Boolean).join(' '),
      candidateEmail: email,
      openingCode,
      openingId: appData.openingId || openingCode,
      openingTitle: appData.openingTitle || '',
      experience: Array.isArray(appData.experience) ? appData.experience : [],
      skills: Array.isArray(appData.skills) ? appData.skills : [],
      questions: Array.isArray(appData.questions) ? appData.questions : [],
      cvUrl: appData.cvUrl || null,
      submittedAt: now,
      updatedAt: now,
      status: 'applied',
      pipelineStage: '',
      inPipeline: false,
      isMockData: false,
      source: 'jobs.nearwork.co'
    };

    await db.collection('applications').doc(appId).set(applicationPayload, { merge: true });

    await db.collection('audit_logs').add({
      action: 'candidate_applied',
      entity: 'candidate',
      entityId: candidateId,
      openingCode,
      timestamp: now,
      source: 'jobs.nearwork.co',
      detail: `${existingCandidate ? 'Updated' : 'New candidate'} — applied to ${openingCode}`
    }).catch(() => null);

    const emailResult = await sendResendEmail({
      to: email,
      candidateName: applicationPayload.candidateName,
      openingTitle: applicationPayload.openingTitle || openingCode,
      openingCode,
      candidateCode
    });

    return res.status(200).json({
      ok: true,
      candCode: candidateCode,
      candId: candidateId,
      appId,
      email: emailResult
    });
  } catch (error) {
    console.error('submit-application error:', error);
    return res.status(500).json({
      error: 'Application submit failed',
      message: error.message || 'Unknown error'
    });
  }
}

function makeCandidateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'CAND-' + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function sendResendEmail({ to, candidateName, openingTitle, openingCode, candidateCode }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, skipped: true, reason: 'RESEND_API_KEY is not configured' };

  const safeName = escapeHtml(candidateName || 'there');
  const safeTitle = escapeHtml(openingTitle || 'this role');
  const safeCode = escapeHtml(openingCode || '');
  const safeCandidateCode = escapeHtml(candidateCode || '');
  const from = process.env.RESEND_FROM || 'Nearwork <support@nearwork.co>';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to,
      subject: `We received your application for ${openingTitle || 'this role'}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#182033;line-height:1.6">
          <p>Hi ${safeName},</p>
          <p>Thanks for applying to <strong>${safeTitle}</strong> with Nearwork.</p>
          <p>We received your application and our team will review it. You should receive more information in the next couple of hours.</p>
          ${safeCode ? `<p><strong>Opening:</strong> ${safeCode}</p>` : ''}
          ${safeCandidateCode ? `<p><strong>Candidate reference:</strong> ${safeCandidateCode}</p>` : ''}
          <p>We'll keep in touch.</p>
          <p>Nearwork Team<br><a href="mailto:support@nearwork.co">support@nearwork.co</a></p>
        </div>
      `,
      text: [
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
      ].filter(Boolean).join('\n')
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { sent: false, error: data };
  return { sent: true, id: data.id };
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
