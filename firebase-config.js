import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, query, where,
  getDocs, getDoc, doc, setDoc, addDoc, updateDoc, serverTimestamp, arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithRedirect, getRedirectResult, getAdditionalUserInfo,
  browserPopupRedirectResolver, signInWithCustomToken
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
  // Always stamp authUid so getCandidateSession() can detect cross-user contamination.
  const authUid = auth.currentUser?.uid || candidate.authUid || candidate.uid || '';
  localStorage.setItem(CANDIDATE_SESSION_KEY, JSON.stringify({
    id: candidate.id || '',
    code: candidate.code || '',
    email: candidate.email || '',
    firstName,
    lastName,
    authUid,
    loggedInAt: Date.now()
  }));
}

export function getCandidateSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(CANDIDATE_SESSION_KEY) || 'null');
    if (!saved?.email) return null;
    // Guard against cross-user session contamination: if a different Firebase user
    // is currently signed in, clear this stale session rather than returning it.
    // This prevents "User A logged out, User B logs in, form still shows User A's data".
    const currentUid = auth.currentUser?.uid;
    if (currentUid && saved.authUid && saved.authUid !== currentUid) {
      localStorage.removeItem(CANDIDATE_SESSION_KEY);
      return null;
    }
    return saved;
  } catch(e) {
    return null;
  }
}

export function clearCandidateSession() {
  localStorage.removeItem(CANDIDATE_SESSION_KEY);
}

// Clear all per-user cached data (applied set, etc.) for the given UID.
// Called on sign-out so stale badges never survive a session end.
export function clearUserCache(uid) {
  try {
    if (uid) localStorage.removeItem('nw_jobs_applied_' + uid);
  } catch {}
}

// Subscribe to auth state changes. Returns an unsubscribe function.
// Use this for a persistent listener that fires whenever the auth state
// changes — including when an account is deleted externally.
export function subscribeToAuthChanges(callback) {
  return onAuthStateChanged(auth, callback);
}

// Force a server-side reload of the current user's Firebase Auth token.
// If the account was deleted in Firebase Console, calling reload() causes
// the SDK to immediately fire onAuthStateChanged(null) rather than waiting
// up to 1 hour for the refresh token to naturally expire.
// Fire-and-forget — the persistent subscribeToAuthChanges listener handles cleanup.
export function reloadCurrentUser() {
  const user = auth.currentUser;
  if (user) {
    user.reload().catch(e => {
      // auth/user-not-found, auth/user-disabled, etc. — sign out right now
      const code = (e.code || '').toString();
      if (code.startsWith('auth/') && code !== 'auth/network-request-failed') {
        signOut(auth).catch(() => {});
      }
    });
  }
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
    const snap = await withTimeout(
      getDocs(query(collection(db, 'openings'), where('published', '==', true))),
      'getPublishedOpenings',
      10000
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
    let snap = await withTimeout(getDoc(doc(db, 'openings', upper)), 'getOpening by id', 8000);
    if (!snap.exists()) snap = await withTimeout(getDoc(doc(db, 'openings', raw)), 'getOpening raw', 8000);
    if (!snap.exists() && lower !== raw) snap = await withTimeout(getDoc(doc(db, 'openings', lower)), 'getOpening lower', 8000);
    if (!snap.exists()) {
      const byCode = await withTimeout(getDocs(query(collection(db, 'openings'), where('code', 'in', codeVariants))), 'getOpening by code', 8000);
      if (!byCode.empty) snap = byCode.docs[0];
    }
    if (!snap.exists()) {
      const bySlug = await withTimeout(getDocs(query(collection(db, 'openings'), where('slug', 'in', codeVariants))), 'getOpening by slug', 8000);
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
  await signInWithRedirect(auth, provider, browserPopupRedirectResolver);
  // Page navigates away — nothing below executes
}

export async function getGoogleRedirectResult() {
  await authPersistenceReady;
  try {
    const credential = await getRedirectResult(auth, browserPopupRedirectResolver);
    if (!credential) return null;
    const isNewUser = getAdditionalUserInfo(credential)?.isNewUser === true;
    return { user: credential.user, isNewUser };
  } catch (e) {
    console.error('[NW] Google redirect error', { code: e?.code, message: e?.message });
    throw e;
  }
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

export async function hasAppliedToOpening(uid, openingCode, email = '') {
  if ((!uid && !email) || !openingCode) return false;
  const code = String(openingCode).trim().toUpperCase();
  const normalizedEmail = String(email || auth.currentUser?.email || '').trim().toLowerCase();
  try {
    const params = new URLSearchParams({ openingCode: code });
    const idToken = await auth.currentUser?.getIdToken().catch(() => '');
    const headers = idToken ? { Authorization: `Bearer ${idToken}` } : {};
    const response = await withTimeout(
      fetch('/api/check-application?' + params.toString(), { headers }),
      'server duplicate check', 7000
    );
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.applied) return true;
    }
  } catch(e) {
    console.warn('server duplicate check skipped:', e.code || e.message);
  }
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

async function _saveCandidateProfile(uid, email, displayName, consentData = {}) {
  const now = serverTimestamp();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const candCode = 'CAND-' + Array.from({length:6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const nameParts = (displayName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  const consentAt = new Date().toISOString();
  const profile = {
    email,
    name: displayName || '',
    firstName,
    lastName,
    role: 'candidate',
    code: candCode,
    candidateCode: candCode,
    source: 'jobs.nearwork.co',
    status: 'active',
    privacyConsent: true,
    privacyConsentAt: consentData.privacyConsentAt || consentAt,
    marketingConsent: consentData.marketingConsent === true,
    marketingConsentAt: consentData.marketingConsent === true ? (consentData.marketingConsentAt || consentAt) : null,
    createdAt: now,
    updatedAt: now,
    ownerUid: uid,
    authUid: uid
  };
  await withTimeout(setDoc(doc(db, 'users', uid), profile, { merge: true }), 'user profile creation');
  await withTimeout(setDoc(doc(db, 'candidates', candCode), { ...profile, id: candCode }, { merge: true }), 'candidate creation');
  return { ...profile, id: uid };
}

export async function createNewCandidateAccount(email, password, displayName, consentData = {}) {
  const user = await createCandidateAuth(email, password, displayName);
  const profile = await _saveCandidateProfile(user.uid, email.trim().toLowerCase(), displayName, consentData);
  return { user, candCode: profile.code, profile };
}

export async function createCandidateProfile(uid, email, displayName, consentData = {}) {
  return _saveCandidateProfile(uid, (email || '').trim().toLowerCase(), displayName || '', consentData);
}

export async function syncCandidateToHubSpot(candidate) {
  const email = candidate?.email;
  if (!email) return { ok: false, skipped: true };
  try {
    const idToken = await auth.currentUser?.getIdToken().catch(() => '');
    const response = await fetch('/api/sync-hubspot-candidate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ candidate: { ...candidate, email } })
    });
    return response.json().catch(() => ({ ok: false }));
  } catch {
    return { ok: false };
  }
}

export async function signOutCandidate() {
  const uid = auth.currentUser?.uid;
  clearCandidateSession();
  clearUserCache(uid);
  await signOut(auth);
}

// Returns true when the given UID belongs to a candidate (or a brand-new user
// with no profile yet).  Returns false for client, admin, and staff accounts so
// jobs.nearwork.co can reject them before they reach the application form.
// Fails OPEN — if the lookup times out or errors, we allow rather than block a
// real candidate who just happens to have a slow connection.
export async function isCandidatePortalUser(uid) {
  if (!uid) return false;
  try {
    const snap = await withTimeout(getDoc(doc(db, 'users', uid)), 'portal role check', 5000);
    if (!snap.exists()) return true; // no users doc yet → brand-new user, allow
    const role = String(snap.data()?.role || '').toLowerCase();
    // Candidate accounts have role === 'candidate'.
    // Every other non-empty role belongs to the app portal or admin.
    return !role || role === 'candidate';
  } catch {
    return true; // fail open
  }
}

export async function submitApplication(applicationData) {
  const { openingCode } = applicationData;
  const rawEmail = applicationData.email.trim();
  const email = rawEmail.toLowerCase();
  const now = serverTimestamp();
  const expectedSalaryUSD = applicationData.expectedSalaryUSD != null && applicationData.expectedSalaryUSD !== '' ? Number(applicationData.expectedSalaryUSD) : null;
  const expectedSalaryCOP = applicationData.expectedSalaryCOP != null && applicationData.expectedSalaryCOP !== '' ? Number(applicationData.expectedSalaryCOP) : null;
  // Legacy single amount+currency fields, kept for Admin's existing candidate views
  const expectedSalaryAmount = expectedSalaryUSD || expectedSalaryCOP || Number(applicationData.expectedSalaryAmount || applicationData.salaryExpectationAmount || 0);
  const expectedSalaryCurrency = expectedSalaryUSD
    ? 'USD'
    : expectedSalaryCOP
      ? 'COP'
      : (String(applicationData.expectedSalaryCurrency || applicationData.salaryCurrency || 'USD').toUpperCase() === 'COP' ? 'COP' : 'USD');
  const expectedSalary = expectedSalaryAmount
    ? `$${Math.round(expectedSalaryAmount).toLocaleString(expectedSalaryCurrency === 'COP' ? 'es-CO' : 'en-US')} ${expectedSalaryCurrency}/mo`
    : '';
  const user = await waitForAuthReady();
  const ownerUid = user?.uid || applicationData.ownerUid || applicationData.authUid || null;
  if (!ownerUid) {
    throw new Error('Please log in again before submitting your application.');
  }
  if (await hasAppliedToOpening(ownerUid, openingCode, email)) {
    const error = new Error('You already applied to this opening.');
    error.code = 'already-applied';
    throw error;
  }
  let candSnap = null;
  // Guard: only accept properly formatted CAND-XXXXXX codes from the start.
  let candId = /^CAND-/i.test(applicationData.candidateId || '') ? applicationData.candidateId : '';
  let candCode = /^CAND-/i.test(applicationData.candidateCode || '') ? applicationData.candidateCode : '';
  const userRef = doc(db, 'users', ownerUid);
  let existingUser = {};
  try {
    const userSnap = await withTimeout(getDoc(userRef), 'candidate user lookup', 8000);
    if (userSnap.exists()) existingUser = userSnap.data() || {};
  } catch(e) {
    console.warn('candidate user lookup skipped:', e.code || e.message);
  }
  // Only use the stored code if it is a valid CAND code (not a Firebase UID).
  const storedCode = existingUser.candidateCode || existingUser.code || '';
  if (!candCode && /^CAND-/i.test(storedCode)) {
    candCode = storedCode;
  }
  const candidateProfile = {
    email,
    name: [applicationData.firstName, applicationData.lastName].filter(Boolean).join(' '),
    firstName: applicationData.firstName,
    lastName: applicationData.lastName,
    phone: applicationData.phone,
    city: applicationData.city || '',
    locationDepartment: applicationData.department || '',
    locationCity: applicationData.city || '',
    locationId: applicationData.locationId || '',
    location: applicationData.location || '',
    english: applicationData.english || '',
    englishLevel: applicationData.english || '',
    linkedin: applicationData.linkedin || '',
    currentRole: applicationData.currentRole || '',
    expectedSalaryUSD,
    expectedSalaryCOP,
    expectedSalaryAmount,
    expectedSalaryCurrency,
    expectedSalary,
    salaryExpectation: expectedSalary,
    cvUrl: applicationData.cvUrl || null,
    workHistory: applicationData.experience || [],  // renamed: keep array as workHistory
    skills: applicationData.skills || [],
    languages: applicationData.languages || [],
    certifications: applicationData.certifications || [],
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
      // Search by email — only accept docs whose ID is a real CAND code.
      // Legacy docs keyed by Firebase UID are skipped to force clean migration.
      const snaps = await withTimeout(getDocs(query(collection(db,'candidates'), where('email','==',email))), 'candidate lookup');
      const fallbackSnaps = (snaps.empty && rawEmail !== email)
        ? await withTimeout(getDocs(query(collection(db,'candidates'), where('email','==',rawEmail))), 'candidate lookup')
        : snaps;
      for (const d of (fallbackSnaps.empty ? snaps : fallbackSnaps).docs) {
        if (/^CAND-/i.test(d.id)) {
          candId = d.id;
          candCode = d.data().code || d.id;
          break;
        }
      }
    } catch(e) {
      console.warn('candidate lookup skipped during submit:', e.code || e.message);
    }
  }

  // If no valid CAND code was found, generate one and patch the users doc so
  // this account is properly migrated for all future submissions.
  if (!candId) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    candCode = 'CAND-' + Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    candId = candCode;
    try {
      await withTimeout(
        setDoc(userRef, { candidateCode: candCode, code: candCode }, { merge: true }),
        'cand code migration', 6000
      );
    } catch(e) {
      console.warn('cand code migration skipped:', e.code || e.message);
    }
  }
  candCode = candCode || candId;

  const appliedDate = new Date().toISOString().split('T')[0];
  const embeddedApplication = {
    opening: openingCode,
    openingCode,
    role: applicationData.openingTitle || openingCode,
    openingTitle: applicationData.openingTitle || openingCode,
    applied: appliedDate,
    appliedAt: appliedDate,
    status: 'applied',
    outcome: 'Application only',
    source: 'jobs.nearwork.co'
  };
  // Embed the application in the candidates doc so admin can find it
  // even when Firestore security rules prevent reading the applications collection
  const candidateProfileWithApp = { ...candidateProfile, applications: arrayUnion(embeddedApplication) };
  if (candId) {
    candCode = candCode || candId;
    try {
      await withTimeout(setDoc(doc(db,'candidates',candId), candidateProfileWithApp, {merge:true}), 'candidate update');
    } catch(e) {
      console.warn('candidate update skipped:', e.code || e.message);
    }
  } else {
    if (!candCode) {
      const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      candCode='CAND-'+Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
    }
    candId=candCode;
    await withTimeout(setDoc(doc(db,'candidates',candId),{code:candCode,status:'applied',createdAt:now,...candidateProfileWithApp}), 'candidate creation');
  }
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
    city: applicationData.city || '',
    locationCity: applicationData.city || '',
    locationDepartment: applicationData.department || '',
    locationId: applicationData.locationId || '',
    location: applicationData.location || '',
    locationCountry: 'Colombia',
    english: applicationData.english || '',
    englishLevel: applicationData.english || '',
    linkedin: applicationData.linkedin || '',
    currentRole: applicationData.currentRole || '',
    expectedSalaryUSD,
    expectedSalaryCOP,
    expectedSalaryAmount,
    expectedSalaryCurrency,
    expectedSalary,
    salaryExpectation: expectedSalary,
    salary: expectedSalary || existingUser.salary || '',
    salaryCurrency: expectedSalaryCurrency,
    cvUrl: applicationData.cvUrl || null,
    skills: applicationData.skills || [],
    experience: applicationData.experience || [],
    languages: applicationData.languages || [],
    certifications: applicationData.certifications || [],
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
    languages: applicationData.languages || [],
    certifications: applicationData.certifications || [],
    currentRole: applicationData.currentRole || '',
    expectedSalaryUSD,
    expectedSalaryCOP,
    expectedSalaryAmount,
    expectedSalaryCurrency,
    expectedSalary,
    salaryExpectation: expectedSalary,
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

  // ── Add candidate to the pipeline so they appear in the ATS Applied column ──
  try {
    // Try query-by-code first; fall back to document-ID lookup so older pipelines
    // (without a code field) are still found.
    let pipelineDocSnap = null;
    const pipelineQ = query(collection(db, 'pipelines'), where('code', '==', openingCode));
    const pipelineSnap = await withTimeout(getDocs(pipelineQ), 'pipeline lookup', 6000);
    if (!pipelineSnap.empty) {
      pipelineDocSnap = pipelineSnap.docs[0];
    } else {
      // Pipeline doc ID equals the opening code in all kickoff-created pipelines
      const byId = await withTimeout(getDoc(doc(db, 'pipelines', openingCode)), 'pipeline id lookup', 4000);
      if (byId.exists()) pipelineDocSnap = byId;
    }

    if (pipelineDocSnap) {
      const pipelineData = pipelineDocSnap.data() || {};
      const existingCandidates = Array.isArray(pipelineData.candidates) ? pipelineData.candidates : [];
      const alreadyIn = existingCandidates.some(c =>
        c.candidateId === candId || c.candidateCode === candCode
      );
      if (!alreadyIn) {
        const candidateName = [applicationData.firstName, applicationData.lastName].filter(Boolean).join(' ');
        const pipelineEntry = {
          candidateId: candId,       // Firestore doc ID — matches candidate.id in ATS
          candidateCode: candCode,
          name: candidateName,
          email,
          stage: 'applied',
          pendingReview: true,       // held in Applicants inbox until a recruiter approves
          addedAt: new Date().toISOString(),
          source: 'jobs.nearwork.co',
          cvUrl: applicationData.cvUrl || null,
          skills: applicationData.skills || [],
          expectedSalary,
        };
        await withTimeout(
          updateDoc(doc(db, 'pipelines', pipelineDocSnap.id), {
            candidates: [...existingCandidates, pipelineEntry],
            updatedAt: serverTimestamp(),
          }),
          'pipeline update', 6000
        );
      }
    } else {
      console.warn('pipeline update skipped: no pipeline found for', openingCode);
    }
  } catch(e) {
    console.warn('pipeline update skipped:', e.code || e.message);
  }

  return {candCode,candId,appId:savedAppRef.id};
}

export async function uploadCV(file, candCode) {
  const ext=file.name.split('.').pop();
  const storageRef=ref(storage,'cvs/'+candCode+'/cv-'+Date.now()+'.'+ext);
  const upload = await withTimeout(uploadBytes(storageRef,file), 'CV upload', 20000);
  return withTimeout(getDownloadURL(upload.ref), 'CV URL', 10000);
}

export async function getCurrentIdToken() {
  return auth.currentUser?.getIdToken().catch(() => '') ?? '';
}

export async function signInWithHandoffToken(customToken) {
  return signInWithCustomToken(auth, customToken);
}

export { db, storage, auth, serverTimestamp, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc };
