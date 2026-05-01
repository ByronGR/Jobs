import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, query, where,
  getDocs, getDoc, doc, setDoc, addDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyApRNyW8PoP28E0x77dUB5jOgHuTqA2by4",
  authDomain: "nearwork-97e3c.firebaseapp.com",
  projectId: "nearwork-97e3c",
  storageBucket: "nearwork-97e3c.firebasestorage.app",
  messagingSenderId: "145642656516",
  appId: "1:145642656516:web:0ac2da8931283121e87651"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);
const authPersistenceReady = setPersistence(auth, browserLocalPersistence).catch(e => {
  console.warn('Firebase Auth persistence setup skipped:', e.code || e.message);
});
const CANDIDATE_SESSION_KEY = 'nearworkCandidate';

function withTimeout(promise, label, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms))
  ]);
}

export function saveCandidateSession(candidate) {
  if (!candidate) return;
  const displayName = candidate.name || candidate.displayName || '';
  const firstName = candidate.firstName || displayName.split(/\s+/)[0] || '';
  const lastName = candidate.lastName || displayName.split(/\s+/).slice(1).join(' ') || '';
  localStorage.setItem(CANDIDATE_SESSION_KEY, JSON.stringify({
    id: candidate.id || '',
    code: candidate.code || '',
    email: candidate.email || '',
    firstName,
    lastName,
    authUid: auth.currentUser?.uid || candidate.authUid || '',
    loggedInAt: Date.now()
  }));
}

export function getCandidateSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(CANDIDATE_SESSION_KEY) || 'null');
    if (!saved?.email) return null;
    return saved;
  } catch(e) {
    return null;
  }
}

export function clearCandidateSession() {
  localStorage.removeItem(CANDIDATE_SESSION_KEY);
}

export async function waitForAuthReady(ms = 3000) {
  await authPersistenceReady;
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      unsub();
      resolve(auth.currentUser || null);
    }, ms);
    const unsub = onAuthStateChanged(auth, user => {
      clearTimeout(timer);
      unsub();
      resolve(user || null);
    });
  });
}

// Get all published openings — NO orderBy to avoid composite index requirement
export async function getPublishedOpenings() {
  try {
    const snap = await getDocs(
      query(collection(db, 'openings'), where('published', '==', true))
    );
    const results = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(o => (o.status || '').toLowerCase() !== 'archived');

    // Sort client-side — handles Firestore Timestamp AND ISO string
    results.sort((a, b) => {
      const toMs = v => v?.toDate?.()?.getTime() ?? (v ? new Date(v).getTime() : 0);
      return toMs(b.createdAt) - toMs(a.createdAt);
    });
    return results;
  } catch(e) {
    console.error('getPublishedOpenings error:', e.code, e.message);
    return [];
  }
}

export async function getOpening(code) {
  try {
    const raw = String(code || '').trim();
    const upper = raw.toUpperCase();
    const lower = raw.toLowerCase();
    const codeVariants = [...new Set([upper, raw, lower].filter(Boolean))];
    let snap = await getDoc(doc(db, 'openings', upper));
    if (!snap.exists()) snap = await getDoc(doc(db, 'openings', raw));
    if (!snap.exists() && lower !== raw) snap = await getDoc(doc(db, 'openings', lower));
    if (!snap.exists()) {
      const byCode = await getDocs(query(collection(db, 'openings'), where('code', 'in', codeVariants)));
      if (!byCode.empty) snap = byCode.docs[0];
    }
    if (!snap.exists()) {
      const bySlug = await getDocs(query(collection(db, 'openings'), where('slug', 'in', codeVariants)));
      if (!bySlug.empty) snap = bySlug.docs[0];
    }
    if (!snap.exists()) return null;
    const data = snap.data();
    if (!data.published) return null;
    return { id: snap.id, ...data };
  } catch(e) {
    console.error('getOpening error:', e.message);
    return null;
  }
}

export async function getCandidateByEmail(email) {
  try {
    const normalized = email.trim().toLowerCase();
    let snap = await withTimeout(getDocs(query(collection(db,'candidates'), where('email','==',normalized))), 'candidate lookup');
    if (snap.empty && normalized !== email.trim()) {
      snap = await withTimeout(getDocs(query(collection(db,'candidates'), where('email','==',email.trim()))), 'candidate lookup');
    }
    if (snap.empty) return null;
    const docSnap = snap.docs[0];
    return { id: docSnap.id, ...docSnap.data() };
  } catch(e) {
    console.error('getCandidateByEmail error:', e.message);
    throw e;
  }
}

export async function signInCandidate(email, password) {
  await authPersistenceReady;
  const credential = await withTimeout(
    signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password),
    'login',
    20000
  );
  return credential.user;
}

export async function signInCandidateWithGoogle() {
  await authPersistenceReady;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const credential = await withTimeout(signInWithPopup(auth, provider), 'google login', 30000);
  return credential.user;
}

export async function getCurrentUserProfile() {
  const user = await waitForAuthReady();
  if (!user) return null;
  try {
    const snap = await withTimeout(getDoc(doc(db, 'users', user.uid)), 'current user profile lookup', 8000);
    if (snap.exists()) return { id: snap.id, ...snap.data() };
  } catch(e) {
    console.warn('current user profile lookup skipped:', e.code || e.message);
  }
  return {
    id: user.uid,
    email: user.email || '',
    name: user.displayName || '',
    firstName: user.displayName?.split(/\s+/)[0] || '',
    lastName: user.displayName?.split(/\s+/).slice(1).join(' ') || ''
  };
}

export async function hasAppliedToOpening(uid, openingCode) {
  if (!uid || !openingCode) return false;
  const code = String(openingCode).trim().toUpperCase();
  try {
    const appSnap = await withTimeout(getDocs(query(
      collection(db, 'applications'),
      where('ownerUid', '==', uid),
      where('openingCode', '==', code)
    )), 'application duplicate check', 8000);
    if (!appSnap.empty) return true;
  } catch(e) {
    console.warn('application duplicate check skipped:', e.code || e.message);
  }
  try {
    const userSnap = await withTimeout(getDoc(doc(db, 'users', uid)), 'user application duplicate check', 8000);
    const applications = userSnap.exists() && Array.isArray(userSnap.data().applications)
      ? userSnap.data().applications
      : [];
    return applications.some(app => {
      const appCode = typeof app === 'string'
        ? app
        : (app?.opening || app?.openingCode || app?.jobCode || app?.code || app?.id || '');
      return String(appCode).trim().toUpperCase() === code;
    });
  } catch(e) {
    console.warn('user application duplicate check skipped:', e.code || e.message);
    return false;
  }
}

export async function createCandidateAuth(email, password, displayName = '') {
  await authPersistenceReady;
  const credential = await withTimeout(
    createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password),
    'account creation',
    20000
  );
  if (displayName) {
    try {
      await withTimeout(updateProfile(credential.user, { displayName }), 'profile update', 8000);
    } catch(e) {
      console.warn('auth profile update skipped:', e.code || e.message);
    }
  }
  return credential.user;
}

export async function signOutCandidate() {
  clearCandidateSession();
  await signOut(auth);
}

export async function submitApplication(applicationData) {
  const { openingCode } = applicationData;
  const rawEmail = applicationData.email.trim();
  const email = rawEmail.toLowerCase();
  const now = serverTimestamp();
  const user = await waitForAuthReady();
  const ownerUid = user?.uid || applicationData.ownerUid || applicationData.authUid || null;
  if (!ownerUid) {
    throw new Error('Please log in again before submitting your application.');
  }
  if (await hasAppliedToOpening(ownerUid, openingCode)) {
    const error = new Error('You already applied to this opening.');
    error.code = 'already-applied';
    throw error;
  }
  let candSnap = null;
  let candId = applicationData.candidateId || '';
  let candCode = applicationData.candidateCode || '';
  const userRef = doc(db, 'users', ownerUid);
  let existingUser = {};
  try {
    const userSnap = await withTimeout(getDoc(userRef), 'candidate user lookup', 8000);
    if (userSnap.exists()) existingUser = userSnap.data() || {};
  } catch(e) {
    console.warn('candidate user lookup skipped:', e.code || e.message);
  }
  if (!candCode && (existingUser.candidateCode || existingUser.code)) {
    candCode = existingUser.candidateCode || existingUser.code;
  }
  const candidateProfile = {
    email,
    firstName: applicationData.firstName,
    lastName: applicationData.lastName,
    phone: applicationData.phone,
    city: applicationData.city,
    english: applicationData.english,
    linkedin: applicationData.linkedin || '',
    cvUrl: applicationData.cvUrl || null,
    experience: applicationData.experience || [],
    skills: applicationData.skills || [],
    updatedAt: now,
    isMockData: false,
    source: 'jobs.nearwork.co',
    authUid: ownerUid,
    ownerUid,
    lastAppliedOpeningCode: openingCode,
    lastAppliedAt: now
  };
  if (!candId) {
    try {
      candSnap = await withTimeout(getDocs(query(collection(db,'candidates'), where('email','==',email))), 'candidate lookup');
      if (candSnap.empty && rawEmail !== email) {
        candSnap = await withTimeout(getDocs(query(collection(db,'candidates'), where('email','==',rawEmail))), 'candidate lookup');
      }
    } catch(e) {
      console.warn('candidate lookup skipped during submit:', e.code || e.message);
    }
    if (candSnap && !candSnap.empty) {
      const ex = candSnap.docs[0];
      candId = ex.id;
      candCode = ex.data().code || ex.id;
    }
  }

  if (candId) {
    candCode = candCode || candId;
    try {
      await withTimeout(setDoc(doc(db,'candidates',candId), candidateProfile, {merge:true}), 'candidate update');
    } catch(e) {
      console.warn('candidate update skipped:', e.code || e.message);
    }
  } else {
    if (!candCode) {
      const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      candCode='CAND-'+Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
    }
    candId=candCode;
    await withTimeout(setDoc(doc(db,'candidates',candId),{code:candCode,status:'applied',createdAt:now,...candidateProfile}), 'candidate creation');
  }
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
      role: applicationData.openingTitle || openingCode,
      openingTitle: applicationData.openingTitle || openingCode,
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
    roleApplied: applicationData.openingTitle || openingCode,
    headline: existingUser.headline || applicationData.openingTitle || '',
    jobTitle: existingUser.jobTitle || '',
    candidateCode: candCode,
    code: candCode,
    email,
    name: [applicationData.firstName, applicationData.lastName].filter(Boolean).join(' '),
    firstName: applicationData.firstName,
    lastName: applicationData.lastName,
    phone: applicationData.phone,
    city: applicationData.city,
    locationCity: applicationData.city,
    locationCountry: 'Colombia',
    english: applicationData.english,
    englishLevel: applicationData.english,
    linkedin: applicationData.linkedin || '',
    cvUrl: applicationData.cvUrl || null,
    skills: applicationData.skills || [],
    experience: applicationData.experience || [],
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
  await withTimeout(setDoc(userRef, userProfile, { merge:true }), 'candidate user profile save');

  const safeOpeningCode = String(openingCode).replace(/[^\w-]/g,'_');
  const appRef=doc(db,'applications',candId+'_'+safeOpeningCode);
  const applicationPayload = {
    candidateId:ownerUid,
    candidateDocId:candId,
    ownerUid,
    authUid:ownerUid,
    candidateCode:candCode,
    candidateName:[applicationData.firstName,applicationData.lastName].filter(Boolean).join(' '),
    candidateEmail:email,
    openingCode,
    jobId:openingCode,
    openingId:applicationData.openingId||openingCode,
    openingTitle:applicationData.openingTitle||'',
    jobTitle:applicationData.openingTitle||openingCode,
    title:applicationData.openingTitle||openingCode,
    clientName:'Nearwork client',
    experience:applicationData.experience,
    skills:applicationData.skills,
    questions:applicationData.questions,
    cvUrl:applicationData.cvUrl||null,
    submittedAt:now,
    updatedAt:now,
    status:'applied',
    pipelineStage:'',
    inPipeline:false,
    isMockData:false,
    source:'jobs.nearwork.co'
  };
  let savedAppRef = appRef;
  try {
    await withTimeout(setDoc(appRef, applicationPayload, {merge:true}), 'application save');
  } catch(e) {
    console.warn('stable application save failed, trying create:', e.code || e.message);
    savedAppRef = await withTimeout(addDoc(collection(db,'applications'), applicationPayload), 'application create');
  }
  const emailOpeningTitle = String(applicationData.openingTitle || openingCode).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
  try {
    await withTimeout(setDoc(doc(db,'mail',savedAppRef.id), {
      to: email,
      message: {
        subject: 'Thank you for applying to Nearwork',
        text: `Thank you for applying to ${applicationData.openingTitle || openingCode}. We received your application and will review it carefully. You should receive more information in the next couple of hours.`,
        html: `<p>Thank you for applying to <strong>${emailOpeningTitle}</strong>.</p><p>We received your application and will review it carefully. You should receive more information in the next couple of hours.</p><p>Nearwork Team<br>support@nearwork.co</p>`
      },
      createdAt: now,
      source: 'jobs.nearwork.co',
      applicationId: savedAppRef.id
    }, {merge:true}), 'mail notification', 6000);
  } catch(e) {
    console.warn('mail notification skipped:', e.code || e.message);
  }
  try {
    const auditPrefix = candSnap && !candSnap.empty ? 'Updated' : 'New candidate';
    await withTimeout(addDoc(collection(db,'audit_logs'),{action:'candidate_applied',entity:'candidate',entityId:candId,openingCode,timestamp:now,source:'jobs.nearwork.co',detail:auditPrefix+' — applied to '+openingCode}), 'audit log', 6000);
  } catch(e) {
    console.warn('audit log skipped:', e.code || e.message);
  }
  return {candCode,candId,appId:savedAppRef.id};
}

export async function uploadCV(file, candCode) {
  const ext=file.name.split('.').pop();
  const storageRef=ref(storage,'cvs/'+candCode+'/cv-'+Date.now()+'.'+ext);
  const upload = await withTimeout(uploadBytes(storageRef,file), 'CV upload', 20000);
  return withTimeout(getDownloadURL(upload.ref), 'CV URL', 10000);
}

export { db, storage, auth, serverTimestamp, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc };
