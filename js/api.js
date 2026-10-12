/**
 * ============================================================================
 * STEERADAR API GATEWAY (v7.0)
 * ============================================================================
 * This module handles all communication between the frontend and the Google
 * Apps Script backend. It manages authentication tokens, handles network
 * retries, and provides a clean, typed interface for all backend actions.
 * 
 * PROTOCOL:
 *   POST text/plain body = JSON { action, phone?, token?, ...params }
 *   OK   { "data": <result> }
 *   FAIL { "error": "<code>", "message": "<human text>" }
 * ============================================================================
 */

import { CONFIG } from './config.js';

// Constants for storage keys
const STORAGE_KEYS = {
  PHONE: 'steeradar-phone',
  TOKEN: 'steeradar-token',
  USER: 'steeradar-user' // Optional: cache user object for instant UI
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
  // SESSION MANAGEMENT (LocalStorage Getters/Setters)
  // --------------------------------------------------------------------------
  get phone() {
    return localStorage.getItem(STORAGE_KEYS.PHONE) || '';
  },

  get token() {
    return localStorage.getItem(STORAGE_KEYS.TOKEN) || '';
  },

  /**
   * Save session data after a successful login/register.
   * @param {Object} session - { token, phone, user }
   */
  setSession(session) {
    if (!session) return;
    if (session.token) localStorage.setItem(STORAGE_KEYS.TOKEN, session.token);
    if (session.phone) localStorage.setItem(STORAGE_KEYS.PHONE, session.phone);
    if (session.user) localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(session.user));
  },

  /**
   * Clear all session data on logout or session expiration.
   */
  clearSession() {
    localStorage.removeItem(STORAGE_KEYS.PHONE);
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.USER);
    this.lastError = '';
    this.lastAction = '';
  },

  // --------------------------------------------------------------------------
  // CORE FETCH WRAPPER
  // --------------------------------------------------------------------------
  /**
   * Core API call function with exponential backoff retry logic.
   * 
   * @param {string} action - The backend action to perform (e.g., 'login').
   * @param {Object} params - Payload to send to the backend.
   * @param {number} retries - Number of retries remaining (internal use).
   * @returns {Promise<any|null>} - The `data` object from the response, or null on failure.
   */
  async call(action, params = {}, retries = 2) {
    // 1. Validate Configuration
    if (!this.url) {
      this.lastError = 'Backend URL is missing. Check config.js';
      console.error('[api]', this.lastError);
      return null;
    }

    // 2. Prepare Request State
    this.lastError = '';
    this.lastAction = action;

    const body = Object.assign({ action: action }, params);
    
    // Attach auth credentials if they exist
    if (this.phone) body.phone = this.phone;
    if (this.token) body.token = this.token;

    // 3. Setup Timeout Mechanism (10 seconds)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);

    try {
      // 4. Execute Fetch
      const res = await fetch(this.url, {
        method: 'POST',
        signal: ctrl.signal,
        body: JSON.stringify(body),
        // Use text/plain to avoid CORS preflight requests (Google Apps Script limitation)
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      });

      // 5. Parse Response
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error(`Server returned invalid JSON: ${text.substring(0, 50)}...`);
      }

      // 6. Handle Backend Errors
      if (data.error) {
        const err = new Error(data.message || data.error);
        err.code = data.error;
        
        // Auto-clear session if token is invalid/expired
        if (data.error === 'bad_session' || data.error === 'unauthorized') {
          this.clearSession();
        }
        throw err;
      }

      // 7. Success
      this.isOnline = true;
      return data.data;

    } catch (e) {
      // 8. Handle Network Errors & Retries
      const isNetworkError = 
        e.name === 'TypeError' || 
        e.message.includes('Failed to fetch') || 
        e.name === 'AbortError';

      if (isNetworkError && retries > 0) {
        const delay = 1000 * (3 - retries); // 1s, then 2s
        console.warn(`[api] ${action} failed (${e.message}). Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        clearTimeout(timer);
        return this.call(action, params, retries - 1);
      }

      // 9. Final Error Handling
      this.isOnline = false;
      this.lastError = e.name === 'AbortError' ? 'Request timed out' : (e.message || String(e));
      console.warn('[api]', action, '->', this.lastError);
      return null;

    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Helper for actions that return a list (array). Ensures an array is always returned.
   */
  async list(action, params = {}) {
    const r = await this.call(action, params);
    return Array.isArray(r) ? r : [];
  },

  // --------------------------------------------------------------------------
  // SYSTEM & UTILITIES
  // --------------------------------------------------------------------------
  
  /** Ping the server to check connectivity. */
  ping() { 
    return this.call('ping').then(r => r === 'pong'); 
  },

  /** Get backend diagnostics (Admin only). */
  debug() { 
    return this.call('debug'); 
  },

  // --------------------------------------------------------------------------
  // AUTHENTICATION & ACCOUNT
  // --------------------------------------------------------------------------

  /** 
   * Request an OTP for registration or login.
   * @param {string} phone - 10-digit mobile number
   * @param {string} email - Email address (required for register, optional for login)
   * @param {string} purpose - 'register' or 'login'
   */
  sendOtp(phone, email, purpose = 'register') { 
    return this.call('sendOtp', { phone, email, purpose }); 
  },

  /**
   * Verify an OTP code.
   * @param {string} phone 
   * @param {string} code - 6-digit OTP
   */
  verifyOtp(phone, code) { 
    return this.call('verifyOtp', { phone, code }); 
  },

  /**
   * Register a new user (RearAgent).
   * @param {Object} data - { phone, name, email, password, vehicle? }
   */
  register(data) { 
    return this.call('register', data); 
  },

  /**
   * Login with phone + password OR phone + OTP.
   * @param {Object} data - { phone, password? } or { phone, code? }
   */
  login(data) { 
    return this.call('login', data); 
  },

  /** Logout and invalidate the current session. */
  logout() { 
    return this.call('logout'); 
  },

  /** Check if the current token is still valid. */
  checkSession() { 
    return this.call('checkSession'); 
  },

  /** Get the current user's profile. */
  getMe() { 
    return this.call('getMe'); 
  },

  /** Update the current user's profile. */
  updateMe(patch) { 
    return this.call('updateMe', { patch }); 
  },

  /**
   * Set or change the user's password.
   * @param {string} password - The new password
   * @param {string} oldPassword - The current password (required if one exists)
   */
  setPassword(password, oldPassword) { 
    return this.call('setPassword', { password, oldPassword }); 
  },

  // --------------------------------------------------------------------------
  // STEERAGENT FLOW
  // --------------------------------------------------------------------------

  /**
   * Apply to become a SteerAgent (Driver).
   * @param {Object} data - { vehicle, vehicleType, vehiclePhoto, photo, city }
   */
  becomeAgent(data) { 
    return this.call('becomeAgent', data); 
  },

  // --------------------------------------------------------------------------
  // LANES (Live Routes / Drivers)
  // --------------------------------------------------------------------------

  /** Get all active lanes (public). */
  listLanes() { 
    return this.list('listLanes'); 
  },

  /** 
   * Create a new lane (SteerAgent only). 
   * @param {Object} row - { title, description, lat, lng, type, photo }
   */
  insertLane(row) { 
    return this.call('insertLane', { row }); 
  },

  /** Update an existing lane (Owner only). */
  updateLane(id, row) { 
    return this.call('updateLane', { id, row }); 
  },

  /** Delete a lane (Owner only). */
  removeLane(id) { 
    return this.call('removeLane', { id }); 
  },

  // --------------------------------------------------------------------------
  // HIVE (Community Feed)
  // --------------------------------------------------------------------------

  /** Get all Hive posts (public). */
  listHive() { 
    return this.list('listHive'); 
  },

  /** 
   * Create a new Hive post. 
   * @param {Object} row - { text, lat, lng, photo, mediaUrl, mediaType }
   */
  insertHive(row) { 
    return this.call('insertHive', { row }); 
  },

  /** Update a Hive post (Owner only). */
  updateHive(id, row) { 
    return this.call('updateHive', { id, row }); 
  },

  /** Delete a Hive post (Owner only). */
  deleteHive(id) { 
    return this.call('deleteHive', { id }); 
  },

  /**
   * Like or Unlike a post.
   * @param {string} kind - 'lane' or 'hive'
   * @param {string} id - The post ID
   * @param {number} delta - 1 to like, -1 to unlike
   */
  like(kind, id, delta) { 
    return this.call('like', { kind, id, delta }); 
  },

  // --------------------------------------------------------------------------
  // MESSAGING (Chat)
  // --------------------------------------------------------------------------

  /**
   * Fetch chat messages for a room.
   * @param {string} roomId - Unique identifier for the chat room
   * @param {number} limit - Max messages to fetch (default 50)
   * @param {string} since - ISO timestamp to fetch messages after
   */
  getMessages(roomId, limit = 50, since = null) { 
    const params = { roomId, limit };
    if (since) params.since = since;
    return this.list('getMessages', params); 
  },

  /**
   * Send a chat message.
   * @param {Object} row - { roomId, text }
   */
  sendMessage(row) { 
    return this.call('sendMessage', { row }); 
  },

  // --------------------------------------------------------------------------
  // PRESENCE (Live Map Tracking)
  // --------------------------------------------------------------------------

  /** 
   * Update the user's live location on the map.
   * @param {Object} row - { lat, lng, heading, speed, vehicle }
   */
  updatePresence(row) { 
    return this.call('updatePresence', { row }); 
  },

  /** Get all active vehicles on the map. */
  activeVehicles() { 
    return this.list('activeVehicles'); 
  },

  /** Remove the user's presence from the map (Go offline). */
  removePresence() { 
    return this.call('removePresence'); 
  },

  // --------------------------------------------------------------------------
  // TRIPS
  // --------------------------------------------------------------------------

  /** Start a new trip. */
  startTrip(data) { 
    return this.call('startTrip', { data }); 
  },

  /** End an active trip. */
  endTrip(id, data) { 
    return this.call('endTrip', { id, data }); 
  },

  /** Get the user's trip history. */
  myTrips() { 
    return this.list('myTrips'); 
  },

  // --------------------------------------------------------------------------
  // IMAGES & UPLOADS
  // --------------------------------------------------------------------------

  /**
   * Upload a Base64 image to Google Drive.
   * @param {string} base64 - The data:image/...;base64,... string
   * @param {string} folder - 'lanes', 'hive', 'avatars', 'vehicles', or 'misc'
   */
  uploadImage(base64, folder = 'misc') { 
    return this.call('uploadImage', { base64, folder }); 
  },

  /** Delete an uploaded image from Google Drive. */
  deleteImage(fileId) { 
    return this.call('deleteImage', { fileId }); 
  },

  // --------------------------------------------------------------------------
  // SAVED MAP POINTS
  // --------------------------------------------------------------------------

  /** 
   * Save a new point on the map.
   * @param {Object} row - { label, note, category, lat, lng, shared }
   */
  savePoint(row) { 
    return this.call('savePoint', { row }); 
  },

  /** Update a saved point (Owner only). */
  updatePoint(id, row) { 
    return this.call('updatePoint', { id, row }); 
  },

  /** Delete a saved point (Owner only). */
  deletePoint(id) { 
    return this.call('deletePoint', { id }); 
  },

  /** Get all points saved by the current user. */
  myPoints() { 
    return this.list('myPoints'); 
  },

  /** Get all publicly shared points. */
  listPoints() { 
    return this.list('listPoints'); 
  },

  // --------------------------------------------------------------------------
  // ADMIN ACTIONS
  // --------------------------------------------------------------------------

  /** Get all pending SteerAgent applications (Admin only). */
  adminPendingAgents() { 
    return this.list('adminPendingAgents'); 
  },

  /**
   * Approve or Reject a SteerAgent application.
   * @param {string} uid - The user ID of the applicant
   * @param {boolean} approve - true to approve, false to reject
   */
  adminApproveAgent(uid, approve) { 
    return this.call('adminApproveAgent', { uid, approve }); 
  }
};