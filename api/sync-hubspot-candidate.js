function splitName(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return {
    firstname: parts[0] || '',
    lastname: parts.slice(1).join(' ')
  };
}

function compactProperties(properties) {
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
  );
}

async function upsertHubspotContact(token, email, properties) {
  let response = await fetch(
    'https://api.hubapi.com/crm/v3/objects/contacts/' + encodeURIComponent(email) + '?idProperty=email',
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties })
    }
  );
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

function isUnknownHubspotProperty(body = {}) {
  const msg = String(body.message || '').toLowerCase();
  return msg.includes('property') && (msg.includes('does not exist') || msg.includes('unknown'));
}

import admin from 'firebase-admin';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'nearwork-97e3c';

function initAdmin() {
  if (admin.apps.length) return admin.app();
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId: PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }
  throw new Error('Firebase Admin credentials are not configured');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'HUBSPOT_ACCESS_TOKEN is not configured' });
  }

  const { candidate = {} } = req.body || {};
  if (!candidate.email) {
    return res.status(400).json({ ok: false, error: 'Candidate email is required' });
  }

  const { firstname, lastname } = splitName(candidate.name);

  const properties = compactProperties({
    email: candidate.email,
    firstname,
    lastname,
    phone: candidate.phone,
    city: candidate.city || candidate.location,
    jobtitle: candidate.role,
    company: 'Nearwork Candidate',
    type: 'Candidate',
    nearwork_contact_type: 'candidate',
    nearwork_portal_type: 'jobs',
    nearwork_candidate_code: candidate.code || candidate.candidateCode,
    nearwork_candidate_status: candidate.status || 'active',
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

  if (!hubspot.response.ok) {
    return res.status(hubspot.response.status).json({
      ok: false,
      error: hubspot.body.message || 'HubSpot sync failed',
      details: hubspot.body
    });
  }

  return res.status(200).json({
    ok: true,
    id: hubspot.body.id,
    createdOrUpdated: true,
    nearworkPropertiesSkipped: !!hubspot.body.nearworkPropertiesSkipped
  });
}
