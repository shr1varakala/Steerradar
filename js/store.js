// js/store.js - Shared state, storage, session, utils

const CFG = window.STEERADAR || {};

export const VEHICLE_TYPES = CFG.VEHICLE_TYPES || [];
export function getVehicleType(id) {
  return VEHICLE_TYPES.find(v => v.id === id) || VEHICLE_TYPES[0] || { id: 'car', label: 'Car', emoji: '🚗', seats: 4 };
}

export const state = {
  vehicle: localStorage.getItem('steeradar-vehicle') || null,
  userName: localStorage.getItem('steeradar-name') || '',
  phone: localStorage.getItem('steeradar-phone') || '',
  token: localStorage.getItem('steeradar-token') || '',
  lanes: [],
  hivePosts: [],
  cloudPeers: new Map(),
  localPeers: new Map(),
  connections: new Map(),
  localConns: new Map(),
  localPeer: null,
  localSlot: null,
  localRoomPrefix: null,
  peer: null,
  peerId: null,
  map: null,
  mapLibreLayer: null,
  userMarker: null,
  busMarkers: [],
  userLat: null,
  userLng: null,
  userGeohash: null,
  currentTab: 'pulse',
  selectedFilter: 'live',
  selectedVehicleType: 'car',
  cloudOnline: true,
  cloudLastError: '',
  trackedLaneId: null,
  btDevices: [],
  timers: {},
};

const PREFIX = 'steeradar-';
export const storage = {
  get(k, d) { try { const r = localStorage.getItem(PREFIX + k); return r == null ? d : JSON.parse(r); } catch (e) { return d; } },
  set(k, v) { localStorage.setItem(PREFIX + k, JSON.stringify(v)); },
  remove(k) { localStorage.removeItem(PREFIX + k); },
  raw(k, d) { const v = localStorage.getItem(PREFIX + k); return v == null ? d : v; },
  setRaw(k, v) { localStorage.setItem(PREFIX + k, String(v)); },
  removeRaw(k) { localStorage.removeItem(PREFIX + k); },
};

export const session = {
  get() { return { phone: state.phone, token: state.token }; },
  isLoggedIn() { return !!(state.phone && state.token); },
  set(data) {
    state.phone = data.phone || '';
    state.token = data.token || '';
    storage.setRaw('phone', state.phone);
    storage.setRaw('token', state.token);
    if (data.user) {
      state.userName = data.user.name || state.userName;
      state.vehicle = data.user.vehicle || state.vehicle;
      state.selectedVehicleType = data.user.vehicleType || state.selectedVehicleType;
      storage.setRaw('name', state.userName);
      storage.setRaw('vehicle', state.vehicle);
      storage.set('user', data.user);
    }
  },
  clear() {
    state.phone = '';
    state.token = '';
    storage.removeRaw('phone');
    storage.removeRaw('token');
    storage.remove('user');
  },
  user() { return storage.get('user', null); },
};

const lanesKey = () => 'lanes-' + (state.vehicle || 'anon');
const hiveKey  = () => 'hive-' + (state.vehicle || 'anon');

export function loadLanes() { state.lanes = storage.get(lanesKey(), []) || []; return state.lanes; }
export function saveLanes() { storage.set(lanesKey(), state.lanes.filter(l => l.mine)); }
export function loadHive() { state.hivePosts = storage.get(hiveKey(), []) || []; return state.hivePosts; }
export function saveHive() { storage.set(hiveKey(), state.hivePosts); }

export function dedupeLanes() {
  const seen = new Set();
  state.lanes = state.lanes.filter(l => {
    const k = l.id || (l.driver + '|' + (l.route && l.route.to) + '|' + l.fare);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
export function dedupeHive() {
  const seen = new Set();
  state.hivePosts = state.hivePosts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function timeAgo(ts, fallback) {
  const t = Number(ts);
  if (!t) return fallback || 'just now';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ago';
  return Math.floor(h / 24) + ' d ago';
}

export function fmtDist(m) {
  if (m == null || !isFinite(m)) return '-';
  return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
}

export function distanceM(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function geohash(lat, lng, precision) {
  precision = precision || CFG.GEOHASH_PRECISION || 6;
  let latR = [-90, 90], lngR = [-180, 180];
  let hash = '', bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const m = (lngR[0] + lngR[1]) / 2;
      if (lng >= m) { ch = (ch << 1) + 1; lngR[0] = m; } else { ch = ch << 1; lngR[1] = m; }
    } else {
      const m = (latR[0] + latR[1]) / 2;
      if (lat >= m) { ch = (ch << 1) + 1; latR[0] = m; } else { ch = ch << 1; latR[1] = m; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

export const validateVehicle = (v) => /^[A-Z0-9]{4,15}$/i.test(String(v || '').replace(/[\s-]/g, ''));
export const normalizeVehicle = (v) => String(v || '').replace(/[\s-]/g, '').toUpperCase();

export function setTimer(name, fn, ms) {
  clearTimer(name);
  state.timers[name] = setInterval(fn, ms);
}
export function clearTimer(name) {
  if (state.timers[name]) { clearInterval(state.timers[name]); delete state.timers[name]; }
}

let _toastTimer = null;
export function showToast(msg, variant, duration) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  if (variant) t.dataset.variant = variant; else delete t.dataset.variant;
  t.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.classList.remove('show'); }, duration || CFG.TOAST_DURATION_MS || 2400);
}