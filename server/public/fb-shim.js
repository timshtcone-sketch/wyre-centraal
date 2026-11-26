// Vervangt de Firebase-modules voor de eigen server: dezelfde functienamen als de site
// gebruikt, maar pratend met /api/… (zie ../app.js). De site zelf blijft daardoor ongewijzigd.

const SLEUTEL = 'wyre-token';
let token = null;
try { token = localStorage.getItem(SLEUTEL); } catch (e) {}
const bewaar = t => { token = t; try { t ? localStorage.setItem(SLEUTEL, t) : localStorage.removeItem(SLEUTEL); } catch (e) {} };

class ApiFout extends Error { constructor(code, bericht) { super(bericht); this.code = code; } }
async function api(methode, pad, body) {
  let r;
  try {
    r = await fetch(pad, { method: methode, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new ApiFout('auth/network-request-failed', 'Geen verbinding met de server.'); }
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) {
    if (r.status === 401 && j?.fout === 'auth/niet-ingelogd') afmelden();
    throw new ApiFout(j?.fout || 'serverfout', j?.bericht || ('Fout ' + r.status));
  }
  return j;
}

/* ---------- app ---------- */
export function initializeApp(config, naam) { return { naam: naam || '[DEFAULT]' }; }

/* ---------- auth ---------- */
const luisteraars = [];
const hoofd = { currentUser: null, languageCode: 'nl', hoofd: true };
const maakUser = email => ({
  email, emailVerified: true, uid: email,
  reload: async () => {}, getIdToken: async () => token,
  _oud: null
});
function meld() { luisteraars.forEach(f => { try { f(hoofd.currentUser); } catch (e) { console.error(e); } }); }
function afmelden() { if (!hoofd.currentUser && !token) return; bewaar(null); hoofd.currentUser = null; stopAlles(); meld(); }

export function getAuth(app) { return app.naam === '[DEFAULT]' ? hoofd : { currentUser: null, hoofd: false }; }
export const inMemoryPersistence = 'memory';
export async function setPersistence() {}
let gestart = false;
export function onAuthStateChanged(auth, cb) {
  luisteraars.push(cb);
  if (!gestart) {
    gestart = true;
    (async () => {
      if (token) { try { const m = await api('GET', '/api/me'); hoofd.currentUser = maakUser(m.email); } catch (e) { bewaar(null); } }
      meld();
    })();
  } else queueMicrotask(() => cb(hoofd.currentUser));
  return () => { const i = luisteraars.indexOf(cb); if (i >= 0) luisteraars.splice(i, 1); };
}
export async function signInWithEmailAndPassword(auth, email, password) {
  const r = await api('POST', '/api/login', { email, password });
  bewaar(r.token); hoofd.currentUser = maakUser(r.email); meld();
  return { user: hoofd.currentUser };
}
export async function createUserWithEmailAndPassword(auth, email, password) {
  // Alleen een beheerder maakt accounts aan (via de tweede "app" van het Team-scherm).
  if (auth.hoofd) throw new ApiFout('auth/operation-not-allowed', 'Op deze server maakt een beheerder je account aan. Vraag een beheerder om je toe te voegen.');
  await api('POST', '/api/users', { email, password });
  auth.currentUser = maakUser(String(email).toLowerCase());
  return { user: auth.currentUser };
}
export async function sendEmailVerification() {}
export async function sendPasswordResetEmail() {
  throw new ApiFout('auth/operation-not-allowed', 'Vraag een beheerder om je wachtwoord terug te zetten naar het standaardwachtwoord (Team → Gebruiker aanmaken met jouw e-mailadres).');
}
export async function signOut(auth) { if (auth.hoofd) afmelden(); else auth.currentUser = null; }
export const EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
export async function reauthenticateWithCredential(user, cred) {
  await api('POST', '/api/login', { email: cred.email, password: cred.password }); // controleert het huidige wachtwoord
  user._oud = cred.password;
}
export async function updatePassword(user, nieuw) {
  if (user._oud == null) throw new ApiFout('auth/requires-recent-login', 'Vul eerst je huidige wachtwoord in.');
  const r = await api('POST', '/api/password', { oud: user._oud, nieuw });
  if (r.token) bewaar(r.token); // het oude token vervalt bij een nieuw wachtwoord
  user._oud = null;
}
export async function getIdTokenResult(user) { return { claims: { email: user.email, email_verified: true, firebase: { sign_in_provider: 'eigen server' } } }; }

/* ---------- database ---------- */
class Tijd {
  constructor(ms) { this.ms = ms; this.seconds = Math.floor(ms / 1000); }
  toDate() { return new Date(this.ms); }
  toMillis() { return this.ms; }
  toJSON() { return { __ts: this.ms }; }
}
const isTs = v => v && typeof v === 'object' && typeof v.__ts === 'number';
function uit(data) { // van de server: {__ts} → tijd-object (alleen bovenste niveau, daar staan ze)
  if (!data) return data;
  const o = { ...data };
  for (const k in o) if (isTs(o[k])) o[k] = new Tijd(o[k].__ts);
  return o;
}
export const serverTimestamp = () => ({ __st: 1 });

export function getFirestore() { return { db: true }; }
export function doc(basis, ...delen) {
  const pad = (basis.pad ? basis.pad + '/' : '') + delen.join('/');
  return { soort: 'doc', pad, id: pad.slice(pad.lastIndexOf('/') + 1) };
}
export function collection(basis, ...delen) {
  return { soort: 'col', pad: (basis.pad ? basis.pad + '/' : '') + delen.join('/') };
}
const docSnap = (ref, bestaat, data) => ({ id: ref.id, ref, exists: () => bestaat, data: () => bestaat ? uit(data) : undefined });
function colSnap(ref, docs) {
  const lijst = docs.map(d => docSnap({ soort: 'doc', pad: ref.pad + '/' + d.id, id: d.id }, true, d.data));
  return { docs: lijst, size: lijst.length, empty: !lijst.length, forEach: f => lijst.forEach(f) };
}
const q = pad => encodeURIComponent(pad);

export async function getDoc(ref) { const r = await api('GET', '/api/doc?pad=' + q(ref.pad)); return docSnap(ref, r.bestaat, r.data); }
export async function getDocs(ref) { const r = await api('GET', '/api/col?pad=' + q(ref.pad)); return colSnap(ref, r.docs); }
export async function setDoc(ref, data, opties) {
  await api('POST', '/api/batch', { ops: [{ t: 'set', pad: ref.pad, data, merge: !!opties?.merge }] }); ververs();
}
export async function deleteDoc(ref) { await api('POST', '/api/batch', { ops: [{ t: 'del', pad: ref.pad }] }); ververs(); }
export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opties) { ops.push({ t: 'set', pad: ref.pad, data, merge: !!opties?.merge }); return this; },
    delete(ref) { ops.push({ t: 'del', pad: ref.pad }); return this; },
    async commit() { if (ops.length) { await api('POST', '/api/batch', { ops }); ververs(); } }
  };
}

// onSnapshot: eerst ophalen, daarna elke 15 seconden kijken of er iets veranderd is
// (de server antwoordt met "zelfde" als de versie gelijk is), en direct na een eigen wijziging.
const volgers = new Set();
const INTERVAL = 15000;
export function onSnapshot(ref, cb, bijFout) {
  const v = { ref, cb, bijFout, versie: null, bezig: false, gestopt: false };
  volgers.add(v); haal(v);
  return () => { v.gestopt = true; volgers.delete(v); };
}
async function haal(v) {
  if (v.bezig || v.gestopt) return;
  v.bezig = true;
  try {
    const soort = v.ref.soort === 'col' ? 'col' : 'doc';
    const r = await api('GET', `/api/${soort}?pad=${q(v.ref.pad)}` + (v.versie !== null ? '&v=' + q(v.versie) : ''));
    if (v.gestopt) return;
    if (!r.zelfde) { v.versie = r.v; v.cb(soort === 'col' ? colSnap(v.ref, r.docs) : docSnap(v.ref, r.bestaat, r.data)); }
  } catch (e) {
    if (!v.gestopt && v.versie === null && v.bijFout) { v.gestopt = true; volgers.delete(v); v.bijFout(e); }
  } finally { v.bezig = false; }
}
function ververs() { volgers.forEach(haal); }
function stopAlles() { volgers.forEach(v => { v.gestopt = true; }); volgers.clear(); }
setInterval(() => { if (!document.hidden) ververs(); }, INTERVAL);
document.addEventListener('visibilitychange', () => { if (!document.hidden) ververs(); });
