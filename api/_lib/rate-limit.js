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

function sanitizeKey(str) {
  return str.replace(/\//g, '_').replace(/[.#$[\]]/g, '-').slice(0, 1024);
}

export async function checkRateLimit({ key, limit, windowMs }) {
  initAdmin();
  const db = admin.firestore();
  const ref = db.collection('_rateLimits').doc(sanitizeKey(key));
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || now - snap.data().windowStart > windowMs) {
      tx.set(ref, { count: 1, windowStart: now });
      return { allowed: true };
    }
    const { count, windowStart } = snap.data();
    if (count >= limit) {
      return { allowed: false, retryAfter: Math.ceil((windowStart + windowMs - now) / 1000) };
    }
    tx.update(ref, { count: count + 1 });
    return { allowed: true };
  });
}
