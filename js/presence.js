// js/presence.js - Live tracking + geohash mesh

import { api } from './api.js';
import { chat } from './chat.js';
import {
  state, storage, showToast,
  getVehicleType, geohash, distanceM, fmtDist,
  setTimer, clearTimer, session,
} from './store.js';

const CFG = window.STEERADAR || {};
let presenceRunning = false;
let liveMarkers = new Map();
let routeLayer = null, routeGlowLayer = null;
let pickupMarker = null, vehiclePin = null;
let routeData = null, trackingTargetId = null;
let localRescanTimer = null;
const ROOM_SLOTS = CFG.LOCAL_ROOM_SLOTS || 20;

export async function startPresence() {
  if (presenceRunning) return;
  presenceRunning = true;
  await presenceBeat();
  setTimer('presence', presenceBeat, CFG.PRESENCE_INTERVAL_MS || 20000);
}
export function stopPresence() { presenceRunning = false; clearTimer('presence'); }

async function presenceBeat() {
  if (document.hidden || !session.isLoggedIn()) return;
  if (storage.raw('ghost', '') === 'true') { try { await api.removePresence(); } catch (e) {} return; }
  const shareGps = storage.raw('share-gps', 'true') !== 'false';
  const row = {
    vehicle: state.vehicle, name: state.userName,
    avatar: (state.userName || 'DR').substring(0, 2).toUpperCase(),
    peerId: state.peerId || ('steeradar-veh-' + state.vehicle),
    vehicleType: state.selectedVehicleType || 'car',
  };
  if (shareGps && state.userLat != null) { row.lat = state.userLat; row.lng = state.userLng; }
  try { await api.updatePresence(row); } catch (e) {}
  await refreshActiveVehicles();
}

async function refreshActiveVehicles() {
  const list = await api.activeVehicles();
  if (!Array.isArray(list)) return;
  const others = new Map();
  list.forEach(v => { if (v.vehicle !== state.vehicle) others.set(v.vehicle, v); });
  state.cloudPeers = others;
  renderLiveVehicles();
}

function renderLiveVehicles() {
  if (!state.map) return;
  liveMarkers.forEach((entry, v) => {
    if (!state.cloudPeers.has(v)) { try { state.map.removeLayer(entry.marker); } catch (e) {} liveMarkers.delete(v); }
  });
  state.cloudPeers.forEach((v, vehicle) => {
    if (v.lat == null || v.lng == null) return;
    const vt = getVehicleType(v.vehicleType || 'car');
    const existing = liveMarkers.get(vehicle);
    if (existing) animateMarkerTo(existing.marker, v.lat, v.lng, 1200);
    else {
      const icon = L.divIcon({
        className: '',
        html: '<div class="live-vehicle-marker"><div class="lv-trail"></div><div class="lv-core">' + vt.emoji + '</div></div>',
        iconSize: [60, 60], iconAnchor: [30, 30],
      });
      const m = L.marker([v.lat, v.lng], { icon: icon }).addTo(state.map);
      m.bindPopup('<b>' + escapeHtml(v.name) + '</b>');
      m.on('click', () => showVehicleCard(v));
      liveMarkers.set(vehicle, { marker: m });
    }
  });
}

function animateMarkerTo(m, tLat, tLng, dur) {
  const s = m.getLatLng(), sLat = s.lat, sLng = s.lng;
  const t0 = performance.now();
  function step(now) {
    const t = Math.min((now - t0) / dur, 1);
    const e = 1 - Math.pow(1 - t, 3);
    m.setLatLng([sLat + (tLat - sLat) * e, sLng + (tLng - sLng) * e]);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function showVehicleCard(v) {
  const card = document.getElementById('mapLaneCard');
  if (!card) return;
  const vt = getVehicleType(v.vehicleType || 'car');
  const dist = state.userLat != null ? distanceM({ lat: state.userLat, lng: state.userLng }, { lat: v.lat, lng: v.lng }) : null;
  card.innerHTML =
    '<button class="close-x" id="mapCardClose">✕</button>' +
    '<div class="vtype-badge">' + vt.emoji + ' ' + vt.label + '</div>' +
    '<h3>' + escapeHtml(v.name) + '</h3>' +
    '<div class="route">' + (dist != null ? fmtDist(dist) + ' away' : 'Live now') + '</div>' +
    '<div class="actions">' +
      '<button class="btn-request" style="flex:1;background:var(--surface-2);color:var(--text);border:1px solid var(--border)" id="liveChatBtn">💬 Chat</button>' +
      '<button class="btn-request" style="flex:1" id="liveTrackBtn">📍 Track</button>' +
    '</div>';
  card.classList.add('show');
  document.getElementById('mapCardClose').onclick = () => card.classList.remove('show');
  document.getElementById('liveChatBtn').onclick = () => { card.classList.remove('show'); chat.openPersonal(v.vehicle, v.name, v.avatar, v.peerId); };
  document.getElementById('liveTrackBtn').onclick = () => { card.classList.remove('show'); startRouteTracking(v); };
}

export async function startRouteTracking(target) {
  stopRouteTracking();
  if (state.userLat == null) { showToast('Enable location', 'error'); return; }
  const pickup = { lat: state.userLat, lng: state.userLng };
  trackingTargetId = target.id || ('peer-' + target.vehicle);
  const vt = getVehicleType(target.vehicleType || 'car');
  const avatarEl = document.getElementById('trackAvatar');
  if (avatarEl) { avatarEl.textContent = (target.avatar || target.driver || 'DR').substring(0, 2).toUpperCase(); avatarEl.style.background = vt.color || 'var(--teal)'; }
  setText('trackName', target.name || target.driver || 'Vehicle');
  const metaEl = document.getElementById('trackMeta');
  if (metaEl) metaEl.innerHTML = '<span class="live-dot"></span> ' + vt.emoji + ' ' + vt.label + ' - coming';
  document.getElementById('trackHud')?.classList.add('show');

  const pulseTab = document.querySelector('.nav-item[data-tab="pulse"]');
  if (pulseTab) pulseTab.click();
  setTimeout(() => { if (state.map) try { state.map.invalidateSize(); } catch (e) {} }, 200);

  if (state.map) state.map.fitBounds(L.latLngBounds([[pickup.lat, pickup.lng], [target.lat, target.lng]]), { padding: [80, 80] });
  drawPickup(pickup);
  drawVehiclePin(target);
  await refreshRoute(pickup, target);

  setTimer('routeRefresh', async () => {
    const cur = findTrackedTarget();
    if (!cur || cur.lat == null) return;
    drawVehiclePin(cur);
    await refreshRoute(pickup, cur);
    updateTrackStats(cur, pickup);
  }, 8000);
  setTimer('trackTick', () => {
    const cur = findTrackedTarget();
    if (cur) updateTrackStats(cur, pickup);
  }, 1000);
}

function findTrackedTarget() {
  if (!trackingTargetId) return null;
  let t = state.lanes.find(l => l.id === trackingTargetId);
  if (!t && trackingTargetId.indexOf('peer-') === 0) {
    const p = state.cloudPeers.get(trackingTargetId.replace('peer-', ''));
    if (p) t = Object.assign({}, p, { id: trackingTargetId });
  }
  return t;
}

async function refreshRoute(from, to) {
  const r = await fetchOSRM(from, to);
  if (!r) return;
  routeData = r;
  drawRouteLine(r.coordinates);
}

async function fetchOSRM(from, to) {
  const url = 'https://router.project-osrm.org/route/v1/driving/' + from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat + '?overview=full&geometries=geojson';
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.routes || !data.routes[0]) return null;
    return {
      coordinates: data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]),
      distance: data.routes[0].distance,
      duration: data.routes[0].duration,
    };
  } catch (e) { return null; }
}

function drawRouteLine(coords) {
  clearRouteLayers();
  if (!state.map) return;
  routeGlowLayer = L.polyline(coords, { color: '#0D9488', weight: 8, opacity: 0.15, lineCap: 'round' }).addTo(state.map);
  routeLayer = L.polyline(coords, { color: '#0D9488', weight: 4, opacity: 0.9, lineCap: 'round', dashArray: '2, 8' }).addTo(state.map);
}

function drawPickup(p) {
  if (!state.map) return;
  if (pickupMarker) try { state.map.removeLayer(pickupMarker); } catch (e) {}
  pickupMarker = L.marker([p.lat, p.lng], {
    icon: L.divIcon({
      className: '',
      html: '<div style="width:26px;height:26px;border-radius:50%;background:#DC2626;border:3px solid #fff;box-shadow:0 2px 10px rgba(220,38,38,.5)"></div>',
      iconSize: [26, 26], iconAnchor: [13, 13],
    }),
  }).addTo(state.map);
}

function drawVehiclePin(t) {
  if (!state.map) return;
  if (vehiclePin) try { state.map.removeLayer(vehiclePin); } catch (e) {}
  const vt = getVehicleType(t.vehicleType || 'car');
  vehiclePin = L.marker([t.lat, t.lng], {
    icon: L.divIcon({
      className: '',
      html: '<div style="width:38px;height:38px;border-radius:50%;background:#fff;border:3px solid #0D9488;display:flex;align-items:center;justify-content:center;font-size:1.2rem">' + vt.emoji + '</div>',
      iconSize: [38, 38], iconAnchor: [19, 19],
    }),
  }).addTo(state.map);
}

function clearRouteLayers() {
  if (routeLayer) try { state.map.removeLayer(routeLayer); } catch (e) {}
  if (routeGlowLayer) try { state.map.removeLayer(routeGlowLayer); } catch (e) {}
  routeLayer = null; routeGlowLayer = null;
}

function updateTrackStats(target, pickup) {
  const dEl = document.getElementById('trackDist');
  const eEl = document.getElementById('trackEta');
  const sEl = document.getElementById('trackSeats');
  if (routeData) {
    if (dEl) dEl.textContent = fmtDist(routeData.distance);
    if (eEl) eEl.textContent = Math.max(1, Math.round(routeData.duration / 60)) + ' min';
  }
  if (sEl && target.seats) {
    const left = target.seats.total - target.seats.taken;
    sEl.textContent = left + '/' + target.seats.total;
  }
}

export function stopRouteTracking() {
  clearTimer('routeRefresh');
  clearTimer('trackTick');
  routeData = null;
  trackingTargetId = null;
  clearRouteLayers();
  if (pickupMarker) try { state.map.removeLayer(pickupMarker); } catch (e) {}
  if (vehiclePin) try { state.map.removeLayer(vehiclePin); } catch (e) {}
  pickupMarker = null; vehiclePin = null;
  document.getElementById('trackHud')?.classList.remove('show');
}

// ============================================================
//  MESH
// ============================================================
export async function joinLocalMesh(lat, lng) {
  if (typeof Peer === 'undefined') { setText('localRoomSub', 'WebRTC not available'); return; }
  const gh = geohash(lat, lng, 6);
  state.userGeohash = gh;
  state.localRoomPrefix = 'steeradar-loc-' + gh;
  setText('localRoomId', gh.toUpperCase());
  setText('localRoomSub', 'Your neighbourhood mesh');
  setText('localPeerCount', 'Searching...');

  let claimed = null;
  for (let i = 1; i <= ROOM_SLOTS; i++) {
    claimed = await tryClaimSlot(state.localRoomPrefix + '-' + i);
    if (claimed) { state.localSlot = i; state.localPeer = claimed; break; }
  }
  if (!claimed) { setText('localRoomSub', 'Room is full'); return; }

  claimed.on('connection', (conn) => {
    conn.on('open', () => {
      conn.send({ type: 'hello', name: state.userName, vehicle: state.vehicle, avatar: (state.userName || 'DR').substring(0, 2).toUpperCase(), lat: state.userLat, lng: state.userLng });
      attachLocalConn(conn);
    });
  });
  claimed.on('error', (e) => { if (e.type !== 'peer-unavailable') console.warn(e.type); });

  scanLocalRoom();
  clearInterval(localRescanTimer);
  localRescanTimer = setInterval(scanLocalRoom, 30000);
}

function tryClaimSlot(id) {
  return new Promise((resolve) => {
    let resolved = false;
    const p = new Peer(id, { debug: 0 });
    const t = setTimeout(() => { if (!resolved) { resolved = true; try { p.destroy(); } catch (e) {} resolve(null); } }, 6000);
    p.on('open', () => { if (!resolved) { resolved = true; clearTimeout(t); resolve(p); } });
    p.on('error', () => { if (!resolved) { resolved = true; clearTimeout(t); try { p.destroy(); } catch (e) {} resolve(null); } });
  });
}

function scanLocalRoom() {
  if (!state.localPeer || !state.localPeer.open || !state.localRoomPrefix) return;
  if (storage.raw('visible', 'true') === 'false') return;
  for (let i = 1; i <= ROOM_SLOTS; i++) {
    if (i === state.localSlot) continue;
    const targetId = state.localRoomPrefix + '-' + i;
    if (state.localPeers.has(targetId) || state.localPeers.get(targetId + ':pending')) continue;
    const conn = state.localPeer.connect(targetId, { reliable: true });
    state.localPeers.set(targetId + ':pending', true);
    const cleanup = () => state.localPeers.delete(targetId + ':pending');
    const t = setTimeout(() => { try { conn.close(); } catch (e) {} cleanup(); }, 5000);
    conn.on('open', () => {
      clearTimeout(t); cleanup();
      conn.send({ type: 'hello', name: state.userName, vehicle: state.vehicle, avatar: (state.userName || 'DR').substring(0, 2).toUpperCase(), lat: state.userLat, lng: state.userLng });
      attachLocalConn(conn);
    });
    conn.on('error', () => { clearTimeout(t); cleanup(); });
  }
}

function attachLocalConn(conn) {
  state.localConns.set(conn.peer, conn);
  conn.on('data', (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hello') {
      state.localPeers.set(conn.peer, { name: data.name, vehicle: data.vehicle, avatar: data.avatar, lat: data.lat, lng: data.lng });
      updateLocalUI();
      showToast(data.name + ' joined the room');
    } else if (data.type === 'chat') {
      chat.receive(data.text, data.sender, data.roomId || ('local-' + state.userGeohash));
    } else if (data.type === 'hive-post') {
      window.dispatchEvent(new CustomEvent('steeradar:hive-broadcast', { detail: data.post }));
    }
  });
  conn.on('close', () => {
    state.localPeers.delete(conn.peer);
    state.localConns.delete(conn.peer);
    updateLocalUI();
  });
}

function updateLocalUI() {
  const peers = [...state.localPeers.entries()].filter(([k]) => !k.endsWith(':pending'));
  setText('localPeerCount', peers.length + ' ' + (peers.length === 1 ? 'peer' : 'peers'));
  renderNear();
}

export function broadcastToAllPeers(payload) {
  let sent = 0;
  for (const conn of state.connections.values()) if (conn.open) { try { conn.send(payload); sent++; } catch (e) {} }
  for (const conn of state.localConns.values()) if (conn.open) { try { conn.send(payload); sent++; } catch (e) {} }
  return sent;
}

export function renderNear() {
  const wrap = document.getElementById('proximityWrap');
  if (!wrap) return;
  const peers = [...state.localPeers.entries()].filter(([k]) => !k.endsWith(':pending'));
  const lanes = (state.lanes || []).filter(l => !l.mine && l.lat).slice(0, 3);
  const total = Math.max(peers.length + lanes.length, 1);
  let html = '<div class="center-user">' + escapeHtml((state.userName || 'You').charAt(0).toUpperCase()) + '</div>';
  html += '<div class="center-label">' + escapeHtml(state.vehicle || '') + '</div>';
  const items = [];
  peers.forEach(([id, p], i) => {
    const angle = (i / total) * 360 - 90;
    const d = state.userLat != null && p.lat != null ? distanceM({ lat: state.userLat, lng: state.userLng }, { lat: p.lat, lng: p.lng }) : 20 + Math.random() * 30;
    const r = Math.min((d / 70) * 40, 40);
    const rad = angle * Math.PI / 180;
    items.push({ x: 50 + Math.cos(rad) * r, y: 50 + Math.sin(rad) * r, avatar: p.avatar, name: p.name, dist: d, type: 'peer', id: id });
  });
  lanes.forEach((l, i) => {
    const angle = ((peers.length + i) / total) * 360 - 90;
    const r = 30;
    const rad = angle * Math.PI / 180;
    items.push({ x: 50 + Math.cos(rad) * r, y: 50 + Math.sin(rad) * r, avatar: l.avatar, name: l.driver, dist: 0, type: 'lane', id: l.id, coral: true });
  });
  items.forEach((it, i) => {
    html += '<div class="peer-bubble" style="left:' + it.x + '%;top:' + it.y + '%;transform:translate(-50%,-50%);animation-delay:' + (i * 0.06) + 's" data-type="' + it.type + '" data-id="' + escapeHtml(it.id) + '">' +
      '<div class="p-avatar ' + (it.coral ? 'coral' : '') + '">' + escapeHtml(it.avatar) + '</div>' +
      '<div class="p-label"><span class="dist">' + fmtDist(it.dist) + '</span><br>' + escapeHtml((it.name || '').slice(0, 14)) + '</div>' +
    '</div>';
  });
  html += '<div class="connected-pill"><span class="live-dot"></span> ' + peers.length + ' local - ' + lanes.length + ' lanes</div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('.peer-bubble').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.type === 'lane') {
        const lane = state.lanes.find(l => l.id === b.dataset.id);
        if (lane) chat.openLane(lane);
      } else {
        chat.openLocal();
      }
    });
  });

  const rooms = [];
  if (peers.length || state.localRoomPrefix) {
    rooms.push({ id: 'local', name: 'Neighbourhood room', meta: peers.length + ' peers', emoji: '📡', local: true });
  }
  (state.lanes || []).filter(l => l.status === 'live').slice(0, 3).forEach(l => {
    rooms.push({ id: l.id, name: l.route.to + ' Lane', meta: (l.seats.total - l.seats.taken) + ' seats left', emoji: '🚌' });
  });
  if (!rooms.length) rooms.push({ id: null, name: 'Community Chat', meta: 'No active rooms', emoji: '💬' });

  const cntEl = document.getElementById('chatRoomsCount');
  if (cntEl) cntEl.textContent = rooms.length + ' active';
  const listEl = document.getElementById('roomList');
  if (listEl) {
    listEl.innerHTML = rooms.map(r =>
      '<div class="room-card" data-id="' + (r.id || '') + '" data-local="' + (r.local ? '1' : '') + '">' +
        '<div class="room-icon' + (r.local ? ' bt' : '') + '">' + r.emoji + '</div>' +
        '<div class="room-info"><div class="room-name">' + escapeHtml(r.name) + ' <span class="live-dot"></span></div><div class="room-meta">' + escapeHtml(r.meta) + '</div></div>' +
        '<button class="open-btn">' + (r.local ? 'Join' : 'Open') + '</button>' +
      '</div>'
    ).join('');
    listEl.querySelectorAll('.room-card').forEach(card => {
      card.addEventListener('click', () => {
        if (card.dataset.local === '1') { chat.openLocal(); return; }
        const id = card.dataset.id;
        if (!id) { showToast('No lanes yet'); return; }
        const lane = state.lanes.find(l => l.id === id);
        if (lane) chat.openLane(lane);
      });
    });
  }
}

function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export const presence = {
  start: startPresence,
  stop: stopPresence,
  joinMesh: joinLocalMesh,
  broadcast: broadcastToAllPeers,
  startTracking: startRouteTracking,
  stopTracking: stopRouteTracking,
  renderNear: renderNear,
};