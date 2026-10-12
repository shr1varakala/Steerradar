/**
 * ============================================================================
 * STEERADAR API GATEWAY (v7.0)
 * ============================================================================
 * This module handles all communication between the frontend and the Google
 * Apps Script backend. It manages authentication tokens, handles network
 * retries, and provides a clean, typed interface for all backend actions.
 * 
 * NOTE: This file reads config from window.STEERADAR, matching config.js.
 * ============================================================================
 */

// No import statement needed. We read from the global window object.
const CONFIG = window.STEERADAR || {};

// Constants for storage keys
const STORAGE_KEYS = {
  PHONE: 'steeradar-phone',
  TOKEN: 'steeradar-token',
  USER: 'steeradar-user'
};

export const api = {
  // --------------------------------------------------------------------------
  // STATE & CONFIGURATION
  // --------------------------------------------------------------------------
  url: CONFIG.SHEET_API_URL || '',
  lastError: '',
  lastAction: '',
  isOnline: true,

  // --------------------------------------------------------------------------
  // SESSION MANAGEMENT
  // --------------------------------------------------------------------------
  get phone() {
    return localStorage.getItem(STORAGE_KEYS.PHONE) || '';
  },

  get token() {
    return localStorage.getItem(STORAGE_KEYS.TOKEN) || '';
  },

  setSession(session) {
    if (!session) return;
    if (session.token) localStorage.setItem(STORAGE_KEYS.TOKEN, session.token);
    if (session.phone) localStorage.setItem(STORAGE_KEYS.PHONE, session.phone);
    if (session.user) localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(session.user));
  },

  clearSession() {
    localStorage.removeItem(STORAGE_KEYS.PHONE);
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.USER);
    this.lastError = '';
    this.lastAction = '';
  },

  // --------------------------------------------------------------------------
  // CORE FETCH WRAPPER (with exponential backoff retry)
  // --------------------------------------------------------------------------
  async call(action, params = {}, retries = 2) {
    if (!this.url) {
      this.lastError = 'Backend URL is missing. Check config.js';
      console.error('[api]', this.lastError);
      return null;
    }

    this.lastError = '';
    this.lastAction = action;

    const body = Object.assign({ action: action }, params);
    if (this.phone) body.phone = this.phone;
    if (this.token) body.token = this.token;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000); // 10s timeout

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        signal: ctrl.signal,
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error(`Server returned invalid JSON: ${text.substring(0, 50)}...`);
      }

      if (data.error) {
        const err = new Error(data.message || data.error);
        err.code = data.error;
        
        // Auto-clear session on invalid token
        if (data.error === 'bad_session' || data.error === 'unauthorized') {
          this.clearSession();
        }
        throw err;
      }

      this.isOnline = true;
      return data.data;

    } catch (e) {
      const isNetworkError = 
        e.name === 'TypeError' || 
        e.message.includes('Failed to fetch') || 
        e.name === 'AbortError';

      if (isNetworkError && retries > 0) {
        const delay = 1000 * (3 - retries);
        console.warn(`[api] ${action} failed (${e.message}). Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        clearTimeout(timer);
        return this.call(action, params, retries - 1);
      }

      this.isOnline = false;
      this.lastError = e.name === 'AbortError' ? 'Request timed out' : (e.message || String(e));
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

  // --------------------------------------------------------------------------
  // SYSTEM
  // --------------------------------------------------------------------------
  ping() { return this.call('ping').then(r => r === 'pong'); },
  debug() { return this.call('debug'); },

  // --------------------------------------------------------------------------
  // AUTHENTICATION & ACCOUNT
  // --------------------------------------------------------------------------
  sendOtp(phone, email, purpose = 'register') { return this.call('sendOtp', { phone, email, purpose }); },
  verifyOtp(phone, code) { return this.call('verifyOtp', { phone, code }); },
  register(data) { return this.call('register', data); },
  login(data) { return this.call('login', data); },
  logout() { return this.call('logout'); },
  checkSession() { return this.call('checkSession'); },
  getMe() { return this.call('getMe'); },
  updateMe(patch) { return this.call('updateMe', { patch }); },
  setPassword(password, oldPassword) { return this.call('setPassword', { password, oldPassword }); },

  // --------------------------------------------------------------------------
  // STEERAGENT
  // --------------------------------------------------------------------------
  becomeAgent(data) { return this.call('becomeAgent', data); },

  // --------------------------------------------------------------------------
  // LANES
  // --------------------------------------------------------------------------
  listLanes() { return this.list('listLanes'); },
  insertLane(row) { return this.call('insertLane', { row }); },
  updateLane(id, row) { return this.call('updateLane', { id, row }); },
  removeLane(id) { return this.call('removeLane', { id }); },

  // --------------------------------------------------------------------------
  // HIVE
  // --------------------------------------------------------------------------
  listHive() { return this.list('listHive'); },
  insertHive(row) { return this.call('insertHive', { row }); },
  updateHive(id, row) { return this.call('updateHive', { id, row }); },
  deleteHive(id) { return this.call('deleteHive', { id }); },
  like(kind, id, delta) { return this.call('like', { kind, id, delta }); },

  // --------------------------------------------------------------------------
  // MESSAGING
  // --------------------------------------------------------------------------
  getMessages(roomId, limit = 50, since = null) { 
    const params = { roomId, limit };
    if (since) params.since = since;
    return this.list('getMessages', params); 
  },
  sendMessage(row) { return this.call('sendMessage', { row }); },

  // --------------------------------------------------------------------------
  // PRESENCE
  // --------------------------------------------------------------------------
  updatePresence(row) { return this.call('updatePresence', { row }); },
  activeVehicles() { return this.list('activeVehicles'); },
  removePresence() { return this.call('removePresence'); },

  // --------------------------------------------------------------------------
  // TRIPS
  // --------------------------------------------------------------------------
  startTrip(data) { return this.call('startTrip', { data }); },
  endTrip(id, data) { return this.call('endTrip', { id, data }); },
  myTrips() { return this.list('myTrips'); },

  // --------------------------------------------------------------------------
  // IMAGES
  // --------------------------------------------------------------------------
  uploadImage(base64, folder = 'misc') { return this.call('uploadImage', { base64, folder }); },
  deleteImage(fileId) { return this.call('deleteImage', { fileId }); },

  // --------------------------------------------------------------------------
  // SAVED POINTS
  // --------------------------------------------------------------------------
  savePoint(row) { return this.call('savePoint', { row }); },
  updatePoint(id, row) { return this.call('updatePoint', { id, row }); },
  deletePoint(id) { return this.call('deletePoint', { id }); },
  myPoints() { return this.list('myPoints'); },
  listPoints() { return this.list('listPoints'); },

  // --------------------------------------------------------------------------
  // ADMIN
  // --------------------------------------------------------------------------
  adminPendingAgents() { return this.list('adminPendingAgents'); },
  adminApproveAgent(uid, approve) { return this.call('adminApproveAgent', { uid, approve }); }
};