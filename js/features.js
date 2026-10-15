/**
 * ============================================================================
 * STEERADAR FEATURES (v14.1)
 * ============================================================================
 * Loaded as a separate ES module, after app.js.
 *
 * Changelog vs v14.0:
 *   + showLaneDetails now mirrors the selected agent into window.state.selectedAgent
 *   + "View Full Profile" button calls viewAgentProfile() with no arg
 *     (was passing window.state.selectedAgent || null, which broke when null)
 *   Everything else preserved.
 *
 * Changelog vs v13:
 *   ✗ Removed window.openChat override (was clobbering app.js's real chat)
 *   ✗ Removed window.sendMessage override (was clobbering real message send)
 *   + openAgentChat()  — builds a proper DM room id, calls app.js's openChat
 *   + sendOffer()      — now sends the offer as a real message via app.js
 *   + viewAgentProfile — shows real uploaded photos when available
 *   + getLastAgent()   — named export for other modules
 * ============================================================================
 */

import { logger } from './logger.js';

/* --------------------------- STATE --------------------------- */
let currentSelectedAgent = null;
let currentOfferAmount = 0;
let lastOpenedAgent = null;

/* --------------------------- CONSTANTS --------------------------- */
const DEFAULT_AGENT_AVATAR = 'https://i.pravatar.cc/150?img=12';
const DEFAULT_USER_AVATAR  = 'https://i.pravatar.cc/150?img=11';

/* --------------------------- HELPERS --------------------------- */
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getCurrentUser() {
  return (window.state && window.state.user) || null;
}

/**
 * Build a stable DM room id matching backend's checkRoom() format:
 *   dm-<VEHICLE_A>-<VEHICLE_B>  (both sorted, uppercased, no spaces)
 */
function buildDmRoomId(agent) {
  const me = getCurrentUser();
  const myVehicle    = ((me && me.vehicle) || 'ME').toUpperCase().replace(/[\s-]/g, '');
  const theirVehicle = (agent.vehicle || agent.licensePlate || agent.id || 'AGENT')
                          .toString().toUpperCase().replace(/[\s-]/g, '');
  const ids = [myVehicle, theirVehicle].sort();
  return 'dm-' + ids[0] + '-' + ids[1];
}

/* ==========================================================================
   1. MAP PIN → BOTTOM SHEET
   ========================================================================== */
window.showLaneDetails = function (agent) {
  if (!agent) return;
  currentSelectedAgent = agent;
  lastOpenedAgent = agent;

  // ⭐ v14.1: expose to window.state so external callers can see it
  if (window.state) window.state.selectedAgent = agent;

  const baseFare = Number(agent.baseFare) || 10;
  const distance = Number(agent.distance) || 5;
  const perKm    = Number(agent.perKm)   || 2;
  const totalFare = Number(agent.totalFare) || (baseFare + distance * perKm);
  const occupancy = Number(agent.occupancy) || 78;
  const startTime = agent.startTime || 'Now';
  const route     = agent.route || 'On the road';
  const avatar    = agent.avatar || DEFAULT_AGENT_AVATAR;
  const name      = agent.name || 'SteerAgent';

  const content = `
    <div class="flex justify-between align-center mb-3">
      <div class="flex align-center gap-2">
        <img src="${esc(avatar)}" alt="${esc(name)}" class="user-avatar" style="width: 40px; height: 40px;" onerror="this.src='${DEFAULT_AGENT_AVATAR}'">
        <div>
          <h3 style="font-weight: 700; font-size: 16px;">${esc(name)}</h3>
          <div class="text-sub text-xs">⭐ ${esc(agent.rating || '4.8')}</div>
        </div>
      </div>
      <button onclick="closeBottomSheet()" class="icon-btn"><i class="fas fa-times"></i></button>
    </div>

    <div class="post-card mb-3" style="background: var(--bg-card); padding: 12px; border-radius: 12px; border: 1px solid var(--border-color);">
      <p style="font-weight: 600; margin-bottom: 8px; color: var(--text-main);">${esc(route)}</p>
      <div class="flex justify-between text-sm text-sub">
        <span><i class="fas fa-clock" style="color: var(--primary);"></i> Starts: ${esc(startTime)}</span>
        <span><i class="fas fa-users" style="color: #f59e0b;"></i> ${occupancy}% Full</span>
      </div>
    </div>

    <div class="mb-4">
      <h4 class="text-sub text-xs font-bold mb-2" style="letter-spacing: 0.5px;">FARE BREAKDOWN</h4>
      <div class="flex justify-between text-sm mb-1 text-sub">
        <span>Base Fare</span>
        <span>₹${baseFare}</span>
      </div>
      <div class="flex justify-between text-sm mb-2 text-sub">
        <span>Distance (${distance} km @ ₹${perKm}/km)</span>
        <span>₹${distance * perKm}</span>
      </div>
      <div class="flex justify-between font-bold pt-2" style="border-top: 1px solid var(--border-color); color: var(--text-main);">
        <span>Total Fare</span>
        <span style="color: var(--primary); font-size: 18px;">₹${totalFare}</span>
      </div>
    </div>

    <div class="flex gap-2">
      <button onclick="openNegotiation(${totalFare})" class="btn btn-secondary flex-1" style="padding: 12px;">
        <i class="fas fa-hand-holding-usd"></i> Negotiate
      </button>
      <button onclick="window.openAgentChat()" class="btn btn-primary flex-1" style="padding: 12px;">
        <i class="fas fa-chair"></i> Book Seat
      </button>
    </div>

    <button onclick="viewAgentProfile()" class="btn btn-secondary w-full mt-2" style="padding: 10px;">
      <i class="fas fa-user-circle"></i> View Full Profile
    </button>
  `;

  const contentBox = document.getElementById('bottom-sheet-content');
  if (contentBox) contentBox.innerHTML = content;

  const sheet = document.getElementById('map-bottom-sheet');
  if (!sheet) return;
  sheet.classList.remove('hidden');
  const sheetInner = sheet.querySelector('.bottom-sheet');
  if (sheetInner) sheetInner.classList.add('slide-up');
};

window.closeBottomSheet = function (event) {
  if (event && event.target !== event.currentTarget && !event.target.closest('.bottom-sheet-handle')) return;
  const sheet = document.getElementById('map-bottom-sheet');
  if (!sheet) return;
  const sheetInner = sheet.querySelector('.bottom-sheet');
  if (sheetInner) sheetInner.classList.remove('slide-up');
  sheet.classList.add('hidden');
};

/* ==========================================================================
   2. FARE NEGOTIATION (- digit +)
   ========================================================================== */
window.openNegotiation = function (standardFare) {
  const fare = Number(standardFare) || 20;
  currentOfferAmount = Math.max(5, fare - 2);

  const stdEl = document.getElementById('neg-standard-fare');
  const offerEl = document.getElementById('neg-offer-display');
  if (stdEl) stdEl.innerText = '₹' + fare;
  if (offerEl) offerEl.innerText = '₹' + currentOfferAmount;

  window.closeBottomSheet();

  if (typeof window.openModal === 'function') window.openModal('negotiation-modal');
  else document.getElementById('negotiation-modal').classList.remove('hidden');
};

window.updateOffer = function (delta) {
  currentOfferAmount += Number(delta) || 0;
  if (currentOfferAmount < 5) currentOfferAmount = 5;
  const offerEl = document.getElementById('neg-offer-display');
  if (offerEl) offerEl.innerText = '₹' + currentOfferAmount;
};

window.sendOffer = function () {
  if (!currentSelectedAgent) return;

  const agent = currentSelectedAgent;
  const offer = currentOfferAmount;

  // Close the negotiation modal
  if (typeof window.closeModal === 'function') window.closeModal('negotiation-modal');
  else document.getElementById('negotiation-modal').classList.add('hidden');

  // Open the real DM chat with this agent
  window.openAgentChat(agent);

  // After the chat opens + connects, send the offer as a real message
  setTimeout(function () {
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.value = `Hi, I'd like to offer ₹${offer} for this ride. Is that OK?`;
    if (typeof window.sendMessage === 'function') window.sendMessage();
  }, 500);
};

/* ==========================================================================
   3. CHAT (delegates to app.js's real openChat / sendMessage)
   ========================================================================== */

/**
 * Open a real DM with the given agent (or with the last-selected one).
 * Calls app.js's `openChat(roomId, name, avatar)` which handles the backend.
 */
window.openAgentChat = function (agent) {
  const a = agent || currentSelectedAgent || lastOpenedAgent;
  if (!a) {
    logger.warn('openAgentChat called with no agent');
    return;
  }
  currentSelectedAgent = a;
  lastOpenedAgent = a;

  const roomId = buildDmRoomId(a);
  const name   = a.name || 'SteerAgent';
  const avatar = a.avatar || DEFAULT_AGENT_AVATAR;

  if (typeof window.openChat === 'function') {
    window.openChat(roomId, name, avatar);
  } else {
    logger.error('app.js openChat not available — chat cannot open');
    if (typeof window.showToast === 'function') {
      window.showToast('Chat is unavailable right now', 'error');
    }
  }

  window.closeBottomSheet();
};

window.openChatFromAgentProfile = function () {
  window.openAgentChat(lastOpenedAgent);
};

/* ==========================================================================
   4. AGENT PROFILE MODAL
   ========================================================================== */
window.viewAgentProfile = function (agent) {
  const a = agent || currentSelectedAgent || lastOpenedAgent;
  if (!a) {
    logger.warn('viewAgentProfile called with no agent');
    if (typeof window.showToast === 'function') {
      window.showToast('No agent selected', 'warning');
    }
    return;
  }

  currentSelectedAgent = a;
  lastOpenedAgent = a;

  const avatar = a.avatar || DEFAULT_AGENT_AVATAR;

  const setText = function (id, val) {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
  };
  const setSrc = function (id, src, fallback) {
    const el = document.getElementById(id);
    if (el) {
      el.src = src || fallback || DEFAULT_AGENT_AVATAR;
      el.onerror = function () { this.src = fallback || DEFAULT_AGENT_AVATAR; };
    }
  };

  setSrc('agent-profile-avatar', avatar, DEFAULT_AGENT_AVATAR);
  setText('agent-profile-name', a.name || 'SteerAgent');
  setText('agent-profile-rating', `⭐ ${a.rating || '4.8'} (120 Rides)`);
  setText('agent-vehicle-model', a.vehicleModel || 'Vehicle');
  setText('agent-vehicle-color', a.vehicleColor || '—');
  setText('agent-vehicle-plate', a.licensePlate || a.vehicle || 'N/A');

  // Gallery — prefer real uploaded images, fall back to demo tiles
  const gallery = document.getElementById('agent-images-gallery');
  if (gallery) {
    const photos = [];
    if (a.vehiclePhoto)  photos.push({ url: a.vehiclePhoto,  label: 'Vehicle' });
    if (a.platePhoto)    photos.push({ url: a.platePhoto,    label: 'Number Plate' });
    if (a.selfie)        photos.push({ url: a.selfie,        label: 'Selfie' });
    if (a.licensePhoto)  photos.push({ url: a.licensePhoto,  label: 'License' });
    if (a.photo && a.photo !== avatar) photos.push({ url: a.photo, label: 'Profile' });

    if (photos.length) {
      gallery.innerHTML = photos.map(function (p) {
        return (
          '<div style="min-width: 110px; height: 110px; border-radius: 10px; overflow: hidden; ' +
          'flex-shrink: 0; cursor: pointer; border: 1px solid var(--border-subtle); background: var(--bg-dark); position: relative;">' +
            '<img src="' + esc(p.url) + '" alt="' + esc(p.label) + '" loading="lazy" ' +
              'style="width: 100%; height: 100%; object-fit: cover; display: block;" ' +
              'onerror="this.style.display=\'none\'; this.nextElementSibling.style.display=\'flex\';" />' +
            '<div style="display: none; position: absolute; inset: 0; align-items: center; justify-content: center; ' +
              'color: var(--text-sub); font-size: 11px; font-weight: 700; background: var(--bg-card);">' + esc(p.label) + '</div>' +
          '</div>'
        );
      }).join('');
    } else {
      // Demo tiles (no real photos uploaded yet)
      const mockImages = [
        { label: 'Front View', color: '#bfdbfe', icon: 'fa-car-side' },
        { label: 'Back View',  color: '#bbf7d0', icon: 'fa-car' },
        { label: 'Interior',   color: '#fef08a', icon: 'fa-chair' },
        { label: 'License',    color: '#e9d5ff', icon: 'fa-id-card' }
      ];
      gallery.innerHTML = mockImages.map(function (img) {
        return (
          '<div style="min-width: 110px; height: 85px; background: ' + img.color + '; ' +
          'border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; ' +
          'flex-shrink: 0; cursor: pointer; border: 1px solid rgba(0,0,0,0.05);">' +
            '<i class="fas ' + img.icon + '" style="color: #475569; font-size: 18px; margin-bottom: 4px;"></i>' +
            '<span style="font-size: 10px; font-weight: 600; color: #333;">' + img.label + '</span>' +
          '</div>'
        );
      }).join('');
    }
  }

  if (typeof window.openModal === 'function') window.openModal('agent-profile-modal');
  else document.getElementById('agent-profile-modal').classList.remove('hidden');
};

/* ==========================================================================
   5. NAMED EXPORTS (for app.js or other modules)
   ========================================================================== */
export function getLastAgent()     { return lastOpenedAgent; }
export function getSelectedAgent() { return currentSelectedAgent; }

/* ==========================================================================
   LOG
   ========================================================================== */
logger.info('features.js v14.1 loaded — Lanes, Negotiation, Agent Profile wired.');
console.log('[features] v14.1 loaded');