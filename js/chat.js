// js/chat.js - Lane chat + Room chat + Personal chat
// Every chat has a roomId so incoming messages route correctly.

import { api } from './api.js';
import { state, storage, showToast } from './store.js';

const CFG = window.STEERADAR || {};

// ============================================================
//  STATE
// ============================================================
let activeRoom = null;
// {
//   id: 'lane-xxx' | 'local-xxx' | 'dm-xxx',
//   type: 'lane' | 'local' | 'personal',
//   title: string,
//   avatar: string,
//   peerIds: [string],   // one or many target peer ids
//   mine: boolean,       // my own lane?
//   vehicle: string,     // for personal: the other vehicle
// }

let activeConns = new Map();  // peerId -> DataConnection
let ownLaneHintShown = false;

// ============================================================
//  PUBLIC: BOOT
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

  // Listen for peer broadcasts routed from app.js
  window.addEventListener('steeradar:peer-chat', (e) => {
    const detail = e.detail || {};
    receive(detail.text, detail.sender, detail.roomId);
  });
}

// ============================================================
//  OPEN: LANE CHAT (1:1 with the driver of a lane)
// ============================================================
export function openChatForLane(lane) {
  if (!lane) return;

  const roomId = 'lane-' + (lane.id || lane.vehicle);
  const peerId = lane.peerId || ('steeradar-veh-' + (lane.vehicle || lane.id));

  activeRoom = {
    id: roomId,
    type: 'lane',
    title: lane.driver || 'Driver',
    avatar: lane.avatar || (lane.driver || 'DR').substring(0, 2).toUpperCase(),
    peerIds: lane.mine ? [] : [peerId],
    mine: !!lane.mine,
    vehicle: lane.vehicle || '',
  };
  ownLaneHintShown = false;

  prepareModal();

  // My own lane — no one to dial
  if (lane.mine) {
    setStatus(true, 'Your lane - waiting for passengers');
    addSystemBubble('This is your lane. Others can reach you here.');
    loadHistory(roomId);
    return;
  }

  // Try to dial the peer
  dialPeer(peerId);
  loadHistory(roomId);
}

// ============================================================
//  OPEN: LOCAL MESH ROOM (group)
// ============================================================
export function openLocalChat(peerId) {
  const roomId = 'local-' + (state.userGeohash || 'mesh');

  activeRoom = {
    id: roomId,
    type: 'local',
    title: peerId === 'room' ? 'Neighbourhood room' : 'Neighbour',
    avatar: '📡',
    peerIds: [], // broadcast to all localConns
    mine: false,
    vehicle: '',
  };
  ownLaneHintShown = false;

  prepareModal();

  const n = state.localConns ? state.localConns.size : 0;
  setStatus(n > 0, n + ' connected', 'purple');
  addSystemBubble('You are on the local mesh' + (state.userGeohash ? ' - ' + state.userGeohash.toUpperCase() : ''));
  if (n === 0) addSystemBubble('Waiting for neighbours to join...');

  loadHistory(roomId);
}

// ============================================================
//  OPEN: PERSONAL CHAT (1:1 with a specific vehicle)
// ============================================================
export function openPersonalChat(vehicle, name, avatar, peerId) {
  if (!vehicle) return;

  // Sort vehicle IDs so both sides use the same room
  const parts = [state.vehicle, vehicle].sort();
  const roomId = 'dm-' + parts[0] + '-' + parts[1];

  activeRoom = {
    id: roomId,
    type: 'personal',
    title: name || 'Driver',
    avatar: avatar || (name || 'DR').substring(0, 2).toUpperCase(),
    peerIds: peerId ? [peerId] : ['steeradar-veh-' + vehicle],
    mine: false,
    vehicle: vehicle,
  };
  ownLaneHintShown = false;

  prepareModal();
  dialPeer(activeRoom.peerIds[0]);
  loadHistory(roomId);
}

// ============================================================
//  DIAL A PEER
// ============================================================
function dialPeer(peerId) {
  if (!peerId) return;

  // Already connected in this session?
  if (state.connections.has(peerId)) {
    activeConns.set(peerId, state.connections.get(peerId));
    setStatus(true, 'Connected');
    return;
  }

  // No peer client? Try again shortly
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

// ============================================================
//  HANDLE INCOMING DATA ON A CONNECTION
// ============================================================
function attachHandlers(conn, peerId) {
  conn.on('data', (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'chat') {
      // Route to the correct room
      const roomId = data.roomId || activeRoom?.id;
      receive(data.text, data.sender || 'Peer', roomId);
    }
  });

  conn.on('close', () => {
    state.connections.delete(peerId);
    activeConns.delete(peerId);
    if (activeRoom && activeRoom.peerIds.includes(peerId)) {
      setStatus(false, 'Disconnected');
    }
  });
}

// ============================================================
//  PREPARE MODAL
// ============================================================
function prepareModal() {
  const avatarEl = document.getElementById('chatAvatar');
  const nameEl = document.getElementById('chatName');
  const box = document.getElementById('chatMessages');
  const input = document.getElementById('chatInput');

  if (avatarEl) {
    avatarEl.textContent = activeRoom?.avatar || '?';
    avatarEl.classList.toggle('bt', activeRoom?.type === 'local');
  }
  if (nameEl) nameEl.textContent = activeRoom?.title || 'Chat';
  if (box) box.innerHTML = '';
  if (input) input.value = '';

  setStatus(false, 'Connecting...');

  document.getElementById('chatModal')?.classList.add('active');
  setTimeout(() => input?.focus(), 250);
}

// ============================================================
//  SEND
// ============================================================
function sendCurrentMessage() {
  const input = document.getElementById('chatInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text || !activeRoom) return;

  // Render locally
  addBubble(text, state.userName, 'me');

  // Own lane — no delivery
  if (activeRoom.mine) {
    if (!ownLaneHintShown) {
      addSystemBubble('(Your own lane - only you see this)');
      ownLaneHintShown = true;
    }
    saveToCloud(activeRoom.id, text, state.userName);
    input.value = '';
    return;
  }

  // Build payload with roomId so receiver routes it correctly
  const payload = {
    type: 'chat',
    text: text,
    sender: state.userName,
    senderVehicle: state.vehicle,
    roomId: activeRoom.id,
  };

  let delivered = 0;

  // Local mesh: broadcast to every local connection
  if (activeRoom.type === 'local' && state.localConns) {
    for (const conn of state.localConns.values()) {
      if (conn.open) {
        try { conn.send(payload); delivered++; } catch (e) {}
      }
    }
    if (delivered === 0) addSystemBubble('(No neighbours connected)');
  } else {
    // Lane / Personal: send to target peers
    for (const pid of activeRoom.peerIds) {
      const conn = activeConns.get(pid) || state.connections.get(pid);
      if (conn && conn.open) {
        try { conn.send(payload); delivered++; } catch (e) {}
      }
    }
    if (delivered === 0) {
      addSystemBubble('(Not delivered - peer offline. Message saved.)');
    }
  }

  // Always persist
  saveToCloud(activeRoom.id, text, state.userName);
  input.value = '';
}

// ============================================================
//  RECEIVE (called from app.js bridge OR local conn handler)
// ============================================================
export function receive(text, sender, roomId) {
  if (!text) return;

  // If the chat modal is open for this room, append live
  if (activeRoom && activeRoom.id === roomId) {
    addBubble(text, sender || 'Peer', 'them');
  }

  // Always persist
  saveToCloud(roomId, text, sender);

  // Notify if hidden
  notifyIfHidden(sender, text);
}

// ============================================================
//  PERSIST TO CLOUD
// ============================================================
async function saveToCloud(roomId, text, sender) {
  if (!roomId || !text) return;
  try {
    await api.sendMessage({
      id: 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      roomId: String(roomId),
      from: state.vehicle || state.phone || 'anon',
      to: 'ALL',
      sender: sender || state.userName,
      text: String(text).slice(0, 1000),
      ts: Date.now(),
    });
  } catch (e) {
    // silent - offline persistence is best-effort
  }
}

// ============================================================
//  LOAD HISTORY
// ============================================================
async function loadHistory(roomId) {
  if (!roomId) return;
  const box = document.getElementById('chatMessages');
  if (!box) return;

  const history = await api.getMessages(roomId, 50);
  if (!Array.isArray(history) || !history.length) return;

  // Skip any we already showed live
  const already = new Set();
  box.querySelectorAll('.chat-msg[data-ts]').forEach(el => {
    already.add(String(el.dataset.ts));
  });

  history.forEach(m => {
    const ts = String(m.ts || '');
    if (already.has(ts)) return;
    const side = String(m.from) === String(state.vehicle) ? 'me' : 'them';
    addBubble(m.text, m.sender || 'Peer', side, ts, false);
  });

  box.scrollTop = box.scrollHeight;
}

// ============================================================
//  BUBBLES
// ============================================================
function addBubble(text, sender, side, tsOverride, scroll) {
  if (scroll === undefined) scroll = true;
  const box = document.getElementById('chatMessages');
  if (!box) return;

  const div = document.createElement('div');
  div.className = 'chat-msg ' + side;
  const ts = tsOverride || String(Date.now());
  div.dataset.ts = ts;

  const time = new Date(Number(ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (side === 'me') {
    div.innerHTML = escapeHtml(text) + '<div class="time">' + time + '</div>';
  } else {
    div.innerHTML =
      '<div class="sender">' + escapeHtml(sender || 'Peer') + '</div>' +
      escapeHtml(text) +
      '<div class="time">' + time + '</div>';
  }

  box.appendChild(div);
  if (scroll) box.scrollTop = box.scrollHeight;
}

function addSystemBubble(text) {
  const box = document.getElementById('chatMessages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ============================================================
//  STATUS + NOTIFICATIONS
// ============================================================
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
  try {
    new Notification('Steeradar', {
      body: (sender || 'Peer') + ': ' + text,
      icon: CFG.LOGO_URL,
    });
  } catch (e) {}
}

// ============================================================
//  CLOSE
// ============================================================
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
  get activePeerId() { return activeRoom && activeRoom.peerIds.length ? activeRoom.peerIds[0] : null; },
};