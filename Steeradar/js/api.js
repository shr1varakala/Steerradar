// js/api.js — Single gateway for every Apps Script call.
// Handles timeout, JSON parse, error formatting, and session auth.
//
// SECURITY MODEL (v6.1):
//   • There is NO shared secret in the browser any more.
//   • Every call automatically carries the signed-in user's phone + session token
//     (read fresh from localStorage). The server decides what each user may do.
//   • Failures return null (see api.lastError). list() also returns null on
//     failure so callers can tell "offline" apart from "no data".

const CFG = window.STEERADAR || {};

function readSession() {
  try {
    return {
      phone: localStorage.getItem('steeradar-phone') || '',
      token: localStorage.getItem('steeradar-token') || '',
    };
  } catch {
    return { phone: '', token: '' };
  }
}

export const api = {
  url: (() => { try { return localStorage.getItem('steeradar-cloud-url'); } catch { return null; } })() || CFG.SHEET_API_URL || '',
  lastError: '',

  /**
   * Low-level call. Every backend action flows through here.
   * @param {string} action
   * @param {object} params
   * @returns {Promise<any|null>} data on success, null on failure (see api.lastError)
   */
  async call(action, params = {}) {
    if (!this.url) {
      this.lastError = 'No API URL configured';
      return null;
    }
    this.lastError = '';

    const s = readSession();
    const body = { action, ...params };
    if (body.phone === undefined && s.phone) body.phone = s.phone;
    if (body.token === undefined && s.token) body.token = s.token;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        redirect: 'follow',
        signal: ctrl.signal,
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('Server returned HTML — check deployment is set to "Anyone"');
      }

      if (data.error) {
        if (data.error === 'unauthorized') {
          window.dispatchEvent(new CustomEvent('steeradar:unauthorized'));
        }
        throw new Error(data.error + (data.message ? ' — ' + data.message : ''));
      }
      return data.data;
    } catch (e) {
      this.lastError = e.name === 'AbortError' ? 'Timed out after 20s' : (e.message || String(e));
      console.warn('[api]', action, 'failed:', this.lastError);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  /** Like call() but returns an array on success and null on failure. */
  async list(action, params = {}) {
    const r = await this.call(action, params);
    return Array.isArray(r) ? r : null;
  },

  /** Health check. Returns true/false. */
  async ping() {
    return (await this.call('ping')) === 'pong';
  },

  /** Server diagnostics: row counts only (no secrets, no sheet URL). */
  debug() {
    return this.call('debug');
  },

  // ─── AUTH ───
  sendOtp(phone, email, purpose = 'register') {
    return this.call('sendOtp', { phone, email, purpose });
  },
  verifyOtp(phone, code) {
    return this.call('verifyOtp', { phone, code });
  },
  register(data) {
    return this.call('register', data);
  },
  /** Login requires a verified OTP for this phone (done server-side). */
  login(phone) {
    return this.call('login', { phone, token: '' });
  },
  logout()              { return this.call('logout'); },
  checkSession()        { return this.call('checkSession'); },
  getMe()               { return this.call('getMe'); },
  updateMe(updates)     { return this.call('updateMe', updates); },

  // ─── LANES ───
  listLanes()             { return this.list('listLanes'); },
  insertLane(row)         { return this.call('insertLane', { row }); },
  updateLane(id, row)     { return this.call('updateLane', { id, row }); },
  removeLane(id)          { return this.call('removeLane', { id }); },

  // ─── HIVE ───
  listHive()              { return this.list('listHive'); },
  insertHive(row)         { return this.call('insertHive', { row }); },
  updateHive(id, row)     { return this.call('updateHive', { id, row }); },
  deleteHive(id)          { return this.call('deleteHive', { id }); },
  like(id, delta)         { return this.call('like', { id, delta: delta > 0 ? 1 : -1 }); },

  // ─── MESSAGES ───
  getMessages(roomId, limit = 50) {
    return this.list('getMessages', { roomId, limit });
  },
  sendMessage(row)        { return this.call('sendMessage', { row }); },

  // ─── PRESENCE ───
  updatePresence(row)     { return this.call('updatePresence', { row }); },
  activeVehicles()        { return this.list('activeVehicles'); },
  removePresence()        { return this.call('removePresence'); },

  // ─── TRIPS ───
  startTrip(data)         { return this.call('startTrip', data); },
  endTrip(data)           { return this.call('endTrip', data); },
  myTrips()               { return this.list('myTrips'); },

  // ─── IMAGES ───
  uploadImage(base64, folder, filename) {
    return this.call('uploadImage', { base64, folder, filename });
  },
  deleteImage(fileId)     { return this.call('deleteImage', { fileId }); },
};
