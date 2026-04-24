// ═══════════════════════════════════════════
// Nearwork — Firebase Config
// jobs.nearwork.co — public job board
// ═══════════════════════════════════════════

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  collection, query, where, orderBy,
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

// Read all published active openings
export async function getPublishedOpenings() {
  try {
    const q = query(
      collection(db, 'openings'),
      where('published', '==', true),
      orderBy('createdAt', 'desc')
    );
    const snap = await getDocs(q);
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(o => ['active','Active','on hold','On hold'].includes(o.status));
  } catch(e) {
    console.error('getPublishedOpenings:', e);
    return [];
  }
}

// Read one opening by code (only if published + active)
export async function getOpening(code) {
  try {
    const snap = await getDoc(doc(db, 'openings', code));
    if (!snap.exists()) return null;
    const data = snap.data();
    if (!data.published) return null;
    return { id: snap.id, ...data };
  } catch(e) {
    console.error('getOpening:', e);
    return null;
  }
}

// Submit application — upserts CAND record, writes application + audit log
export async function submitApplication(applicationData) {
  const { email, openingCode } = applicationData;
  const now = serverTimestamp();

  // Check for existing candidate by email
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

  // Application record
  const appRef = doc(collection(db, 'applications'));
  await setDoc(appRef, {
    candidateId: candId, candidateCode: candCode,
    openingCode, experience: applicationData.experience,
    skills: applicationData.skills, questions: applicationData.questions,
    cvUrl: applicationData.cvUrl || null,
    submittedAt: now, status: 'new', isMockData: false,
  });

  // Audit log
  await addDoc(collection(db, 'audit_logs'), {
    action: 'candidate_applied', entity: 'candidate', entityId: candId,
    openingCode, timestamp: now, source: 'jobs.nearwork.co',
    detail: (candSnap.empty ? 'New candidate' : 'Existing candidate updated') + ' — applied to ' + openingCode,
  });

  return { candCode, appId: appRef.id };
}

// Upload CV to Firebase Storage
export async function uploadCV(file, candCode) {
  const ext = file.name.split('.').pop();
  const storageRef = ref(storage, 'cvs/' + candCode + '/cv-' + Date.now() + '.' + ext);
  const snapshot   = await uploadBytes(storageRef, file);
  return await getDownloadURL(snapshot.ref);
}

export { db, storage };
