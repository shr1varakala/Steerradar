// js/api.js - Gateway for every SteerRadar backend call.
import { CONFIG } from './config.js';

export const api = {
  url: CONFIG.SHEET_API_URL || '',
  lastError: '',
  lastAction: '',

  get phone() { return localStorage.getItem('steeradar-phone') || ''; },
  get token() { return localStorage.getItem('steeradar-token') || ''; },

  async call(action, params = {}, retries = 2) {
    if (!this.url) { this.lastError = 'No backend URL configured in config.js'; return null; }
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
      try { data = JSON.parse(text); } 
      catch (e) { throw new Error('Server returned non-JSON'); }

      if (data.error) {
        const err = new Error(data.error + (data.message ? ' - ' + data.message : ''));
        err.code = data.error;
        throw err;
      }
      return data.data;
    } catch (e) {
      const isNetworkError = e.name === 'TypeError' || e.message.includes('Failed to fetch') || e.name === 'AbortError';
      if (isNetworkError && retries > 0) {
        await new Promise(r => setTimeout(r, 1000 * (3 - retries)));
        clearTimeout(timer);
        return this.call(action, params, retries - 1);
      }
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

  // --- AUTH & USER ---
  register(data) { return this.call('register', data); }, // { name, phone, email, password }
  login(data) { return this.call('login', data); },       // { identity, password }
  logout() { return this.call('logout'); },
  checkSession() { return this.call('checkSession'); },
  getMe() { return this.call('getMe'); },
  updateMe(patch) { return this.call('updateMe', patch); },

  // --- STEERAGENT ROLE ---
  upgradeToSteerAgent(data) { return this.call('upgradeToSteerAgent', data); }, 
  getPendingApplications() { return this.list('getPendingApplications'); },
  approveSteerAgent(phone) { return this.call('approveSteerAgent', { targetPhone: phone }); },
  rejectSteerAgent(phone, reason) { return this.call('rejectSteerAgent', { targetPhone: phone, reason }); },

  // --- LANES & HIVE ---
  listLanes() { return this.list('listLanes'); },
  listHive() { return this.list('listHive'); },
  
  // --- MAP & LOCATIONS ---
  saveLocation(data) { return this.call('saveLocation', data); }, 
  reportAlert(data) { return this.call('reportAlert', data); },   

  // --- CHAT ---
  getMessages(roomId, limit) { return this.list('getMessages', { roomId, limit: limit || 50 }); },
  sendMessage(row) { return this.call('sendMessage', { row }); },
};