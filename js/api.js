/**
 * ============================================================================
 * STEERADAR API CLIENT (v2.0)
 * ============================================================================
 * Matches app.js v14.1 call signatures exactly.
 *
 * Public:
 *   • getters: api.token, api.phone, api.user, api.lastError
 *   • setSession({ phone, token, user })   — saves to localStorage
 *   • clearSession()                       — wipes session
 *   • checkSession()                       — { valid, user } | { valid:false }
 *   • login({ phone, password })           — { token, phone, user } or { error }
 *   • sendOtp(phone, email, purpose)       — { ok, sentTo } or { ok:false, error }
 *   • verifyOtp(phone, code)               — { ok, verified } or { ok:false, error }
 *   • register(data)                       — { token, phone, user } or { error }
 *   • uploadImage(base64, folder, name)    — { url, fileId, ... }
 *   • like(kind, id, delta)                — { likes, liked }
 *   • addHiveComment / listHiveComments / deleteHiveComment
 *   • … all other backend actions
 * ============================================================================
 */

import { logger } from './logger.js';

/* --------------------------- CONFIG --------------------------- */
const SHEET_API_URL =
  (typeof window !== 'undefined' && window.STEERADAR && window.STEERADAR.SHEET_API_URL) ||
  'https://script.google.com/macros/s/AKfycbwcATMRSXU-LogPvBJtvS2n6oxVa51o9d48F29s9FUe96C0X-VaV_KgqHvEVLNICfzr/exec';

const TIMEOUT_MS        = 25000;
const UPLOAD_TIMEOUT_MS = 90000;

/* --------------------------- SESSION --------------------------- */
const KEYS = {
  phone: 'steeradar-phone',
  token: 'steeradar-token',
  user:  'steeradar-user'
};

let _session = { phone: '', token: '', user: null };
let _lastError = '';

function _loadSession() {
  try {
    _session.phone = localStorage.getItem(KEYS.phone) || '';
    _session.token = localStorage.getItem(KEYS.token) || '';
    const u = localStorage.getItem(KEYS.user);
    _session.user = u ? JSON.parse(u) : null;
  } catch (e) {
    _session = { phone: '', token: '', user: null };
  }
}

function _saveSession() {
  try {
    if (_session.phone) localStorage.setItem(KEYS.phone, _session.phone);
    else                localStorage.removeItem(KEYS.phone);

    if (_session.token) localStorage.setItem(KEYS.token, _session.token);
    else                localStorage.removeItem(KEYS.token);

    if (_session.user)  localStorage.setItem(KEYS.user, JSON.stringify(_session.user));
    else                localStorage.removeItem(KEYS.user);
  } catch (e) {
    logger.warn('saveSession failed:', e);
  }
}

function _clearSessionSilent(reason) {
  _session = { phone: '', token: '', user: null };
  _saveSession();
  try {
    window.dispatchEvent(new CustomEvent('steeradar:signout', {
      detail: { reason: reason || 'unknown' }
    }));
  } catch (e) {}
}

_loadSession();

/* --------------------------- REQUEST CORE --------------------------- */
/**
 * Send a POST to the Apps Script endpoint.
 * Returns { data } on success, or { error, message, retry } on failure.
 */
async function _request(action, params, opts) {
  opts = opts || {};
  const timeout = opts.timeout || TIMEOUT_MS;

  const body = Object.assign({ action: action }, params || {});
  if (_session.phone) body.phone = _session.phone;
  if (_session.token) body.token = _session.token;

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeout);

  let res;
  try {
    res = await fetch(SHEET_API_URL, {
      method: 'POST',
      // text/plain avoids CORS preflight (Apps Script requires this)
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.name === 'AbortError') ? 'Request timed out' : ((e && e.message) || 'Network error');
    _lastError = msg;
    logger.warn('API ' + action + ' → ' + msg);
    return { error: 'network', message: msg };
  }
  clearTimeout(timer);

  if (!res.ok) {
    _lastError = 'Server error ' + res.status;
    logger.warn('API ' + action + ' → HTTP ' + res.status);
    return { error: 'http_' + res.status, message: _lastError };
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    _lastError = 'Malformed server response';
    return { error: 'bad_json', message: _lastError };
  }

  // Backend returns either { data: <handler return> } or { error, message, retry }
  if (json && json.error) {
    _lastError = json.message || json.error;

    // Auto-clear on auth failures
    if (json.error === 'unauthorized' || json.error === 'bad_session' || json.error === 'banned') {
      logger.warn('Session invalid — signing out (' + json.error + ')');
      _clearSessionSilent(json.error);
    }

    return { error: json.error, message: json.message || json.error, retry: json.retry };
  }

  return { data: (json && 'data' in json) ? json.data : json };
}

/* ============================================================================
   PUBLIC API
   ============================================================================ */

export const api = {

  /* ---------- Session getters (app.js reads these as properties) ---------- */
  get token()     { return _session.token; },
  get phone()     { return _session.phone; },
  get user()      { return _session.user; },
  get lastError() { return _lastError; },

  setSession: function (s) {
    if (!s) return;
    if (s.phone !== undefined) _session.phone = String(s.phone || '');
    if (s.token !== undefined) _session.token = String(s.token || '');
    if (s.user  !== undefined) _session.user  = s.user || null;
    _saveSession();
  },

  clearSession: function () {
    _clearSessionSilent('manual');
  },

  isSignedIn: function () {
    return !!(_session.phone && _session.token);
  },

  /* ---------- Core ping / debug ---------- */
  ping: function () {
    return _request('ping', {}, { timeout: 8000 });
  },

  debug: function () {
    return _request('debug', {}, { timeout: 8000 });
  },

  /* ---------- Auth ---------- */
  checkSession: async function () {
    if (!_session.phone || !_session.token) return { valid: false };
    const r = await _request('checkSession');
    if (r.error) return { valid: false, error: r.error };
    return r.data || { valid: false };
  },

  sendOtp: async function (phone, email, purpose) {
    const r = await _request('sendOtp', {
      phone: phone, email: email, purpose: purpose || 'register'
    });
    if (r.error) return { ok: false, error: r.error, message: r.message, retry: r.retry };
    return r.data;
  },

  verifyOtp: async function (phone, code) {
    const r = await _request('verifyOtp', { phone: phone, code: code });
    if (r.error) return { ok: false, error: r.error, message: r.message };
    return r.data;
  },

  register: async function (data) {
    const r = await _request('register', data);
    if (r.error) return { error: r.error, message: r.message };
    return r.data;
  },

  login: async function (creds) {
    // creds = { phone: identity, password }
    const r = await _request('login', creds);
    if (r.error) return { error: r.error, message: r.message };
    return r.data;
  },

  logout: async function () {
    const r = await _request('logout');
    _clearSessionSilent('logout');
    return r;
  },

  /* ---------- Profile ---------- */
  getMe: async function () {
    const r = await _request('getMe');
    if (r.error) return null;
    if (r.data) _session.user = r.data;
    _saveSession();
    return r.data;
  },

  updateMe: async function (patch) {
    const r = await _request('updateMe', { patch: patch });
    if (r.error) return null;
    if (r.data) _session.user = r.data;
    _saveSession();
    return r.data;
  },

  setPassword: async function (password, oldPassword) {
    const r = await _request('setPassword', { password: password, oldPassword: oldPassword });
    return r.error ? null : r.data;
  },

  /* ---------- SteerAgent ---------- */
  becomeAgent: async function (data) {
    const r = await _request('becomeAgent', data);
    if (r.error) return null;
    return r.data;
  },

  /* ---------- Lanes ---------- */
  listLanes: async function () {
    const r = await _request('listLanes');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  insertLane: async function (row) {
    const r = await _request('insertLane', { row: row });
    return r.error ? null : r.data;
  },

  removeLane: async function (id) {
    const r = await _request('removeLane', { id: id });
    return r.error ? null : r.data;
  },

  /* ---------- Hive ---------- */
  listHive: async function () {
    const r = await _request('listHive');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  insertHive: async function (row) {
    const r = await _request('insertHive', { row: row });
    return r.error ? null : r.data;
  },

  deleteHive: async function (id) {
    const r = await _request('deleteHive', { id: id });
    return r.error ? null : r.data;
  },

  /**
   * Like / unlike a post.
   * app.js signature: api.like('hive', postId, delta)
   */
  like: async function (kind, id, delta) {
    const r = await _request('like', { id: id, delta: delta });
    return r.error ? null : r.data;
  },

  /* ---------- Hive Comments (v14) ---------- */
  addHiveComment: async function (postId, text) {
    const r = await _request('addHiveComment', { postId: postId, text: text });
    return r.error ? { ok: false, error: r.error } : r.data;
  },

  listHiveComments: async function (postId, limit) {
    const r = await _request('listHiveComments', {
      postId: postId, limit: limit || 100
    });
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  deleteHiveComment: async function (id) {
    const r = await _request('deleteHiveComment', { id: id });
    return r.error ? null : r.data;
  },

  /* ---------- Messages ---------- */
  getMessages: async function (roomId, limit) {
    const r = await _request('getMessages', {
      roomId: roomId, limit: limit || 50
    });
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  sendMessage: async function (row) {
    const r = await _request('sendMessage', { row: row });
    return r.error ? null : r.data;
  },

  /* ---------- Presence ---------- */
  updatePresence: async function (data) {
    const r = await _request('updatePresence', { row: data });
    return r.error ? null : r.data;
  },

  activeVehicles: async function () {
    const r = await _request('activeVehicles');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  removePresence: async function () {
    const r = await _request('removePresence');
    return r.error ? null : r.data;
  },

  /* ---------- Trips ---------- */
  startTrip: async function (data) {
    const r = await _request('startTrip', { data: data });
    return r.error ? null : r.data;
  },

  endTrip: async function (id, data) {
    const payload = Object.assign({ id: id }, data || {});
    const r = await _request('endTrip', payload);
    return r.error ? null : r.data;
  },

  myTrips: async function () {
    const r = await _request('myTrips');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  /* ---------- Points ---------- */
  savePoint: async function (row) {
    const r = await _request('savePoint', { row: row });
    return r.error ? null : r.data;
  },

  myPoints: async function () {
    const r = await _request('myPoints');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  deletePoint: async function (id) {
    const r = await _request('deletePoint', { id: id });
    return r.error ? null : r.data;
  },

  /* ---------- Images ---------- */
  /**
   * Upload an image.
   * app.js signature: api.uploadImage(base64, folder, filename)
   *   base64   → data URL ("data:image/jpeg;base64,...") OR raw base64
   *   folder   → 'lanes' | 'hive' | 'avatars' | 'vehicles' | 'misc'
   *   filename → used only for the stored file name
   * Returns { fileId, url, thumbUrl, viewUrl, mimeType, size } or null.
   */
  uploadImage: async function (base64, folder, filename) {
    const r = await _request('uploadImage', {
      base64: base64,
      folder: folder || 'misc',
      filename: filename || ''
    }, { timeout: UPLOAD_TIMEOUT_MS });
    return r.error ? null : r.data;
  },

  deleteImage: async function (fileId) {
    const r = await _request('deleteImage', { fileId: fileId });
    return r.error ? null : r.data;
  },

  /* ---------- Admin ---------- */
  adminPendingAgents: async function () {
    const r = await _request('adminPendingAgents');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  adminApproveAgent: async function (uid, approve, reason) {
    const r = await _request('adminApproveAgent', {
      uid: uid,
      approve: approve !== false,
      reason: reason || ''
    });
    return r.error ? null : r.data;
  },

  adminRejectAgent: async function (uid, reason) {
    const r = await _request('adminRejectAgent', {
      uid: uid, reason: reason || ''
    });
    return r.error ? null : r.data;
  },

  /* ---------- Reports / Alerts ---------- */
  /**
   * app.js signature: api.reportAlert({ type, lat, lng })
   * Backend action is `reportUser` (needs reason + optional target vehicle).
   */
  reportAlert: async function (data) {
    data = data || {};
    const r = await _request('reportUser', {
      vehicle: data.vehicle || '',
      reason: data.type || 'alert',
      detail: (data.lat != null ? String(data.lat) : '') + ',' +
              (data.lng != null ? String(data.lng) : '')
    });
    return r.error ? null : r.data;
  },

  reportUser: async function (vehicle, reason, detail) {
    const r = await _request('reportUser', {
      vehicle: vehicle, reason: reason, detail: detail
    });
    return r.error ? null : r.data;
  }
};

/* --------------------------- DEFAULT EXPORT --------------------------- */
export default api;

/* --------------------------- LOG --------------------------- */
console.log('[api] v2.0 loaded →', SHEET_API_URL.slice(0, 60) + '…');