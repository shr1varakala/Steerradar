// js/lanes.js - Post/view lanes, edit, request seats, map markers, track

import { api } from './api.js';
import { chat } from './chat.js';
import {
  state, storage, showToast,
  VEHICLE_TYPES, getVehicleType,
  dedupeLanes, loadLanes, saveLanes,
  timeAgo, fmtDist, session, esc,
} from './store.js';

const CFG = window.STEERADAR || {};

let pendingSeats = null;
let requestTarget = null;
let _editTarget = null;
let _editSeats = null;

export function initLanes() {
  wirePostModal();
  wireRequestModal();
  wireFilterChips();
  renderVehicleTypeGrid();
}

export function loadLanesFromStorage() { loadLanes(); dedupeLanes(); }

export async function syncLanesFromCloud() {
  const list = await api.listLanes();
  if (!Array.isArray(list)) { state.cloudOnline = false; return; }
  state.cloudOnline = true;

  const mineLocal = state.lanes.filter(l => l.mine);
  const merged = mineLocal.slice();
  list.forEach(l => {
    const lane = {
      id: String(l.id),
      driver: l.driver,
      phone: '',
      vehicle: l.vehicle || '',
      vehicleType: l.vehicleType || 'car',
      avatar: (l.driver || 'D').substring(0, 2).toUpperCase(),
      rating: 5.0,
      route: {
        from: l.from || '',
        via: l.via ? String(l.via).split('|').filter(Boolean) : [],
        to: l.to || '',
      },
      seats: { total: Number(l.total) || 10, taken: Number(l.taken) || 0 },
      fare: Number(l.fare) || 0,
      status: l.status || 'live',
      lat: Number(l.lat),
      lng: Number(l.lng),
      peerId: l.peerId || (l.vehicle ? 'steeradar-veh-' + l.vehicle : null),
      mine: !!l.own,
      ts: Number(l.ts) || Date.now(),
    };
    if (!merged.find(m => m.id === lane.id)) merged.push(lane);
  });
  state.lanes = merged;
  dedupeLanes();
  renderLanes();
  renderBusMarkers();
}

export function renderVehicleTypeGrid() {
  const grid = document.getElementById('vehicleTypeGrid');
  if (!grid) return;
  grid.innerHTML = VEHICLE_TYPES.map(v =>
    '<button type="button" class="vehicle-type-btn ' + (v.id === state.selectedVehicleType ? 'active' : '') + '" data-vtype="' + v.id + '">' +
      '<span class="vt-emoji">' + v.emoji + '</span>' +
      '<span class="vt-label">' + v.label + '</span>' +
    '</button>'
  ).join('');

  grid.querySelectorAll('.vehicle-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedVehicleType = btn.dataset.vtype;
      grid.querySelectorAll('.vehicle-type-btn').forEach(b => b.classList.toggle('active', b === btn));
      const vt = getVehicleType(state.selectedVehicleType);
      const suggest = Math.min(vt.seats, 10);
      document.querySelectorAll('#seatSelector .seat-btn').forEach(b => {
        const seats = parseInt(b.dataset.seats, 10);
        b.classList.toggle('active', seats === suggest);
      });
      pendingSeats = suggest;
    });
  });
}

function wireFilterChips() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
      state.selectedFilter = chip.dataset.filter;
      renderLanes();
      renderBusMarkers();
    });
  });
}

function filteredLanes() {
  return state.lanes.filter(lane => {
    if (storage.raw('ghost', '') === 'true') return false;
    const left = lane.seats.total - lane.seats.taken;
    if (state.selectedFilter === 'live') return lane.status === 'live' && left > 0;
    if (state.selectedFilter === 'seats') return left > 0;
    if (state.selectedFilter === 'mine') return lane.mine;
    return true;
  });
}

export function renderLanes() {
  dedupeLanes();
  const list = document.getElementById('laneList');
  if (!list) return;
  const lanes = filteredLanes();
  if (!lanes.length) {
    list.innerHTML = '<div class="empty"><div class="icon">🚌</div><p>No lanes yet. Tap <b>Post my lane</b> to be the first.</p></div>';
    return;
  }
  const sorted = lanes.slice().sort((a, b) => (b.mine - a.mine) || (b.ts - a.ts));
  list.innerHTML = sorted.map(lane => {
    const left = lane.seats.total - lane.seats.taken;
    const occ = lane.seats.taken / Math.max(lane.seats.total, 1);
    const full = left <= 0;
    const circ = 2 * Math.PI * 28;
    const dash = occ * circ;
    const vt = getVehicleType(lane.vehicleType);
    return (
      '<div class="lane-card ' + (lane.mine ? 'mine' : '') + '" data-id="' + lane.id + '">' +
        (lane.mine ? '<button class="edit-lane-btn" data-edit="' + lane.id + '" title="Edit">✎</button>' : '') +
        '<div class="status-tag ' + (full ? 'delayed' : '') + '">' +
          '<span class="live-dot"></span>' + (full ? 'FULL' : 'LIVE - ON TIME') +
          (lane.mine ? '<span class="you-tag">YOU</span>' : '') +
        '</div>' +
        '<div class="vtype-badge">' + vt.emoji + ' ' + vt.label + '</div>' +
        '<div class="row-1">' +
          '<div class="occupancy-ring ' + (full ? 'full' : '') + '">' +
            '<svg viewBox="0 0 68 68">' +
              '<circle class="bg-ring" cx="34" cy="34" r="28"/>' +
              '<circle class="fg-ring" cx="34" cy="34" r="28" stroke-dasharray="' + dash + ' ' + circ + '"/>' +
            '</svg>' +
            '<div class="label"><span class="num">' + (full ? 0 : left) + '</span><span class="sub">Seats</span></div>' +
          '</div>' +
          '<div class="info">' +
            '<div class="destination">' + esc(lane.route.to) + '</div>' +
            '<div class="route">' + esc(lane.route.from) + ' → ' + esc(lane.route.via.join(' → ')) + ' → ' + esc(lane.route.to) + '</div>' +
            '<span class="fare-tag">₹ ' + lane.fare + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="row-2">' +
          '<div class="driver">' +
            '<div class="driver-avatar">' + esc(lane.avatar) + '</div>' +
            '<div><div class="driver-name">' + esc(lane.driver) + '</div><div class="driver-rating">★ ' + lane.rating + '</div></div>' +
          '</div>' +
          '<div class="card-actions">' +
            '<button class="btn-icon-sm" data-action="chat" data-id="' + lane.id + '" title="Chat">💬</button>' +
            '<button class="btn-icon-sm" data-action="track" data-id="' + lane.id + '" title="Track">📍</button>' +
            '<button class="btn-request" data-action="request" data-id="' + lane.id + '" ' + (full ? 'disabled' : '') + '>' + (full ? 'Full' : 'Request') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  list.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lane = state.lanes.find(l => l.id === btn.dataset.id);
      if (!lane) return;
      const a = btn.dataset.action;
      if (a === 'chat') { try { chat.openLane(lane); } catch (err) { showToast('Chat error: ' + err.message, 'error'); } }
      if (a === 'request') openRequest(lane);
      if (a === 'track') {
        if (window.Steeradar && window.Steeradar.presence) window.Steeradar.presence.startTracking(lane);
        else showToast('Tracking not available');
      }
    });
  });

  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lane = state.lanes.find(l => l.id === btn.dataset.edit);
      if (lane) openEditLane(lane);
    });
  });
}

export function renderBusMarkers() {
  if (!state.map) return;
  state.busMarkers.forEach(m => { try { state.map.removeLayer(m); } catch (e) {} });
  state.busMarkers = [];
  filteredLanes().forEach(lane => {
    if (!lane.lat || !lane.lng) return;
    const occ = lane.seats.taken / Math.max(lane.seats.total, 1);
    const full = occ >= 0.85 || (lane.seats.total - lane.seats.taken) <= 0;
    const vt = getVehicleType(lane.vehicleType);
    const icon = L.divIcon({
      className: '',
      html: '<div class="bus-marker-wrap ' + (full ? 'full' : '') + '">' +
        '<div class="ring"></div><div class="ring d2"></div>' +
        '<div class="bus-core"><span style="font-size:20px;line-height:1">' + vt.emoji + '</span></div>' +
      '</div>',
      iconSize: [60, 60], iconAnchor: [30, 30],
    });
    const m = L.marker([lane.lat, lane.lng], { icon: icon }).addTo(state.map);
    m.on('click', () => showLaneCard(lane));
    state.busMarkers.push(m);
  });
}

export function showLaneCard(lane) {
  const card = document.getElementById('mapLaneCard');
  if (!card) return;
  const left = lane.seats.total - lane.seats.taken;
  const full = left <= 0;
  const vt = getVehicleType(lane.vehicleType);
  card.innerHTML =
    '<button class="close-x" id="mapCardClose">✕</button>' +
    '<div class="vtype-badge">' + vt.emoji + ' ' + vt.label + '</div>' +
    '<h3>' + esc(lane.route.to) + '</h3>' +
    '<div class="route">' + esc(lane.route.from) + ' → ' + esc(lane.route.via.join(' → ')) + '</div>' +
    '<div class="stats"><div class="stat ' + (full ? 'coral' : 'teal') + '">' + (full ? 'Full' : left + ' seats left') + '</div><div class="stat coral">₹' + lane.fare + '</div></div>' +
    '<div class="actions">' +
      '<button class="btn-request" style="flex:1;background:var(--surface-2);color:var(--text);border:1px solid var(--border)" id="mapChatBtn">💬</button>' +
      '<button class="btn-request" style="flex:1;background:var(--surface-2);color:var(--text);border:1px solid var(--border)" id="mapTrackBtn">📍</button>' +
      '<button class="btn-request" style="flex:1" id="mapReqBtn" ' + (full ? 'disabled' : '') + '>Request</button>' +
    '</div>';
  card.classList.add('show');

  document.getElementById('mapCardClose').onclick = hideLaneCard;
  document.getElementById('mapChatBtn').onclick = () => { hideLaneCard(); try { chat.openLane(lane); } catch (e) {} };
  document.getElementById('mapTrackBtn').onclick = () => { hideLaneCard(); if (window.Steeradar && window.Steeradar.presence) window.Steeradar.presence.startTracking(lane); };
  document.getElementById('mapReqBtn').onclick = () => { hideLaneCard(); openRequest(lane); };
  try { state.map.setView([lane.lat, lane.lng], Math.max(state.map.getZoom(), 13), { animate: true }); } catch (e) {}
}

export function hideLaneCard() {
  document.getElementById('mapLaneCard')?.classList.remove('show');
}

function wirePostModal() {
  document.querySelectorAll('#seatSelector .seat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#seatSelector .seat-btn').forEach(b => b.classList.toggle('active', b === btn));
      pendingSeats = parseInt(btn.dataset.seats, 10);
    });
  });
  document.getElementById('postConfirm').onclick = handlePostConfirm;
}

export function openPostModal() {
  document.getElementById('pDest').value = '';
  document.getElementById('pRoute').value = '';
  document.getElementById('pFare').value = '20';
  pendingSeats = null;
  document.querySelectorAll('#seatSelector .seat-btn').forEach(b => b.classList.remove('active'));
  state.selectedVehicleType = state.selectedVehicleType || 'car';
  renderVehicleTypeGrid();
  document.getElementById('postModal').classList.add('active');
}

async function handlePostConfirm() {
  if (!session.isLoggedIn()) { showToast('Sign in to post lanes', 'error'); return; }

  const dest = document.getElementById('pDest').value.trim();
  const routeStr = document.getElementById('pRoute').value.trim();
  const fare = parseInt(document.getElementById('pFare').value, 10) || 0;
  if (!dest || !routeStr) { showToast('Fill destination and route', 'error'); return; }
  if (pendingSeats === null) { showToast('Select seats', 'error'); return; }

  const via = routeStr.split(',').map(s => s.trim()).filter(Boolean);
  const from = via.shift() || 'Your location';
  const vt = getVehicleType(state.selectedVehicleType);
  const total = vt.seats || 4;
  const taken = Math.max(0, total - pendingSeats);

  const coords = await getCoords();

  const lane = {
    id: 'mine-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    driver: state.userName,
    vehicle: state.vehicle,
    vehicleType: vt.id,
    avatar: (state.userName || 'DR').substring(0, 2).toUpperCase(),
    rating: 5.0,
    route: { from: from, via: via.length ? via : ['Via Main'], to: dest },
    seats: { total: total, taken: taken },
    fare: fare,
    status: 'live',
    lat: coords.lat, lng: coords.lng,
    peerId: state.peerId,
    mine: true,
    ts: Date.now(),
  };
  state.lanes.unshift(lane);
  saveLanes();
  renderLanes();
  renderBusMarkers();
  document.getElementById('postModal').classList.remove('active');
  const lanesTab = document.querySelector('.nav-item[data-tab="lanes"]');
  if (lanesTab) lanesTab.click();
  showToast('Lane is live!', 'success');

  const row = {
    id: lane.id, driver: lane.driver, vehicle: lane.vehicle, vehicleType: lane.vehicleType,
    from: lane.route.from, via: lane.route.via.join('|'), to: lane.route.to,
    total: total, taken: taken, fare: fare, lat: lane.lat, lng: lane.lng,
    status: 'live', ts: lane.ts, peerId: state.peerId,
  };
  const r = await api.insertLane(row);
  if (!r) showToast('Saved locally - cloud: ' + (api.lastError || 'failed'), 'error');
}

function getCoords() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve({ lat: 12.95, lng: 77.65 }); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve({ lat: 12.95, lng: 77.65 }),
      { timeout: 5000 }
    );
  });
}

// EDIT
export function initEditLane() {
  const overlay = document.getElementById('editLaneModal');
  if (!overlay) return;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
  document.querySelectorAll('#elSeatSelector .seat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#elSeatSelector .seat-btn').forEach(b => b.classList.toggle('active', b === btn));
      _editSeats = parseInt(btn.dataset.seats, 10);
    });
  });
  document.getElementById('editLaneConfirm').onclick = saveEditedLane;
  document.getElementById('editLaneDelete').onclick = deleteEditedLane;
}

export function openEditLane(lane) {
  if (!lane || !lane.mine) { showToast('You can only edit your own lanes'); return; }
  _editTarget = lane;
  const left = lane.seats.total - lane.seats.taken;
  const via = (lane.route.via || []).join(', ');
  document.getElementById('elDest').value = lane.route.to || '';
  document.getElementById('elRoute').value = (lane.route.from ? lane.route.from + ', ' : '') + via;
  document.getElementById('elFare').value = lane.fare || 0;
  _editSeats = null;
  document.querySelectorAll('#elSeatSelector .seat-btn').forEach(b => {
    const s = parseInt(b.dataset.seats, 10);
    const active = s === left || (s === 40 && left > 10);
    b.classList.toggle('active', active);
    if (active) _editSeats = s;
  });
  document.getElementById('editLaneModal').classList.add('active');
}

async function saveEditedLane() {
  if (!_editTarget) return;
  const dest = document.getElementById('elDest').value.trim();
  const routeStr = document.getElementById('elRoute').value.trim();
  const fare = parseInt(document.getElementById('elFare').value, 10) || 0;
  if (!dest) { showToast('Destination required', 'error'); return; }
  const via = routeStr.split(',').map(s => s.trim()).filter(Boolean);
  const from = via.shift() || _editTarget.route.from || 'Your location';
  const total = _editTarget.seats.total;
  const taken = _editSeats != null ? Math.max(0, total - _editSeats) : _editTarget.seats.taken;

  _editTarget.route = { from: from, via: via.length ? via : ['Via Main'], to: dest };
  _editTarget.seats.taken = taken;
  _editTarget.fare = fare;
  saveLanes();
  renderLanes();
  renderBusMarkers();
  document.getElementById('editLaneModal').classList.remove('active');
  showToast('Lane updated', 'success');

  const row = {
    from: from, via: via.join('|'), to: dest, total: total, taken: taken, fare: fare,
    vehicleType: _editTarget.vehicleType, peerId: _editTarget.peerId, status: 'live',
  };
  await api.updateLane(_editTarget.id, row);
  _editTarget = null;
  _editSeats = null;
}

async function deleteEditedLane() {
  if (!_editTarget) return;
  if (!confirm('Delete this lane?')) return;
  const id = _editTarget.id;
  await api.removeLane(id);
  state.lanes = state.lanes.filter(l => l.id !== id);
  saveLanes();
  renderLanes();
  renderBusMarkers();
  document.getElementById('editLaneModal').classList.remove('active');
  showToast('Lane deleted', 'success');
  _editTarget = null;
  _editSeats = null;
}

// REQUEST
function wireRequestModal() {
  document.getElementById('reqConfirm').onclick = handleRequestConfirm;
}

export function openRequest(lane) {
  if (lane.mine) { showToast('This is your own lane'); return; }
  requestTarget = lane;
  const info = document.getElementById('reqInfo');
  if (info) info.textContent = 'To ' + lane.driver + ' · ' + lane.route.from + ' → ' + lane.route.to + ' · ₹' + lane.fare;
  document.getElementById('reqMsg').value = '';
  document.getElementById('requestModal').classList.add('active');
}

async function handleRequestConfirm() {
  if (!requestTarget) return;
  const msg = document.getElementById('reqMsg').value.trim();
  const pid = requestTarget.peerId || ('steeradar-veh-' + (requestTarget.vehicle || requestTarget.id));
  if (state.peer && pid) {
    try {
      const conn = state.peer.connect(pid, { reliable: true });
      conn.on('open', () => {
        conn.send({ type: 'chat', text: 'Seat request: ' + (msg || 'Can I join?'), sender: state.userName, roomId: 'dm-' + [state.vehicle, requestTarget.vehicle].sort().join('-') });
        setTimeout(() => { try { conn.close(); } catch (e) {} }, 500);
      });
      conn.on('error', () => {});
    } catch (e) {}
  }
  showToast('Request sent to ' + requestTarget.driver, 'success');
  document.getElementById('requestModal').classList.remove('active');
  requestTarget = null;
}

export const lanes = {
  init: initLanes,
  loadFromStorage: loadLanesFromStorage,
  syncFromCloud: syncLanesFromCloud,
  render: renderLanes,
  renderMarkers: renderBusMarkers,
  openPost: openPostModal,
  openRequest: openRequest,
  showCard: showLaneCard,
  hideCard: hideLaneCard,
  openEdit: openEditLane,
  getVehicleType: getVehicleType,
  VEHICLE_TYPES: VEHICLE_TYPES,
};