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
  const safeOpeningCode = safeId(openingCode);

  if (uid) {
    const byUid = await db.collection('applications')
      .where('ownerUid', '==', uid)
      .where('openingCode', '==', openingCode)
      .limit(1)
      .get();
    if (!byUid.empty) return true;

    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const user = userSnap.data() || {};
      if (Array.isArray(user.applications) && user.applications.some(app => applicationHasOpening(app, openingCode))) {
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
      .where('openingCode', '==', openingCode)
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
      if (normalizeCode(candidate.lastAppliedOpeningCode) === openingCode) return true;
      if (Array.isArray(candidate.applications) && candidate.applications.some(app => applicationHasOpening(app, openingCode))) {
        return true;
      }
    }

    const userByEmail = await db.collection('users')
      .where('email', '==', email)
      .limit(3)
      .get();
    for (const userDoc of userByEmail.docs) {
      const user = userDoc.data() || {};
      if (Array.isArray(user.applications) && user.applications.some(app => applicationHasOpening(app, openingCode))) {
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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = String(req.headers?.authorization || '').trim();
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    return res.status(401).json({ ok: false, applied: false, error: 'Authentication required' });
  }

  try {
    initAdmin();
    const db = admin.firestore();
    const openingCode = normalizeCode(req.query.openingCode || req.query.code || '');
    if (!openingCode) return res.status(400).json({ error: 'Opening code is required' });

    // Verify the token and scope the check to the requesting user only
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ ok: false, applied: false, error: 'Invalid or expired session' });
    }

    const uid = decoded.uid;
    const email = String(decoded.email || '').trim().toLowerCase();

    const applied = await hasApplied({ db, uid, email, openingCode });
    return res.status(200).json({ ok: true, applied });
  } catch (error) {
    console.error('check-application error:', error);
    return res.status(500).json({ ok: false, applied: false, error: 'Application check failed' });
  }
}
