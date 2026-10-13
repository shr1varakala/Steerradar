/**
 * Steeradar backend — v8.7 (Final Stable)
 * - Filename support for uploads
 * - Higher upload rate limit (30 per 6h)
 * - All previous fixes intact
 */

const VERSION = '8.7';
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
const MAX_BODY_CHARS = 5000000;
const MAX_POINTS_PER_USER = 200;
const PW_MIN = 6;
const PW_MAX = 100;
const VEHICLE_TYPES = ['bus', 'car', 'auto', 'bike', 'walk', 'event', 'two-wheeler'];
const PHOTO_SLOTS = ['avatar', 'vehiclePhoto', 'platePhoto', 'upiQr', 'selfie', 'license', 'rc', 'hive', 'lanes', 'misc'];

const SCHEMA = {
  users:        ['phone','email','name','username','vehicle','vehicleType',
                 'avatarId','vehiclePhotoId','platePhotoId','upiQrId',
                 'community','role','status','agentStatus','ghostMode',
                 'laneCount','tripCount','ratingSum','ratingCount',
                 'passHash','salt',
                 'createdAt','lastLogin','device'],
  sessions:     ['tokenHash','phone','type','createdAt','expiresAt','device','lastSeen'],
  magic:        ['tokenHash','phone','createdAt','expiresAt','consumed'],
  otps:         ['id','phone','email','purpose','codeHash','createdAt',
                 'expiresAt','attempts','verifiedAt','consumed'],
  applications: ['id','phone','name','vehicle','vehicleType','vehiclePhotoId',
                 'platePhotoId','selfieId','licenseId','upiId','agreement','status','notes',
                 'appliedAt','reviewedAt','reviewedBy'],
  lanes:        ['id','ownerPhone','driver','vehicle','vehicleType','community',
                 'title','description','photoUrl',
                 'from','via','to','total','taken','fare','lat','lng',
                 'status','ts','peerId','lastSeen','showPlate'],
  hive:         ['id','ownerPhone','name','avatar','community',
                 'title','text','tags','time','likes','ts','vehicle',
                 'photoUrl','mediaUrl','mediaType'],
  likes:        ['key','postId','phone','ts'],
  messages:     ['id','roomId','roomType','fromVehicle','fromPhone',
                 'sender','text','seq','ts'],
  presence:     ['vehicle','phone','name','avatar','peerId','vehicleType',
                 'lat','lng','lastSeen'],
  trips:        ['id','phone','laneId','driverPhone','startTs','endTs',
                 'startLat','startLng','endLat','endLng','distance','fare','status','notes'],
  ratings:      ['id','tripId','fromPhone','toPhone','stars','comment','ts'],
  reports:      ['id','reporterPhone','targetPhone','targetVehicle',
                 'reason','detail','status','ts','resolvedAt'],
  blocks:       ['ownerPhone','blockedPhone','ts'],
  communities:  ['id','name','city','adminPhone','memberCount','createdAt','status'],
  members:      ['community','phone','joinedAt'],
  points:       ['id','ownerPhone','ownerName','label','note','category',
                 'lat','lng','shared','createdAt','updatedAt'],
  audit:        ['ts','phone','action','detail'],
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

function extractDriveId(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^[A-Za-z0-9_-]{20,64}$/.test(s)) return s;
  let m = s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  m = s.match(/\/d\/([\w-]{10,})/);
  if (m) return m[1];
  return '';
}

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

function newToken() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function newSalt() { return Utilities.getUuid().replace(/-/g, '').slice(0, 32); }

function hashPassword(pw, salt) {
  let h = salt + ':' + pw + ':' + pepper();
  for (let i = 0; i < 200; i++) h = sha256Hex(h + salt);
  return h;
}

function shortId(prefix) { return prefix + '-' + newToken().slice(0, 12); }

function todayKey() { return Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd'); }

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

function migrateSheet(name) {
  const sh = getSheet(name);
  const cols = SCHEMA[name];
  const existing = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  const missing = cols.filter(function (c) { return existing.indexOf(c) < 0; });
  if (!missing.length) return;
  const startCol = existing.length + 1;
  sh.getRange(1, startCol, 1, missing.length).setNumberFormat('@').setValues([missing]).setFontWeight('bold');
  Logger.log('Migrated ' + name + ': added ' + missing.join(', '));
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

function deleteRow(name, rowIdx) { getSheet(name).deleteRow(rowIdx); }

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ─── Email building blocks ───
function emailHeader() {
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F3F6;padding:32px 16px;">'
    + '<tr><td align="center">'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#FFFFFF;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">'
    + '<tr><td align="center" style="background:linear-gradient(135deg,' + TEAL + ' 0%,' + TEAL2 + ' 100%);padding:36px 24px 28px;">'
    + '<img src="' + LOGO_URL + '" alt="' + APP_NAME + '" width="84" height="84" style="display:block;border-radius:50%;border:3px solid rgba(255,255,255,0.3);background:#FFFFFF;object-fit:cover;">'
    + '<div style="color:#FFFFFF;font-size:24px;font-weight:800;letter-spacing:-0.5px;margin-top:14px;">Steer<span>adar</span><span style="color:' + CORAL + ';">.</span></div>'
    + '<div style="color:rgba(255,255,255,0.85);font-size:11px;margin-top:6px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;">Community rides</div>'
    + '</td></tr>'
    + '<tr><td style="padding:36px 32px;color:' + INK + ';">';
}

function emailFooter() {
  return '</td></tr>'
    + '<tr><td style="padding:24px 32px 32px;border-top:1px solid #E5E7EB;background:#F8F9FB;">'
    + '<div style="text-align:center;color:#9CA3AF;font-size:12px;line-height:1.6;">'
    + '<div style="font-weight:700;color:#6B7280;margin-bottom:6px;">Thank you for riding with us 🚌</div>'
    + '<div>' + APP_NAME + ' · ' + new Date().getFullYear() + '</div>'
    + '<div style="margin-top:14px;font-size:11px;">'
    + '<a href="' + APP_URL + '" style="color:' + TEAL + ';text-decoration:none;font-weight:700;">Visit Steeradar</a>'
    + '</div>'
    + '<div style="margin-top:18px;font-size:10px;color:#B4BAC6;">If you didn\'t request this email, you can safely ignore it.</div>'
    + '</div></td></tr></table></td></tr></table>';
}

function emailShell(bodyHtml) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#F1F3F6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">'
    + emailHeader() + bodyHtml + emailFooter() + '</body></html>';
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

function buildWelcome(email, name, vehicle, community, phone) {
  const firstName = escapeHtml((name || 'Driver').split(' ')[0]);
  const safeEmail = escapeHtml(email || '');
  const safePhone = escapeHtml(phone || '');
  const safeVehicle = escapeHtml(vehicle || '');
  const safeCommunity = escapeHtml(community || 'Not specified');

  const personalNoteHTML = '<div style="margin: 28px 0; padding: 20px; border-left: 4px solid ' + CORAL + '; background: linear-gradient(135deg, #FEF2F2 0%, #FFF5F5 100%); border-radius: 0 10px 10px 0;">'
    + '<div style="display:block; margin-bottom:12px;">'
    + '<span style="display:inline-block; background:' + CORAL + '; color:#FFFFFF; font-size:10px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; padding:5px 12px; border-radius:20px;">💌 Personal Note</span>'
    + '</div>'
    + '<p style="margin: 0; color: ' + INK + '; font-size: 15px; line-height: 1.7; font-style: italic;">'
    + '"Hey ' + firstName + ', I\'m absolutely thrilled to welcome you to the Steeradar family! This platform was built for drivers, by drivers. Our goal is to make your daily commute safer, more connected, and more rewarding. If you ever have a suggestion or just want to chat, the Hive is the place to be. Happy driving!"'
    + '</p>'
    + '<p style="margin: 14px 0 0; color: ' + MUTED + '; font-size: 13px; font-weight: 700; text-align: right;">'
    + '— SteerMan<br>'
    + '<span style="font-weight: 400; font-size: 11px; color: ' + SOFT + ';">Maker of Steeradar</span>'
    + '</p></div>';

  const userDetailsHTML = '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0 0; background:#F8F9FB; border-radius:14px; border: 1px solid #E5E7EB;">'
    + '<tr><td style="padding: 20px 22px;">'
    + '<div style="color: ' + TEAL + '; font-size: 11px; font-weight: 800; letter-spacing: 1.6px; text-transform: uppercase; margin-bottom: 16px;">📋 Your Account Details</div>'
    + rowKV('Name', name)
    + rowKV('User Type', 'RearAgent')
    + rowKV('User ID (Phone)', safePhone, true)
    + rowKV('Email', safeEmail)
    + rowKV('Vehicle', safeVehicle)
    + rowKV('Community', safeCommunity)
    + '</td></tr></table>';

  const thankYouHTML = '<div style="margin: 28px 0 0; padding: 20px; text-align: center; background: linear-gradient(135deg, ' + TEAL + ' 0%, ' + TEAL2 + ' 100%); border-radius: 12px;">'
    + '<p style="margin: 0; color: #FFFFFF; font-size: 16px; font-weight: 700; line-height: 1.5;">🙏 Thank you for joining our community!</p>'
    + '<p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 13px; line-height: 1.6;">We\'re excited to have you on board. Let\'s make every ride memorable.</p>'
    + '</div>';

  const body = '<h1 style="margin:0 0 10px;color:' + INK + ';font-size:26px;font-weight:800;letter-spacing:-0.4px;">Welcome aboard, ' + firstName + '! 🎉</h1>'
    + '<p style="margin:0 0 26px;color:' + MUTED + ';font-size:15px;line-height:1.6;">'
    + 'Your Steeradar account is ready' + (community ? ' in <strong style="color:' + INK + ';">' + escapeHtml(community) + '</strong>' : '') + '. Here\'s what you can do now:'
    + '</p>'
    + featureTile('🚌', 'Post your lane', 'Share your route and available seats')
    + featureTile('💬', 'Chat with drivers', 'Real-time peer-to-peer messaging')
    + featureTile('📍', 'Track live', 'See vehicles approaching in real time')
    + featureTile('⭐', 'Build trust', 'Rate and get rated after each ride')
    + personalNoteHTML + userDetailsHTML + thankYouHTML
    + '<p style="margin: 24px 0 0; color: ' + SOFT + '; font-size: 12px; line-height: 1.7; text-align: center;">'
    + 'Need help? Just reply to this email or find us in the Hive.<br>We\'re always here for you.</p>';

  return emailShell(body);
}

function buildAgentApproved(name) {
  const firstName = escapeHtml((name || 'Driver').split(' ')[0]);
  const body = '<h1 style="margin:0 0 10px;color:' + INK + ';font-size:26px;font-weight:800;letter-spacing:-0.4px;">You\'re a SteerAgent now! 🎉</h1>'
    + '<p style="margin:0 0 22px;color:' + MUTED + ';font-size:15px;line-height:1.6;">'
    + 'Congratulations ' + firstName + '! Your application has been reviewed and <strong style="color:' + TEAL + ';">approved</strong>.'
    + '</p>'
    + '<div style="background: linear-gradient(135deg, #F0FDFA 0%, #ECFDF5 100%); border: 1px solid ' + TEAL + '; border-radius: 12px; padding: 20px; margin: 20px 0;">'
    + '<div style="color:' + TEAL + '; font-size:11px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; margin-bottom:10px;">✓ Unlocked Features</div>'
    + '<p style="margin:6px 0; color:' + INK + '; font-size:14px;">🚌 Post your own lanes</p>'
    + '<p style="margin:6px 0; color:' + INK + '; font-size:14px;">💰 Accept payments via UPI</p>'
    + '<p style="margin:6px 0; color:' + INK + '; font-size:14px;">👻 Ghost mode & alerts</p>'
    + '<p style="margin:6px 0; color:' + INK + '; font-size:14px;">📊 Trip tracking & history</p>'
    + '</div>'
    + '<div style="text-align:center; margin: 28px 0;">'
    + '<a href="' + APP_URL + '" style="display:inline-block; background:' + TEAL + '; color:#FFFFFF; font-weight:800; font-size:15px; padding:14px 36px; border-radius:12px; text-decoration:none;">Start Driving</a>'
    + '</div>';
  return emailShell(body);
}

function buildAgentRejected(name, reason) {
  const firstName = escapeHtml((name || 'Driver').split(' ')[0]);
  const safeReason = escapeHtml(reason || 'Documents were not valid.');
  const body = '<h1 style="margin:0 0 10px;color:' + INK + ';font-size:24px;font-weight:800;">Application Update</h1>'
    + '<p style="margin:0 0 22px;color:' + MUTED + ';font-size:15px;line-height:1.6;">'
    + 'Hi ' + firstName + ', we reviewed your SteerAgent application but couldn\'t approve it at this time.'
    + '</p>'
    + '<div style="background:#FEF2F2; border-left: 4px solid ' + CORAL + '; border-radius: 0 10px 10px 0; padding: 16px 20px; margin: 20px 0;">'
    + '<div style="color:' + CORAL + '; font-size:11px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; margin-bottom:8px;">Reason</div>'
    + '<p style="margin:0; color:' + INK + '; font-size:14px; line-height:1.6;">' + safeReason + '</p>'
    + '</div>'
    + '<p style="margin:22px 0 0;color:' + MUTED + ';font-size:14px;line-height:1.6;">'
    + 'You can update your documents and apply again anytime from your profile.'
    + '</p>';
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
      to: to, subject: subject, htmlBody: html,
      body: plain || subject, name: APP_NAME, noReply: true
    });
    return true;
  } catch (e) {
    Logger.log('Mail failed: ' + e);
    return false;
  }
}

function sendOtpEmail(to, code, purpose) {
  return sendMail(to, '🔐 Your Steeradar code: ' + code,
    buildOtp(code, purpose),
    'Your Steeradar code is ' + code + '. Expires in 10 minutes.');
}

function sendWelcomeEmail(to, name, vehicle, community, phone, email) {
  return sendMail(to, '🎉 Welcome to Steeradar, ' + ((name || '').split(' ')[0] || 'friend') + '!',
    buildWelcome(email || to, name, vehicle, community, phone),
    'Welcome ' + name + '! User ID: ' + phone);
}

function sendAgentApprovedEmail(to, name) {
  return sendMail(to, '🎉 You\'re a SteerAgent now!',
    buildAgentApproved(name),
    'Congratulations ' + name + '! Your SteerAgent application has been approved.');
}

function sendAgentRejectedEmail(to, name, reason) {
  return sendMail(to, '📝 Update on your SteerAgent application',
    buildAgentRejected(name, reason),
    'Hi ' + name + '. Your application needs attention: ' + reason);
}

function sendReportAckEmail(to) {
  return sendMail(to, '🛡️ We received your Steeradar report',
    buildReportAck(),
    'We received your report and will review it shortly.');
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

function findUserByEmail(email) {
  const e = String(email || '').toLowerCase();
  const users = readAll('users');
  for (let i = 0; i < users.length; i++) {
    if ((users[i].email || '').toLowerCase() === e) return users[i];
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

function isAdmin_(u) {
  if (!u) return false;
  if (u.role === 'admin') return true;
  const list = (PropertiesService.getScriptProperties().getProperty('ADMIN_PHONES') || '').split(',');
  return list.map(function (s) { return s.replace(/\D/g, '').slice(-10); }).indexOf(u.phone) >= 0;
}

function createSession(phone, device) {
  const token = newToken();
  const t = now();
  appendRow('sessions', {
    tokenHash: sha256Hex(token + pepper()),
    phone: phone, type: 'access',
    createdAt: t, expiresAt: t + SESSION_DAYS * 24 * 3600 * 1000,
    device: clean(device, 100), lastSeen: t
  });
  return token;
}

function publicSelf(u) {
  const isAgent = u.role === 'agent' && u.agentStatus === 'active';
  return {
    phone: u.phone, email: u.email, name: u.name, username: u.username,
    vehicle: u.vehicle, vehicleType: u.vehicleType,
    avatarId: u.avatarId, vehiclePhotoId: u.vehiclePhotoId,
    platePhotoId: u.platePhotoId, upiQrId: u.upiQrId,
    community: u.community || '',
    role: u.role || 'user',
    agentStatus: u.agentStatus || '',
    isAgent: isAgent,
    isAdmin: isAdmin_(u),
    ghostMode: u.ghostMode === 'true',
    upiId: u.upiQrId || '',
    photo: u.avatarId ? 'https://drive.google.com/thumbnail?id=' + u.avatarId + '&sz=w400' : '',
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
    appendRow('audit', { ts: now(), phone: phone || '', action: action || '', detail: clean(detail, 500) });
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
  return { version: VERSION, user: u.name, counts: counts, mailQuota: safeQuota() };
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
    return { ok: false, error: 'cooldown', wait: Math.ceil((OTP_COOLDOWN_MS - (t - Number(recent[0].createdAt))) / 1000) };
  }

  for (let i = 0; i < all.length; i++) {
    if (!all[i].consumed) {
      try { updateRow('otps', all[i]._row, { consumed: '1' }); } catch (e) {}
    }
  }

  const hash = sha256Hex(Utilities.getUuid() + Utilities.getUuid());
  const code = String(parseInt(hash.slice(0, 8), 16) % 1000000).padStart(6, '0');

  appendRow('otps', {
    id: shortId('otp'), phone: phone, email: email, purpose: purpose,
    codeHash: sha256Hex(phone + ':' + code + ':' + pepper()),
    createdAt: t, expiresAt: t + OTP_TTL_MS,
    attempts: 0, verifiedAt: '', consumed: ''
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
  if (attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: 'too_many_attempts', attemptsLeft: 0 };

  if (sha256Hex(phone + ':' + code + ':' + pepper()) !== row.codeHash) {
    updateRow('otps', row._row, { attempts: attempts + 1 });
    return { ok: false, error: 'wrong_code', attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts - 1) };
  }

  updateRow('otps', row._row, { verifiedAt: t });
  return { ok: true, verified: true };
};

H.register = function (b) {
  const phone = String(b.phone || '');
  if (!isPhone(phone)) throw new ApiError('bad_phone');

  const otp = takeVerifiedOtp(phone, 'register');
  if (!otp) return { ok: false, error: 'not_verified' };

  const email = clean(b.email, 254).toLowerCase();
  if (email !== otp.email) return { ok: false, error: 'email_mismatch' };

  const name = clean(b.name, 40);
  if (!name) return { ok: false, error: 'bad_name' };

  let username = clean(b.username, 20);
  if (!username) username = 'rider_' + phone.slice(-6);

  const vehicle = normVehicle(b.vehicle);
  const vehicleType = VEHICLE_TYPES.indexOf(b.vehicleType) !== -1 ? b.vehicleType : 'car';

  let passHash = '', salt = '';
  if (b.password) {
    const pw = String(b.password);
    if (pw.length < PW_MIN || pw.length > PW_MAX) return { ok: false, error: 'weak_password' };
    salt = newSalt();
    passHash = hashPassword(pw, salt);
  }

  const users = readAll('users');
  for (let i = 0; i < users.length; i++) {
    if (users[i].phone === phone) return { ok: false, error: 'phone_exists' };
    if (users[i].username && users[i].username.toLowerCase() === username.toLowerCase()) {
      return { ok: false, error: 'username_taken' };
    }
    if (users[i].email && users[i].email.toLowerCase() === email) {
      return { ok: false, error: 'email_taken' };
    }
  }

  const t = now();
  appendRow('users', {
    phone: phone, email: email, name: name, username: username,
    vehicle: vehicle, vehicleType: vehicleType,
    avatarId: '', vehiclePhotoId: '', platePhotoId: '', upiQrId: '',
    community: clean(b.community, 40),
    role: 'user', status: 'active', agentStatus: '',
    ghostMode: 'false',
    laneCount: 0, tripCount: 0, ratingSum: 0, ratingCount: 0,
    passHash: passHash, salt: salt,
    createdAt: t, lastLogin: t, device: clean(b.device, 100)
  });

  updateRow('otps', otp._row, { consumed: '1' });

  const token = createSession(phone, b.device);

  try { sendWelcomeEmail(email, name, vehicle, b.community, phone, email); }
  catch (e) { Logger.log('Welcome email failed: ' + e); }

  logAudit(phone, 'register', vehicle);
  return { ok: true, token: token, phone: phone, user: publicSelf(findUser(phone)) };
};

H.login = function (b) {
  const identity = String(b.phone || '').trim();
  if (!identity) throw new ApiError('bad_identity', 'Enter phone or email');

  const isEmailLogin = identity.indexOf('@') > -1;
  let user = null;

  if (isEmailLogin) {
    if (!isEmail(identity)) throw new ApiError('bad_email', 'Invalid email');
    user = findUserByEmail(identity);
    if (!user) return { ok: false, error: 'not_registered' };
  } else {
    if (!isPhone(identity)) throw new ApiError('bad_phone', 'Invalid phone number');
    user = findUser(identity);
    if (!user) return { ok: false, error: 'not_registered' };
  }

  const phone = user.phone;

  if (b.password) {
    if (!user.passHash) return { ok: false, error: 'no_password' };
    const hash = hashPassword(String(b.password), user.salt);
    if (hash !== user.passHash) {
      try { rateLimit(['pw:' + phone], 8, 900); }
      catch (e) { throw new ApiError('too_many_attempts', 'Too many attempts. Try again in 15 minutes.'); }
      return { ok: false, error: 'bad_credentials' };
    }
  } else if (b.code) {
    const otp = takeVerifiedOtp(phone, 'login');
    if (!otp) return { ok: false, error: 'not_verified' };
    updateRow('otps', otp._row, { consumed: '1' });
  } else {
    return { ok: false, error: 'no_credentials' };
  }

  try { updateRow('users', user._row, { lastLogin: now() }); } catch (e) {}

  const token = createSession(phone, b.device);
  logAudit(phone, 'login', isEmailLogin ? 'email' : 'phone');
  return { ok: true, token: token, phone: phone, user: publicSelf(findUser(phone)) };
};

H.setPassword = function (b, u) {
  const pw = String(b.password || '');
  if (pw.length < PW_MIN || pw.length > PW_MAX) return { ok: false, error: 'weak_password' };
  if (u.passHash && b.oldPassword) {
    const oldHash = hashPassword(String(b.oldPassword), u.salt);
    if (oldHash !== u.passHash) return { ok: false, error: 'bad_credentials' };
  }
  const salt = newSalt();
  const hash = hashPassword(pw, salt);
  updateRow('users', u._row, { passHash: hash, salt: salt });
  return { ok: true };
};

H.logout = function (b, u) {
  const sessions = readAll('sessions').filter(function (s) { return s.phone === u.phone; });
  for (let i = sessions.length - 1; i >= 0; i--) {
    try { deleteRow('sessions', sessions[i]._row); } catch (e) {}
  }
  return { ok: true };
};

H.checkSession = function (b, u) {
  if (!u) return { valid: false };
  return { valid: true, user: publicSelf(u) };
};

H.getMe = function (b, u) { return publicSelf(u); };

H.updateMe = function (b, u) {
  const patch = {};
  const r = b.patch || b;

  if (r.name !== undefined) {
    const n = clean(r.name, 40);
    if (!n) return { ok: false, error: 'bad_name' };
    patch.name = n;
  }

  if (r.vehicle !== undefined) {
    const v = normVehicle(r.vehicle);
    if (v && !isVehicle(v)) return { ok: false, error: 'bad_vehicle' };
    if (v) {
      const users = readAll('users');
      for (let i = 0; i < users.length; i++) {
        if (users[i].vehicle === v && users[i].phone !== u.phone) {
          return { ok: false, error: 'vehicle_taken' };
        }
      }
    }
    patch.vehicle = v;
  }

  if (r.vehicleType !== undefined && VEHICLE_TYPES.indexOf(r.vehicleType) !== -1) {
    patch.vehicleType = r.vehicleType;
  }

  if (r.upiId !== undefined) patch.upiQrId = clean(r.upiId, 100);
  if (r.upiQrId !== undefined) patch.upiQrId = clean(r.upiQrId, 100);
  if (r.city !== undefined) patch.community = clean(r.city, 60);
  if (r.community !== undefined) patch.community = clean(r.community, 60);
  if (r.ghostMode !== undefined) patch.ghostMode = r.ghostMode ? 'true' : 'false';

  if (r.photo !== undefined) {
    const url = String(r.photo || '');
    if (url === '') {
      patch.avatarId = '';
    } else {
      const fid = extractDriveId(url);
      if (fid && fileOwnedBy(fid, ownerTag(u.phone))) patch.avatarId = fid;
    }
  }

  const slots = ['avatarId', 'vehiclePhotoId', 'platePhotoId', 'upiQrId'];
  for (let i = 0; i < slots.length; i++) {
    const k = slots[i];
    if (r[k] === undefined) continue;
    const id = String(r[k] || '');
    if (id === '') { patch[k] = ''; continue; }
    if (!isId(id) || !fileOwnedBy(id, ownerTag(u.phone))) continue;
    patch[k] = id;
  }

  if (Object.keys(patch).length) updateRow('users', u._row, patch);
  return publicSelf(findUser(u.phone));
};

H.becomeAgent = function (b, u) {
  if (u.role === 'agent' && u.agentStatus === 'active') {
    return { ok: true, user: publicSelf(u), already: true };
  }

  rateLimit(['agent:' + u.phone], 3, 3600);

  const vehicle = normVehicle(b.vehicle || b.plate || u.vehicle);
  if (!isVehicle(vehicle)) throw new ApiError('bad_vehicle', 'Invalid vehicle number');

  const vehicleType = VEHICLE_TYPES.indexOf(b.vehicleType) !== -1 ? b.vehicleType : (u.vehicleType || 'car');
  const upiId = clean(b.upiId, 100);

  const tag = ownerTag(u.phone);

  function resolvePhoto(v) {
    if (!v) return '';
    const s = String(v).trim();
    if (isId(s) && fileOwnedBy(s, tag)) return s;
    const fid = extractDriveId(s);
    if (fid && fileOwnedBy(fid, tag)) return fid;
    return '';
  }

  const vehiclePhotoId = resolvePhoto(b.vehiclePhotoId || b.vehiclePhoto || b.rcUrl || b.rc);
  const platePhotoId = resolvePhoto(b.platePhotoId || b.platePhoto);
  const selfieId = resolvePhoto(b.selfieId || b.selfie || b.photo);
  const licenseId = resolvePhoto(b.licenseId || b.license);

  const apps = readAll('applications');
  for (let i = 0; i < apps.length; i++) {
    if (apps[i].phone === u.phone && apps[i].status === 'pending') {
      return { ok: true, pending: true, user: publicSelf(u) };
    }
  }

  const appliedAt = now();
  appendRow('applications', {
    id: shortId('app'), phone: u.phone, name: u.name,
    vehicle: vehicle, vehicleType: vehicleType,
    vehiclePhotoId: vehiclePhotoId, platePhotoId: platePhotoId,
    selfieId: selfieId, licenseId: licenseId, upiId: upiId, agreement: 'accepted',
    status: 'pending', notes: '',
    appliedAt: appliedAt, reviewedAt: '', reviewedBy: ''
  });

  updateRow('users', u._row, {
    vehicle: vehicle, vehicleType: vehicleType,
    vehiclePhotoId: vehiclePhotoId, platePhotoId: platePhotoId,
    agentStatus: 'pending', upiQrId: upiId
  });

  logAudit(u.phone, 'becomeAgent', vehicle);
  return { ok: true, pending: true, user: publicSelf(findUser(u.phone)) };
};

H.adminPendingAgents = function (b, u) {
  const apps = readAll('applications').filter(function (a) { return a.status === 'pending'; });
  return apps.map(function (a) {
    return {
      uid: a.phone, phone: a.phone, name: a.name,
      vehicle: a.vehicle, vehicleType: a.vehicleType,
      vehiclePhotoId: a.vehiclePhotoId, platePhotoId: a.platePhotoId,
      selfieId: a.selfieId, licenseId: a.licenseId, upiId: a.upiId,
      city: '', appliedAt: Number(a.appliedAt)
    };
  });
};

H.adminApproveAgent = function (b, u) {
  const targetPhone = String(b.uid || b.phone || '');
  const approve = b.approve !== false && b.approve !== 'false';

  const target = findUser(targetPhone);
  if (!target) throw new ApiError('not_found', 'User not found');

  const apps = readAll('applications');
  let appRow = null;
  for (let i = 0; i < apps.length; i++) {
    if (apps[i].phone === targetPhone && apps[i].status === 'pending') {
      appRow = apps[i];
      break;
    }
  }

  const reviewedAt = now();
  if (approve) {
    updateRow('users', target._row, { role: 'agent', agentStatus: 'active' });
    if (appRow) {
      updateRow('applications', appRow._row, {
        status: 'approved', reviewedAt: reviewedAt, reviewedBy: u.phone
      });
    }
    try { sendAgentApprovedEmail(target.email, target.name); } catch (e) {}
  } else {
    updateRow('users', target._row, { role: 'user', agentStatus: 'rejected' });
    if (appRow) {
      updateRow('applications', appRow._row, {
        status: 'rejected', notes: clean(b.reason, 500),
        reviewedAt: reviewedAt, reviewedBy: u.phone
      });
    }
    try { sendAgentRejectedEmail(target.email, target.name, b.reason || 'Documents were not valid.'); } catch (e) {}
  }

  logAudit(u.phone, approve ? 'approveAgent' : 'rejectAgent', targetPhone);
  return { ok: true };
};

H.adminRejectAgent = function (b, u) {
  return H.adminApproveAgent({ uid: b.uid || b.phone, approve: false, reason: b.reason }, u);
};

// ─── Lanes ───
function publicLane(l, me) {
  const own = !!me && l.ownerPhone === me.phone;
  const title = l.title || ((l.from ? l.from + ' → ' : '') + l.to) || 'Untitled Route';
  const description = l.description || l.via || '';

  return {
    id: l.id,
    driver: l.driver,
    ownerName: l.driver,
    vehicle: l.vehicle,
    vehicleType: l.vehicleType,
    title: title,
    description: description,
    photo: l.photoUrl || '',
    from: l.from, via: l.via, to: l.to,
    total: Number(l.total),
    seats: Math.max(0, Number(l.total) - Number(l.taken)),
    taken: Number(l.taken),
    fare: Number(l.fare),
    lat: own ? round(l.lat, 7) : round(l.lat, 3),
    lng: own ? round(l.lng, 7) : round(l.lng, 3),
    status: l.status,
    ts: Number(l.ts),
    createdAt: new Date(Number(l.ts)).toISOString(),
    peerId: l.peerId,
    lastSeen: Number(l.lastSeen),
    showPlate: l.showPlate || 'true',
    own: own
  };
}

function laneFields(row, user, existing) {
  const total = Math.round(toNum(row.total || row.seats, 1, 60, existing ? Number(existing.total) : 4));
  const taken = Math.round(toNum(row.taken, 0, total, existing ? Number(existing.taken) : 0));
  return {
    driver: user.name,
    vehicle: user.vehicle,
    vehicleType: VEHICLE_TYPES.indexOf(row.vehicleType) !== -1 ? row.vehicleType : (user.vehicleType || 'car'),
    title: clean(row.title, 120),
    description: clean(row.description, 300),
    photoUrl: clean(row.photo, 500),
    from: clean(row.from, 80),
    via: clean(row.via, 200),
    to: clean(row.to, 80),
    total: total, taken: taken,
    fare: Math.round(toNum(row.fare, 0, 10000, 0)),
    lat: coord(row.lat, 90), lng: coord(row.lng, 180),
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
  const row = b.row || b;
  if (!isId(row.id)) row.id = shortId('L');

  rateLimit(['lane:' + u.phone], 20, 3600);
  const lanes = readAll('lanes');
  const mine = lanes.filter(function (l) {
    return l.ownerPhone === u.phone && now() - Number(l.ts) < LANE_TTL_MS;
  });
  if (mine.length >= 5) throw new ApiError('lane_limit', 'Max 5 live lanes');

  const f = laneFields(row, u, null);
  const obj = { id: row.id, ownerPhone: u.phone, ts: now() };
  Object.keys(f).forEach(function (k) { obj[k] = f[k]; });
  appendRow('lanes', obj);

  logAudit(u.phone, 'insertLane', f.title || f.to);
  return publicLane(Object.assign({ id: row.id, ownerPhone: u.phone }, f), u);
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
  updateRow('lanes', l._row, laneFields(b.row || b, u, l));
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
    id: p.id, name: p.name, ownerName: p.name, avatar: p.avatar,
    title: p.title, text: p.text, tags: p.tags,
    photo: p.photoUrl || '',
    mediaUrl: p.mediaUrl || '',
    mediaType: p.mediaType || '',
    time: p.time, likes: Number(p.likes), ts: Number(p.ts),
    createdAt: new Date(Number(p.ts)).toISOString(),
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
  const r = b.row || b;
  if (!isId(r.id)) r.id = shortId('H');

  const title = clean(r.title, 80);
  const text = clean(String(r.text || '').replace(/\r/g, ''), 2000).trim() || title;
  if (!text && !r.photo && !r.mediaUrl) throw new ApiError('empty', 'Post cannot be empty');

  rateLimit(['hive:' + u.phone], 30, 3600);

  const tags = String(r.tags || '')
    .split('|')
    .map(function (t) { return clean(t, 24); })
    .filter(Boolean)
    .slice(0, 5)
    .join('|');

  const ts = now();
  const photoUrl = clean(r.photo, 500);
  const mediaUrl = clean(r.mediaUrl, 500);
  const mediaType = clean(r.mediaType, 20);

  appendRow('hive', {
    id: r.id, ownerPhone: u.phone, name: u.name,
    avatar: initials(u.name),
    title: title, text: text, tags: tags,
    time: 'just now', likes: 0, ts: ts,
    vehicle: u.vehicle,
    photoUrl: photoUrl,
    mediaUrl: mediaUrl,
    mediaType: mediaType
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
  const r = b.row || b;
  const patch = {};
  if (r.title !== undefined) patch.title = clean(r.title, 80);
  if (r.text !== undefined) patch.text = clean(r.text, 2000);
  if (r.photo !== undefined) patch.photoUrl = clean(r.photo, 500);
  if (r.mediaUrl !== undefined) patch.mediaUrl = clean(r.mediaUrl, 500);
  if (r.mediaType !== undefined) patch.mediaType = clean(r.mediaType, 20);
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
  if (/^local_[-0-9._a-z]{3,40}$/.test(id)) return { id: id, type: 'local' };
  if (/^local-[0-9a-z]{4,8}$/.test(id)) return { id: id, type: 'local' };
  if (/^[A-Za-z0-9_\-:.]{1,60}$/.test(id)) return { id: id, type: 'room' };
  throw new ApiError('bad_room');
}

H.sendMessage = function (b, u) {
  const r = b.row || b;
  const room = checkRoom(r.roomId, u);
  const text = clean(r.text, 1000);
  if (!text) throw new ApiError('empty');

  rateLimit(['msg:' + u.phone], 40, 60);

  appendRow('messages', {
    id: isId(r.id) ? r.id : shortId('m'),
    roomId: room.id, roomType: room.type,
    fromVehicle: u.vehicle, fromPhone: u.phone,
    sender: u.name, text: text,
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
      id: m.id, roomId: m.roomId, from: m.fromVehicle,
      sender: m.sender, text: m.text,
      seq: m.seq === '' ? null : Number(m.seq),
      ts: Number(m.ts),
      mine: m.fromPhone === u.phone
    };
  });
};

// ─── Presence ───
H.updatePresence = function (b, u) {
  const r = b.row || b;
  rateLimit(['pres:' + u.phone], 12, 60);

  const obj = {
    vehicle: u.vehicle, phone: u.phone, name: u.name,
    avatar: initials(u.name),
    peerId: /^steeradar-veh-[A-Z0-9-]{4,24}$/.test(String(r.peerId || '')) ? r.peerId : '',
    vehicleType: VEHICLE_TYPES.indexOf(r.vehicleType) !== -1 ? r.vehicleType : (u.vehicleType || 'car'),
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
      vehicle: p.vehicle, phone: p.phone, owner: p.phone,
      name: p.name, ownerName: p.name,