// js/api.js - Gateway for every Steeradar backend call.
// v6.1: no shared secret. Auth = phone + token from session storage.

const CFG = window.STEERADAR || {};

export const api = {
  url: CFG.SHEET_API_URL || '',
  lastError: '',
  lastAction: '',

  get phone() { return localStorage.getItem('steeradar-phone') || ''; },
  get token() { return localStorage.getItem('steeradar-token') || ''; },

  async call(action, params = {}) {
    if (!this.url) { this.lastError = 'No backend URL'; return null; }
    this.lastError = '';
    this.lastAction = action;

    const body = Object.assign({ action: action }, params);
    // Attach auth for every call. Backend ignores it on public actions.
    if (this.phone) body.phone = this.phone;
    if (this.token) body.token = this.token;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);

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
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('Server returned non-JSON'); }

      if (data.error) {
        const err = new Error(data.error + (data.message ? ' - ' + data.message : ''));
        err.code = data.error;
        throw err;
      }
      return data.data;
    } catch (e) {
      this.lastError = e.name === 'AbortError' ? 'Timed out' : (e.message || String(e));
      console.warn('[api]', action, '->', this.lastError);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  async list(action, params = {}) {
    const r = await this.call(action, params);
    return Array.isArray(r) ? r : [];
  },

  ping() { return this.call('ping').then(r => r === 'pong'); },

  // AUTH
  sendOtp(phone, email, purpose) { return this.call('sendOtp', { phone, email, purpose }); },
  verifyOtp(phone, code) { return this.call('verifyOtp', { phone, code }); },
  register(data) { return this.call('register', data); },
  login(data) { return this.call('login', data); },
  logout() { return this.call('logout'); },
  checkSession() { return this.call('checkSession'); },
  getMe() { return this.call('getMe'); },
  updateMe(patch) { return this.call('updateMe', patch); },

  // LANES
  listLanes() { return this.list('listLanes'); },
  insertLane(row) { return this.call('insertLane', { row }); },
  updateLane(id, row) { return this.call('updateLane', { id, row }); },
  removeLane(id) { return this.call('removeLane', { id }); },

  // HIVE
  listHive() { return this.list('listHive'); },
  insertHive(row) { return this.call('insertHive', { row }); },
  updateHive(id, row) { return this.call('updateHive', { id, row }); },
  deleteHive(id) { return this.call('deleteHive', { id }); },
  like(id, delta) { return this.call('like', { id, delta }); },

  // MESSAGES
  getMessages(roomId, limit) { return this.list('getMessages', { roomId, limit: limit || 50 }); },
  sendMessage(row) { return this.call('sendMessage', { row }); },

  // PRESENCE
  updatePresence(row) { return this.call('updatePresence', { row }); },
  activeVehicles() { return this.list('activeVehicles'); },
  removePresence() { return this.call('removePresence'); },

  // TRIPS
  startTrip(data) { return this.call('startTrip', data || {}); },
  endTrip(data) { return this.call('endTrip', data); },
  myTrips() { return this.list('myTrips'); },

  // IMAGES
  uploadImage(base64, folder) { return this.call('uploadImage', { base64, folder }); },
  deleteImage(fileId) { return this.call('deleteImage', { fileId }); },

  debug() { return this.call('debug'); },
};