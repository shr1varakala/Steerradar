/**
 * ============================================================================
 * STEERADAR API CLIENT (v2.1)
 * ============================================================================
 * v2.1 changes:
 *   • AbortController now uses a reason string — no more
 *     "signal is aborted without reason" log spam
 *   • Per-action timeouts: FAST 10s · NORMAL 25s · SLOW 30s · UPLOAD 90s
 *   • Retry policy: one retry on timeout, no retry on user cancel / HTTP 4xx
 *   • Errors always carry { code, message, retry, action }
 *   • Request failures now surface the action name — much easier to debug
 * ============================================================================
 */

import { logger } from './logger.js';

/* --------------------------- CONFIG --------------------------- */
const SHEET_API_URL =
  (typeof window !== 'undefined' && window.STEERADAR && window.STEERADAR.SHEET_API_URL) ||
  'https://script.google.com/macros/s/AKfycbwcATMRSXU-LogPvBJtvS2n6oxVa51o9d48F29s9FUe96C0X-VaV_KgqHvEVLNICfzr/exec';

const TIMEOUTS = {
  FAST:   10000, // ping, checkSession, logout
  NORMAL: 25000, // default
  SLOW:   35000, // listHive, listLanes, activeVehicles, myTrips, uploads metadata
  UPLOAD: 90000  // image uploads
};

/**
 * Which actions need a longer timeout.
 * Everything else uses NORMAL.
 */
const ACTION_TIMEOUTS = {
  ping:           TIMEOUTS.FAST,
  checkSession:   TIMEOUTS.FAST,
  logout:         TIMEOUTS.FAST,
  debug:          TIMEOUTS.FAST,

  listHive:       TIMEOUTS.SLOW,
  listLanes:      TIMEOUTS.SLOW,
  activeVehicles: TIMEOUTS.SLOW,
  myTrips:        TIMEOUTS.SLOW,
  myPoints:       TIMEOUTS.SLOW,
  listPoints:     TIMEOUTS.SLOW,
  adminPendingAgents: TIMEOUTS.SLOW,

  uploadImage:    TIMEOUTS.UPLOAD
};

const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 2000;

/* --------------------------- SESSION --------------------------- */
const KEYS = {
  phone: 'steeradar-phone',
  token: 'steeradar-token',
  user:  'steeradar-user'
};

let _session = { phone: '', token: '', user: null };
let _lastError = '';
let _lastErrorAction = '';

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

function _timeoutFor(action, override) {
  if (override && override.timeout) return override.timeout;
  return ACTION_TIMEOUTS[action] || TIMEOUTS.NORMAL;
}

/**
 * Single fetch attempt.
 * Returns { ok:true, data } or { ok:false, error:{ code, message, retry, abort } }
 */
async function _attempt(action, params, timeoutMs) {
  const body = Object.assign({ action: action }, params || {});
  if (_session.phone) body.phone = _session.phone;
  if (_session.token) body.token = _session.token;

  const controller = new AbortController();
  const reason = 'steeradar_timeout_' + action + '_' + timeoutMs + 'ms';
  const timer = setTimeout(function () {
    // Provide a reason so the error message is meaningful
    try { controller.abort(reason); } catch (e) { controller.abort(); }
  }, timeoutMs);

  let res;
  try {
    res = await fetch(SHEET_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (e) {
    clearTimeout(timer);

    // AbortError — the user's or our timeout, not a network fault
    if (e && (e.name === 'AbortError' || e.code === 20)) {
      return {
        ok: false,
        error: {
          code: 'timeout',
          message: 'Request timed out after ' + Math.round(timeoutMs / 1000) + 's',
          retry: 3,
          abort: true
        }
      };
    }

    return {
      ok: false,
      error: {
        code: 'network',
        message: (e && e.message) ? e.message : 'Network error',
        retry: 5
      }
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    // HTTP error — 5xx is retryable, 4xx is not
    const retry = res.status >= 500 ? 5 : null;
    return {
      ok: false,
      error: {
        code: 'http_' + res.status,
        message: 'Server error (' + res.status + ')',
        retry: retry
      }
    };
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    return {
      ok: false,
      error: { code: 'bad_json', message: 'Malformed server response', retry: null }
    };
  }

  if (json && json.error) {
    // Auto-clear on auth failure
    if (json.error === 'unauthorized' || json.error === 'bad_session' || json.error === 'banned') {
      _clearSessionSilent(json.error);
    }
    return {
      ok: false,
      error: {
        code: json.error,
        message: json.message || json.error,
        retry: json.retry || null
      }
    };
  }

  return { ok: true, data: (json && 'data' in json) ? json.data : json };
}

/**
 * Public request with retry.
 */
async function _request(action, params, opts) {
  opts = opts || {};
  const timeoutMs = _timeoutFor(action, opts);
  const maxRetries = (opts.retry === false) ? 0 : MAX_RETRIES;

  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await _attempt(action, params, timeoutMs);

    if (r.ok) return { data: r.data };

    lastErr = r.error;

    // Decide whether to retry
    const shouldRetry =
      attempt < maxRetries &&
      lastErr &&
      lastErr.retry &&
      // Never retry auth/bad-request errors
      lastErr.code !== 'unauthorized' &&
      lastErr.code !== 'bad_session' &&
      lastErr.code !== 'banned' &&
      !/^http_4/.test(lastErr.code);

    if (!shouldRetry) break;

    logger.warn(
      'API ' + action + ' → ' + lastErr.message +
      ' — retrying in ' + RETRY_BACKOFF_MS + 'ms (attempt ' + (attempt + 2) + '/' + (maxRetries + 1) + ')'
    );

    await new Promise(function (resolve) { setTimeout(resolve, RETRY_BACKOFF_MS); });
  }

  _lastError = (lastErr && lastErr.message) || 'Request failed';
  _lastErrorAction = action;

  // Only log the final failure once
  if (lastErr && lastErr.code !== 'timeout') {
    logger.warn('API ' + action + ' failed: ' + _lastError);
  } else if (lastErr) {
    logger.warn('API ' + action + ' timed out');
  }

  return {
    error: lastErr ? lastErr.code : 'unknown',
    message: _lastError,
    retry: lastErr ? lastErr.retry : null
  };
}

/* ============================================================================
   PUBLIC API
   ============================================================================ */

export const api = {

  /* ---------- Session getters ---------- */
  get token()           { return _session.token; },
  get phone()           { return _session.phone; },
  get user()            { return _session.user; },
  get lastError()       { return _lastError; },
  get lastErrorAction() { return _lastErrorAction; },

  setSession: function (s) {
    if (!s) return;
    if (s.phone !== undefined) _session.phone = String(s.phone || '');
    if (s.token !== undefined) _session.token = String(s.token || '');
    if (s.user  !== undefined) _session.user  = s.user || null;
    _saveSession();
  },

  clearSession: function () { _clearSessionSilent('manual'); },

  isSignedIn: function () { return !!(_session.phone && _session.token); },

  /* ---------- Core ---------- */
  ping: function () {
    return _request('ping', {}, { retry: false });
  },

  debug: function () {
    return _request('debug', {}, { retry: false });
  },

  /* ---------- Auth ---------- */
  checkSession: async function () {
    if (!_session.phone || !_session.token) return { valid: false };
    const r = await _request('checkSession', {}, { retry: false });
    if (r.error) return { valid: false, error: r.error };
    return r.data || { valid: false };
  },

  sendOtp: async function (phone, email, purpose) {
    const r = await _request('sendOtp', {
      phone: phone, email: email, purpose: purpose || 'register'
    }, { retry: false });
    if (r.error) return { ok: false, error: r.error, message: r.message, retry: r.retry };
    return r.data;
  },

  verifyOtp: async function (phone, code) {
    const r = await _request('verifyOtp', { phone: phone, code: code }, { retry: false });
    if (r.error) return { ok: false, error: r.error, message: r.message };
    return r.data;
  },

  register: async function (data) {
    const r = await _request('register', data, { retry: false });
    if (r.error) return { error: r.error, message: r.message };
    return r.data;
  },

  login: async function (creds) {
    const r = await _request('login', creds, { retry: false });
    if (r.error) return { error: r.error, message: r.message };
    return r.data;
  },

  logout: async function () {
    const r = await _request('logout', {}, { retry: false });
    _clearSessionSilent('logout');
    return r;
  },

  /* ---------- Profile ---------- */
  getMe: async function () {
    const r = await _request('getMe');
    if (r.error) return null;
    if (r.data) { _session.user = r.data; _saveSession(); }
    return r.data;
  },

  updateMe: async function (patch) {
    const r = await _request('updateMe', { patch: patch }, { retry: false });
    if (r.error) return null;
    if (r.data) { _session.user = r.data; _saveSession(); }
    return r.data;
  },

  setPassword: async function (password, oldPassword) {
    const r = await _request('setPassword', { password: password, oldPassword: oldPassword }, { retry: false });
    return r.error ? null : r.data;
  },

  /* ---------- SteerAgent ---------- */
  becomeAgent: async function (data) {
    const r = await _request('becomeAgent', data, { retry: false });
    if (r.error) return null;
    return r.data;
  },

  /* ---------- Lanes ---------- */
  listLanes: async function () {
    const r = await _request('listLanes');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  insertLane: async function (row) {
    const r = await _request('insertLane', { row: row }, { retry: false });
    return r.error ? null : r.data;
  },

  removeLane: async function (id) {
    const r = await _request('removeLane', { id: id }, { retry: false });
    return r.error ? null : r.data;
  },

  updateLane: async function (id, row) {
    const payload = Object.assign({ id: id }, row || {});
    const r = await _request('updateLane', payload, { retry: false });
    return r.error ? null : r.data;
  },

  /* ---------- Hive ---------- */
  listHive: async function () {
    const r = await _request('listHive');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  insertHive: async function (row) {
    const r = await _request('insertHive', { row: row }, { retry: false });
    return r.error ? null : r.data;
  },

  updateHive: async function (id, row) {
    const payload = Object.assign({ id: id }, row || {});
    const r = await _request('updateHive', payload, { retry: false });
    return r.error ? null : r.data;
  },

  deleteHive: async function (id) {
    const r = await _request('deleteHive', { id: id }, { retry: false });
    return r.error ? null : r.data;
  },

  like: async function (kind, id, delta) {
    const r = await _request('like', { id: id, delta: delta }, { retry: false });
    return r.error ? null : r.data;
  },

  /* ---------- Hive Comments ---------- */
  addHiveComment: async function (postId, text) {
    const r = await _request('addHiveComment', { postId: postId, text: text }, { retry: false });
    return r.error ? { ok: false, error: r.error } : r.data;
  },

  listHiveComments: async function (postId, limit) {
    const r = await _request('listHiveComments', {
      postId: postId, limit: limit || 100
    });
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  deleteHiveComment: async function (id) {
    const r = await _request('deleteHiveComment', { id: id }, { retry: false });
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
    const r = await _request('sendMessage', { row: row }, { retry: false });
    return r.error ? null : r.data;
  },

  /* ---------- Presence ---------- */
  updatePresence: async function (data) {
    const r = await _request('updatePresence', { row: data }, {
      retry: false,
      timeout: TIMEOUTS.FAST // presence is fire-and-forget, don't wait 25s
    });
    return r.error ? null : r.data;
  },

  activeVehicles: async function () {
    const r = await _request('activeVehicles');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  removePresence: async function () {
    const r = await _request('removePresence', {}, { retry: false });
    return r.error ? null : r.data;
  },

  /* ---------- Trips ---------- */
  startTrip: async function (data) {
    const r = await _request('startTrip', { data: data }, { retry: false });
    return r.error ? null : r.data;
  },

  endTrip: async function (id, data) {
    const payload = Object.assign({ id: id }, data || {});
    const r = await _request('endTrip', payload, { retry: false });
    return r.error ? null : r.data;
  },

  myTrips: async function () {
    const r = await _request('myTrips');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  /* ---------- Points ---------- */
  savePoint: async function (row) {
    const r = await _request('savePoint', { row: row }, { retry: false });
    return r.error ? null : r.data;
  },

  myPoints: async function () {
    const r = await _request('myPoints');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  listPoints: async function () {
    const r = await _request('listPoints');
    return r.error ? [] : (Array.isArray(r.data) ? r.data : []);
  },

  deletePoint: async function (id) {
    const r = await _request('deletePoint', { id: id }, { retry: false });
    return r.error ? null : r.data;
  },

  /* ---------- Images ---------- */
  uploadImage: async function (base64, folder, filename) {
    const r = await _request('uploadImage', {
      base64: base64,
      folder: folder || 'misc',
      filename: filename || ''
    }, { timeout: TIMEOUTS.UPLOAD, retry: false });
    return r.error ? null : r.data;
  },

  deleteImage: async function (fileId) {
    const r = await _request('deleteImage', { fileId: fileId }, { retry: false });
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
    }, { retry: false });
    return r.error ? null : r.data;
  },

  adminRejectAgent: async function (uid, reason) {
    const r = await _request('adminRejectAgent', {
      uid: uid, reason: reason || ''
    }, { retry: false });
    return r.error ? null : r.data;
  },

  /* ---------- Reports / Alerts ---------- */
  reportAlert: async function (data) {
    data = data || {};
    const r = await _request('reportUser', {
      vehicle: data.vehicle || '',
      reason: data.type || 'alert',
      detail: (data.lat != null ? String(data.lat) : '') + ',' +
              (data.lng != null ? String(data.lng) : '')
    }, { retry: false });
    return r.error ? null : r.data;
  },

  reportUser: async function (vehicle, reason, detail) {
    const r = await _request('reportUser', {
      vehicle: vehicle, reason: reason, detail: detail
    }, { retry: false });
    return r.error ? null : r.data;
  }
};

export default api;

console.log('[api] v2.1 loaded →', SHEET_API_URL.slice(0, 60) + '…');