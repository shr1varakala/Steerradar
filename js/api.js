/* ============================================================================
   STEERADAR API CLIENT (v3.0)
   ============================================================================
   Pairs with backend code.gs v8.11+
   Features:
     • Universal request() with token, timeout, retry
     • Auto-clears session on 401-family errors (fires 'steeradar:signout')
     • Exposes every backend action as a typed method
     • uploadImage accepts File | Blob | dataURL | base64
     • Client-side image compression for large files
     • Hive comments + share-URL helpers
   ============================================================================ */

import { logger } from './logger.js';

/* --------------------------- CONFIG --------------------------- */
// Prefer window.CONFIG if config.js exports one, else fallback.
const SHEET_API_URL =
  (typeof window !== 'undefined' && window.CONFIG && window.CONFIG.SHEET_API_URL) ||
  'https://script.google.com/macros/s/AKfycbwcATMRSXU-LogPvBJtvS2n6oxVa51o9d48F29s9FUe96C0X-VaV_KgqHvEVLNICfzr/exec';

const DEFAULT_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 90000;
const MAX_UPLOAD_B64_CHARS = 10000000; // matches backend limit (~7 MB binary)
const COMPRESS_THRESHOLD_BYTES = 3 * 1024 * 1024; // compress files > 3 MB
const COMPRESS_MAX_DIMENSION = 1600; // longest edge after compression
const COMPRESS_QUALITY = 0.82;

/* --------------------------- SESSION --------------------------- */
const STORAGE_KEYS = {
  phone: 'steeradar-phone',
  token: 'steeradar-token',
  user:  'steeradar-user'
};

let session = {
  phone: '',
  token: '',
  user: null
};

function loadSession() {
  try {
    session.phone = localStorage.getItem(STORAGE_KEYS.phone) || '';
    session.token = localStorage.getItem(STORAGE_KEYS.token) || '';
    const u = localStorage.getItem(STORAGE_KEYS.user);
    session.user = u ? JSON.parse(u) : null;
  } catch (e) {
    session = { phone: '', token: '', user: null };
  }
}

function saveSession() {
  try {
    if (session.phone) localStorage.setItem(STORAGE_KEYS.phone, session.phone);
    else localStorage.removeItem(STORAGE_KEYS.phone);

    if (session.token) localStorage.setItem(STORAGE_KEYS.token, session.token);
    else localStorage.removeItem(STORAGE_KEYS.token);

    if (session.user) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(session.user));
    else localStorage.removeItem(STORAGE_KEYS.user);
  } catch (e) {
    logger.warn('saveSession failed:', e);
  }
}

function clearSession(opts) {
  session.phone = '';
  session.token = '';
  session.user = null;
  saveSession();

  // Notify the app
  try {
    window.dispatchEvent(new CustomEvent('steeradar:signout', { detail: opts || {} }));
  } catch (e) {}

  logger.info('Session cleared', opts && opts.reason ? '(' + opts.reason + ')' : '');
}

loadSession();

/* --------------------------- ERRORS --------------------------- */
export class ApiError extends Error {
  constructor(code, message, retry) {
    super(message || code || 'Request failed');
    this.name = 'ApiError';
    this.code = code || 'server_error';
    this.retry = retry || null;
  }
}

/* --------------------------- REQUEST CORE --------------------------- */
async function request(action, params, opts) {
  opts = opts || {};
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const retry = opts.retry !== false && action !== 'ping';

  const body = Object.assign(
    { action: action },
    params || {}
  );

  // Attach session credentials when available
  if (session.phone) body.phone = session.phone;
  if (session.token) body.token = session.token;

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeout);

  let res;
  try {
    res = await fetch(SHEET_API_URL, {
      method: 'POST',
      // text/plain avoids preflight — Apps Script requires this
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      throw new ApiError('timeout', 'Request timed out', 2);
    }
    throw new ApiError('network', e && e.message ? e.message : 'Network error', 3);
  }
  clearTimeout(timer);

  if (!res.ok) {
    // Try a single retry on 5xx
    if (retry && res.status >= 500) {
      logger.warn('API ' + action + ' HTTP ' + res.status + ' — retrying once');
      return request(action, params, Object.assign({}, opts, { retry: false, timeout: timeout }));
    }
    throw new ApiError('http_' + res.status, 'Server error (' + res.status + ')', 5);
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new ApiError('bad_json', 'Malformed server response');
  }

  // Backend returns { data } or { error, message, retry }
  if (json && typeof json === 'object' && 'error' in json && json.error) {
    const err = new ApiError(json.error, json.message || json.error, json.retry || null);

    // Auto-clear session on auth failures
    if (err.code === 'unauthorized' || err.code === 'bad_session' || err.code === 'banned') {
      clearSession({ reason: err.code });
    }

    // Auto-retry on rate_limited with wait
    if (retry && err.code === 'rate_limited' && json.retry && json.retry <= 5) {
      await new Promise(function (r) { setTimeout(r, json.retry * 1000); });
      return request(action, params, Object.assign({}, opts, { retry: false }));
    }

    throw err;
  }

  return json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json;
}

/* --------------------------- IMAGE HELPERS --------------------------- */
function fileToDataUrl(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || '')); };
    reader.onerror = function () { reject(new Error('Failed to read file')); };
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error('Image decode failed')); };
    img.src = src;
  });
}

/**
 * Compress an image file client-side if it's too large.
 * Returns a data URL (JPEG unless source was PNG with transparency).
 */
async function compressImageFile(file) {
  const dataUrl = await fileToDataUrl(file);

  // Under threshold — just return as-is
  if (file.size <= COMPRESS_THRESHOLD_BYTES) return dataUrl;

  const img = await loadImage(dataUrl);
  const maxDim = COMPRESS_MAX_DIMENSION;
  let w = img.naturalWidth;
  let h = img.naturalHeight;

  if (w > maxDim || h > maxDim) {
    if (w >= h) { h = Math.round(h * (maxDim / w)); w = maxDim; }
    else        { w = Math.round(w * (maxDim / h)); h = maxDim; }
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  // Use PNG only if source was PNG (preserve transparency), else JPEG
  const isPng = file.type === 'image/png';
  const outType = isPng ? 'image/png' : 'image/jpeg';
  const outQuality = isPng ? undefined : COMPRESS_QUALITY;

  let compressed = canvas.toDataURL(outType, outQuality);

  // If compression somehow made it bigger, fall back to original
  if (compressed.length > dataUrl.length) return dataUrl;

  logger.info('Compressed ' + Math.round(file.size / 1024) + ' KB → ' +
              Math.round(compressed.length / 1024) + ' KB');
  return compressed;
}

/**
 * Normalize an image source to a dataURL ready for upload.
 * Accepts: File | Blob | HTMLImageElement | dataURL string | raw base64
 */
async function normalizeImageSource(src) {
  if (!src) throw new ApiError('bad_image', 'No image provided');

  // File / Blob
  if (src instanceof File || src instanceof Blob) {
    return compressImageFile(src);
  }

  // data URL / raw base64
  if (typeof src === 'string') {
    if (src.indexOf('data:') === 0) return src;
    // Assume raw base64 → wrap as JPEG
    if (/^[A-Za-z0-9+/=\s]+$/.test(src)) {
      return 'data:image/jpeg;base64,' + src.replace(/\s+/g, '');
    }
  }

  throw new ApiError('bad_image', 'Unsupported image source');
}

/* ============================================================================
   PUBLIC API
   ============================================================================ */

export const api = {

  /* ---------------- SESSION ---------------- */
  getSession: function () { return Object.assign({}, session); },
  getPhone:   function () { return session.phone; },
  getToken:   function () { return session.token; },
  getUser:    function () { return session.user; },
  isSignedIn: function () { return !!(session.phone && session.token); },

  setSession: function (phone, token, user) {
    session.phone = String(phone || '');
    session.token = String(token || '');
    session.user = user || null;
    saveSession();
  },

  setUser: function (user) {
    session.user = user || null;
    saveSession();
  },

  signOut: function () {
    clearSession({ reason: 'manual' });
  },

  /* ---------------- CORE ---------------- */
  request: request,

  ping: function () {
    return request('ping', {}, { retry: false, timeout: 8000 });
  },

  debug: function () {
    return request('debug', {}, { retry: false });
  },

  /* ---------------- AUTH ---------------- */
  sendOtp: function (phone, email, purpose) {
    return request('sendOtp', { phone: phone, email: email, purpose: purpose || 'register' });
  },

  verifyOtp: function (phone, code) {
    return request('verifyOtp', { phone: phone, code: code });
  },

  register: function (data) {
    return request('register', data).then(function (res) {
      if (res && res.token && res.phone) {
        api.setSession(res.phone, res.token, res.user);
      }
      return res;
    });
  },

  login: function (identity, password) {
    return request('login', { phone: identity, password: password }).then(function (res) {
      if (res && res.token && res.phone) {
        api.setSession(res.phone, res.token, res.user);
      }
      return res;
    });
  },

  loginWithOtp: function (phone, code, device) {
    return request('login', { phone: phone, code: code, device: device }).then(function (res) {
      if (res && res.token && res.phone) {
        api.setSession(res.phone, res.token, res.user);
      }
      return res;
    });
  },

  logout: function () {
    return request('logout', {}).finally(function () {
      clearSession({ reason: 'logout' });
    });
  },

  checkSession: function () {
    if (!session.phone || !session.token) return Promise.resolve({ valid: false });
    return request('checkSession', {}, { retry: false }).then(function (res) {
      if (res && res.valid && res.user) api.setUser(res.user);
      return res;
    }).catch(function () {
      return { valid: false };
    });
  },

  /* ---------------- PROFILE ---------------- */
  getMe: function () {
    return request('getMe', {}).then(function (u) {
      api.setUser(u);
      return u;
    });
  },

  updateMe: function (patch) {
    return request('updateMe', { patch: patch }).then(function (u) {
      api.setUser(u);
      return u;
    });
  },

  setPassword: function (password, oldPassword) {
    return request('setPassword', { password: password, oldPassword: oldPassword });
  },

  /* ---------------- STEERAGENT ---------------- */
  becomeAgent: function (data) {
    return request('becomeAgent', data).then(function (res) {
      if (res && res.user) api.setUser(res.user);
      return res;
    });
  },

  /* ---------------- LANES ---------------- */
  listLanes: function () {
    return request('listLanes', {}, { retry: false });
  },

  insertLane: function (row) {
    return request('insertLane', { row: row });
  },

  updateLane: function (id, row) {
    return request('updateLane', Object.assign({ id: id }, row || {}));
  },

  removeLane: function (id) {
    return request('removeLane', { id: id });
  },

  /* ---------------- HIVE ---------------- */
  listHive: function () {
    return request('listHive', {}, { retry: false });
  },

  insertHive: function (row) {
    return request('insertHive', { row: row });
  },

  updateHive: function (id, row) {
    return request('updateHive', Object.assign({ id: id }, row || {}));
  },

  deleteHive: function (id) {
    return request('deleteHive', { id: id });
  },

  /**
   * Toggle like. Pass current state → we send the correct delta.
   */
  likeToggle: function (postId, currentlyLiked) {
    const delta = currentlyLiked ? -1 : 1;
    return request('like', { id: postId, delta: delta });
  },

  /* ---------------- HIVE COMMENTS ---------------- */
  addHiveComment: function (postId, text) {
    return request('addHiveComment', { postId: postId, text: text });
  },

  listHiveComments: function (postId, limit) {
    return request('listHiveComments', { postId: postId, limit: limit || 100 }, { retry: false });
  },

  deleteHiveComment: function (commentId) {
    return request('deleteHiveComment', { id: commentId });
  },

  /* ---------------- SHARE ---------------- */
  getShareUrl: function (postId) {
    const base = (typeof location !== 'undefined' && location.origin && location.pathname) || '';
    return base + '#hive/' + encodeURIComponent(postId);
  },

  /* ---------------- MESSAGES ---------------- */
  getMessages: function (roomId, limit) {
    return request('getMessages', { roomId: roomId, limit: limit || 50 }, { retry: false });
  },

  sendMessage: function (row) {
    return request('sendMessage', { row: row });
  },

  /* ---------------- PRESENCE ---------------- */
  updatePresence: function (row) {
    return request('updatePresence', { row: row }, { retry: false });
  },

  activeVehicles: function () {
    return request('activeVehicles', {}, { retry: false });
  },

  removePresence: function () {
    return request('removePresence', {});
  },

  /* ---------------- TRIPS ---------------- */
  startTrip: function (data) {
    return request('startTrip', { data: data });
  },

  endTrip: function (id, data) {
    return request('endTrip', Object.assign({ id: id }, data || {}));
  },

  myTrips: function () {
    return request('myTrips', {}, { retry: false });
  },

  /* ---------------- POINTS ---------------- */
  savePoint: function (row) {
    return request('savePoint', { row: row });
  },

  myPoints: function () {
    return request('myPoints', {}, { retry: false });
  },

  listPoints: function () {
    return request('listPoints', {}, { retry: false });
  },

  deletePoint: function (id) {
    return request('deletePoint', { id: id });
  },

  /* ---------------- IMAGES ---------------- */
  /**
   * Upload an image. Accepts:
   *   - File / Blob (from <input type="file">)
   *   - dataURL string ("data:image/jpeg;base64,...")
   *   - raw base64 string
   *
   * Auto-compresses files larger than 3 MB.
   */
  uploadImage: async function (src, opts) {
    opts = opts || {};
    const dataUrl = await normalizeImageSource(src);

    // Size guard
    if (dataUrl.length > MAX_UPLOAD_B64_CHARS) {
      throw new ApiError('too_large', 'Image is too large after compression');
    }

    const body = {
      base64: dataUrl,
      folder: opts.folder || 'misc',
      filename: opts.filename || ''
    };

    return request('uploadImage', body, { timeout: UPLOAD_TIMEOUT_MS, retry: false });
  },

  deleteImage: function (fileId) {
    return request('deleteImage', { fileId: fileId });
  },

  /* ---------------- ADMIN ---------------- */
  adminPendingAgents: function () {
    return request('adminPendingAgents', {}, { retry: false });
  },

  adminApproveAgent: function (uid, approve, reason) {
    return request('adminApproveAgent', {
      uid: uid,
      approve: approve !== false,
      reason: reason || ''
    });
  },

  adminRejectAgent: function (uid, reason) {
    return request('adminRejectAgent', { uid: uid, reason: reason || '' });
  },

  /* ---------------- REPORTS ---------------- */
  reportUser: function (vehicle, reason, detail) {
    return request('reportUser', { vehicle: vehicle, reason: reason, detail: detail });
  }
};

/* --------------------------- NAMED EXPORTS --------------------------- */
// Some app.js files prefer named imports
export const {
  ping, debug,
  sendOtp, verifyOtp, register, login, logout, checkSession,
  getMe, updateMe, setPassword,
  becomeAgent,
  listLanes, insertLane, updateLane, removeLane,
  listHive, insertHive, updateHive, deleteHive, likeToggle,
  addHiveComment, listHiveComments, deleteHiveComment,
  getShareUrl,
  getMessages, sendMessage,
  updatePresence, activeVehicles, removePresence,
  startTrip, endTrip, myTrips,
  savePoint, myPoints, listPoints, deletePoint,
  uploadImage, deleteImage,
  adminPendingAgents, adminApproveAgent, adminRejectAgent,
  reportUser
} = api;

export default api;