// js/chat.js - Chat for Steeradar v7
// w2g.tv-style synchronization:
//   • Host is elected by lowest peer id (all peers agree)
//   • Every message gets a monotonic sequence number from host
//   • Host stamps authoritative timestamp
//   • Receivers sort by (seq, ts) so everyone sees identical order
//   • Graceful failover if host leaves

import { api } from './api.js';
import { state, storage, showToast, session } from './store.js';

const CFG = window.STEERADAR || {};

let activeRoom = null;
let activeConns = new Map();
let ownLaneHintShown = false;

// Message buffer keyed by roomId
// Each entry: { id, text, sender, side, seq, ts, fromVehicle }
const messageBuffers = new Map();

// ============================================================
//  ROOM ID BUILDERS (must match server regex)
// ============================================================
function dmRoomId(a, b) {
  const parts = [String(a || '').toUpperCase(), String(b || '').toUpperCase()].sort();
  if (!parts[0] || !parts[1]) return null;
  return 'dm-' + parts[0] + '-' + parts[1];
}
function localRoomId() {
  return 'local-' + (state.userGeohash || 'mesh');
}

// ============================================================
//  HOST ELECTION (shared with app.js via window.SteeradarApp)
// ============================================================
function host() {
  return (window.SteeradarApp && window.SteeradarApp.getHost)
    ? window.SteeradarApp.getHost()
    : { isHost: true, seq: 0, nextSeq: () => ++activeRoom._seq };
}

function stampSequence() {
  const h = host();
  if (h.isHost && typeof h.nextSeq === 'function') {
    return h.nextSeq();
  }
  return null; // not host - will receive seq from host's broadcast
}

// ============================================================
//  BOOT
// ============================================================
export function initChat() {
  const send = document.getElementById('chatSend');
  const input = document.getElementById('chatInput');

  if (send) send.onclick = sendCurrentMessage;
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentMessage();
      }
    });
  }

  document.querySelector('[data-close="#chatModal"]')?.addEventListener('click', closeChat);
}

// ============================================================
//  OPENERS
// ============================================================
export function openChatForLane(lane) {
  if (!lane) return;

  // Own lane - echo only
  if (lane.mine) {
    activeRoom = {
      id: 'dm-' + state.vehicle + '-' + state.vehicle,
      type: 'own',
      title: lane.driver || 'Your lane',
      avatar: lane.avatar || (state.userName || 'DR').substring(0, 2).toUpperCase(),
      peerIds: [],
      mine: true,
      vehicle: state.vehicle,
      _seq: 0,
    };
    ownLaneHintShown = false;
    prepareModal();
    setStatus(true, 'Waiting for passengers');
    addSystemBubble('This is your lane. Others can reach you here.');
    loadHistory(activeRoom.id);
    return;
  }

  const otherVehicle = lane.vehicle || (lane.id ? lane.id.replace('mine-', '') : '');
  if (!otherVehicle) { showToast('Cannot open chat - no vehicle id', 'error'); return; }

  const roomId = dmRoomId(state.vehicle, otherVehicle);
  if (!roomId) { showToast('Cannot open chat', 'error'); return; }

  const peerId = lane.peerId || ('steeradar-veh-' + otherVehicle);

  activeRoom = {
    id: roomId,
    type: 'personal',
    title: lane.driver || 'Driver',
    avatar: lane.avatar || (lane.driver || 'DR').substring(0, 2).toUpperCase(),
    peerIds: [peerId],
    mine: false,
    vehicle: otherVehicle,
    _seq: 0,
  };
  ownLaneHintShown = false;
  prepareModal();
  dialPeer(peerId);
  loadHistory(roomId);
}

export function openLocalChat() {
  const roomId = localRoomId();

  activeRoom = {
    id: roomId,
    type: 'local',
    title: 'Neighbourhood room',
    avatar: '📡',
    peerIds: [],
    mine: false,
    vehicle: '',
    _seq: 0,
  };
  ownLaneHintShown = false;

  prepareModal();
  const n = state.localConns ? state.localConns.size : 0;
  setStatus(n > 0, n + ' connected', 'purple');
  addSystemBubble('You are on the local mesh' + (state.userGeohash ? ' - ' + state.userGeohash.toUpperCase() : ''));
  if (n === 0) addSystemBubble('Waiting for neighbours to join...');
  loadHistory(roomId);
}

export function openPersonalChat(vehicle, name, avatar, peerId) {
  if (!vehicle || vehicle === state.vehicle) return;
  const roomId = dmRoomId(state.vehicle, vehicle);
  if (!roomId) return;

  activeRoom = {
    id: roomId,
    type: 'personal',
    title: name || 'Driver',
    avatar: avatar || (name || 'DR').substring(0, 2).toUpperCase(),
    peerIds: peerId ? [peerId] : ['steeradar-veh-' + vehicle],
    mine: false,
    vehicle: vehicle,
    _seq: 0,
  };
  ownLaneHintShown = false;
  prepareModal();
  dialPeer(activeRoom.peerIds[0]);
  loadHistory(roomId);
}

// ============================================================
//  DIAL
// ============================================================
function dialPeer(peerId) {
  if (!peerId) return;

  if (state.connections.has(peerId)) {
    activeConns.set(peerId, state.connections.get(peerId));
    setStatus(true, 'Connected');
    return;
  }
  if (!state.peer || !state.peer.open) {
    setStatus(false, 'Connecting to network...');
    addSystemBubble('Waiting for the WebRTC network...');
    setTimeout(() => dialPeer(peerId), 1500);
    return;
  }

  setStatus(false, 'Connecting...');
  addSystemBubble('Dialing...');

  let conn;
  try {
    conn = state.peer.connect(peerId, { reliable: true });
  } catch (e) {
    setStatus(false, 'Peer unavailable');
    addSystemBubble('Could not reach this person.');
    return;
  }

  let opened = false;
  const timeout = setTimeout(() => {
    if (opened) return;
    setStatus(false, 'Peer offline');
    addSystemBubble('Not online right now. Your message will still be saved.');
    try { conn.close(); } catch (e) {}
  }, 6000);

  conn.on('open', () => {
    opened = true;
    clearTimeout(timeout);
    state.connections.set(peerId, conn);
    activeConns.set(peerId, conn);
    attachHandlers(conn, peerId);
    setStatus(true, 'Connected');
    addSystemBubble('Connected');
  });

  conn.on('error', () => {
    clearTimeout(timeout);
    setStatus(false, 'Connection failed');
    addSystemBubble('Could not connect.');
  });
}

function attachHandlers(conn, peerId) {
  conn.on('data', (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'chat') {
      receive(data.text, data.sender, data.roomId, data.seq, data.ts, data.fromVehicle);
    }
  });

  conn.on('close', () => {
    state.connections.delete(peerId);
    activeConns.delete(peerId);
    if (activeRoom && activeRoom.peerIds.indexOf(peerId) !== -1) setStatus(false, 'Disconnected');
  });
}

// ============================================================
//  MODAL
// ============================================================
function prepareModal() {
  const avatarEl = document.getElementById('chatAvatar');
  const nameEl = document.getElementById('chatName');
  const box = document.getElementById('chatMessages');
  const input = document.getElementById('chatInput');

  if (avatarEl) {
    avatarEl.textContent = activeRoom ? activeRoom.avatar : '?';
    avatarEl.classList.toggle('bt', activeRoom && activeRoom.type === 'local');
  }
  if (nameEl) nameEl.textContent = activeRoom ? activeRoom.title : 'Chat';
  if (box) box.innerHTML = '';
  if (input) input.value = '';

  // Reset the buffer for this room
  if (activeRoom) {
    messageBuffers.set(activeRoom.id, []);
  }

  setStatus(false, 'Connecting...');
  document.getElementById('chatModal')?.classList.add('active');
  setTimeout(() => input && input.focus(), 250);
}

// ============================================================
//  SEND
// ============================================================
async function sendCurrentMessage() {
  const input = document.getElementById('chatInput');
  if (!input || !activeRoom) return;
  const text = input.value.trim();
  if (!text) return;

  if (!session.isLoggedIn()) { showToast('Sign in to send messages', 'error'); return; }

  // Build message with w2g-style sync
  const seq = stampSequence();
  const ts = Date.now();

  // Local echo
  pushToBuffer(activeRoom.id, {
    id: 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    text: text,
    sender: state.userName,
    side: 'me',
    seq: seq,
    ts: ts,
    fromVehicle: state.vehicle,
  });
  renderBuffer(activeRoom.id);

  if (activeRoom.type === 'own') {
    if (!ownLaneHintShown) { addSystemBubble('(Your own lane - only you see this)'); ownLaneHintShown = true; }
    await saveToCloud(activeRoom.id, text);
    input.value = '';
    return;
  }

  const payload = {
    type: 'chat',
    text: text,
    sender: state.userName,
    senderVehicle: state.vehicle,
    fromVehicle: state.vehicle,
    roomId: activeRoom.id,
    seq: seq,
    ts: ts,
  };

  let delivered = 0;

  if (activeRoom.type === 'local' && state.localConns) {
    for (const conn of state.localConns.values()) {
      if (conn.open) { try { conn.send(payload); delivered++; } catch (e) {} }
    }
    if (delivered === 0) addSystemBubble('(No neighbours connected)');
  } else {
    for (const pid of activeRoom.peerIds) {
      const conn = activeConns.get(pid) || state.connections.get(pid);
      if (conn && conn.open) { try { conn.send(payload); delivered++; } catch (e) {} }
    }
    if (delivered === 0) addSystemBubble('(Not delivered - peer offline. Message saved.)');
  }

  await saveToCloud(activeRoom.id, text);
  input.value = '';
}

// ============================================================
//  RECEIVE
// ============================================================
export function receive(text, sender, roomId, seq, ts, fromVehicle) {
  if (!text || !roomId) return;

  pushToBuffer(roomId, {
    id: 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    text: text,
    sender: sender || 'Peer',
    side: (fromVehicle && fromVehicle === state.vehicle) ? 'me' : 'them',
    seq: (typeof seq === 'number') ? seq : null,
    ts: ts || Date.now(),
    fromVehicle: fromVehicle || '',
  });

  if (activeRoom && activeRoom.id === roomId) renderBuffer(roomId);

  saveToCloud(roomId, text, sender);
  notifyIfHidden(sender, text);
}

// ============================================================
//  BUFFER MANAGEMENT (w2g-style ordering)
// ============================================================
function pushToBuffer(roomId, msg) {
  if (!messageBuffers.has(roomId)) messageBuffers.set(roomId, []);
  const buf = messageBuffers.get(roomId);

  // Dedupe by id
  if (buf.some(m => m.id === msg.id)) return;
  buf.push(msg);

  // Sort: by (seq, ts). Nulls go last.
  buf.sort((a, b) => {
    if (a.seq != null && b.seq != null) {
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.ts - b.ts;
    }
    if (a.seq != null) return -1;
    if (b.seq != null) return 1;
    return a.ts - b.ts;
  });
}

function renderBuffer(roomId) {
  const box = document.getElementById('chatMessages');
  if (!box) return;

  const buf = messageBuffers.get(roomId) || [];

  // Rebuild the container but preserve any system bubbles
  const systemBubbles = [];
  box.querySelectorAll('.chat-msg.system').forEach(el => systemBubbles.push(el.textContent));

  box.innerHTML = '';

  // Re-render system bubbles first (in original order)
  systemBubbles.forEach(text => {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.textContent = text;
    box.appendChild(div);
  });

  // Re-render messages
  buf.forEach(m => {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + m.side;
    const time = new Date(Number(m.ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (m.side === 'me') {
      div.innerHTML = escapeHtml(m.text) + '<div class="time">' + time + '</div>';
    } else {
      div.innerHTML =
        '<div class="sender">' + escapeHtml(m.sender || 'Peer') + '</div>' +
        escapeHtml(m.text) +
        '<div class="time">' + time + '</div>';
    }
    box.appendChild(div);
  });

  box.scrollTop = box.scrollHeight;
}

// ============================================================
//  PERSIST
// ============================================================
async function saveToCloud(roomId, text, sender) {
  if (!roomId || !text || !session.isLoggedIn()) return;
  try {
    await api.sendMessage({
      id: 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      roomId: roomId,
      text: text,
      sender: sender || state.userName,
      ts: Date.now(),
    });
  } catch (e) { /* silent */ }
}

// ============================================================
//  HISTORY
// ============================================================
async function loadHistory(roomId) {
  if (!roomId) return;
  if (!session.isLoggedIn()) {
    addSystemBubble('Sign in to see message history');
    return;
  }

  const history = await api.getMessages(roomId, 50);
  if (!Array.isArray(history) || !history.length) return;

  // Push each historical message into the buffer (they'll get seq=null)
  history.forEach(m => {
    pushToBuffer(roomId, {
      id: m.id || ('h-' + m.ts),
      text: m.text,
      sender: m.sender || 'Peer',
      side: String(m.from) === String(state.vehicle) ? 'me' : 'them',
      seq: null,       // history has no sequence
      ts: Number(m.ts) || Date.now(),
      fromVehicle: m.from || '',
    });
  });

  if (activeRoom && activeRoom.id === roomId) renderBuffer(roomId);
}

// ============================================================
//  SYSTEM BUBBLES + STATUS
// ============================================================
function addSystemBubble(text) {
  const box = document.getElementById('chatMessages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setStatus(online, text, variant) {
  const wrap = document.getElementById('chatStatusWrap');
  const status = document.getElementById('chatStatus');
  if (!wrap || !status) return;
  wrap.classList.toggle('offline', !online);
  wrap.classList.toggle('purple', variant === 'purple');
  status.textContent = text;
}

function notifyIfHidden(sender, text) {
  if (!document.hidden) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (storage.raw('notif-chat', 'true') === 'false') return;
  try { new Notification('Steeradar', { body: (sender || 'Peer') + ': ' + text, icon: CFG.LOGO_URL }); } catch (e) {}
}

export function closeChat() {
  document.getElementById('chatModal')?.classList.remove('active');
  activeRoom = null;
  activeConns.clear();
}

// ============================================================
//  UTILS
// ============================================================
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ============================================================
//  PUBLIC API
// ============================================================
export const chat = {
  init: initChat,
  openLane: openChatForLane,
  openLocal: openLocalChat,
  openPersonal: openPersonalChat,
  receive: receive,
  close: closeChat,
  get activeRoomId() { return activeRoom ? activeRoom.id : null; },
};