// ═══════════════════════════════════════════
// Nearwork — Firebase Config
// jobs.nearwork.co — public job board
// ═══════════════════════════════════════════

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  collection, query, where,
  getDocs, getDoc, doc, setDoc, addDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyApRNyW8PoP28E0x77dUB5jOgHuTqA2by4",
  authDomain: "nearwork-97e3c.firebaseapp.com",
  projectId: "nearwork-97e3c",
  storageBucket: "nearwork-97e3c.firebasestorage.app",
  messagingSenderId: "145642656516",
  appId: "1:145642656516:web:0ac2da8931283121e87651"
};

const app     = initializeApp(firebaseConfig);
const db      = getFirestore(app);
const storage = getStorage(app);

// Get all published openings — no orderBy to avoid composite index requirement
export async function getPublishedOpenings() {
  try {
    const q    = query(collection(db, 'openings'), where('published', '==', true));
    const snap = await getDocs(q);
    const results = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(o => (o.status || '').toLowerCase() !== 'archived');

    // Sort client-side — handles both Firestore Timestamp and ISO string
    results.sort((a, b) => {
      const ta = a.createdAt?.toDate?.() ?? (a.createdAt ? new Date(a.createdAt) : new Date(0));
      const tb = b.createdAt?.toDate?.() ?? (b.createdAt ? new Date(b.createdAt) : new Date(0));
      return tb - ta;
    });
    return results;
  } catch(e) {
    console.error('getPublishedOpenings:', e);
    return [];
  }
}

// Get one opening by code (any case)
export async function getOpening(code) {
  try {
    // Try exact code
    let snap = await getDoc(doc(db, 'openings', code));
    if (!snap.exists()) {
      // Try uppercase
      snap = await getDoc(doc(db, 'openings', code.toUpperCase()));
    }
    if (!snap.exists()) return null;
    const data = snap.data();
    if (!data.published) return null;
    return { id: snap.id, ...data };
  } catch(e) {
    console.error('getOpening:', e);
    return null;
  }
}

// Submit application — upserts candidate, writes application + audit log
export async function submitApplication(applicationData) {
  const { email, openingCode } = applicationData;
  const now = serverTimestamp();

  const candSnap = await getDocs(
    query(collection(db, 'candidates'), where('email', '==', email))
  );

  let candId, candCode;

  if (!candSnap.empty) {
    const existing = candSnap.docs[0];
    candId   = existing.id;
    candCode = existing.data().code;
    await setDoc(doc(db, 'candidates', candId), {
      firstName: applicationData.firstName,
      lastName:  applicationData.lastName,
      phone:     applicationData.phone,
      city:      applicationData.city,
      english:   applicationData.english,
      linkedin:  applicationData.linkedin || '',
      updatedAt: now,
      isMockData: false,
    }, { merge: true });
  } else {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rand  = Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    candCode = 'CAND-' + rand;
    candId   = candCode;
    await setDoc(doc(db, 'candidates', candId), {
      code: candCode, email,
      firstName: applicationData.firstName,
      lastName:  applicationData.lastName,
      phone:     applicationData.phone,
      city:      applicationData.city,
      english:   applicationData.english,
      linkedin:  applicationData.linkedin || '',
      status: 'applied', isMockData: false,
      createdAt: now, updatedAt: now,
      source: 'jobs.nearwork.co',
    });
  }

  const appRef = doc(collection(db, 'applications'));
  await setDoc(appRef, {
    candidateId: candId, candidateCode: candCode,
    openingCode, experience: applicationData.experience,
    skills: applicationData.skills, questions: applicationData.questions,
    cvUrl: applicationData.cvUrl || null,
    submittedAt: now, status: 'new', isMockData: false,
  });

  await addDoc(collection(db, 'audit_logs'), {
    action: 'candidate_applied', entity: 'candidate', entityId: candId,
    openingCode, timestamp: now, source: 'jobs.nearwork.co',
    detail: (candSnap.empty ? 'New candidate' : 'Existing candidate updated') + ' — applied to ' + openingCode,
  });

  return { candCode, appId: appRef.id };
}

export async function uploadCV(file, candCode) {
  const ext = file.name.split('.').pop();
  const storageRef = ref(storage, 'cvs/' + candCode + '/cv-' + Date.now() + '.' + ext);
  const snapshot   = await uploadBytes(storageRef, file);
  return await getDownloadURL(snapshot.ref);
}

export { db, storage, serverTimestamp };
