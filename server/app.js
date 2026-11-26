// WYRE Centraal — eigen server: inloggen, rechten en een documentopslag in PostgreSQL.
// Vervangt Firebase (Auth + Firestore) voor de site in ../index.html.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const PORT = +(process.env.PORT || 3000);
const SECRET = process.env.SECRET || '';
const STANDAARD_PW = process.env.STANDAARD_PW || '0123456789';
const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const MAX_BODY = 12 * 1024 * 1024;
const TOKEN_DAGEN = 30;
if (SECRET.length < 32) { console.error('SECRET ontbreekt of is te kort (minstens 32 tekens).'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    create table if not exists gebruikers (
      email text primary key,
      hash text not null,
      aangemaakt timestamptz not null default now()
    );
    create table if not exists docs (
      pad text primary key,
      ouder text not null,
      data jsonb not null,
      bijgewerkt bigint not null
    );
    create index if not exists docs_ouder on docs (ouder);
    create table if not exists col_versie (
      ouder text primary key,
      versie bigint not null default 0
    );`);
  // Eerste beheerder, alleen als er nog geen enkele gebruiker is.
  const { rows } = await pool.query('select count(*)::int as n from gebruikers');
  const em = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (rows[0].n === 0 && em && process.env.ADMIN_PASSWORD) {
    await pool.query('insert into gebruikers (email, hash) values ($1, $2)', [em, await hashPw(process.env.ADMIN_PASSWORD)]);
    await schrijf(pool, 'toegang/' + em, { naam: process.env.ADMIN_NAAM || em, rol: 'beheer', aangemaaktDoorBeheer: true, op: { __ts: Date.now() } }, false);
    console.log('Eerste beheerder aangemaakt:', em);
  }
}

/* ---------- wachtwoorden en tokens ---------- */
function hashPw(pw) {
  return new Promise((ok, nok) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, (e, key) => e ? nok(e) : ok('s1$' + salt.toString('base64') + '$' + key.toString('base64')));
  });
}
function checkPw(pw, hash) {
  return new Promise(ok => {
    const [v, s, k] = String(hash).split('$');
    if (v !== 's1' || !s || !k) return ok(false);
    const want = Buffer.from(k, 'base64');
    crypto.scrypt(pw, Buffer.from(s, 'base64'), want.length, (e, key) => ok(!e && crypto.timingSafeEqual(key, want)));
  });
}
const b64 = b => Buffer.from(b).toString('base64url');
const teken = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
// Het token bevat een afdruk van de wachtwoord-hash: na een wachtwoordwijziging vervallen oude tokens.
const afdruk = hash => crypto.createHash('sha256').update(hash).digest('base64url').slice(0, 10);
function maakToken(email, hash) {
  const body = b64(JSON.stringify({ e: email, h: afdruk(hash), x: Date.now() + TOKEN_DAGEN * 864e5 }));
  return body + '.' + teken(body);
}
function leesToken(t) {
  const [body, sig] = String(t || '').split('.');
  if (!body || !sig) return null;
  const want = teken(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const j = JSON.parse(Buffer.from(body, 'base64url').toString()); return j.x > Date.now() ? j : null; } catch (e) { return null; }
}

/* ---------- documentopslag ---------- */
const PAD_OK = /^[^\s/][^/]*(\/[^/]+)*$/;
const ouderVan = pad => pad.slice(0, pad.lastIndexOf('/'));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function diepSamen(a, b) { // b over a; alleen gewone objecten worden samengevoegd
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = (isObj(v) && isObj(o[k]) && !('__ts' in v)) ? diepSamen(o[k], v) : v;
  return o;
}
function zetTijd(data) { // serverTimestamp() uit de site → tijd van de server
  const nu = Date.now();
  for (const [k, v] of Object.entries(data)) if (isObj(v) && v.__st === 1) data[k] = { __ts: nu };
  return data;
}
async function lees(db, pad) {
  const { rows } = await db.query('select data, bijgewerkt from docs where pad = $1', [pad]);
  return rows[0] || null;
}
async function schrijf(db, pad, data, merge) {
  zetTijd(data);
  if (merge) { const oud = await lees(db, pad); if (oud) data = diepSamen(oud.data, data); }
  const ouder = ouderVan(pad);
  await db.query(`insert into docs (pad, ouder, data, bijgewerkt) values ($1, $2, $3, $4)
    on conflict (pad) do update set data = excluded.data, bijgewerkt = excluded.bijgewerkt`, [pad, ouder, JSON.stringify(data), Date.now()]);
  await raak(db, ouder);
}
async function wis(db, pad) {
  await db.query('delete from docs where pad = $1', [pad]);
  await raak(db, ouderVan(pad));
}
const raak = (db, ouder) => db.query(`insert into col_versie (ouder, versie) values ($1, 1)
  on conflict (ouder) do update set versie = col_versie.versie + 1`, [ouder]);

/* ---------- rechten (zelfde als de vroegere Firestore-regels) ---------- */
async function wie(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const tok = m && leesToken(m[1]);
  if (!tok) return null;
  const email = tok.e;
  const { rows } = await pool.query('select hash from gebruikers where email = $1', [email]);
  if (!rows.length || afdruk(rows[0].hash) !== tok.h) return null;
  const t = await lees(pool, 'toegang/' + email);
  return { email, lid: !!t, beheer: !!t && t.data.rol === 'beheer', toegang: t ? t.data : null };
}
function magLezen(u, pad) {
  if (pad.startsWith('toegang/')) return u.lid || pad === 'toegang/' + u.email;
  if (pad === 'toegang') return u.lid;
  if (pad === 'wyre' || pad.startsWith('wyre/')) return u.lid;
  return false;
}
// Geeft true, of bij een eigen toegangsregel de enige toegestane wijziging.
function magSchrijven(u, pad, data, merge, wissen) {
  if (pad.startsWith('toegang/')) {
    if (u.beheer) return true;
    if (!wissen && u.lid && pad === 'toegang/' + u.email && merge && data
      && Object.keys(data).length === 1 && data.moetWijzigen === false) return true;
    return false;
  }
  if (pad.startsWith('wyre/')) return u.lid;
  return false;
}

/* ---------- http ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function stuur(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}
const fout = (res, code, c, bericht) => stuur(res, code, { fout: c, bericht });
function body(req) {
  return new Promise((ok, nok) => {
    let n = 0; const delen = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { nok(Object.assign(new Error('te groot'), { code: 413 })); req.destroy(); } else delen.push(c); });
    req.on('end', () => { try { ok(delen.length ? JSON.parse(Buffer.concat(delen).toString()) : {}); } catch (e) { nok(Object.assign(new Error('geen geldige JSON'), { code: 400 })); } });
    req.on('error', nok);
  });
}
// Rem op raden van wachtwoorden: 10 mislukte pogingen per adres per kwartier.
const pogingen = new Map();
function teVeel(sleutel) {
  const nu = Date.now(); const p = (pogingen.get(sleutel) || []).filter(t => nu - t < 15 * 60e3);
  pogingen.set(sleutel, p); return p.length >= 10;
}
const mislukt = sleutel => pogingen.get(sleutel).push(Date.now());

async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;

  if (route === 'POST /api/login') {
    const { email, password } = await body(req);
    const em = String(email || '').trim().toLowerCase(), pw = String(password || '');
    if (teVeel(em)) return fout(res, 429, 'auth/too-many-requests', 'Te veel pogingen. Wacht even en probeer opnieuw.');
    let { rows } = await pool.query('select hash from gebruikers where email = $1', [em]);
    if (!rows.length) {
      // Op de toegangslijst maar nog geen wachtwoord (bv. na verhuizing): eerste login met het standaardwachtwoord.
      const t = await lees(pool, 'toegang/' + em);
      if (t && pw === STANDAARD_PW) {
        const h = await hashPw(pw);
        await pool.query('insert into gebruikers (email, hash) values ($1, $2) on conflict do nothing', [em, h]);
        await schrijf(pool, 'toegang/' + em, { moetWijzigen: true, aangemaaktDoorBeheer: true }, true);
        return stuur(res, 200, { token: maakToken(em, h), email: em });
      }
      mislukt(em); return fout(res, 401, 'auth/invalid-credential', 'E-mailadres of wachtwoord klopt niet.');
    }
    if (!(await checkPw(pw, rows[0].hash))) { mislukt(em); return fout(res, 401, 'auth/invalid-credential', 'E-mailadres of wachtwoord klopt niet.'); }
    return stuur(res, 200, { token: maakToken(em, rows[0].hash), email: em });
  }

  const u = await wie(req);
  if (!u) return fout(res, 401, 'auth/niet-ingelogd', 'Niet ingelogd.');

  if (route === 'GET /api/me') return stuur(res, 200, { email: u.email });

  if (route === 'POST /api/password') {
    const { oud, nieuw } = await body(req);
    if (String(nieuw || '').length < 8) return fout(res, 400, 'auth/weak-password', 'Kies een wachtwoord van minstens 8 tekens.');
    const { rows } = await pool.query('select hash from gebruikers where email = $1', [u.email]);
    if (!(await checkPw(String(oud || ''), rows[0].hash))) return fout(res, 401, 'auth/invalid-credential', 'Het huidige wachtwoord klopt niet.');
    const h = await hashPw(String(nieuw));
    await pool.query('update gebruikers set hash = $2 where email = $1', [u.email, h]);
    return stuur(res, 200, { ok: true, token: maakToken(u.email, h) });
  }

  // Beheerder maakt een account aan, of zet het wachtwoord van een bestaand account terug.
  if (route === 'POST /api/users') {
    if (!u.beheer) return fout(res, 403, 'permission-denied', 'Je hebt hier geen rechten voor.');
    const { email, password } = await body(req);
    const em = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return fout(res, 400, 'auth/invalid-email', 'Dit is geen geldig e-mailadres.');
    if (String(password || '').length < 8) return fout(res, 400, 'auth/weak-password', 'Kies een wachtwoord van minstens 8 tekens.');
    const r = await pool.query(`insert into gebruikers (email, hash) values ($1, $2)
      on conflict (email) do update set hash = excluded.hash returning (xmax = 0) as nieuw`, [em, await hashPw(String(password))]);
    return stuur(res, 200, { ok: true, nieuw: r.rows[0].nieuw });
  }

  if (route === 'GET /api/doc') {
    const pad = url.searchParams.get('pad') || '';
    if (!PAD_OK.test(pad) || !magLezen(u, pad)) return fout(res, 403, 'permission-denied', 'Je hebt hier geen rechten voor.');
    const d = await lees(pool, pad);
    const v = d ? String(d.bijgewerkt) : '0';
    if (url.searchParams.get('v') === v) return stuur(res, 200, { zelfde: true, v });
    return stuur(res, 200, { v, bestaat: !!d, data: d ? d.data : null });
  }

  if (route === 'GET /api/col') {
    const pad = url.searchParams.get('pad') || '';
    if (!PAD_OK.test(pad) || !magLezen(u, pad)) return fout(res, 403, 'permission-denied', 'Je hebt hier geen rechten voor.');
    const cv = await pool.query('select versie from col_versie where ouder = $1', [pad]);
    const v = String(cv.rows[0]?.versie || 0);
    if (url.searchParams.get('v') === v) return stuur(res, 200, { zelfde: true, v });
    const { rows } = await pool.query('select pad, data from docs where ouder = $1 order by pad', [pad]);
    return stuur(res, 200, { v, docs: rows.map(r => ({ id: r.pad.slice(pad.length + 1), data: r.data })) });
  }

  if (route === 'POST /api/batch') { // ook gebruikt voor één losse schrijf- of wisactie
    const { ops } = await body(req);
    if (!Array.isArray(ops) || !ops.length) return fout(res, 400, 'ongeldig', 'Geen bewerkingen.');
    for (const o of ops) {
      const wissen = o.t === 'del';
      if (!PAD_OK.test(o.pad || '') || !o.pad.includes('/') || (!wissen && !isObj(o.data))) return fout(res, 400, 'ongeldig', 'Ongeldige bewerking.');
      if (!magSchrijven(u, o.pad, o.data, !!o.merge, wissen)) return fout(res, 403, 'permission-denied', 'Je hebt hier geen rechten voor.');
    }
    const c = await pool.connect();
    try {
      await c.query('begin');
      for (const o of ops) o.t === 'del' ? await wis(c, o.pad) : await schrijf(c, o.pad, o.data, !!o.merge);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    return stuur(res, 200, { ok: true });
  }

  return fout(res, 404, 'niet-gevonden', 'Onbekend adres.');
}

function statisch(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(PUBLIC, path.normalize(p));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Niet gevonden'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return (req.method === 'GET' || req.method === 'HEAD') ? statisch(req, res, url) : (res.writeHead(405), res.end());
  api(req, res, url).catch(e => {
    if (e.code === 413) return fout(res, 413, 'te-groot', 'Het bestand is te groot.');
    if (e.code === 400) return fout(res, 400, 'ongeldig', e.message);
    console.error(new Date().toISOString(), req.method, url.pathname, e);
    if (!res.headersSent) fout(res, 500, 'serverfout', 'Er ging iets mis op de server.');
  });
});

(async () => {
  for (let i = 0; ; i++) { // de database start soms iets later dan dit programma
    try { await initDb(); break; } catch (e) { if (i > 30) throw e; await new Promise(r => setTimeout(r, 2000)); }
  }
  server.listen(PORT, () => console.log('WYRE Centraal luistert op poort', PORT));
})().catch(e => { console.error(e); process.exit(1); });
