/**
 * Steeradar backend — v8.2
 * Clean, verified, welcome email with personal note from SteerMan
 */

const VERSION = '8.2';
const APP_NAME = 'Steeradar';
const APP_URL = 'https://suryasticsai.github.io/Steeradar/';
const LOGO_URL = 'https://raw.githubusercontent.com/suryasticsai/Steeradar/main/steerardar-logo.png';
const TEAL = '#0D9488';
const TEAL2 = '#14B8A6';
const CORAL = '#DC2626';
const INK = '#111827';
const MUTED = '#4B5563';
const SOFT = '#9CA3AF';

const SESSION_DAYS = 90;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_VERIFIED_TTL_MS = 15 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_DAILY_CAP = 80;
const OTP_COOLDOWN_MS = 45000;
const LANE_TTL_MS = 24 * 3600 * 1000;
const PRESENCE_TTL_MS = 2 * 60 * 1000;
const MAX_BODY_CHARS = 1200000;
const VEHICLE_TYPES = ['bus', 'car', 'auto', 'bike', 'walk', 'event'];
const PHOTO_SLOTS = ['avatar', 'vehiclePhoto', 'platePhoto', 'upiQr'];

const SCHEMA = {
  users:      ['phone','email','name','username','vehicle','vehicleType',
               'avatarId','vehiclePhotoId','platePhotoId','upiQrId',
               'community','role','status',
               'laneCount','tripCount','ratingSum','ratingCount',
               'createdAt','lastLogin','device'],
  sessions:   ['tokenHash','phone','type','createdAt','expiresAt','device','lastSeen'],
  magic:      ['tokenHash','phone','createdAt','expiresAt','consumed'],
  otps:       ['id','phone','email','purpose','codeHash','createdAt',
               'expiresAt','attempts','verifiedAt','consumed'],
  lanes:      ['id','ownerPhone','driver','vehicle','vehicleType','community',
               'from','via','to','total','taken','fare','lat','lng',
               'status','ts','peerId','lastSeen','showPlate'],
  hive:       ['id','ownerPhone','name','avatar','community',
               'title','text','tags','time','likes','ts','vehicle'],
  likes:      ['key','postId','phone','ts'],
  messages:   ['id','roomId','roomType','fromVehicle','fromPhone',
               'sender','text','seq','ts'],
  presence:   ['vehicle','phone','name','avatar','peerId','vehicleType',
               'lat','lng','lastSeen'],
  trips:      ['id','phone','laneId','driverPhone','startTs','endTs',
               'distance','fare','status','notes'],
  ratings:    ['id','tripId','fromPhone','toPhone','stars','comment','ts'],
  reports:    ['id','reporterPhone','targetPhone','targetVehicle',
               'reason','detail','status','ts','resolvedAt'],
  blocks:     ['ownerPhone','blockedPhone','ts'],
  communities:['id','name','city','adminPhone','memberCount','createdAt','status'],
  members:    ['community','phone','joinedAt'],
  audit:      ['ts','phone','action','detail'],
};

class ApiError extends Error {
  constructor(code, message, retry) {
    super(message || code);
    this.code = code;
    this.retry = retry || null;
  }
}

// ─── Utilities ───
function now() { return Date.now(); }

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function isId(v) { return /^[A-Za-z0-9_-]{1,64}$/.test(String(v || '')); }
function isPhone(v) { return /^\d{10}$/.test(String(v || '')); }
function isEmail(v) { return /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/.test(String(v || '')); }
function isVehicle(v) { return /^[A-Z0-9]{4,15}$/.test(String(v || '')); }
function normVehicle(v) { return String(v || '').replace(/[\s-]/g, '').toUpperCase(); }

function toNum(v, min, max, dflt) {
  const n = Number(v);
  return isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function coord(v, lim) {
  if (v === '' || v == null) return '';
  const n = Number(v);
  return isFinite(n) && Math.abs(n) <= lim ? n : '';
}

function round(v, d) {
  if (v === '' || v == null || !isFinite(Number(v))) return '';
  return Number(Number(v).toFixed(d));
}

function initials(name) { return (clean(name, 40) || 'DR').substring(0, 2).toUpperCase(); }
function maskEmail(e) { return String(e).replace(/^(.).*(@.*)$/, '$1***$2'); }

function sha256Hex(s) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(s),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) {
    return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join('');
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

function shortId(prefix) {
  return prefix + '-' + newToken().slice(0, 12);
}

function todayKey() {
  return Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd');
}

function rateLimit(keys, max, windowSec) {
  const cache = CacheService.getScriptCache();
  const arr = Array.isArray(keys) ? keys : [keys];
  for (let i = 0; i < arr.length; i++) {
    const n = Number(cache.get(arr[i]) || 0);
    if (n >= max) throw new ApiError('rate_limited', 'Too many requests', 60);
  }
  for (let i = 0; i < arr.length; i++) {
    const n = Number(cache.get(arr[i]) || 0);
    cache.put(arr[i], String(n + 1), Math.min(windowSec, 21600));
  }
}

// ─── Sheets ───
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
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
  }
  return sh;
}

function readAll(name) {
  const sh = getSheet(name);
  const last = sh.getLastRow();
  const cols = SCHEMA[name];
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, cols.length).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const o = { _row: i + 2 };
    for (let j = 0; j < cols.length; j++) {
      const v = vals[i][j];
      o[cols[j]] = v === undefined || v === null ? '' : String(v);
    }
    out.push(o);
  }
  return out;
}

function appendRow(name, obj) {
  const sh = getSheet(name);
  const cols = SCHEMA[name];
  const r = sh.getLastRow() + 1;
  const values = cols.map(function (c) { return obj[c] == null ? '' : String(obj[c]); });
  sh.getRange(r, 1, 1, cols.length).setNumberFormat('@').setValues([values]);
}

function updateRow(name, rowIdx, obj) {
  const sh = getSheet(name);
  const cols = SCHEMA[name];
  const rng = sh.getRange(rowIdx, 1, 1, cols.length);
  const cur = rng.getValues()[0].map(function (v) { return v == null ? '' : String(v); });
  for (let j = 0; j < cols.length; j++) {
    if (obj[cols[j]] !== undefined) cur[j] = String(obj[cols[j]]);
  }
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

// ─── Email building blocks ───
function emailHeader() {
  const lines = [
    '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F3F6;padding:32px 16px;">',
    '<tr><td align="center">',
    '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#FFFFFF;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">',
    '<tr><td align="center" style="background:linear-gradient(135deg,' + TEAL + ' 0%,' + TEAL2 + ' 100%);padding:36px 24px 28px;">',
    '<img src="' + LOGO_URL + '" alt="' + APP_NAME + '" width="84" height="84" style="display:block;border-radius:50%;border:3px solid rgba(255,255,255,0.3);background:#FFFFFF;object-fit:cover;">',
    '<div style="color:#FFFFFF;font-size:24px;font-weight:800;letter-spacing:-0.5px;margin-top:14px;">Steer<span>adar</span><span style="color:' + CORAL + ';">.</span></div>',
    '<div style="color:rgba(255,255,255,0.85);font-size:11px;margin-top:6px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;">Community rides</div>',
    '</td></tr>',
    '<tr><td style="padding:36px 32px;color:' + INK + ';">'
  ];
  return lines.join('');
}

function emailFooter() {
  const lines = [
    '</td></tr>',
    '<tr><td style="padding:24px 32px 32px;border-top:1px solid #E5E7EB;background:#F8F9FB;">',
    '<div style="text-align:center;color:#9CA3AF;font-size:12px;line-height:1.6;">',
    '<div style="font-weight:700;color:#6B7280;margin-bottom:6px;">Thank you for riding with us 🚌</div>',
    '<div>' + APP_NAME + ' · ' + new Date().getFullYear() + '</div>',
    '<div style="margin-top:14px;font-size:11px;">',
    '<a href="' + APP_URL + '" style="color:' + TEAL + ';text-decoration:none;font-weight:700;">Visit Steeradar</a>',
    '</div>',
    '<div style="margin-top:18px;font-size:10px;color:#B4BAC6;">If you didn\'t request this email, you can safely ignore it.</div>',
    '</div></td></tr>',
    '</table></td></tr></table>'
  ];
  return lines.join('');
}

function emailShell(bodyHtml) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#F1F3F6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">'
    + emailHeader()
    + bodyHtml
    + emailFooter()
    + '</body></html>';
}

function rowKV(label, value, accent) {
  const color = accent ? CORAL : INK;
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;"><tr>'
    + '<td style="color:' + SOFT + ';font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:700;padding:4px 0;">' + escapeHtml(label) + '</td>'
    + '<td style="color:' + color + ';font-size:14px;font-weight:700;text-align:right;padding:4px 0;">' + escapeHtml(String(value)) + '</td>'
    + '</tr></table>';
}

function featureTile(emoji, title, sub) {
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">'
    + '<tr><td style="padding:14px 0;border-bottom:1px solid #E5E7EB;">'
    + '<table cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td style="width:40px;font-size:22px;">' + emoji + '</td>'
    + '<td style="padding-left:12px;color:' + MUTED + ';font-size:14px;line-height:1.55;"><strong style="color:' + INK + ';">' + title + '</strong><br>' + sub + '</td>'
    + '</tr></table></td></tr></table>';
}

// ─── Email templates ───
function buildOtp(code, purpose) {
  const heading = purpose === 'login' ? 'Welcome back!' : 'Welcome to Steeradar!';
  const sub = purpose === 'login'
    ? 'Use this code to sign back in to your account.'
    : 'Use this code to verify your email and get started.';

  const body = '<h1 style="margin:0 0 10px;color:' + INK + ';font-size:24px;font-weight:800;letter-spacing:-0.4px;">' + heading + '</h1>'
    + '<p style="margin:0 0 26px;color:' + MUTED + ';font-size:15px;line-height:1.6;">' + sub + '</p>'
    + '<div style="background:#F1F3F6;border-radius:14px;padding:28px 16px;text-align:center;margin:0 0 24px;">'
    + '<div style="color:' + MUTED + ';font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;margin-bottom:12px;">Your verification code</div>'
    + '<div style="font-family:\'SF Mono\',\'Courier New\',monospace;font-size:42px;font-weight:800;letter-spacing:12px;color:' + INK + ';line-height:1;">' + code + '</div>'
    + '</div>'
    + '<p style="margin:0;color:' + SOFT + ';font-size:13px;line-height:1.7;">⏱️ This code expires in <strong>10 minutes</strong></p>'
    + '<p style="margin:20px 0 0;color:' + SOFT + ';font-size:13px;line-height:1.6;">Never share this code with anyone.</p>';

  return emailShell(body);
}

/**
 * Beautiful personalized welcome email with personal note from SteerMan.
 */
function buildWelcome(email, name, vehicle, community, phone) {
  const firstName = escapeHtml((name || 'Driver').split(' ')[0]);
  const safeEmail = escapeHtml(email || '');
  const safePhone = escapeHtml(phone || '');
  const safeVehicle = escapeHtml(vehicle || '');
  const safeCommunity = escapeHtml(community || 'Not specified');

  // Personal Note from SteerMan
  const personalNoteHTML = `
    <div style="margin: 28px 0; padding: 20px; border-left: 4px solid ${CORAL}; background: linear-gradient(135deg, #FEF2F2 0%, #FFF5F5 100%); border-radius: 0 10px 10px 0;">
      <div style="display:block; margin-bottom:12px;">
        <span style="display:inline-block; background:${CORAL}; color:#FFFFFF; font-size:10px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; padding:5px 12px; border-radius:20px;">💌 Personal Note</span>
      </div>
      <p style="margin: 0; color: ${INK}; font-size: 15px; line-height: 1.7; font-style: italic;">
        "Hey ${firstName}, I'm absolutely thrilled to welcome you to the Steeradar family! This platform was built for drivers, by drivers. Our goal is to make your daily commute safer, more connected, and more rewarding. If you ever have a suggestion or just want to chat, the Hive is the place to be. Happy driving!"
      </p>
      <p style="margin: 14px 0 0; color: ${MUTED}; font-size: 13px; font-weight: 700; text-align: right;">
        — SteerMan<br>
        <span style="font-weight: 400; font-size: 11px; color: ${SOFT};">Maker of Steeradar</span>
      </p>
    </div>
  `;

  // User Details Section
  const userDetailsHTML = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0 0; background:#F8F9FB; border-radius:14px; border: 1px solid #E5E7EB;">
      <tr><td style="padding: 20px 22px;">
        <div style="color: ${TEAL}; font-size: 11px; font-weight: 800; letter-spacing: 1.6px; text-transform: uppercase; margin-bottom: 16px;">📋 Your Account Details</div>
        ${rowKV('Name', name)}
        ${rowKV('User Type', 'RearAgent')}
        ${rowKV('User ID (Phone)', safePhone, true)}
        ${rowKV('Email', safeEmail)}
        ${rowKV('Vehicle', safeVehicle)}
        ${rowKV('Community', safeCommunity)}
      </td></tr>
    </table>
  `;

  // Thank You Section
  const thankYouHTML = `
    <div style="margin: 28px 0 0; padding: 20px; text-align: center; background: linear-gradient(135deg, ${TEAL} 0%, ${TEAL2} 100%); border-radius: 12px;">
      <p style="margin: 0; color: #FFFFFF; font-size: 16px; font-weight: 700; line-height: 1.5;">
        🙏 Thank you for joining our community!
      </p>
      <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 13px; line-height: 1.6;">
        We're excited to have you on board. Let's make every ride memorable.
      </p>
    </div>
  `;

  // Assemble Full Body
  const body = `
    <h1 style="margin:0 0 10px;color:${INK};font-size:26px;font-weight:800;letter-spacing:-0.4px;">Welcome aboard, ${firstName}! 🎉</h1>
    <p style="margin:0 0 26px;color:${MUTED};font-size:15px;line-height:1.6;">
      Your Steeradar account is ready${community ? ' in <strong style="color:' + INK + ';">' + escapeHtml(community) + '</strong>' : ''}. Here's what you can do now:
    </p>
    
    ${featureTile('🚌', 'Post your lane', 'Share your route and available seats')}
    ${featureTile('💬', 'Chat with drivers', 'Real-time peer-to-peer messaging')}
    ${featureTile('📍', 'Track live', 'See vehicles approaching in real time')}
    ${featureTile('⭐', 'Build trust', 'Rate and get rated after each ride')}
    
    ${personalNoteHTML}
    ${userDetailsHTML}
    ${thankYouHTML}
    
    <p style="margin: 24px 0 0; color: ${SOFT}; font-size: 12px; line-height: 1.7; text-align: center;">
      Need help? Just reply to this email or find us in the Hive.<br>
      We're always here for you.
    </p>
  `;

  return emailShell(body);
}

function buildReceipt(driver, from, to, distance, fare, duration) {
  const body = '<h1 style="margin:0 0 10px;color:' + INK + ';font-size:24px;font-weight:800;letter-spacing:-0.4px;">Trip receipt 🧾</h1>'
    + '<p style="margin:0 0 24px;color:' + MUTED + ';font-size:15px;line-height:1.6;">Thanks for completing your trip.</p>'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8F9FB;border-radius:14px;margin-bottom:22px;"><tr><td style="padding:18px;">'
    + rowKV('Driver', driver)
    + rowKV('Pickup', from)
    + rowKV('Drop-off', to)
    + rowKV('Distance', distance)
    + rowKV('Duration', duration)
    + rowKV('Fare', '₹ ' + fare, true)
    + '</td></tr></table>';

  return emailShell(body);
}

function buildRateRequest(driver, url) {
  const body = '<h1 style="margin:0 0 10px;color:' + INK + ';font-size:24px;font-weight:800;letter-spacing:-0.4px;">How was your ride? ⭐</h1>'
    + '<p style="margin:0 0 24px;color:' + MUTED + ';font-size:15px;line-height:1.6;">Rate your experience with ' + escapeHtml(driver) + '</p>'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr><td align="center">'
    + '<a href="' + url + '" style="display:inline-block;background:' + TEAL + ';color:#FFFFFF;font-weight:800;font-size:15px;padding:14px 36px;border-radius:12px;text-decoration:none;">Rate now</a>'
    + '</td></tr></table>';

  return emailShell(body);
}

function buildReportAck() {
  const body = '<h1 style="margin:0 0 10px;color:' + INK + ';font-size:24px;font-weight:800;letter-spacing:-0.4px;">We received your report 🛡️</h1>'
    + '<p style="margin:0 0 20px;color:' + MUTED + ';font-size:15px;line-height:1.6;">Our moderators will review it shortly.</p>'
    + '<p style="margin:0;color:' + SOFT + ';font-size:13px;">We take community safety seriously.</p>';

  return emailShell(body);
}

// ─── Send mail ───
function sendMail(to, subject, html, plain) {
  try {
    MailApp.sendEmail({
      to: to,
      subject: subject,
      htmlBody: html,
      body: plain || subject,
      name: APP_NAME,
      noReply: true
    });
    return true;
  } catch (e) {
    Logger.log('Mail failed: ' + e);
    return false;
  }
}

function sendOtpEmail(to, code, purpose) {
  const subject = '🔐 Your Steeradar code: ' + code;
  const plain = 'Your Steeradar code is ' + code + '. Expires in 10 minutes.';
  return sendMail(to, subject, buildOtp(code, purpose), plain);
}

function sendWelcomeEmail(to, name, vehicle, community, phone, email) {
  const subject = '🎉 Welcome to Steeradar, ' + ((name || '').split(' ')[0] || 'friend') + '!';
  const plain = 'Welcome ' + name + '! Your vehicle ' + vehicle + ' is now linked to Steeradar. User ID: ' + phone + '. Thanks for joining!';
  return sendMail(to, subject, buildWelcome(email || to, name, vehicle, community, phone), plain);
}

function sendReceiptEmail(to, driver, from, to_, distance, fare, duration) {
  const subject = '🧾 Your Steeradar trip receipt';
  const plain = 'Trip receipt: ₹' + fare + ' for ' + distance + '.';
  return sendMail(to, subject, buildReceipt(driver, from, to_, distance, fare, duration), plain);
}

function sendRateRequestEmail(to, driver, url) {
  const subject = '⭐ How was your Steeradar ride?';
  const plain = 'Rate your ride with ' + driver + ': ' + url;
  return sendMail(to, subject, buildRateRequest(driver, url), plain);
}

function sendReportAckEmail(to) {
  const subject = '🛡️ We received your Steeradar report';
  const plain = 'We received your report and will review it shortly.';
  return sendMail(to, subject, buildReportAck(), plain);
}

// ─── Auth ───
function findUser(phone) {
  const users = readAll('users');
  for (let i = 0; i < users.length; i++) {
    if (users[i].phone === String(phone)) return users[i];
  }
  return null;
}

function findUserByVehicle(vehicle) {
  const users = readAll('users');
  for (let i = 0; i < users.length; i++) {
    if (users[i].vehicle === String(vehicle)) return users[i];
  }
  return null;
}

function userByToken(body) {
  const phone = String(body.phone || '');
  const token = String(body.token || '');
  if (!isPhone(phone) || token.length < 32) return null;
  const hash = sha256Hex(token + pepper());
  const sessions = readAll('sessions');
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.tokenHash === hash && s.phone === phone && Number(s.expiresAt) > now()) {
      if (now() - Number(s.lastSeen || 0) > 60000) {
        try { updateRow('sessions', s._row, { lastSeen: now() }); } catch (e) {}
      }
      return findUser(phone);
    }
  }
  return null;
}

function requireUser(body) {
  const u = userByToken(body);
  if (!u) throw new ApiError('unauthorized', 'Sign in required');
  if (u.status === 'banned') throw new ApiError('banned', 'Account suspended');
  return u;
}

function createSession(phone, device) {
  const token = newToken();
  const t = now();
  appendRow('sessions', {
    tokenHash: sha256Hex(token + pepper()),
    phone: phone,
    type: 'access',
    createdAt: t,
    expiresAt: t + SESSION_DAYS * 24 * 3600 * 1000,
    device: clean(device, 100),
    lastSeen: t
  });
  return token;
}

function publicSelf(u) {
  return {
    phone: u.phone,
    email: u.email,
    name: u.name,
    username: u.username,
    vehicle: u.vehicle,
    vehicleType: u.vehicleType,
    avatarId: u.avatarId,
    vehiclePhotoId: u.vehiclePhotoId,
    platePhotoId: u.platePhotoId,
    upiQrId: u.upiQrId,
    community: u.community || '',
    role: u.role || 'user',
    rating: Number(u.ratingCount) > 0
      ? Math.round((Number(u.ratingSum) / Number(u.ratingCount)) * 10) / 10
      : 5.0
  };
}

function takeVerifiedOtp(phone, purpose) {
  const t = now();
  const rows = readAll('otps');
  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i];
    if (o.phone === phone && o.purpose === purpose && !o.consumed && o.verifiedAt &&
        t - Number(o.verifiedAt) < OTP_VERIFIED_TTL_MS) {
      candidates.push(o);
    }
  }
  candidates.sort(function (a, b) { return Number(b.createdAt) - Number(a.createdAt); });
  return candidates[0] || null;
}

function logAudit(phone, action, detail) {
  try {
    appendRow('audit', {
      ts: now(),
      phone: phone || '',
      action: action || '',
      detail: clean(detail, 500)
    });
  } catch (e) {}
}

function safeQuota() {
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return -1; }
}

// ═══════════════════════════════════════════════════
//  HANDLERS
// ═══════════════════════════════════════════════════
const H = {};

H.ping = function () { return 'pong'; };

H.debug = function (b, u) {
  const counts = {};
  const names = Object.keys(SCHEMA);
  for (let i = 0; i < names.length; i++) {
    try { counts[names[i]] = readAll(names[i]).length; }
    catch (e) { counts[names[i]] = -1; }
  }
  return {
    version: VERSION,
    user: u.name,
    counts: counts,
    mailQuota: safeQuota()
  };
};

H.sendOtp = function (b) {
  const phone = String(b.phone || '');
  const purpose = b.purpose === 'login' ? 'login' : 'register';
  let email = clean(b.email, 254).toLowerCase();

  if (!isPhone(phone)) throw new ApiError('bad_phone');
  if (!isEmail(email)) throw new ApiError('bad_email');

  const user = findUser(phone);
  if (purpose === 'register' && user) return { ok: false, error: 'phone_exists' };
  if (purpose === 'login') {
    if (!user) return { ok: false, error: 'not_registered' };
    email = user.email;
  }

  const props = PropertiesService.getScriptProperties();
  const dk = 'otpday:' + todayKey();
  const sent = Number(props.getProperty(dk) || 0);
  if (sent >= OTP_DAILY_CAP) return { ok: false, error: 'too_many_requests', retry: 3600 };

  try { rateLimit(['otp:p:' + phone, 'otp:e:' + email], 5, 3600); }
  catch (e) { return { ok: false, error: 'too_many_requests', retry: 60 }; }

  const t = now();
  const all = readAll('otps').filter(function (o) { return o.phone === phone; });
  const recent = all.filter(function (o) { return t - Number(o.createdAt) < OTP_COOLDOWN_MS; });
  if (recent.length) {
    return {
      ok: false,
      error: 'cooldown',
      wait: Math.ceil((OTP_COOLDOWN_MS - (t - Number(recent[0].createdAt))) / 1000)
    };
  }

  for (let i = 0; i < all.length; i++) {
    if (!all[i].consumed) {
      try { updateRow('otps', all[i]._row, { consumed: '1' }); } catch (e) {}
    }
  }

  const hash = sha256Hex(Utilities.getUuid() + Utilities.getUuid());
  const code = String(parseInt(hash.slice(0, 8), 16) % 1000000).padStart(6, '0');

  appendRow('otps', {
    id: shortId('otp'),
    phone: phone,
    email: email,
    purpose: purpose,
    codeHash: sha256Hex(phone + ':' + code + ':' + pepper()),
    createdAt: t,
    expiresAt: t + OTP_TTL_MS,
    attempts: 0,
    verifiedAt: '',
    consumed: ''
  });

  props.setProperty(dk, String(sent + 1));

  const mailOk = sendOtpEmail(email, code, purpose);
  if (!mailOk) {
    try { CacheService.getScriptCache().remove('otp:p:' + phone); } catch (e) {}
    return { ok: false, error: 'email_failed', retry: 300 };
  }

  logAudit(phone, 'sendOtp', purpose);
  return { ok: true, sentTo: maskEmail(email) };
};

H.verifyOtp = function (b) {
  const phone = String(b.phone || '');
  const code = String(b.code || '');
  if (!isPhone(phone) || !/^\d{6}$/.test(code)) return { ok: false, error: 'bad_code' };

  const t = now();
  const rows = readAll('otps').filter(function (o) {
    return o.phone === phone && !o.consumed && Number(o.expiresAt) > t;
  });
  rows.sort(function (a, b2) { return Number(b2.createdAt) - Number(a.createdAt); });
  const row = rows[0];
  if (!row) return { ok: false, error: 'no_code' };

  const attempts = Number(row.attempts);
  if (attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: 'too_many_attempts', attemptsLeft: 0 };
  }

  if (sha256Hex(phone + ':' + code + ':' + pepper()) !== row.codeHash) {
    updateRow('otps', row._row, { attempts: attempts + 1 });
    return {
      ok: false,
      error: 'wrong_code',
      attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts - 1)
    };
  }

  updateRow('otps', row._row, { verifiedAt: t });
  return { ok: true };
};

H.register = function (b) {
  const phone = String(b.phone || '');
  if (!isPhone(phone)) throw new ApiError('bad_phone');

  const otp = takeVerifiedOtp(phone, 'register');
  if (!otp) return { ok: false, error: 'not_verified' };

  const email = clean(b.email, 254).toLowerCase();
  if (email !== otp.email) return { ok: false, error: 'email_mismatch' };

  const name = clean(b.name, 40);
  const username = clean(b.username, 20);
  const vehicle = normVehicle(b.vehicle);
  const vehicleType = VEHICLE_TYPES.indexOf(b.vehicleType) !== -1 ? b.vehicleType : 'car';

  if (!name) return { ok: false, error: 'bad_name' };
  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) return { ok: false, error: 'bad_username' };
  if (!isVehicle(vehicle)) return { ok: false, error: 'bad_vehicle' };

  const users = readAll('users');
  for (let i = 0; i < users.length; i++) {
    if (users[i].phone === phone) return { ok: false, error: 'phone_exists' };
    if (users[i].username.toLowerCase() === username.toLowerCase()) {
      return { ok: false, error: 'username_taken' };
    }
    if (users[i].vehicle === vehicle) return { ok: false, error: 'vehicle_taken' };
  }

  const t = now();
  appendRow('users', {
    phone: phone,
    email: email,
    name: name,
    username: username,
    vehicle: vehicle,
    vehicleType: vehicleType,
    avatarId: '',
    vehiclePhotoId: '',
    platePhotoId: '',
    upiQrId: '',
    community: clean(b.community, 40),
    role: 'user',
    status: 'active',
    laneCount: 0,
    tripCount: 0,
    ratingSum: 0,
    ratingCount: 0,
    createdAt: t,
    lastLogin: t,
    device: clean(b.device, 100)
  });

  updateRow('otps', otp._row, { consumed: '1' });

  const token = createSession(phone, b.device);

  // Send welcome email with all the user details
  try {
    sendWelcomeEmail(email, name, vehicle, b.community, phone, email);
  } catch (e) {
    Logger.log('Welcome email failed: ' + e);
  }

  logAudit(phone, 'register', vehicle);
  return { ok: true, token: token, user: publicSelf(findUser(phone)) };
};

H.login = function (b) {
  const phone = String(b.phone || '');
  if (!isPhone(phone)) throw new ApiError('bad_phone');

  const user = findUser(phone);
  if (!user) return { ok: false, error: 'not_registered' };

  const otp = takeVerifiedOtp(phone, 'login');
  if (!otp) return { ok: false, error: 'not_verified' };

  updateRow('otps', otp._row, { consumed: '1' });
  try { updateRow('users', user._row, { lastLogin: now() }); } catch (e) {}

  const token = createSession(phone, b.device);
  logAudit(phone, 'login', '');
  return { ok: true, token: token, user: publicSelf(user) };
};

H.logout = function (b, u) {
  const sessions = readAll('sessions').filter(function (s) { return s.phone === u.phone; });
  for (let i = sessions.length - 1; i >= 0; i--) {
    try { deleteRow('sessions', sessions[i]._row); } catch (e) {}
  }
  return { ok: true };
};

H.checkSession = function (b, u) { return { valid: !!u }; };
H.getMe = function (b, u) { return { ok: true, user: publicSelf(u) }; };

H.updateMe = function (b, u) {
  const patch = {};

  if (b.name !== undefined) {
    const n = clean(b.name, 40);
    if (!n) return { ok: false, error: 'bad_name' };
    patch.name = n;
  }

  if (b.vehicle !== undefined) {
    const v = normVehicle(b.vehicle);
    if (!isVehicle(v)) return { ok: false, error: 'bad_vehicle' };
    const users = readAll('users');
    for (let i = 0; i < users.length; i++) {
      if (users[i].vehicle === v && users[i].phone !== u.phone) {
        return { ok: false, error: 'vehicle_taken' };
      }
    }
    patch.vehicle = v;
  }

  if (b.vehicleType !== undefined && VEHICLE_TYPES.indexOf(b.vehicleType) !== -1) {
    patch.vehicleType = b.vehicleType;
  }

  const tag = ownerTag(u.phone);
  const slots = ['avatarId', 'vehiclePhotoId', 'platePhotoId', 'upiQrId'];
  for (let i = 0; i < slots.length; i++) {
    const k = slots[i];
    if (b[k] === undefined) continue;
    const id = String(b[k] || '');
    if (id === '') { patch[k] = ''; continue; }
    if (!isId(id) || !fileOwnedBy(id, tag)) continue;
    patch[k] = id;
  }

  updateRow('users', u._row, patch);
  return { ok: true, user: publicSelf(findUser(u.phone)) };
};

// ─── Lanes ───
function publicLane(l, me) {
  const own = !!me && l.ownerPhone === me.phone;
  return {
    id: l.id,
    driver: l.driver,
    vehicle: l.vehicle,
    vehicleType: l.vehicleType,
    from: l.from,
    via: l.via,
    to: l.to,
    total: Number(l.total),
    taken: Number(l.taken),
    fare: Number(l.fare),
    lat: own ? round(l.lat, 7) : round(l.lat, 3),
    lng: own ? round(l.lng, 7) : round(l.lng, 3),
    status: l.status,
    ts: Number(l.ts),
    peerId: l.peerId,
    lastSeen: Number(l.lastSeen),
    showPlate: l.showPlate || 'true',
    own: own
  };
}

function laneFields(row, user, existing) {
  const total = Math.round(toNum(row.total, 1, 60, existing ? Number(existing.total) : 4));
  const taken = Math.round(toNum(row.taken, 0, total, 0));
  return {
    driver: user.name,
    vehicle: user.vehicle,
    vehicleType: VEHICLE_TYPES.indexOf(row.vehicleType) !== -1 ? row.vehicleType : user.vehicleType,
    from: clean(row.from, 80),
    via: clean(row.via, 200),
    to: clean(row.to, 80),
    total: total,
    taken: taken,
    fare: Math.round(toNum(row.fare, 0, 10000, 0)),
    lat: coord(row.lat, 90),
    lng: coord(row.lng, 180),
    status: row.status === 'full' ? 'full' : 'live',
    peerId: /^steeradar-veh-[A-Z0-9-]{4,24}$/.test(String(row.peerId || '')) ? row.peerId : '',
    lastSeen: now(),
    showPlate: String(row.showPlate) === 'false' ? 'false' : 'true'
  };
}

H.listLanes = function (b, u) {
  const t = now();
  const lanes = readAll('lanes');
  const out = [];
  for (let i = 0; i < lanes.length; i++) {
    if (t - Number(lanes[i].ts) < LANE_TTL_MS) out.push(publicLane(lanes[i], u));
  }
  out.sort(function (a, b2) { return b2.ts - a.ts; });
  return out.slice(0, 300);
};

H.insertLane = function (b, u) {
  const row = b.row || {};
  if (!isId(row.id)) throw new ApiError('bad_id');
  if (!clean(row.to, 80)) throw new ApiError('bad_destination');

  rateLimit(['lane:' + u.phone], 20, 3600);
  const lanes = readAll('lanes');
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i].id === row.id) throw new ApiError('exists');
  }
  const mine = lanes.filter(function (l) {
    return l.ownerPhone === u.phone && now() - Number(l.ts) < LANE_TTL_MS;
  });
  if (mine.length >= 5) throw new ApiError('lane_limit', 'Max 5 live lanes');

  const f = laneFields(row, u, null);
  const obj = { id: row.id, ownerPhone: u.phone, ts: now() };
  Object.keys(f).forEach(function (k) { obj[k] = f[k]; });
  appendRow('lanes', obj);

  logAudit(u.phone, 'insertLane', f.to);
  return { ok: true, id: row.id };
};

function ownLane(id, u) {
  const lanes = readAll('lanes');
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i].id === String(id)) {
      if (lanes[i].ownerPhone !== u.phone) throw new ApiError('forbidden', 'Not your lane');
      return lanes[i];
    }
  }
  return null;
}

H.updateLane = function (b, u) {
  const l = ownLane(b.id, u);
  if (!l) throw new ApiError('not_found');
  updateRow('lanes', l._row, laneFields(b.row || {}, u, l));
  return { ok: true };
};

H.removeLane = function (b, u) {
  const l = ownLane(b.id, u);
  if (l) deleteRow('lanes', l._row);
  return { ok: true };
};

// ─── Hive ───
function publicPost(p, me) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    title: p.title,
    text: p.text,
    tags: p.tags,
    time: p.time,
    likes: Number(p.likes),
    ts: Number(p.ts),
    vehicle: p.vehicle,
    own: !!me && p.ownerPhone === me.phone
  };
}

H.listHive = function (b, u) {
  const posts = readAll('hive');
  posts.sort(function (a, c) { return Number(c.ts) - Number(a.ts); });
  return posts.slice(0, 200).map(function (p) { return publicPost(p, u); });
};

H.insertHive = function (b, u) {
  const r = b.row || {};
  if (!isId(r.id)) throw new ApiError('bad_id');

  const title = clean(r.title, 80);
  const text = clean(String(r.text || '').replace(/\r/g, ''), 2000).trim() || title;
  if (!text) throw new ApiError('empty');

  rateLimit(['hive:' + u.phone], 30, 3600);
  const existing = readAll('hive').filter(function (p) { return p.id === r.id; });
  if (existing.length) throw new ApiError('exists');

  const tags = String(r.tags || '')
    .split('|')
    .map(function (t) { return clean(t, 24); })
    .filter(Boolean)
    .slice(0, 5)
    .join('|');

  appendRow('hive', {
    id: r.id,
    ownerPhone: u.phone,
    name: u.name,
    avatar: initials(u.name),
    title: title,
    text: text,
    tags: tags,
    time: 'just now',
    likes: 0,
    ts: now(),
    vehicle: u.vehicle
  });

  logAudit(u.phone, 'insertHive', title);
  return { ok: true, id: r.id };
};

function ownPost(id, u) {
  const posts = readAll('hive');
  for (let i = 0; i < posts.length; i++) {
    if (posts[i].id === String(id)) {
      if (posts[i].ownerPhone !== u.phone) throw new ApiError('forbidden', 'Not your post');
      return posts[i];
    }
  }
  throw new ApiError('not_found');
}

H.updateHive = function (b, u) {
  const p = ownPost(b.id, u);
  const r = b.row || {};
  const patch = {};
  if (r.title !== undefined) patch.title = clean(r.title, 80);
  if (r.text !== undefined) patch.text = clean(r.text, 2000);
  if (r.tags !== undefined) {
    patch.tags = String(r.tags).split('|').map(function (t) { return clean(t, 24); })
      .filter(Boolean).slice(0, 5).join('|');
  }
  updateRow('hive', p._row, patch);
  return { ok: true };
};

H.deleteHive = function (b, u) {
  const p = ownPost(b.id, u);
  deleteRow('hive', p._row);
  const likes = readAll('likes').filter(function (l) { return l.postId === p.id; });
  for (let i = likes.length - 1; i >= 0; i--) {
    try { deleteRow('likes', likes[i]._row); } catch (e) {}
  }
  return { ok: true };
};

H.like = function (b, u) {
  const id = String(b.id || '');
  if (!isId(id)) throw new ApiError('bad_id');
  rateLimit(['like:' + u.phone], 120, 3600);

  const posts = readAll('hive');
  let post = null;
  for (let i = 0; i < posts.length; i++) {
    if (posts[i].id === id) { post = posts[i]; break; }
  }
  if (!post) throw new ApiError('not_found');

  const key = id + '|' + u.phone;
  const likes = readAll('likes');
  let existing = null;
  for (let i = 0; i < likes.length; i++) {
    if (likes[i].key === key) { existing = likes[i]; break; }
  }

  let count = Number(post.likes) || 0;
  if (Number(b.delta) > 0 && !existing) {
    appendRow('likes', { key: key, postId: id, phone: u.phone, ts: now() });
    count += 1;
  } else if (Number(b.delta) < 0 && existing) {
    deleteRow('likes', existing._row);
    count = Math.max(0, count - 1);
  }
  updateRow('hive', post._row, { likes: count });
  return { likes: count };
};

// ─── Messages ───
function checkRoom(roomId, u) {
  const id = String(roomId || '');
  const dm = /^dm-([A-Z0-9]{4,15})-([A-Z0-9]{4,15})$/.exec(id);
  if (dm) {
    if (u.vehicle !== dm[1] && u.vehicle !== dm[2]) {
      throw new ApiError('forbidden', 'Not your conversation');
    }
    return { id: id, type: 'dm' };
  }
  if (/^local-[0-9a-z]{4,8}$/.test(id)) {
    return { id: id, type: 'local' };
  }
  throw new ApiError('bad_room');
}

H.sendMessage = function (b, u) {
  const r = b.row || {};
  const room = checkRoom(r.roomId, u);
  const text = clean(r.text, 1000);
  if (!text) throw new ApiError('empty');

  rateLimit(['msg:' + u.phone], 40, 60);

  appendRow('messages', {
    id: isId(r.id) ? r.id : shortId('m'),
    roomId: room.id,
    roomType: room.type,
    fromVehicle: u.vehicle,
    fromPhone: u.phone,
    sender: u.name,
    text: text,
    seq: r.seq != null ? toNum(r.seq, 0, 1e9, '') : '',
    ts: now()
  });
  return { ok: true };
};

H.getMessages = function (b, u) {
  const room = checkRoom(b.roomId, u);
  const limit = Math.round(toNum(b.limit, 1, 200, 50));
  const all = readAll('messages').filter(function (m) { return m.roomId === room.id; });
  all.sort(function (a, c) {
    const sa = Number(a.seq) || 0;
    const sc = Number(c.seq) || 0;
    if (sa && sc && sa !== sc) return sa - sc;
    return Number(a.ts) - Number(c.ts);
  });
  return all.slice(-limit).map(function (m) {
    return {
      id: m.id,
      roomId: m.roomId,
      from: m.fromVehicle,
      sender: m.sender,
      text: m.text,
      seq: m.seq === '' ? null : Number(m.seq),
      ts: Number(m.ts)
    };
  });
};

// ─── Presence ───
H.updatePresence = function (b, u) {
  const r = b.row || {};
  rateLimit(['pres:' + u.phone], 12, 60);

  const obj = {
    vehicle: u.vehicle,
    phone: u.phone,
    name: u.name,
    avatar: initials(u.name),
    peerId: /^steeradar-veh-[A-Z0-9-]{4,24}$/.test(String(r.peerId || '')) ? r.peerId : '',
    vehicleType: VEHICLE_TYPES.indexOf(r.vehicleType) !== -1 ? r.vehicleType : u.vehicleType,
    lat: round(coord(r.lat, 90), 5),
    lng: round(coord(r.lng, 180), 5),
    lastSeen: now()
  };

  const list = readAll('presence');
  let found = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].vehicle === u.vehicle) { found = list[i]; break; }
  }
  if (found) updateRow('presence', found._row, obj);
  else appendRow('presence', obj);
  return { ok: true };
};

H.activeVehicles = function (b, u) {
  const t = now();
  const list = readAll('presence').filter(function (p) {
    return t - Number(p.lastSeen) < PRESENCE_TTL_MS;
  });
  return list.slice(0, 200).map(function (p) {
    return {
      vehicle: p.vehicle,
      name: p.name,
      avatar: p.avatar,
      peerId: p.peerId,
      vehicleType: p.vehicleType,
      lat: p.lat === '' ? '' : Number(p.lat),
      lng: p.lng === '' ? '' : Number(p.lng),
      lastSeen: Number(p.lastSeen)
    };
  });
};

H.removePresence = function (b, u) {
  const list = readAll('presence').filter(function (p) { return p.vehicle === u.vehicle; });
  for (let i = list.length - 1; i >= 0; i--) {
    try { deleteRow('presence', list[i]._row); } catch (e) {}
  }
  return { ok: true };
};

// ─── Trips ───
H.startTrip = function (b, u) {
  rateLimit(['trip:' + u.phone], 30, 3600);
  const id = shortId('t');
  appendRow('trips', {
    id: id,
    phone: u.phone,
    laneId: isId(b.laneId) ? b.laneId : '',
    driverPhone: isPhone(b.driverPhone) ? b.driverPhone : '',
    startTs: now(),
    endTs: '',
    distance: '',
    fare: '',
    status: 'active',
    notes: ''
  });
  return { ok: true, id: id };
};

H.endTrip = function (b, u) {
  const trips = readAll('trips');
  let trip = null;
  for (let i = 0; i < trips.length; i++) {
    if (trips[i].id === String(b.id) && trips[i].phone === u.phone) {
      trip = trips[i];
      break;
    }
  }
  if (!trip) throw new ApiError('not_found');

  const fare = toNum(b.fare, 0, 100000, 0);
  const distance = toNum(b.distance, 0, 5000000, 0);

  updateRow('trips', trip._row, {
    endTs: now(),
    distance: distance,
    fare: fare,
    status: 'completed',
    notes: clean(b.notes, 500)
  });

  const driver = isPhone(b.driverPhone) ? findUser(b.driverPhone) : null;
  if (driver) {
    const rateUrl = APP_URL + '?rate=' + trip.id;
    try { sendRateRequestEmail(u.email, driver.name, rateUrl); } catch (e) {}
  }

  return { ok: true };
};

H.myTrips = function (b, u) {
  const trips = readAll('trips').filter(function (t) { return t.phone === u.phone; });
  trips.sort(function (a, c) { return Number(c.startTs) - Number(a.startTs); });
  return trips.slice(0, 100);
};

// ─── Ratings ───
H.rateTrip = function (b, u) {
  const tripId = String(b.tripId || '');
  const stars = Math.round(toNum(b.stars, 1, 5, 5));
  const comment = clean(b.comment, 500);

  const trips = readAll('trips');
  let trip = null;
  for (let i = 0; i < trips.length; i++) {
    if (trips[i].id === tripId && trips[i].phone === u.phone) {
      trip = trips[i];
      break;
    }
  }
  if (!trip) throw new ApiError('not_found');

  const already = readAll('ratings').filter(function (r) {
    return r.tripId === tripId && r.fromPhone === u.phone;
  });
  if (already.length) throw new ApiError('already_rated');

  appendRow('ratings', {
    id: shortId('r'),
    tripId: tripId,
    fromPhone: u.phone,
    toPhone: trip.driverPhone,
    stars: stars,
    comment: comment,
    ts: now()
  });

  if (trip.driverPhone && isPhone(trip.driverPhone)) {
    const target = findUser(trip.driverPhone);
    if (target) {
      updateRow('users', target._row, {
        ratingSum: Number(target.ratingSum || 0) + stars,
        ratingCount: Number(target.ratingCount || 0) + 1
      });
    }
  }
  return { ok: true };
};

// ─── Reports ───
H.reportUser = function (b, u) {
  rateLimit(['report:' + u.phone], 5, 3600);
  const targetVehicle = normVehicle(b.vehicle);
  const reason = clean(b.reason, 60);
  const detail = clean(b.detail, 500);
  if (!reason) throw new ApiError('bad_reason');

  const target = findUserByVehicle(targetVehicle);
  appendRow('reports', {
    id: shortId('rep'),
    reporterPhone: u.phone,
    targetPhone: target ? target.phone : '',
    targetVehicle: targetVehicle,
    reason: reason,
    detail: detail,
    status: 'open',
    ts: now(),
    resolvedAt: ''
  });

  try { sendReportAckEmail(u.email); } catch (e) {}
  return { ok: true };
};

// ─── Images ───
function ownerTag(phone) {
  return 'owner:' + sha256Hex(phone + ':' + pepper()).slice(0, 24);
}

function fileOwnedBy(fileId, tag) {
  try { return DriveApp.getFileById(fileId).getDescription() === tag; }
  catch (e) { return false; }
}

function getFolder(name, parent) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

H.uploadImage = function (b, u) {
  rateLimit(['img:' + u.phone], 12, 21600);

  const data = String(b.base64 || '');
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) throw new ApiError('bad_image', 'JPEG only');
  if (data.length > 900000) throw new ApiError('too_large');

  const slot = String(b.folder || '').split('/').pop();
  if (PHOTO_SLOTS.indexOf(slot) === -1) throw new ApiError('bad_slot');

  const bytes = Utilities.base64Decode(m[1]);
  const blob = Utilities.newBlob(bytes, 'image/jpeg', slot + '_' + now() + '.jpg');

  const root = getFolder('Steeradar Uploads', DriveApp.getRootFolder());
  const mine = getFolder(sha256Hex(u.phone + pepper()).slice(0, 16), root);
  const file = mine.createFile(blob);
  file.setDescription(ownerTag(u.phone));

  return { fileId: file.getId(), url: '' };
};

H.deleteImage = function (b, u) {
  const id = String(b.fileId || '');
  if (!isId(id) || !fileOwnedBy(id, ownerTag(u.phone))) {
    throw new ApiError('forbidden');
  }
  DriveApp.getFileById(id).setTrashed(true);
  return { ok: true };
};

// ═══════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════
const ROUTES = {
  ping:            { auth: 'none' },
  sendOtp:         { auth: 'none', write: true },
  verifyOtp:       { auth: 'none', write: true },
  register:        { auth: 'none', write: true },
  login:           { auth: 'none', write: true },
  checkSession:    { auth: 'optional' },
  listLanes:       { auth: 'optional' },
  listHive:        { auth: 'optional' },
  logout:          { auth: 'required', write: true },
  getMe:           { auth: 'required' },
  updateMe:        { auth: 'required', write: true },
  insertLane:      { auth: 'required', write: true },
  updateLane:      { auth: 'required', write: true },
  removeLane:      { auth: 'required', write: true },
  insertHive:      { auth: 'required', write: true },
  updateHive:      { auth: 'required', write: true },
  deleteHive:      { auth: 'required', write: true },
  like:            { auth: 'required', write: true },
  getMessages:     { auth: 'required' },
  sendMessage:     { auth: 'required', write: true },
  updatePresence:  { auth: 'required', write: true },
  activeVehicles:  { auth: 'required' },
  removePresence:  { auth: 'required', write: true },
  startTrip:       { auth: 'required', write: true },
  endTrip:         { auth: 'required', write: true },
  myTrips:         { auth: 'required' },
  rateTrip:        { auth: 'required', write: true },
  reportUser:      { auth: 'required', write: true },
  uploadImage:     { auth: 'required', write: true },
  deleteImage:     { auth: 'required', write: true },
  debug:           { auth: 'required' }
};

function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return out({ ok: true, service: 'steeradar', version: VERSION });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > MAX_BODY_CHARS) throw new ApiError('bad_request');

    let body;
    try { body = JSON.parse(raw); }
    catch (x) { throw new ApiError('bad_json'); }
    if (!body || typeof body !== 'object') throw new ApiError('bad_request');

    const action = String(body.action || '');
    if (!Object.prototype.hasOwnProperty.call(ROUTES, action)) {
      throw new ApiError('unknown_action');
    }
    const route = ROUTES[action];

    const run = function () {
      let user = null;
      if (route.auth === 'required') user = requireUser(body);
      else if (route.auth === 'optional') user = userByToken(body);
      return H[action](body, user);
    };

    const data = route.write ? withLock(run) : run();
    return out({ data: data });
  } catch (err) {
    if (err instanceof ApiError) {
      return out({
        error: err.code,
        message: err.message === err.code ? undefined : err.message,
        retry: err.retry || undefined
      });
    }
    Logger.log('steeradar error: ' + (err && err.stack ? err.stack : err));
    return out({ error: 'server_error' });
  }
}

// ─── Setup ───
function setup() {
  pepper();
  Object.keys(SCHEMA).forEach(getSheet);
  installTriggers();

  Logger.log('============================================');
  Logger.log('Steeradar backend v' + VERSION + ' ready');
  Logger.log('============================================');
  Logger.log('Sheet URL: ' + getSS().getUrl());
  Logger.log('Mail quota: ' + safeQuota());
  Logger.log('Now: Deploy → New version → Anyone');
}

function installTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cleanup') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(3).create();
  Logger.log('Daily cleanup installed.');
}

function cleanup() {
  withLock(function () {
    const t = now();
    function prune(name, keep) {
      const rows = readAll(name);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!keep(rows[i])) {
          try { deleteRow(name, rows[i]._row); } catch (e) {}
        }
      }
    }
    prune('sessions', function (s) { return Number(s.expiresAt) > t; });
    prune('magic',    function (m) { return Number(m.expiresAt) + 86400000 > t; });
    prune('otps',     function (o) { return Number(o.expiresAt) + 86400000 > t; });
    prune('presence', function (p) { return t - Number(p.lastSeen) < 86400000; });
    prune('lanes',    function (l) { return t - Number(l.ts) < 7 * LANE_TTL_MS; });
    prune('messages', function (m) { return t - Number(m.ts) < 30 * 86400000; });
    Logger.log('Cleanup complete.');
  });
}

// ─── Test helpers ───
function testEmail() {
  const to = Session.getActiveUser().getEmail();
  const ok = sendOtpEmail(to, '123456', 'login');
  Logger.log('OTP email: ' + (ok ? 'OK' : 'FAILED'));
}

function testWelcome() {
  const to = Session.getActiveUser().getEmail();
  const ok = sendWelcomeEmail(
    to,
    'Test Rider',
    'KA01AB1234',
    'Indiranagar',
    '9876543210',
    to
  );
  Logger.log('Welcome email: ' + (ok ? 'OK' : 'FAILED'));
}

function testReceipt() {
  const to = Session.getActiveUser().getEmail();
  const ok = sendReceiptEmail(to, 'Test Driver', 'Koramangala', 'Whitefield', '12.4 km', 45, '28 min');
  Logger.log('Receipt email: ' + (ok ? 'OK' : 'FAILED'));
}

function checkMailQuota() {
  Logger.log('Emails remaining today: ' + safeQuota());
}