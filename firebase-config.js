import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, query, where,
  getDocs, getDoc, doc, setDoc, addDoc, serverTimestamp
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

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);
const storage = getStorage(app);

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
    let snap = await getDocs(query(collection(db,'candidates'), where('email','==',normalized)));
    if (snap.empty && normalized !== email.trim()) {
      snap = await getDocs(query(collection(db,'candidates'), where('email','==',email.trim())));
    }
    if (snap.empty) return null;
    const docSnap = snap.docs[0];
    return { id: docSnap.id, ...docSnap.data() };
  } catch(e) {
    console.error('getCandidateByEmail error:', e.message);
    return null;
  }
}

export async function submitApplication(applicationData) {
  const { openingCode } = applicationData;
  const rawEmail = applicationData.email.trim();
  const email = rawEmail.toLowerCase();
  const now = serverTimestamp();
  let candSnap = await getDocs(query(collection(db,'candidates'), where('email','==',email)));
  if (candSnap.empty && rawEmail !== email) {
    candSnap = await getDocs(query(collection(db,'candidates'), where('email','==',rawEmail)));
  }
  let candId, candCode;
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
    lastAppliedOpeningCode: openingCode,
    lastAppliedAt: now
  };
  if (!candSnap.empty) {
    const ex = candSnap.docs[0];
    candId = ex.id; candCode = ex.data().code || ex.id;
    await setDoc(doc(db,'candidates',candId), candidateProfile, {merge:true});
  } else {
    const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    candCode='CAND-'+Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
    candId=candCode;
    await setDoc(doc(db,'candidates',candId),{code:candCode,status:'applied',createdAt:now,...candidateProfile});
  }
  const safeOpeningCode = String(openingCode).replace(/[^\w-]/g,'_');
  const appRef=doc(db,'applications',candId+'_'+safeOpeningCode);
  await setDoc(appRef,{
    candidateId:candId,
    candidateCode:candCode,
    candidateName:[applicationData.firstName,applicationData.lastName].filter(Boolean).join(' '),
    candidateEmail:email,
    openingCode,
    openingTitle:applicationData.openingTitle||'',
    experience:applicationData.experience,
    skills:applicationData.skills,
    questions:applicationData.questions,
    cvUrl:applicationData.cvUrl||null,
    submittedAt:now,
    updatedAt:now,
    status:'new',
    pipelineStage:'applied',
    isMockData:false,
    source:'jobs.nearwork.co'
  }, {merge:true});
  const emailOpeningTitle = String(applicationData.openingTitle || openingCode).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
  await setDoc(doc(db,'mail',appRef.id), {
    to: email,
    message: {
      subject: 'Thank you for applying to Nearwork',
      text: `Thank you for applying to ${applicationData.openingTitle || openingCode}. We received your application and will review it carefully.`,
      html: `<p>Thank you for applying to <strong>${emailOpeningTitle}</strong>.</p><p>We received your application and will review it carefully.</p>`
    },
    createdAt: now,
    source: 'jobs.nearwork.co',
    applicationId: appRef.id
  }, {merge:true});
  await addDoc(collection(db,'audit_logs'),{action:'candidate_applied',entity:'candidate',entityId:candId,openingCode,timestamp:now,source:'jobs.nearwork.co',detail:(candSnap.empty?'New candidate':'Updated')+' — applied to '+openingCode});
  return {candCode,appId:appRef.id};
}

export async function uploadCV(file, candCode) {
  const ext=file.name.split('.').pop();
  const storageRef=ref(storage,'cvs/'+candCode+'/cv-'+Date.now()+'.'+ext);
  return getDownloadURL((await uploadBytes(storageRef,file)).ref);
}

export { db, storage, serverTimestamp, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc };
