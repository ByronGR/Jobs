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
    const expectedSalaryUSD = appData.expectedSalaryUSD != null && appData.expectedSalaryUSD !== '' ? Number(appData.expectedSalaryUSD) : null;
    const expectedSalaryCOP = appData.expectedSalaryCOP != null && appData.expectedSalaryCOP !== '' ? Number(appData.expectedSalaryCOP) : null;
    // Legacy single amount+currency fields, kept for Admin's existing candidate views
    const expectedSalaryAmount = expectedSalaryUSD || expectedSalaryCOP || Number(appData.expectedSalaryAmount || appData.salaryExpectationAmount || 0);
    const expectedSalaryCurrency = expectedSalaryUSD
      ? 'USD'
      : expectedSalaryCOP
        ? 'COP'
        : (String(appData.expectedSalaryCurrency || appData.salaryCurrency || 'USD').toUpperCase() === 'COP' ? 'COP' : 'USD');
    const expectedSalaryLabel = expectedSalaryAmount
      ? `${expectedSalaryCurrency} ${Math.round(expectedSalaryAmount).toLocaleString('en-US')}/mo`
      : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid candidate email is required' });
    }
    if (!openingCode) {
      return res.status(400).json({ error: 'Opening code is required' });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    // Guard: only accept properly formatted CAND-XXXXXX codes.
    // Firebase Auth UIDs and other strings are discarded so we never key
    // a candidates document with a raw UID.
    let candidateId = /^CAND-/i.test(appData.candidateId || '') ? appData.candidateId : '';
    let candidateCode = /^CAND-/i.test(appData.candidateCode || '') ? appData.candidateCode : '';
    let existingCandidate = null;
    const ownerUid = appData.ownerUid || appData.authUid || null;
    let existingUser = {};

    if (await hasApplied({ db, uid: ownerUid, email, openingCode: normalizeCode(openingCode) })) {
      return res.status(409).json({
        ok: false,
        code: 'already-applied',
        error: 'You already applied to this opening.'
      });
    }

    if (ownerUid) {
      const userSnap = await db.collection('users').doc(ownerUid).get();
      if (userSnap.exists) existingUser = userSnap.data() || {};
      // Only use the stored code if it is a valid CAND code (not a Firebase UID).
      const storedCode = existingUser.candidateCode || existingUser.code || '';
      if (!candidateCode && /^CAND-/i.test(storedCode)) {
        candidateCode = storedCode;
      }
    }

    if (candidateId) {
      const snap = await db.collection('candidates').doc(candidateId).get();
      if (snap.exists) existingCandidate = { id: snap.id, ...snap.data() };
    }

    if (!existingCandidate) {
      // Search by email — only accept docs whose ID is a real CAND code.
      // Docs keyed by Firebase UID (legacy broken accounts) are skipped so we
      // generate a fresh CAND code and migrate cleanly.
      const byEmail = await db.collection('candidates').where('email', '==', email).limit(5).get();
      for (const d of byEmail.docs) {
        if (/^CAND-/i.test(d.id)) {
          existingCandidate = { id: d.id, ...d.data() };
          candidateId = d.id;
          candidateCode = d.data().code || d.id;
          break;
        }
      }
    }

    if (!candidateId) {
      // No valid CAND record found — generate a fresh code and auto-migrate this
      // account so future submissions use the proper CAND-XXXXXX key.
      candidateCode = candidateCode || makeCandidateCode();
      candidateId = candidateCode;
      // Patch the users doc so the candidate carries a valid code going forward.
      if (ownerUid) {
        await db.collection('users').doc(ownerUid).set(
          { candidateCode, code: candidateCode },
          { merge: true }
        ).catch(() => null);
      }
    }
    candidateCode = candidateCode || candidateId;

    const appliedDate = new Date().toISOString().split('T')[0];
    const newApplication = {
      opening: openingCode,
      openingCode,
      role: appData.openingTitle || openingCode,
      openingTitle: appData.openingTitle || openingCode,
      applied: appliedDate,
      appliedAt: appliedDate,
      status: 'applied',
      outcome: 'Application only',
      source: 'jobs.nearwork.co'
    };
    const candidateProfile = {
      code: candidateCode,
      email,
      name: [appData.firstName, appData.lastName].filter(Boolean).join(' '),
      firstName: appData.firstName || '',
      lastName: appData.lastName || '',
      phone: appData.phone || '',
      city: appData.city || '',
      locationCity: appData.city || '',
      locationDepartment: appData.department || '',
      locationId: appData.locationId || '',
      location: appData.location || '',
      english: appData.english || '',
      englishLevel: appData.english || '',
      linkedin: appData.linkedin || '',
      currentRole: appData.currentRole || '',
      expectedSalaryUSD,
      expectedSalaryCOP,
      expectedSalaryAmount,
      expectedSalaryCurrency,
      expectedSalary: expectedSalaryLabel,
      salaryExpectation: expectedSalaryLabel,
      cvUrl: appData.cvUrl || null,
      workHistory: Array.isArray(appData.experience) ? appData.experience : [],  // keep array as workHistory
      skills: Array.isArray(appData.skills) ? appData.skills : [],
      languages: Array.isArray(appData.languages) ? appData.languages : [],
      certifications: Array.isArray(appData.certifications) ? appData.certifications : [],
      status: 'applied',
      isMockData: false,
      source: 'jobs.nearwork.co',
      authUid: ownerUid,
      ownerUid,
      lastAppliedOpeningCode: openingCode,
      lastAppliedAt: now,
      updatedAt: now,
      // Embed the application in the candidates doc so admin can find it
      // even when Firestore security rules prevent reading the applications collection
      applications: admin.firestore.FieldValue.arrayUnion(newApplication)
    };
    if (!existingCandidate) candidateProfile.createdAt = now;

    await db.collection('candidates').doc(candidateId).set(candidateProfile, { merge: true });

    if (ownerUid) {
      const userRef = db.collection('users').doc(ownerUid);
      const appliedDate = new Date().toISOString().split('T')[0];
      const existingApplications = Array.isArray(existingUser.applications) ? existingUser.applications : [];
      const nextApplications = [
        ...existingApplications.filter(app => {
          const appCode = typeof app === 'string'
            ? app
            : (app?.opening || app?.openingCode || app?.jobCode || app?.code || app?.id || '');
          return String(appCode).toUpperCase() !== String(openingCode).toUpperCase();
        }),
        {
          opening: openingCode,
          openingCode,
          role: appData.openingTitle || openingCode,
          openingTitle: appData.openingTitle || openingCode,
          applied: appliedDate,
          appliedAt: appliedDate,
          status: 'applied',
          outcome: 'Application only',
          source: 'jobs.nearwork.co',
          url: `https://jobs.nearwork.co/apply?code=${encodeURIComponent(openingCode)}`
        }
      ];
      const userProfile = {
        role: 'candidate',
        roleApplied: appData.openingTitle || openingCode,
        headline: existingUser.headline || appData.openingTitle || '',
        jobTitle: existingUser.jobTitle || '',
        candidateCode,
        code: candidateCode,
        email,
        name: [appData.firstName, appData.lastName].filter(Boolean).join(' '),
        firstName: appData.firstName || '',
        lastName: appData.lastName || '',
        phone: appData.phone || '',
        city: appData.city || '',
        locationCity: appData.city || '',
        locationDepartment: appData.department || '',
        locationId: appData.locationId || '',
        location: appData.location || '',
        locationCountry: 'Colombia',
        english: appData.english || '',
        englishLevel: appData.english || '',
        linkedin: appData.linkedin || '',
        currentRole: appData.currentRole || '',
        expectedSalaryUSD,
        expectedSalaryCOP,
        expectedSalaryAmount,
        expectedSalaryCurrency,
        expectedSalary: expectedSalaryLabel,
        salaryExpectation: expectedSalaryLabel,
        salary: expectedSalaryLabel || existingUser.salary || '',
        salaryCurrency: expectedSalaryCurrency,
        cvUrl: appData.cvUrl || null,
        skills: Array.isArray(appData.skills) ? appData.skills : [],
        experience: Array.isArray(appData.experience) ? appData.experience : [],
        languages: Array.isArray(appData.languages) ? appData.languages : [],
        certifications: Array.isArray(appData.certifications) ? appData.certifications : [],
        applications: nextApplications,
        status: existingUser.status || 'active',
        source: existingUser.source || 'jobs.nearwork.co',
        ownerUid,
        authUid: ownerUid,
        lastAppliedOpeningCode: openingCode,
        lastAppliedAt: now,
        updatedAt: now
      };
      if (!existingUser.createdAt) userProfile.createdAt = now;
      await userRef.set(userProfile, { merge: true });
    }

    const safeOpeningCode = openingCode.replace(/[^\w-]/g, '_');
    const appId = `${candidateId}_${safeOpeningCode}`;
    const applicationPayload = {
      candidateId: candidateId,        // always the CAND-XXXXXX code, never a Firebase UID
      candidateDocId: candidateId,
      ownerUid,
      authUid: ownerUid,
      candidateCode,
      candidateName: [appData.firstName, appData.lastName].filter(Boolean).join(' '),
      candidateEmail: email,
      openingCode,
      jobId: openingCode,
      openingId: appData.openingId || openingCode,
      openingTitle: appData.openingTitle || '',
      jobTitle: appData.openingTitle || openingCode,
      title: appData.openingTitle || openingCode,
      clientName: 'Nearwork client',
      experience: Array.isArray(appData.experience) ? appData.experience : [],
      skills: Array.isArray(appData.skills) ? appData.skills : [],
      languages: Array.isArray(appData.languages) ? appData.languages : [],
      certifications: Array.isArray(appData.certifications) ? appData.certifications : [],
      currentRole: appData.currentRole || '',
      expectedSalaryUSD,
      expectedSalaryCOP,
      expectedSalaryAmount,
      expectedSalaryCurrency,
      expectedSalary: expectedSalaryLabel,
      salaryExpectation: expectedSalaryLabel,
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

    // Pipeline is NOT touched on apply. The candidate lives in the `applications`
    // collection only until a Nearwork recruiter approves them in the Admin
    // Applicants inbox — at which point they are added to `pipeline.candidates`.

    await db.collection('audit_logs').add({
      action: 'candidate_applied',
      entity: 'candidate',
      entityId: candidateId,
      openingCode,
      timestamp: now,
      source: 'jobs.nearwork.co',
      detail: `${existingCandidate ? 'Updated' : 'New candidate'} — applied to ${openingCode}`
    }).catch(() => null);

    const hubspotResult = await syncCandidateToHubSpot({
      code: candidateCode,
      name: applicationPayload.candidateName,
      email,
      phone: appData.phone || '',
      role: applicationPayload.openingTitle || openingCode,
      location: appData.city || '',
      status: 'applied',
      source: 'jobs.nearwork.co',
      openingCode,
      profileUrl: `https://talent.nearwork.co/profile`
    }).catch(error => ({ ok: false, skipped: true, error: error.message }));

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
      email: emailResult,
      hubspot: hubspotResult
    });
  } catch (error) {
    console.error('submit-application error:', error);
    return res.status(500).json({
      error: 'Application submit failed',
      message: error.message || 'Unknown error'
    });
  }
}

async function syncCandidateToHubSpot(candidate) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token || !candidate?.email) return { ok: false, skipped: true, reason: 'HubSpot not configured' };
  const properties = compactProperties({
    email: candidate.email,
    firstname: String(candidate.name || '').trim().split(/\s+/)[0] || '',
    lastname: String(candidate.name || '').trim().split(/\s+/).slice(1).join(' '),
    phone: candidate.phone,
    city: candidate.location,
    jobtitle: candidate.role,
    company: 'Nearwork Candidate',
    website: candidate.profileUrl,
    type: 'Candidate',
    nearwork_contact_type: 'candidate',
    nearwork_portal_type: 'talent',
    nearwork_candidate_code: candidate.code,
    nearwork_candidate_status: candidate.status,
    lifecyclestage: 'lead'
  });
  let hubspot = await upsertHubspotContact(token, candidate.email, properties);
  if (!hubspot.response.ok && isUnknownHubspotProperty(hubspot.body)) {
    const fallback = { ...properties };
    delete fallback.nearwork_contact_type;
    delete fallback.nearwork_portal_type;
    delete fallback.nearwork_candidate_code;
    delete fallback.nearwork_candidate_status;
    hubspot = await upsertHubspotContact(token, candidate.email, fallback);
    hubspot.body.nearworkPropertiesSkipped = true;
  }
  return {
    ok: hubspot.response.ok,
    id: hubspot.body.id,
    skippedCustomProperties: !!hubspot.body.nearworkPropertiesSkipped,
    error: hubspot.response.ok ? null : (hubspot.body.message || 'HubSpot sync failed')
  };
}

async function upsertHubspotContact(token, email, properties) {
  let response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + encodeURIComponent(email) + '?idProperty=email', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties })
  });
  let body = await response.json().catch(() => ({}));
  if (response.status === 404) {
    response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties })
    });
    body = await response.json().catch(() => ({}));
  }
  return { response, body };
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ''));
}

function isUnknownHubspotProperty(body = {}) {
  const msg = String(body.message || '').toLowerCase();
  return msg.includes('property') && (msg.includes('does not exist') || msg.includes('unknown'));
}

function makeCandidateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'CAND-' + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function safeId(value) {
  return String(value || '').replace(/[^\w-]/g, '_');
}

function applicationHasOpening(app, openingCode) {
  const appCode = typeof app === 'string'
    ? app
    : (app?.opening || app?.openingCode || app?.jobCode || app?.code || app?.id || '');
  return normalizeCode(appCode) === openingCode;
}

async function hasApplied({ db, uid, email, openingCode }) {
  const code = normalizeCode(openingCode);
  const safeOpeningCode = safeId(code);

  if (uid) {
    const byUid = await db.collection('applications')
      .where('ownerUid', '==', uid)
      .where('openingCode', '==', code)
      .limit(1)
      .get();
    if (!byUid.empty) return true;

    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const user = userSnap.data() || {};
      if (Array.isArray(user.applications) && user.applications.some(app => applicationHasOpening(app, code))) {
        return true;
      }
      const candidateCode = user.candidateCode || user.code || '';
      if (candidateCode) {
        const appDoc = await db.collection('applications').doc(`${candidateCode}_${safeOpeningCode}`).get();
        if (appDoc.exists) return true;
      }
    }
  }

  if (email) {
    const byEmail = await db.collection('applications')
      .where('candidateEmail', '==', email)
      .where('openingCode', '==', code)
      .limit(1)
      .get();
    if (!byEmail.empty) return true;

    const candidateSnap = await db.collection('candidates')
      .where('email', '==', email)
      .limit(1)
      .get();
    if (!candidateSnap.empty) {
      const candidateDoc = candidateSnap.docs[0];
      const candidate = candidateDoc.data() || {};
      const candidateIds = [...new Set([candidateDoc.id, candidate.code, candidate.candidateCode].filter(Boolean))];
      for (const candidateId of candidateIds) {
        const appDoc = await db.collection('applications').doc(`${candidateId}_${safeOpeningCode}`).get();
        if (appDoc.exists) return true;
      }
      if (normalizeCode(candidate.lastAppliedOpeningCode) === code) return true;
      if (Array.isArray(candidate.applications) && candidate.applications.some(app => applicationHasOpening(app, code))) {
        return true;
      }
    }

    const userByEmail = await db.collection('users')
      .where('email', '==', email)
      .limit(3)
      .get();
    for (const userDoc of userByEmail.docs) {
      const user = userDoc.data() || {};
      if (Array.isArray(user.applications) && user.applications.some(app => applicationHasOpening(app, code))) {
        return true;
      }
      const candidateCode = user.candidateCode || user.code || '';
      if (candidateCode) {
        const appDoc = await db.collection('applications').doc(`${candidateCode}_${safeOpeningCode}`).get();
        if (appDoc.exists) return true;
      }
    }
  }

  return false;
}

async function sendResendEmail({ to, candidateName, openingTitle, openingCode, candidateCode }) {
  const firstName = String(candidateName || 'there').trim().split(/\s+/)[0] || 'there';
  const roleTitle = openingTitle || openingCode || 'this role';

  // Prefer a direct Resend call using the Jobs-function RESEND_API_KEY.
  // Fall back to the Admin API proxy (EMAIL_API_URL) if no key is set here.
  const directKey = process.env.RESEND_API_KEY;
  if (directKey) {
    const from = process.env.RESEND_FROM || 'Nearwork <support@nearwork.co>';
    const subject = `We received your application — ${roleTitle}`;
    const html = buildJobAppliedEmailHtml(firstName, roleTitle);
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${directKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    const data = await resendRes.json().catch(() => ({}));
    if (!resendRes.ok) return { sent: false, via: 'resend-direct', error: data };
    return { sent: true, via: 'resend-direct', id: data.id };
  }

  // Fallback: call the Admin branded-email API (handles Resend key centrally).
  const adminApiUrl = process.env.EMAIL_API_URL || 'https://admin.nearwork.co/api/send-email';
  const response = await fetch(adminApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to,
      templateId: 'job_applied',
      data: { firstName, name: candidateName || 'there', roleTitle, openingCode: openingCode || '', actionUrl: 'https://talent.nearwork.co' }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { sent: false, via: 'admin-api', error: data };
  return { sent: true, via: 'admin-api', id: data.id };
}

function buildJobAppliedEmailHtml(firstName, roleTitle) {
  const sf = escapeHtml(firstName || 'there');
  const sr = escapeHtml(roleTitle || 'this role');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F5F4F0;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px;">
<table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
<tr><td style="padding:32px 40px 0">
  <span style="font-size:22px;font-weight:700;color:#111;letter-spacing:-.03em;">Nearwork</span>
  <div style="width:68px;height:3px;background:#16A085;border-radius:2px;margin-top:4px;"></div>
</td></tr>
<tr><td style="padding:20px 40px 0"><div style="height:4px;border-radius:2px;background:linear-gradient(90deg,#16A085 0%,#AF7AC5 60%,#E74C7C 100%);"></div></td></tr>
<tr><td style="padding:36px 40px 40px;background:#fff;">
  <p style="font-size:40px;margin:0 0 16px;">&#128233;</p>
  <h1 style="font-size:26px;font-weight:700;color:#111;margin:0 0 14px;">We got your application, ${sf}.</h1>
  <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 10px;">Thanks for applying for the <strong style="color:#111;">${sr}</strong> role. Our team will review your experience and be in touch soon.</p>
  <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 32px;">In the meantime, log in to your portal to track your application. &#128064;</p>
  <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;"><tr><td style="background:#E8F8F5;border-radius:999px;padding:8px 20px;">
    <span style="font-size:13px;font-weight:600;color:#16A085;">&#128188; ${sr}</span>
  </td></tr></table>
  <table cellpadding="0" cellspacing="0"><tr><td style="border-radius:6px;background:#16A085;">
    <a href="https://talent.nearwork.co" style="display:inline-block;font-size:14px;font-weight:600;color:#fff;text-decoration:none;padding:13px 30px;">Track your application &#8594;</a>
  </td></tr></table>
</td></tr>
<tr><td style="background:#F5F4F0;border-top:1px solid #EBEBEB;border-radius:0 0 12px 12px;padding:24px 40px;">
  <p style="font-size:12px;color:#9E9E9E;margin:0;">Questions? <a href="mailto:support@nearwork.co" style="color:#16A085;text-decoration:none;">support@nearwork.co</a></p>
</td></tr>
</table></td></tr></table>
</body></html>`;
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
