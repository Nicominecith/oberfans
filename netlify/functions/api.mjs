/**
 * OberFans – Netlify Function (ersetzt den alten Express-Server)
 * Alle Routen unter /api/*
 * Speicher: Netlify Blobs (Nutzer, Posts, Bilder/Videos)
 * E-Mail:   Gmail + App-Passwort (nodemailer)
 */
import { getStore } from '@netlify/blobs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';

export const config = { path: '/api/*' };

// ─── Einstellungen ──────────────────────────────────────────────────────────
const MIN_AGE        = 18;   // Match-App: nur Erwachsene
const CODE_TTL_MS    = 15 * 60 * 1000;
const MAX_CODE_TRIES = 5;
const MAX_MEDIA      = 5 * 1024 * 1024;   // Netlify-Functions erlauben ~6 MB pro Request
const MAX_AVATAR     = 1.5 * 1024 * 1024;
const FEED_LIMIT     = 60;
const MAX_PHOTOS     = 6;   // wie bei Tinder: bis zu 6 Fotos, das erste ist das Profilbild
const MEDIA_TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogg', 'video/quicktime': 'mov'
};

// ─── Speicher ───────────────────────────────────────────────────────────────
const store = n => getStore({ name: n, consistency: 'strong' });
const users   = () => store('users');    // key: username (klein)
const emails  = () => store('emails');   // key: sha256(email) -> username (klein)
const pending = () => store('pending');  // key: username (klein) -> offene Registrierung
const posts   = () => store('posts');    // key: sortierbare Post-ID
const swipes  = () => store('swipes');   // key: username (klein) -> { liked, passed, matches }
const chats   = () => store('chats');    // key: c_<paar>_<zeit>_<zufall> -> Nachricht
const reports = () => store('reports');  // Meldungen (in Netlify → Blobs einsehbar)
const media   = () => store('media');    // key: Dateiname

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (status, error) => json({ error }, status);

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const emailKey = e => sha(e.trim().toLowerCase());
const lc = s => String(s || '').trim().toLowerCase();
const parseInterests = v => (Array.isArray(v) ? v : String(v || '').split(','))
  .map(x => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 8);
const pairKey = (x, y) => sha([lc(x), lc(y)].sort().join('|')).slice(0, 24);
const getSwipe = async k => (await swipes().get(lc(k), { type: 'json' })) || { liked: [], passed: [], matches: [] };
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

function calcAge(birthStr) {
  const b = new Date(birthStr), t = new Date();
  if (isNaN(b)) return -1;
  let a = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
  return a;
}

const toArrayBuffer = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// Signier-Schlüssel: wird beim ersten Start zufällig erzeugt und in Netlify Blobs gespeichert.
// Unabhängig von Gmail-Daten -> Passwortwechsel loggt niemanden aus.
let _secret;
async function getSecret() {
  if (_secret) return _secret;
  const st = store('config');
  let v = await st.get('secret');
  if (!v) {
    await st.set('secret', crypto.randomBytes(48).toString('hex'));
    v = await st.get('secret');   // erneut lesen: bei gleichzeitigem Start gewinnt ein Wert
  }
  return (_secret = v);
}

async function sign(user) {
  return jwt.sign({ username: user.username }, await getSecret(), { expiresIn: '7d' });
}

// Standard-Avatar als SVG (Initialen + Farbverlauf), komplett selbst erzeugt – kein externer Dienst
function avatarSvg(name) {
  const clean = String(name || '?').slice(0, 40);
  const h = parseInt(sha(clean.toLowerCase()).slice(0, 6), 16);
  const hue = h % 360, hue2 = (hue + 40) % 360;
  const ini = (clean.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?').toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},75%,55%)"/><stop offset="1" stop-color="hsl(${hue2},80%,45%)"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><text x="60" y="60" dy=".35em" text-anchor="middle" font-family="Arial,sans-serif" font-size="46" font-weight="700" fill="#fff">${ini.replace(/[<>&]/g, '')}</text></svg>`;
}

// Fotos eines Nutzers (Altbestand: nur das eine Profilbild, falls es ein echtes Foto ist)
function photosOf(u) {
  if (Array.isArray(u.photos) && u.photos.length) return u.photos;
  return /^\/api\/media\//.test(u.avatar || '') ? [u.avatar] : [];
}

function publicUser(u) {
  const photos = photosOf(u);
  const legacy = /^https:\/\/api\.dicebear\.com\//.test(u.avatar || '');
  return {
    username: u.username,
    avatar: photos[0] || (legacy || !u.avatar ? `/api/avatar/${encodeURIComponent(u.username)}` : u.avatar),
    photos, bio: u.bio || '',
    gender: u.gender || '', age: u.age || '', interests: u.interests || [], createdAt: u.createdAt
  };
}

async function authUser(req) {
  const token = req.headers.get('authorization')?.split(' ')[1];
  if (!token) return null;
  try {
    const { username } = jwt.verify(token, await getSecret());
    return await users().get(lc(username), { type: 'json' });
  } catch { return null; }
}

// data:-URL speichern (Avatare) -> /api/media/<key>
async function saveDataUrl(dataUrl, prefix) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_AVATAR) throw new Error('Profilbild zu groß');
  const key = `${prefix}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}.${MEDIA_TYPES[m[1]]}`;
  await media().set(key, toArrayBuffer(buf), { metadata: { contentType: m[1] } });
  return `/api/media/${key}`;
}
async function deleteOldMedia(url) {
  const m = /^\/api\/media\/([\w.-]+)$/.exec(url || '');
  if (m) { try { await media().delete(m[1]); } catch {} }
}

// ─── E-Mail (Gmail App-Passwort) ────────────────────────────────────────────
async function sendCodeMail(to, username, code) {
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) throw new Error('E-Mail-Versand nicht konfiguriert');
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transport.sendMail({
    from: `"OberFans" <${user}>`,
    to,
    subject: `Dein OberFans-Code: ${code}`,
    text: `Hallo ${username},\n\ndein Bestätigungscode lautet: ${code}\n\nEr ist 15 Minuten gültig. Wenn du dich nicht registriert hast, ignoriere diese E-Mail.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;background:#13131f;color:#eaeaf5;border-radius:14px">
      <h2 style="margin:0 0 8px;color:#c8ff00">OberFans</h2>
      <p>Hallo <b>${username}</b>, dein Bestätigungscode:</p>
      <div style="font-size:34px;letter-spacing:8px;font-weight:700;text-align:center;padding:14px;background:#0f0f1a;border-radius:10px;color:#c8ff00">${code}</div>
      <p style="opacity:.6;font-size:13px">Gültig für 15 Minuten. Nicht von dir? Dann ignoriere diese E-Mail.</p></div>`
  });
}

async function createPending(username, email, passwordHash, extra) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pending().setJSON(lc(username), {
    username, email: email.trim().toLowerCase(), passwordHash, ...extra,
    codeHash: sha(code + await getSecret()),
    expires: Date.now() + CODE_TTL_MS, tries: 0
  });
  await sendCodeMail(email.trim(), username, code);
}

// ─── Routen ─────────────────────────────────────────────────────────────────
async function route(req) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)
    return fail(500, 'GMAIL_USER / GMAIL_APP_PASSWORD fehlen (Netlify → Environment variables)');

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;
  const [a, b, c] = parts;

  // ── Standard-Avatar (öffentlich)
  if (a === 'avatar' && b && method === 'GET') {
    return new Response(avatarSvg(decodeURIComponent(b)), { headers: {
      'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400'
    }});
  }

  // ── Medien ausliefern (öffentlich, damit <img>/<video> funktionieren)
  if (a === 'media' && b && method === 'GET') {
    if (!/^[\w.-]+$/.test(b)) return fail(400, 'Ungültig');
    const f = await media().getWithMetadata(b, { type: 'arrayBuffer' });
    if (!f) return fail(404, 'Nicht gefunden');
    return new Response(f.data, { headers: {
      'Content-Type': f.metadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }});
  }

  // ── Registrierung (Schritt 1: Code per Gmail senden)
  if (a === 'register' && method === 'POST') {
    const { username, email, password, bio, gender, birthdate, avatar, interests } = await req.json();
    if (!username || !password || !email) return fail(400, 'Felder fehlen');
    if (username.length < 2) return fail(400, 'Benutzername zu kurz (min. 2 Zeichen)');
    if (username.length > 30) return fail(400, 'Benutzername zu lang');
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return fail(400, 'Benutzername darf nur Buchstaben, Zahlen, _ . - enthalten');
    if (!isEmail(email)) return fail(400, 'Ungültige E-Mail-Adresse');
    if (password.length < 6) return fail(400, 'Passwort zu kurz (min. 6 Zeichen)');
    if (!birthdate) return fail(400, 'Geburtsdatum erforderlich');
    if (!gender) return fail(400, 'Geschlecht erforderlich');
    if (calcAge(birthdate) < MIN_AGE) return fail(400, `Du musst mindestens ${MIN_AGE} Jahre alt sein.`);
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(avatar || '')) return fail(400, 'Profilbild erforderlich');
    if (avatar.length > MAX_AVATAR * 1.4) return fail(400, 'Profilbild zu groß');

    if (await users().get(lc(username))) return fail(409, 'Benutzername existiert bereits');
    if (await emails().get(emailKey(email))) return fail(409, 'E-Mail wird schon verwendet');

    const extra = {
      bio: String(bio || '').slice(0, 300), gender, birthdate, interests: parseInterests(interests),
      avatar
    };
    try {
      await createPending(username, email, await bcrypt.hash(password, 10), extra);
    } catch (e) {
      console.error('Mail-Fehler:', e.message);
      return fail(500, 'E-Mail konnte nicht gesendet werden. Prüfe GMAIL_USER / GMAIL_APP_PASSWORD.');
    }
    return json({ message: 'Code gesendet', needsCode: true });
  }

  // ── Registrierung (Schritt 2: Code prüfen, Konto anlegen)
  if (a === 'verify' && method === 'POST') {
    const { username, code } = await req.json();
    const key = lc(username);
    const p = await pending().get(key, { type: 'json' });
    if (!p) return fail(400, 'Keine offene Registrierung. Bitte neu registrieren.');
    if (Date.now() > p.expires) { await pending().delete(key); return fail(400, 'Code abgelaufen. Bitte neuen Code anfordern.'); }
    if (p.tries >= MAX_CODE_TRIES) { await pending().delete(key); return fail(429, 'Zu viele Versuche. Bitte neu registrieren.'); }
    if (sha(String(code || '').trim() + await getSecret()) !== p.codeHash) {
      p.tries++; await pending().setJSON(key, p);
      return fail(400, 'Falscher Code');
    }
    // Race-Schutz
    if (await users().get(key)) return fail(409, 'Benutzername existiert bereits');
    if (await emails().get(emailKey(p.email))) return fail(409, 'E-Mail wird schon verwendet');

    let avatarUrl = `/api/avatar/${encodeURIComponent(p.username)}`;
    try { avatarUrl = (await saveDataUrl(p.avatar, 'avatar_' + key)) || avatarUrl; } catch {}

    const user = {
      username: p.username, email: p.email, passwordHash: p.passwordHash,
      bio: p.bio, gender: p.gender, birthdate: p.birthdate, age: calcAge(p.birthdate), interests: p.interests || [], blocked: [],
      avatar: avatarUrl, photos: avatarUrl.startsWith('/api/media/') ? [avatarUrl] : [],
      createdAt: new Date().toISOString()
    };
    await users().setJSON(key, user);
    await emails().set(emailKey(p.email), key);
    await pending().delete(key);
    return json({ message: 'Konto erstellt!' });
  }

  // ── Neuen Code anfordern
  if (a === 'resend' && method === 'POST') {
    const { username } = await req.json();
    const p = await pending().get(lc(username), { type: 'json' });
    if (!p) return fail(400, 'Keine offene Registrierung.');
    try {
      await createPending(p.username, p.email, p.passwordHash,
        { bio: p.bio, gender: p.gender, birthdate: p.birthdate, avatar: p.avatar, interests: p.interests });
    } catch { return fail(500, 'E-Mail konnte nicht gesendet werden.'); }
    return json({ message: 'Neuer Code gesendet' });
  }

  // ── Login (Benutzername ODER E-Mail)
  if (a === 'login' && method === 'POST') {
    const { username, password } = await req.json();
    let key = lc(username);
    if (isEmail(username || '')) key = (await emails().get(emailKey(username))) || '';
    const user = key ? await users().get(key, { type: 'json' }) : null;
    if (!user || !(await bcrypt.compare(password || '', user.passwordHash)))
      return fail(401, 'Falscher Benutzername oder Passwort');

    if (user.birthdate) {
      const age = calcAge(user.birthdate);
      if (age !== user.age) { user.age = age; await users().setJSON(key, user); }
    }
    return json({ token: await sign(user), ...publicUser(user) });
  }

  // ── ab hier nur eingeloggt
  const me = await authUser(req);
  if (!me) return fail(401, 'Nicht eingeloggt');
  const myKey = lc(me.username);

  // Profil aktualisieren (Bio, Geschlecht, Interessen – Alter kommt aus dem Geburtstag)
  if (a === 'profile' && !b && method === 'PUT') {
    const { bio, gender, avatar, interests } = await req.json();
    if (bio !== undefined) me.bio = String(bio).slice(0, 300);
    if (gender !== undefined) me.gender = ['male', 'female', 'divers', 'none', ''].includes(gender) ? gender : me.gender;
    if (interests !== undefined) me.interests = parseInterests(interests);
    if (avatar && avatar.startsWith('data:')) {   // alte App-Versionen: ersetzt das Hauptfoto
      try {
        const newUrl = await saveDataUrl(avatar, 'photo_' + myKey);
        if (!newUrl) return fail(400, 'Ungültiges Bild');
        const ph = photosOf(me);
        if (ph.length) { await deleteOldMedia(ph[0]); ph[0] = newUrl; } else ph.push(newUrl);
        me.photos = ph; me.avatar = newUrl;
      } catch (e) { return fail(400, e.message); }
    }
    await users().setJSON(myKey, me);
    return json({ message: 'Profil aktualisiert', token: await sign(me), ...publicUser(me) });
  }

  // Foto hinzufügen
  if (a === 'profile' && b === 'photos' && method === 'POST') {
    const { photo } = await req.json();
    const ph = photosOf(me);
    if (ph.length >= MAX_PHOTOS) return fail(400, `Maximal ${MAX_PHOTOS} Fotos`);
    let url;
    try { url = await saveDataUrl(photo, 'photo_' + myKey); } catch (e) { return fail(400, e.message); }
    if (!url) return fail(400, 'Ungültiges Bild');
    ph.push(url);
    me.photos = ph; me.avatar = ph[0];
    await users().setJSON(myKey, me);
    return json(publicUser(me));
  }

  // Fotos neu ordnen / löschen (order = neue Reihenfolge, Fehlende werden gelöscht, erstes = Profilbild)
  if (a === 'profile' && b === 'photos' && method === 'PUT') {
    const { order } = await req.json();
    const cur = photosOf(me);
    if (!Array.isArray(order) || !order.length || new Set(order).size !== order.length
      || order.length > cur.length || !order.every(u => cur.includes(u)))
      return fail(400, 'Ungültige Fotoliste (mindestens 1 Foto nötig)');
    for (const u of cur.filter(u => !order.includes(u))) await deleteOldMedia(u);
    me.photos = order; me.avatar = order[0];
    await users().setJSON(myKey, me);
    return json(publicUser(me));
  }

  // Öffentliches Profil
  if (a === 'users' && b && method === 'GET') {
    const u = await users().get(lc(decodeURIComponent(b)), { type: 'json' });
    if (!u) return fail(404, 'Nutzer nicht gefunden');
    return json(publicUser(u));
  }

  // Feed
  if (a === 'posts' && !b && method === 'GET') {
    const { blobs } = await posts().list();
    const keys = blobs.map(x => x.key).sort().slice(0, FEED_LIMIT);
    const list = (await Promise.all(keys.map(k => posts().get(k, { type: 'json' })))).filter(Boolean);
    const avatars = {};
    const names = new Set(list.flatMap(p => [p.author, ...p.comments.map(c => c.user)]));
    await Promise.all([...names].map(async n => {
      const u = await users().get(lc(n), { type: 'json' });
      if (u) avatars[lc(n)] = u.avatar;
    }));
    list.forEach(p => {
      p.avatar = avatars[lc(p.author)] || p.avatar;
      p.comments.forEach(c => { c.avatar = avatars[lc(c.user)] || c.avatar; });
    });
    return json(list);
  }

  // Post erstellen (multipart: image + caption)
  if (a === 'posts' && !b && method === 'POST') {
    const form = await req.formData();
    const caption = String(form.get('caption') || '').slice(0, 2000);
    const file = form.get('image');
    let imageUrl = null;
    const id = `${String(9999999999999 - Date.now()).padStart(13, '0')}_${crypto.randomBytes(3).toString('hex')}`;

    if (file && typeof file === 'object' && file.size) {
      const ext = MEDIA_TYPES[file.type];
      if (!ext) return fail(400, 'Nur Bilder (jpg, png, gif, webp) oder Videos (mp4, webm, ogg, mov)');
      if (file.size > MAX_MEDIA) return fail(413, 'Datei zu groß (max. 5 MB)');
      const key = `m_${id}.${ext}`;
      await media().set(key, await file.arrayBuffer(), { metadata: { contentType: file.type } });
      imageUrl = `/api/media/${key}`;
    }
    if (!caption && !imageUrl) return fail(400, 'Bild, Video oder Text erforderlich');

    const post = {
      id, author: me.username, avatar: me.avatar, caption, imageUrl,
      likes: [], dislikes: [], comments: [], createdAt: new Date().toISOString()
    };
    await posts().setJSON(id, post);
    return json(post);
  }

  // Like / Dislike
  if (a === 'posts' && b && c === 'react' && method === 'POST') {
    const { type } = await req.json();
    if (type !== 'like' && type !== 'dislike') return fail(400, 'Ungültig');
    const post = await posts().get(b, { type: 'json' });
    if (!post) return fail(404, 'Post nicht gefunden');
    const cur = type === 'like' ? 'likes' : 'dislikes';
    const opp = type === 'like' ? 'dislikes' : 'likes';
    post[opp] = (post[opp] || []).filter(u => u !== me.username);
    post[cur] = post[cur] || [];
    const i = post[cur].indexOf(me.username);
    i === -1 ? post[cur].push(me.username) : post[cur].splice(i, 1);
    await posts().setJSON(b, post);
    return json({ likes: post.likes.length, dislikes: post.dislikes.length });
  }

  // Kommentar
  if (a === 'posts' && b && c === 'comment' && method === 'POST') {
    const { text } = await req.json();
    if (!text?.trim()) return fail(400, 'Kommentar leer');
    const post = await posts().get(b, { type: 'json' });
    if (!post) return fail(404, 'Post nicht gefunden');
    const comment = {
      user: me.username, avatar: me.avatar, text: text.trim().slice(0, 1000),
      createdAt: new Date().toISOString(), replies: []
    };
    post.comments.push(comment);
    await posts().setJSON(b, post);
    return json(comment);
  }

  // ── Entdecken: Vorschläge (ohne bereits geswipte, geblockte oder gematchte Nutzer)
  if (a === 'discover' && method === 'GET') {
    const minAge = Math.max(MIN_AGE, parseInt(url.searchParams.get('minAge')) || MIN_AGE);
    const maxAge = parseInt(url.searchParams.get('maxAge')) || 120;
    const interest = lc(url.searchParams.get('interest'));
    const sw = await getSwipe(myKey);
    const seen = new Set([myKey, ...sw.liked, ...sw.passed, ...sw.matches, ...(me.blocked || [])]);
    const { blobs } = await users().list();
    const keys = shuffle(blobs.map(x => x.key).filter(k => !seen.has(k))).slice(0, 60);
    const found = (await Promise.all(keys.map(k => users().get(k, { type: 'json' })))).filter(Boolean);
    const out = found.filter(u => {
      const age = calcAge(u.birthdate);
      if (age < minAge || age > maxAge) return false;
      if ((u.blocked || []).includes(myKey)) return false;
      if (interest && !(u.interests || []).some(i => lc(i).includes(interest))) return false;
      return true;
    }).slice(0, 15);
    return json(out.map(publicUser));
  }

  // ── Swipe (like / pass) – bei gegenseitigem Like entsteht ein Match
  if (a === 'swipe' && method === 'POST') {
    const { username, action } = await req.json();
    const key = lc(username);
    if (!key || key === myKey || (action !== 'like' && action !== 'pass')) return fail(400, 'Ungültig');
    const other = await users().get(key, { type: 'json' });
    if (!other || (other.blocked || []).includes(myKey) || (me.blocked || []).includes(key))
      return fail(404, 'Nutzer nicht gefunden');
    const sw = await getSwipe(myKey);
    let match = false;
    if (action === 'like') {
      if (!sw.liked.includes(key)) sw.liked.push(key);
      const osw = await getSwipe(key);
      if (osw.liked.includes(myKey)) {
        match = true;
        if (!sw.matches.includes(key)) sw.matches.push(key);
        if (!osw.matches.includes(myKey)) osw.matches.push(myKey);
        await swipes().setJSON(key, osw);
      }
    } else if (!sw.passed.includes(key)) sw.passed.push(key);
    await swipes().setJSON(myKey, sw);
    return json(match ? { match: true, user: publicUser(other) } : { match: false });
  }

  // ── Matches
  if (a === 'matches' && method === 'GET') {
    const sw = await getSwipe(myKey);
    const list = await Promise.all(sw.matches.map(k => users().get(k, { type: 'json' })));
    return json(list.filter(Boolean).map(publicUser));
  }

  // ── Chat (nur zwischen Matches)
  if (a === 'chat' && b) {
    const key = lc(decodeURIComponent(b));
    const sw = await getSwipe(myKey);
    if (!sw.matches.includes(key)) return fail(403, 'Chat nur mit Matches möglich');
    const prefix = `c_${pairKey(myKey, key)}_`;
    if (method === 'GET') {
      const { blobs } = await chats().list({ prefix });
      const ks = blobs.map(x => x.key).sort().slice(-100);
      const msgs = (await Promise.all(ks.map(k => chats().get(k, { type: 'json' })))).filter(Boolean);
      return json(msgs);
    }
    if (method === 'POST') {
      const { text } = await req.json();
      if (!text?.trim()) return fail(400, 'Nachricht leer');
      const msg = { from: me.username, text: text.trim().slice(0, 1000), createdAt: new Date().toISOString() };
      await chats().setJSON(`${prefix}${String(Date.now()).padStart(13, '0')}_${crypto.randomBytes(3).toString('hex')}`, msg);
      return json(msg);
    }
  }

  // ── Blockieren (entfernt Match, Nutzer sehen sich nicht mehr)
  if (a === 'block' && method === 'POST') {
    const { username } = await req.json();
    const key = lc(username);
    if (!key || key === myKey) return fail(400, 'Ungültig');
    me.blocked = [...new Set([...(me.blocked || []), key])];
    await users().setJSON(myKey, me);
    const sw = await getSwipe(myKey); sw.matches = sw.matches.filter(k => k !== key); await swipes().setJSON(myKey, sw);
    const osw = await getSwipe(key); osw.matches = osw.matches.filter(k => k !== myKey); await swipes().setJSON(key, osw);
    return json({ message: 'Blockiert' });
  }

  // ── Melden
  if (a === 'report' && method === 'POST') {
    const { username, reason } = await req.json();
    if (!username) return fail(400, 'Ungültig');
    await reports().setJSON(`r_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, {
      reporter: me.username, reported: String(username).slice(0, 40),
      reason: String(reason || '').slice(0, 500), createdAt: new Date().toISOString()
    });
    return json({ message: 'Danke, wir prüfen die Meldung.' });
  }

  return fail(404, 'Route nicht gefunden');
}

export default async (req) => {
  try { return await route(req); }
  catch (e) { console.error(e); return fail(500, 'Serverfehler'); }
};
