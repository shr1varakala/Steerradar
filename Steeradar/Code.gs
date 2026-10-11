/**
 * Steeradar backend — v6.1 (hardened Google Apps Script web app)
 *
 * WHAT CHANGED vs. the old shared-secret backend
 *   • No shared secret. Every private action needs a per-user session token.
 *   • The server decides ownership. Clients never say "I own this" — the token does.
 *   • OTP is bound to the REGISTERED email (login) and to the email that was
 *     verified (register); a verified code is single-use and expires.
 *   • Chats are private 1:1 rooms (dm-<PLATE>-<PLATE>) or a signed-in "local-<geohash>"
 *     room. Sender identity is stamped server-side and cannot be spoofed.
 *   • Phone numbers / emails are NEVER returned to other users.
 *   • Inputs are validated + length-capped; cells are plain text (no formula injection).
 *   • Per-user / per-phone rate limits; writes are serialised with a script lock.
 *
 * DEPLOY: see README ("Backend setup"). Execute as: Me. Who has access: Anyone.
 * (Anyone = the browser can reach it; authorisation is done by the tokens below.)
 */

const VERSION = '6.1';
const SESSION_DAYS = 90;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_VERIFIED_TTL_MS = 15 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_DAILY_CAP = 80;                 // MailApp consumer quota is ~100/day
const LANE_TTL_MS = 24 * 3600 * 1000;
const PRESENCE_TTL_MS = 2 * 60 * 1000;
const MAX_BODY_CHARS = 1200000;           // ~0.9 MB image as base64 + overhead
const VEHICLE_TYPES = ['bus', 'car', 'auto', 'bike', 'walk', 'event'];
const PHOTO_SLOTS = ['avatar', 'vehiclePhoto', 'platePhoto', 'upiQr'];

const SCHEMA = {
  users:    ['phone', 'email', 'name', 'username', 'vehicle', 'vehicleType', 'avatarId', 'vehiclePhotoId', 'platePhotoId', 'upiQrId', 'createdAt', 'device'],
  sessions: ['tokenHash', 'phone', 'createdAt', 'expiresAt', 'device'],
  otps:     ['id', 'phone', 'email', 'purpose', 'codeHash', 'createdAt', 'expiresAt', 'attempts', 'verifiedAt', 'consumed'],
  lanes:    ['id', 'ownerPhone', 'driver', 'vehicle', 'vehicleType', 'from', 'via', 'to', 'total', 'taken', 'fare', 'lat', 'lng', 'status', 'ts', 'peerId', 'lastSeen', 'showPlate'],
  hive:     ['id', 'ownerPhone', 'name', 'avatar', 'title', 'text', 'tags', 'time', 'likes', 'ts', 'vehicle'],
  likes:    ['key', 'postId', 'phone'],
  messages: ['id', 'roomId', 'fromVehicle', 'fromPhone', 'sender', 'text', 'ts'],
  presence: ['vehicle', 'phone', 'name', 'avatar', 'peerId', 'vehicleType', 'lat', 'lng', 'lastSeen'],
  trips:    ['id', 'phone', 'laneId', 'startTs', 'endTs', 'distance', 'fare', 'rating'],
};

// ════════════════════════════════════════════════════════════
//  ERRORS + SMALL HELPERS
// ════════════════════════════════════════════════════════════
class ApiError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const now = () => Date.now();
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const isId = (v) => /^[A-Za-z0-9_-]{1,64}$/.test(String(v || ''));
const isPhone = (v) => /^\d{10}$/.test(String(v || ''));
const isEmail = (v) => /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/.test(String(v || ''));
const normVehicle = (v) => String(v || '').replace(/[\s-]/g, '').toUpperCase();
const isVehicle = (v) => /^[A-Z0-9]{4,15}$/.test(String(v || ''));
const toNum = (v, min, max, dflt) => {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const coord = (v, lim) => {
  if (v === '' || v == null) return '';
  const n = Number(v);
  return isFinite(n) && Math.abs(n) <= lim ? n : '';
};
const round = (v, d) => (v === '' || v == null || !isFinite(Number(v))) ? '' : Number(Number(v).toFixed(d));
const maskEmail = (e) => String(e).replace(/^(.).*(@.*)$/, '$1***$2');
const initials = (name) => (clean(name, 40) || 'DR').substring(0, 2).toUpperCase();

function sha256Hex(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join('');
}

function pepper() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('PEPPER');
  if (!p) {
    p = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PEPPER', p);
  }
  return p;
}

function newToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function rateLimit(key, max, windowSec) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key) || 0);
  if (n >= max) throw new ApiError('rate_limited', 'Too many requests — slow down');
  cache.put(key, String(n + 1), Math.min(windowSec, 21600));
}

// ════════════════════════════════════════════════════════════
//  SHEETS (everything stored as plain text → no formula injection)
// ════════════════════════════════════════════════════════════
let _ss = null;
function getSS() {
  if (_ss) return _ss;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  if (id) { _ss = SpreadsheetApp.openById(id); return _ss; }
  _ss = SpreadsheetApp.create('Steeradar DB');
  props.setProperty('SHEET_ID', _ss.getId());
  return _ss;
}

function getSheet(name) {
  const ss = getSS();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const cols = SCHEMA[name];
    sh.getRange(1, 1, 1, cols.length).setNumberFormat('@').setValues([cols]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll(name) {
  const sh = getSheet(name);
  const last = sh.getLastRow();
  const cols = SCHEMA[name];
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return vals.map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = r[j] === undefined || r[j] === null ? '' : String(r[j]); });
    return o;
  });
}

function appendRow(name, obj) {
  const sh = getSheet(name);
  const cols = SCHEMA[name];
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, cols.length).setNumberFormat('@').setValues([cols.map(c => obj[c] == null ? '' : String(obj[c]))]);
}

function updateRow(name, rowIdx, obj) {
  const sh = getSheet(name);
  const cols = SCHEMA[name];
  const rng = sh.getRange(rowIdx, 1, 1, cols.length);
  const cur = rng.getValues()[0].map(v => (v == null ? '' : String(v)));
  cols.forEach((c, j) => { if (obj[c] !== undefined) cur[j] = String(obj[c]); });
  rng.setNumberFormat('@').setValues([cur]);
}

function deleteRow(name, rowIdx) {
  getSheet(name).deleteRow(rowIdx);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════
function findUser(phone) {
  return readAll('users').find(u => u.phone === String(phone)) || null;
}

function userByToken(body) {
  const phone = String(body.phone || '');
  const token = String(body.token || '');
  if (!isPhone(phone) || token.length < 32) return null;
  const hash = sha256Hex(token + pepper());
  const t = now();
  const s = readAll('sessions').find(x => x.tokenHash === hash && x.phone === phone && Number(x.expiresAt) > t);
  if (!s) return null;
  return findUser(phone);
}

function requireUser(body) {
  const u = userByToken(body);
  if (!u) throw new ApiError('unauthorized', 'Sign in required');
  return u;
}

function createSession(phone, device) {
  const token = newToken();
  appendRow('sessions', {
    tokenHash: sha256Hex(token + pepper()),
    phone,
    createdAt: now(),
    expiresAt: now() + SESSION_DAYS * 24 * 3600 * 1000,
    device: clean(device, 100),
  });
  return token;
}

function publicSelf(u) {
  return {
    phone: u.phone, email: u.email, name: u.name, username: u.username,
    vehicle: u.vehicle, vehicleType: u.vehicleType,
    avatarId: u.avatarId, vehiclePhotoId: u.vehiclePhotoId, platePhotoId: u.platePhotoId, upiQrId: u.upiQrId,
  };
}

function takeVerifiedOtp(phone, purpose) {
  const t = now();
  const rows = readAll('otps')
    .filter(o => o.phone === phone && o.purpose === purpose && !o.consumed && o.verifiedAt && t - Number(o.verifiedAt) < OTP_VERIFIED_TTL_MS)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  return rows[0] || null;
}

function dayKey() { return Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd'); }

// ════════════════════════════════════════════════════════════
//  ACTION HANDLERS
// ════════════════════════════════════════════════════════════
const H = {};

H.ping = () => 'pong';

// ─── OTP ───
H.sendOtp = (b) => {
  const phone = String(b.phone || '');
  const purpose = b.purpose === 'login' ? 'login' : 'register';
  let email = clean(b.email, 254).toLowerCase();
  if (!isPhone(phone)) throw new ApiError('bad_phone');
  if (!isEmail(email)) throw new ApiError('bad_email');

  const user = findUser(phone);
  if (purpose === 'register' && user) return { ok: false, error: 'phone_exists' };
  if (purpose === 'login') {
    if (!user) return { ok: false, error: 'not_registered' };
    email = user.email; // SECURITY: the code only ever goes to the registered address
  }

  const props = PropertiesService.getScriptProperties();
  const dk = 'otpday:' + dayKey();
  const sent = Number(props.getProperty(dk) || 0);
  if (sent >= OTP_DAILY_CAP) return { ok: false, error: 'too_many_requests' };
  try {
    rateLimit('otp:p:' + phone, 5, 3600);
    rateLimit('otp:e:' + email, 5, 3600);
  } catch (e) { return { ok: false, error: 'too_many_requests' }; }

  const t = now();
  const all = readAll('otps').filter(o => o.phone === phone);
  const recent = all.filter(o => t - Number(o.createdAt) < 60 * 1000);
  if (recent.length) return { ok: false, error: 'cooldown' };
  all.filter(o => !o.consumed).forEach(o => updateRow('otps', o._row, { consumed: '1' })); // invalidate older codes

  const code = String(parseInt(sha256Hex(Utilities.getUuid() + Utilities.getUuid()).slice(0, 8), 16) % 1000000).padStart(6, '0');
  appendRow('otps', {
    id: newToken().slice(0, 16), phone, email, purpose,
    codeHash: sha256Hex(phone + ':' + code + ':' + pepper()),
    createdAt: t, expiresAt: t + OTP_TTL_MS, attempts: 0, verifiedAt: '', consumed: '',
  });
  props.setProperty(dk, String(sent + 1));

  MailApp.sendEmail({
    to: email,
    subject: 'Your Steeradar code',
    body: 'Your Steeradar verification code is ' + code + '.\nIt expires in 10 minutes. If you did not ask for it, ignore this email.',
    noReply: true,
  });
  return { ok: true, sentTo: maskEmail(email) };
};

H.verifyOtp = (b) => {
  const phone = String(b.phone || '');
  const code = String(b.code || '');
  if (!isPhone(phone) || !/^\d{6}$/.test(code)) return { ok: false, error: 'bad_code' };
  const t = now();
  const row = readAll('otps')
    .filter(o => o.phone === phone && !o.consumed && Number(o.expiresAt) > t)
    .sort((a, b2) => Number(b2.createdAt) - Number(a.createdAt))[0];
  if (!row) return { ok: false, error: 'no_code' };
  const attempts = Number(row.attempts);
  if (attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: 'too_many_attempts', attemptsLeft: 0 };
  if (sha256Hex(phone + ':' + code + ':' + pepper()) !== row.codeHash) {
    updateRow('otps', row._row, { attempts: attempts + 1 });
    return { ok: false, error: 'wrong_code', attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts - 1) };
  }
  updateRow('otps', row._row, { verifiedAt: t });
  return { ok: true };
};

// ─── REGISTER / LOGIN ───
H.register = (b) => {
  const phone = String(b.phone || '');
  if (!isPhone(phone)) throw new ApiError('bad_phone');
  const otp = takeVerifiedOtp(phone, 'register');
  if (!otp) return { ok: false, error: 'not_verified' };
  const email = clean(b.email, 254).toLowerCase();
  if (email !== otp.email) return { ok: false, error: 'email_mismatch' }; // must be the address that got the code

  const name = clean(b.name, 40);
  const username = clean(b.username, 20);
  const vehicle = normVehicle(b.vehicle);
  const vehicleType = VEHICLE_TYPES.includes(b.vehicleType) ? b.vehicleType : 'car';
  if (!name) return { ok: false, error: 'bad_name' };
  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) return { ok: false, error: 'bad_username' };
  if (!isVehicle(vehicle)) return { ok: false, error: 'bad_vehicle' };

  const users = readAll('users');
  if (users.some(u => u.phone === phone)) return { ok: false, error: 'phone_exists' };
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return { ok: false, error: 'username_taken' };
  if (users.some(u => u.vehicle === vehicle)) return { ok: false, error: 'vehicle_taken' };

  appendRow('users', { phone, email, name, username, vehicle, vehicleType, createdAt: now(), device: clean(b.device, 100) });
  updateRow('otps', otp._row, { consumed: '1' });
  const token = createSession(phone, b.device);
  return { ok: true, token, user: publicSelf(findUser(phone)) };
};

H.login = (b) => {
  const phone = String(b.phone || '');
  if (!isPhone(phone)) throw new ApiError('bad_phone');
  const user = findUser(phone);
  if (!user) return { ok: false, error: 'not_registered' };
  const otp = takeVerifiedOtp(phone, 'login');
  if (!otp) return { ok: false, error: 'not_verified' };
  updateRow('otps', otp._row, { consumed: '1' });
  const token = createSession(phone, b.device);
  return { ok: true, token, user: publicSelf(user) };
};

H.logout = (b, u) => {
  const hash = sha256Hex(String(b.token) + pepper());
  readAll('sessions').filter(s => s.tokenHash === hash).reverse().forEach(s => deleteRow('sessions', s._row));
  return { ok: true };
};

H.checkSession = (b, u) => ({ valid: !!u });
H.getMe = (b, u) => ({ ok: true, user: publicSelf(u) });

H.updateMe = (b, u) => {
  const patch = {};
  if (b.name !== undefined) {
    const n = clean(b.name, 40);
    if (!n) return { ok: false, error: 'bad_name' };
    patch.name = n;
  }
  if (b.vehicle !== undefined) {
    const v = normVehicle(b.vehicle);
    if (!isVehicle(v)) return { ok: false, error: 'bad_vehicle' };
    if (v !== u.vehicle && readAll('users').some(x => x.vehicle === v)) return { ok: false, error: 'vehicle_taken' };
    patch.vehicle = v;
  }
  if (b.vehicleType !== undefined && VEHICLE_TYPES.includes(b.vehicleType)) patch.vehicleType = b.vehicleType;
  const tag = ownerTag(u.phone);
  [['avatarId', 'avatarId'], ['vehiclePhotoId', 'vehiclePhotoId'], ['platePhotoId', 'platePhotoId'], ['upiQrId', 'upiQrId']].forEach(([k]) => {
    if (b[k] === undefined) return;
    const id = String(b[k] || '');
    if (id === '') { patch[k] = ''; return; }
    if (!isId(id) || !fileOwnedBy(id, tag)) return; // silently ignore ids that aren't the caller's own uploads
    patch[k] = id;
  });
  updateRow('users', u._row, patch);
  return { ok: true, user: publicSelf(findUser(u.phone)) };
};

// ─── LANES ───
function publicLane(l, me) {
  const own = !!me && l.ownerPhone === me.phone;
  return {
    id: l.id, driver: l.driver, vehicle: l.vehicle, vehicleType: l.vehicleType,
    from: l.from, via: l.via, to: l.to, total: Number(l.total), taken: Number(l.taken), fare: Number(l.fare),
    // strangers get ~110 m precision; the owner sees their exact point
    lat: own ? round(l.lat, 7) : round(l.lat, 3), lng: own ? round(l.lng, 7) : round(l.lng, 3),
    status: l.status, ts: Number(l.ts), peerId: l.peerId, lastSeen: Number(l.lastSeen),
    showPlate: l.showPlate || 'true', own,
  };
}

function laneFields(row, user, existing) {
  const total = Math.round(toNum(row.total, 1, 60, existing ? Number(existing.total) : 4));
  const taken = Math.round(toNum(row.taken, 0, total, 0));
  const peerId = /^steeradar-veh-[A-Z0-9-]{4,24}$/.test(String(row.peerId || '')) ? row.peerId : '';
  return {
    driver: user.name,
    vehicle: user.vehicle,                     // plate always comes from the account, not the request
    vehicleType: VEHICLE_TYPES.includes(row.vehicleType) ? row.vehicleType : user.vehicleType,
    from: clean(row.from, 80), via: clean(row.via, 200), to: clean(row.to, 80),
    total, taken,
    fare: Math.round(toNum(row.fare, 0, 10000, 0)),
    lat: coord(row.lat, 90), lng: coord(row.lng, 180),
    status: row.status === 'full' ? 'full' : 'live',
    peerId,
    lastSeen: now(),
    showPlate: String(row.showPlate) === 'false' ? 'false' : 'true',
  };
}

H.listLanes = (b, u) => {
  const t = now();
  return readAll('lanes')
    .filter(l => t - Number(l.ts) < LANE_TTL_MS)
    .sort((a, c) => Number(c.ts) - Number(a.ts))
    .slice(0, 300)
    .map(l => publicLane(l, u));
};

H.insertLane = (b, u) => {
  const row = b.row || {};
  if (!isId(row.id)) throw new ApiError('bad_id');
  if (!clean(row.to, 80)) throw new ApiError('bad_destination');
  rateLimit('lane:' + u.phone, 20, 3600);
  const lanes = readAll('lanes');
  if (lanes.some(l => l.id === row.id)) throw new ApiError('exists');
  const mine = lanes.filter(l => l.ownerPhone === u.phone && now() - Number(l.ts) < LANE_TTL_MS);
  if (mine.length >= 5) throw new ApiError('lane_limit', 'You can have at most 5 live lanes');
  const f = laneFields(row, u, null);
  appendRow('lanes', Object.assign({ id: row.id, ownerPhone: u.phone, ts: now() }, f));
  return { ok: true, id: row.id };
};

function ownLane(id, u) {
  const l = readAll('lanes').find(x => x.id === String(id));
  if (!l) return null;
  if (l.ownerPhone !== u.phone) throw new ApiError('forbidden', 'Not your lane');
  return l;
}

H.updateLane = (b, u) => {
  const l = ownLane(b.id, u);
  if (!l) throw new ApiError('not_found');
  const f = laneFields(b.row || {}, u, l);
  updateRow('lanes', l._row, f);
  return { ok: true };
};

H.removeLane = (b, u) => {
  const l = ownLane(b.id, u);
  if (l) deleteRow('lanes', l._row);
  return { ok: true };
};

// ─── HIVE ───
function publicPost(p, me) {
  return {
    id: p.id, name: p.name, avatar: p.avatar, title: p.title, text: p.text, tags: p.tags,
    time: p.time, likes: Number(p.likes), ts: Number(p.ts), vehicle: p.vehicle,
    own: !!me && p.ownerPhone === me.phone,
  };
}

H.listHive = (b, u) => readAll('hive')
  .sort((a, c) => Number(c.ts) - Number(a.ts))
  .slice(0, 200)
  .map(p => publicPost(p, u));

H.insertHive = (b, u) => {
  const r = b.row || {};
  if (!isId(r.id)) throw new ApiError('bad_id');
  const title = clean(r.title, 80);
  const text = clean(String(r.text || '').replace(/\r/g, ''), 2000).trim() || title;
  if (!text) throw new ApiError('empty');
  rateLimit('hive:' + u.phone, 30, 3600);
  if (readAll('hive').some(p => p.id === r.id)) throw new ApiError('exists');
  const tags = String(r.tags || '').split('|').map(t => clean(t, 24)).filter(Boolean).slice(0, 5).join('|');
  appendRow('hive', {
    id: r.id, ownerPhone: u.phone, name: u.name, avatar: initials(u.name),
    title, text, tags, time: 'just now', likes: 0, ts: now(), vehicle: u.vehicle,
  });
  return { ok: true, id: r.id };
};

function ownPost(id, u) {
  const p = readAll('hive').find(x => x.id === String(id));
  if (!p) throw new ApiError('not_found');
  if (p.ownerPhone !== u.phone) throw new ApiError('forbidden', 'Not your post');
  return p;
}

H.updateHive = (b, u) => {
  const p = ownPost(b.id, u);
  const r = b.row || {};
  const patch = {};
  if (r.title !== undefined) patch.title = clean(r.title, 80);
  if (r.text !== undefined) patch.text = clean(r.text, 2000);
  if (r.tags !== undefined) patch.tags = String(r.tags).split('|').map(t => clean(t, 24)).filter(Boolean).slice(0, 5).join('|');
  updateRow('hive', p._row, patch);
  return { ok: true };
};

H.deleteHive = (b, u) => {
  const p = ownPost(b.id, u);
  deleteRow('hive', p._row);
  readAll('likes').filter(l => l.postId === p.id).reverse().forEach(l => deleteRow('likes', l._row));
  return { ok: true };
};

H.like = (b, u) => {
  const id = String(b.id || '');
  if (!isId(id)) throw new ApiError('bad_id');
  rateLimit('like:' + u.phone, 120, 3600);
  const p = readAll('hive').find(x => x.id === id);
  if (!p) throw new ApiError('not_found');
  const key = id + '|' + u.phone;
  const existing = readAll('likes').find(l => l.key === key);
  let likes = Number(p.likes) || 0;
  if (Number(b.delta) > 0 && !existing) { appendRow('likes', { key, postId: id, phone: u.phone }); likes += 1; }
  else if (Number(b.delta) < 0 && existing) { deleteRow('likes', existing._row); likes = Math.max(0, likes - 1); }
  updateRow('hive', p._row, { likes });
  return { likes };
};

// ─── MESSAGES (private rooms only) ───
function checkRoom(roomId, u) {
  const id = String(roomId || '');
  const dm = /^dm-([A-Z0-9]{4,15})-([A-Z0-9]{4,15})$/.exec(id);
  if (dm) {
    if (u.vehicle !== dm[1] && u.vehicle !== dm[2]) throw new ApiError('forbidden', 'Not your conversation');
    return id;
  }
  if (/^local-[0-9a-z]{4,8}$/.test(id)) return id; // neighbourhood room — any signed-in user
  throw new ApiError('bad_room');
}

H.sendMessage = (b, u) => {
  const r = b.row || {};
  const roomId = checkRoom(r.roomId, u);
  const text = clean(r.text, 1000);
  if (!text) throw new ApiError('empty');
  rateLimit('msg:' + u.phone, 40, 60);
  appendRow('messages', {
    id: isId(r.id) ? r.id : 'm-' + newToken().slice(0, 12),
    roomId, fromVehicle: u.vehicle, fromPhone: u.phone,
    sender: u.name, text, ts: now(),      // identity + time are stamped by the server
  });
  return { ok: true };
};

H.getMessages = (b, u) => {
  const roomId = checkRoom(b.roomId, u);
  const limit = Math.round(toNum(b.limit, 1, 100, 50));
  return readAll('messages')
    .filter(m => m.roomId === roomId)
    .sort((a, c) => Number(a.ts) - Number(c.ts))
    .slice(-limit)
    .map(m => ({ id: m.id, roomId: m.roomId, from: m.fromVehicle, sender: m.sender, text: m.text, ts: Number(m.ts) }));
};

// ─── PRESENCE ───
H.updatePresence = (b, u) => {
  const r = b.row || {};
  rateLimit('pres:' + u.phone, 12, 60);
  const obj = {
    vehicle: u.vehicle, phone: u.phone, name: u.name, avatar: initials(u.name),
    peerId: /^steeradar-veh-[A-Z0-9-]{4,24}$/.test(String(r.peerId || '')) ? r.peerId : '',
    vehicleType: VEHICLE_TYPES.includes(r.vehicleType) ? r.vehicleType : u.vehicleType,
    lat: round(coord(r.lat, 90), 5), lng: round(coord(r.lng, 180), 5),
    lastSeen: now(),
  };
  const ex = readAll('presence').find(p => p.vehicle === u.vehicle);
  if (ex) updateRow('presence', ex._row, obj); else appendRow('presence', obj);
  return { ok: true };
};

H.activeVehicles = (b, u) => {
  const t = now();
  return readAll('presence')
    .filter(p => t - Number(p.lastSeen) < PRESENCE_TTL_MS)
    .slice(0, 200)
    .map(p => ({
      vehicle: p.vehicle, name: p.name, avatar: p.avatar, peerId: p.peerId, vehicleType: p.vehicleType,
      lat: p.lat === '' ? '' : Number(p.lat), lng: p.lng === '' ? '' : Number(p.lng), lastSeen: Number(p.lastSeen),
    }));
};

H.removePresence = (b, u) => {
  readAll('presence').filter(p => p.vehicle === u.vehicle).reverse().forEach(p => deleteRow('presence', p._row));
  return { ok: true };
};

// ─── TRIPS ───
H.startTrip = (b, u) => {
  rateLimit('trip:' + u.phone, 30, 3600);
  const id = 't-' + newToken().slice(0, 12);
  appendRow('trips', { id, phone: u.phone, laneId: isId(b.laneId) ? b.laneId : '', startTs: now() });
  return { ok: true, id };
};

H.endTrip = (b, u) => {
  const t = readAll('trips').find(x => x.id === String(b.id) && x.phone === u.phone);
  if (!t) throw new ApiError('not_found');
  updateRow('trips', t._row, {
    endTs: now(),
    distance: toNum(b.distance, 0, 5000000, 0),
    fare: toNum(b.fare, 0, 100000, 0),
    rating: Math.round(toNum(b.rating, 0, 5, 0)),
  });
  return { ok: true };
};

H.myTrips = (b, u) => readAll('trips').filter(t => t.phone === u.phone).slice(-100);

// ─── IMAGES (private Drive files, owner-tagged) ───
const ownerTag = (phone) => 'owner:' + sha256Hex(phone + ':' + pepper()).slice(0, 24);

function fileOwnedBy(fileId, tag) {
  try { return DriveApp.getFileById(fileId).getDescription() === tag; } catch (e) { return false; }
}

function getFolder(name, parent) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

H.uploadImage = (b, u) => {
  rateLimit('img:' + u.phone, 12, 21600);
  const data = String(b.base64 || '');
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) throw new ApiError('bad_image', 'JPEG only');
  if (data.length > 900000) throw new ApiError('too_large', 'Image too large');
  const slot = String(b.folder || '').split('/').pop();
  if (!PHOTO_SLOTS.includes(slot)) throw new ApiError('bad_slot');
  const bytes = Utilities.base64Decode(m[1]);
  const blob = Utilities.newBlob(bytes, 'image/jpeg', slot + '_' + now() + '.jpg');
  const root = getFolder('Steeradar Uploads', DriveApp.getRootFolder());
  const mine = getFolder(sha256Hex(u.phone + pepper()).slice(0, 16), root);
  const file = mine.createFile(blob);
  file.setDescription(ownerTag(u.phone));
  // Intentionally NOT shared: files stay private to the script owner's Drive.
  return { fileId: file.getId(), url: '' };
};

H.deleteImage = (b, u) => {
  const id = String(b.fileId || '');
  if (!isId(id) || !fileOwnedBy(id, ownerTag(u.phone))) throw new ApiError('forbidden');
  DriveApp.getFileById(id).setTrashed(true);
  return { ok: true };
};

// ─── DIAGNOSTICS (signed-in only; counts, no secrets, no sheet URL) ───
H.debug = () => ({
  version: VERSION,
  users: readAll('users').length,
  lanes: readAll('lanes').length,
  hive: readAll('hive').length,
});

// ════════════════════════════════════════════════════════════
//  ROUTER
// ════════════════════════════════════════════════════════════
// auth: 'none' | 'optional' (adds `own` flags) | 'required'.  write: serialise with a lock.
const ROUTES = {
  ping:           { auth: 'none' },
  sendOtp:        { auth: 'none', write: true },
  verifyOtp:      { auth: 'none', write: true },
  register:       { auth: 'none', write: true },
  login:          { auth: 'none', write: true },
  checkSession:   { auth: 'optional' },
  listLanes:      { auth: 'optional' },
  listHive:       { auth: 'optional' },
  logout:         { auth: 'required', write: true },
  getMe:          { auth: 'required' },
  updateMe:       { auth: 'required', write: true },
  insertLane:     { auth: 'required', write: true },
  updateLane:     { auth: 'required', write: true },
  removeLane:     { auth: 'required', write: true },
  insertHive:     { auth: 'required', write: true },
  updateHive:     { auth: 'required', write: true },
  deleteHive:     { auth: 'required', write: true },
  like:           { auth: 'required', write: true },
  getMessages:    { auth: 'required' },
  sendMessage:    { auth: 'required', write: true },
  updatePresence: { auth: 'required', write: true },
  activeVehicles: { auth: 'required' },
  removePresence: { auth: 'required', write: true },
  startTrip:      { auth: 'required', write: true },
  endTrip:        { auth: 'required', write: true },
  myTrips:        { auth: 'required' },
  uploadImage:    { auth: 'required', write: true },
  deleteImage:    { auth: 'required', write: true },
  debug:          { auth: 'required' },
};

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return out({ ok: true, service: 'steeradar', version: VERSION });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > MAX_BODY_CHARS) throw new ApiError('bad_request');
    let body;
    try { body = JSON.parse(raw); } catch (x) { throw new ApiError('bad_json'); }
    if (!body || typeof body !== 'object') throw new ApiError('bad_request');

    const action = String(body.action || '');
    const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action] : null;
    if (!route) throw new ApiError('unknown_action');

    const run = () => {
      let user = null;
      if (route.auth === 'required') user = requireUser(body);
      else if (route.auth === 'optional') user = userByToken(body);
      return H[action](body, user);
    };
    const data = route.write ? withLock(run) : run();
    return out({ data });
  } catch (err) {
    if (err instanceof ApiError) return out({ error: err.code, message: err.message === err.code ? undefined : err.message });
    Logger.log('steeradar error: ' + (err && err.stack ? err.stack : err));
    return out({ error: 'server_error' });
  }
}

// ════════════════════════════════════════════════════════════
//  ONE-TIME SETUP + MAINTENANCE (run from the editor)
// ════════════════════════════════════════════════════════════
/** Run once: creates the sheet + all tabs, generates the private pepper, installs the cleanup trigger. */
function setup() {
  pepper();
  Object.keys(SCHEMA).forEach(getSheet);
  installTriggers();
  Logger.log('Sheet URL: ' + getSS().getUrl());
  Logger.log('Now: Deploy → New deployment → Web app → Execute as: Me, Access: Anyone. Paste the /exec URL into config.js.');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'cleanup').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(3).create();
}

/** Daily: drop expired sessions/OTPs, stale presence, old lanes and 30-day-old messages. */
function cleanup() {
  withLock(() => {
    const t = now();
    const prune = (name, keep) => readAll(name).filter(r => !keep(r)).reverse().forEach(r => deleteRow(name, r._row));
    prune('sessions', s => Number(s.expiresAt) > t);
    prune('otps', o => Number(o.expiresAt) + 24 * 3600 * 1000 > t);
    prune('presence', p => t - Number(p.lastSeen) < 24 * 3600 * 1000);
    prune('lanes', l => t - Number(l.ts) < 7 * LANE_TTL_MS);
    prune('messages', m => t - Number(m.ts) < 30 * 24 * 3600 * 1000);
  });
}
