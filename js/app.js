/**
 * ============================================================================
 * STEERADAR FRONTEND CONTROLLER (v7.0)
 * ============================================================================
 * This file contains all the client-side logic for the SteerRadar app.
 * It manages application state, handles DOM events, renders dynamic content,
 * and communicates with the backend via the api.js module.
 * 
 * ARCHITECTURE:
 * - State Management: Centralized `state` object.
 * - Role-Based UI: Functions dynamically show/hide features based on user role.
 * - Event Delegation: Event listeners are attached to parent containers where
 *   possible to handle dynamically rendered content efficiently.
 * ============================================================================
 */

import { api } from './api.js';

// ============================================================================
// 1. GLOBAL STATE & CONSTANTS
// ============================================================================
const state = {
    user: null,              // Logged-in user object
    activeTab: 'lanes',      // Current active view
    lanes: [],               // Cached lanes data
    hive: [],                // Cached hive feed data
    messages: {},            // Cached chat messages by roomId
    currentRoom: null,       // Active chat room ID
    pendingLocation: null,   // Location selected on map waiting to be saved
    map: null,               // Placeholder for Leaflet/Google Maps instance
    isOnline: true           // Network status
};

const DOM = {
    // Views
    views: document.querySelectorAll('.view-section'),
    navButtons: document.querySelectorAll('#bottom-nav button'),
    
    // Modals
    modals: document.querySelectorAll('.modal-overlay'),
    
    // Profile Elements
    profileName: document.getElementById('profile-name-display'),
    profileRole: document.getElementById('profile-role-display'),
    headerAvatar: document.getElementById('header-avatar'),
    adminBtn: document.getElementById('admin-panel-btn'),
    
    // SteerAgent Elements
    steerAgentControls: document.getElementById('steer-agent-controls'),
    becomeAgentSection: document.getElementById('become-steer-agent-section'),
    pendingAgentSection: document.getElementById('steer-agent-pending-section'),
    
    // Chat Elements
    chatView: document.getElementById('hive-chat-view'),
    chatMessages: document.getElementById('chat-messages-container'),
    chatInput: document.getElementById('chat-input'),
    chatTitle: document.getElementById('chat-room-title'),
    
    // Containers
    lanesContainer: document.querySelector('#view-lanes .lane-card')?.parentElement,
    hiveContainer: document.querySelector('#view-hive .post-card:last-of-type')?.parentElement,
    adminApplicationList: document.getElementById('admin-application-list')
};

// ============================================================================
// 2. INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('[App] Initializing SteerRadar...');
    setupEventListeners();
    initMapPlaceholder();
    await checkSession();
});

async function checkSession() {
    const session = await api.checkSession();
    if (session && session.valid) {
        state.user = session.user;
        api.setSession({ phone: state.user.phone, token: api.token, user: state.user });
        updateUIForRole();
    } else {
        openModal('auth-modal');
    }
}

// ============================================================================
// 3. EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
    // 3.1 Auth Forms
    document.getElementById('signin-form')?.addEventListener('submit', handleSignIn);
    document.getElementById('signup-form')?.addEventListener('submit', handleSignUp);
    
    // 3.2 SteerAgent Application Form
    document.getElementById('steer-agent-form')?.addEventListener('submit', handleSteerAgentApplication);
    
    // 3.3 Settings Toggles
    document.getElementById('toggle-ghost-mode')?.addEventListener('change', handleGhostModeToggle);
    
    // 3.4 Chat Input (Enter key)
    DOM.chatInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // 3.5 Network Status
    window.addEventListener('online', () => { state.isOnline = true; showToast('Back online', 'success'); });
    window.addEventListener('offline', () => { state.isOnline = false; showToast('You are offline', 'error'); });
}

// ============================================================================
// 4. AUTHENTICATION & SESSION
// ============================================================================

async function handleSignIn(e) {
    e.preventDefault();
    const identity = document.getElementById('signin-identity').value.trim();
    const password = document.getElementById('signin-password').value;
    const btn = e.target.querySelector('button[type="submit"]');
    
    btn.textContent = 'Signing in...';
    const res = await api.login({ phone: identity, password }); // Assuming phone for now, adjust if email supported
    btn.textContent = 'Sign In';
    
    if (res && res.token) {
        api.setSession(res);
        state.user = res.user;
        closeModal('auth-modal');
        updateUIForRole();
        showToast(`Welcome back, ${state.user.name}!`, 'success');
    } else {
        showToast(api.lastError || 'Login failed', 'error');
    }
}

async function handleSignUp(e) {
    e.preventDefault();
    const name = document.getElementById('signup-name').value.trim();
    const phone = document.getElementById('signup-phone').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirm = document.getElementById('signup-confirm-password').value;

    if (password !== confirm) return showToast('Passwords do not match', 'error');

    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = 'Creating account...';
    
    // NOTE: In a real flow, you would call api.sendOtp() here first, then show an OTP input field,
    // then call api.verifyOtp(), and finally api.register(). For this implementation, 
    // we assume OTP verification is either bypassed or handled in a previous step.
    const res = await api.register({ name, phone, email, password });
    btn.textContent = 'Create Account';

    if (res && res.token) {
        api.setSession(res);
        state.user = res.user;
        closeModal('auth-modal');
        updateUIForRole();
        showToast('Account created successfully!', 'success');
    } else {
        showToast(api.lastError || 'Registration failed', 'error');
    }
}

async function handleLogout() {
    await api.logout();
    api.clearSession();
    state.user = null;
    window.location.reload(); // Simplest way to reset state
}

// ============================================================================
// 5. ROLE-BASED UI UPDATES
// ============================================================================

function updateUIForRole() {
    if (!state.user) return;

    // 5.1 Update Profile Header & Display
    DOM.profileName.textContent = state.user.name;
    DOM.profileRole.textContent = state.user.role === 'agent' ? 'SteerAgent' : 'RearAgent';
    
    const defaultAvatar = 'https://i.pravatar.cc/150?img=11';
    const avatarUrl = state.user.photo || defaultAvatar;
    DOM.headerAvatar.src = avatarUrl;
    document.querySelector('.profile-avatar')?.setAttribute('src', avatarUrl);

    // 5.2 Admin Panel
    if (state.user.isAdmin) {
        DOM.adminBtn.classList.remove('hidden');
    } else {
        DOM.adminBtn.classList.add('hidden');
    }

    // 5.3 SteerAgent vs RearAgent UI
    if (state.user.role === 'agent') {
        DOM.steerAgentControls.classList.remove('hidden');
        DOM.becomeAgentSection.classList.add('hidden');
        DOM.pendingAgentSection.classList.add('hidden');
    } else {
        DOM.steerAgentControls.classList.add('hidden');
        
        // Check application status
        if (state.user.agentStatus === 'pending') {
            DOM.becomeAgentSection.classList.add('hidden');
            DOM.pendingAgentSection.classList.remove('hidden');
        } else {
            DOM.becomeAgentSection.classList.remove('hidden');
            DOM.pendingAgentSection.classList.add('hidden');
        }
    }

    // 5.4 Load Initial Data
    loadLanes();
    loadHive();
}

// ============================================================================
// 6. NAVIGATION & MODALS
// ============================================================================

window.switchTab = (tabName) => {
    state.activeTab = tabName;
    
    // Update Nav Buttons
    DOM.navButtons.forEach(btn => btn.classList.remove('active'));
    document.getElementById(`nav-${tabName}`)?.classList.add('active');

    // Update Views
    DOM.views.forEach(view => view.classList.remove('active'));
    document.getElementById(`view-${tabName}`)?.classList.add('active');

    // Contextual Loading
    if (tabName === 'hive') loadHive();
    if (tabName === 'lanes') loadLanes();
    if (tabName === 'map') setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 100);
};

window.openModal = (id) => document.getElementById(id)?.classList.remove('hidden');
window.closeModal = (id) => document.getElementById(id)?.classList.add('hidden');

window.switchAuthTab = (tab) => {
    document.getElementById('tab-signin').classList.toggle('active', tab === 'signin');
    document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
    document.getElementById('signin-form').classList.toggle('hidden', tab !== 'signin');
    document.getElementById('signup-form').classList.toggle('hidden', tab !== 'signup');
};

// ============================================================================
// 7. LANES (Live Drivers)
// ============================================================================

async function loadLanes() {
    if (!DOM.lanesContainer) return;
    DOM.lanesContainer.innerHTML = '<div class="text-center text-sub mt-4">Loading lanes...</div>';
    
    const lanes = await api.listLanes();
    state.lanes = lanes;
    
    if (lanes.length === 0) {
        DOM.lanesContainer.innerHTML = '<div class="text-center text-sub mt-4">No active lanes right now.</div>';
        return;
    }

    DOM.lanesContainer.innerHTML = lanes.map(lane => createLaneCardHTML(lane)).join('');
}

function createLaneCardHTML(lane) {
    // Determine seat color
    const seatColor = lane.seats > 5 ? 'var(--primary)' : (lane.seats > 2 ? 'var(--warning)' : 'var(--danger)');
    const statusTag = lane.status === 'active' 
        ? '<span class="tag tag-live">● LIVE</span>' 
        : `<span class="tag tag-warning">● ${lane.status.toUpperCase()}</span>`;

    return `
        <div class="lane-card">
            <div class="lane-header">
                <div class="seat-indicator" style="--progress: ${(lane.seats/10)*100}%; --color: ${seatColor};">
                    <div class="seat-inner">
                        <span class="seat-count">${lane.seats || 0}</span>
                        <span class="seat-label">Seats</span>
                    </div>
                </div>
                <div class="lane-details">
                    <div class="lane-title">${escapeHTML(lane.title || 'Untitled Route')}</div>
                    <div class="lane-route">
                        <i class="fas fa-route"></i> ${escapeHTML(lane.description || 'No description')}
                    </div>
                    <div class="lane-tags">
                        ${statusTag}
                        <span class="tag tag-fare">${lane.vehicleType || 'Any'}</span>
                    </div>
                </div>
            </div>
            <div class="lane-footer">
                <div class="driver-info">
                    <img src="${lane.photo || 'https://i.pravatar.cc/150?img=12'}" class="driver-avatar" style="border-radius:50%; object-fit:cover;">
                    <div>
                        <div class="driver-name">${escapeHTML(lane.ownerName || 'Unknown')}</div>
                        <div class="driver-rating"><i class="fas fa-star"></i> Driver</div>
                    </div>
                </div>
                <div class="lane-actions">
                    <button class="btn btn-secondary btn-sm" onclick="openChat('${lane.id}', '${escapeHTML(lane.ownerName)}')">
                        <i class="fas fa-comment"></i> Chat
                    </button>
                    <button class="btn btn-primary btn-sm">
                        <i class="fas fa-chair"></i> Request
                    </button>
                </div>
            </div>
        </div>
    `;
}

// ============================================================================
// 8. HIVE (Community Feed)
// ============================================================================

async function loadHive() {
    if (!DOM.hiveContainer) return;
    // Clear existing posts but keep the header/stories
    const existingPosts = DOM.hiveContainer.querySelectorAll('.post-card:not(.greeting-card)');
    existingPosts.forEach(p => p.remove());

    const posts = await api.listHive();
    state.hive = posts;

    if (posts.length === 0) {
        DOM.hiveContainer.insertAdjacentHTML('beforeend', '<div class="text-center text-sub mt-4">No posts yet. Be the first to share!</div>');
        return;
    }

    posts.forEach(post => {
        DOM.hiveContainer.insertAdjacentHTML('beforeend', createHivePostHTML(post));
    });
}

function createHivePostHTML(post) {
    let mediaHTML = '';
    
    // Render Media based on type
    if (post.photo) {
        mediaHTML = `<div class="post-image"><img src="${post.photo}" alt="Post image"></div>`;
    } else if (post.mediaType === 'youtube' && post.mediaUrl) {
        const videoId = post.mediaUrl.split('v=')[1]?.split('&')[0] || post.mediaUrl.split('youtu.be/')[1];
        mediaHTML = `<div style="margin-top:10px; border-radius:12px; overflow:hidden;">
            <iframe width="100%" height="200" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe>
        </div>`;
    } else if (post.mediaType === 'instagram' && post.mediaUrl) {
        mediaHTML = `<div style="margin-top:10px;"><blockquote class="instagram-media" data-instgrm-permalink="${post.mediaUrl}" data-instgrm-version="14" style="width:100%;"></blockquote></div>`;
        // Note: Instagram embeds require their script to process dynamically added elements
        if (window.instgrm) setTimeout(() => window.instgrm.Embeds.process(), 100);
    }

    return `
        <div class="post-card">
            <div class="post-header">
                <img src="https://i.pravatar.cc/150?img=${Math.floor(Math.random() * 50)}" class="driver-avatar avatar-lg" style="border-radius:50%;">
                <div>
                    <div class="post-user">${escapeHTML(post.ownerName)} <i class="fas fa-check-circle verified-badge"></i></div>
                    <div class="post-time">${timeAgo(post.createdAt)}</div>
                </div>
            </div>
            <div class="post-content">${escapeHTML(post.text)}</div>
            ${mediaHTML}
            <div class="post-actions">
                <div class="post-action" onclick="toggleLike('${post.id}', ${post.likes})">
                    <i class="far fa-heart"></i> <span id="likes-${post.id}">${post.likes || 0}</span>
                </div>
                <div class="post-action"><i class="far fa-comment"></i> Comment</div>
                <div class="post-action"><i class="fas fa-share"></i> Share</div>
            </div>
        </div>
    `;
}

window.toggleLike = async (postId, currentLikes) => {
    if (!state.user) return showToast('Sign in to like posts', 'error');
    
    const isLiked = document.getElementById(`likes-${postId}`).textContent > currentLikes;
    const delta = isLiked ? -1 : 1;
    
    // Optimistic UI update
    document.getElementById(`likes-${postId}`).textContent = currentLikes + delta;
    
    await api.like('hive', postId, delta);
};

// ============================================================================
// 9. CHAT SYSTEM
// ============================================================================

window.openChat = (roomId, name) => {
    state.currentRoom = roomId;
    DOM.chatTitle.textContent = `Chat with ${name}`;
    DOM.chatView.classList.remove('hidden');
    loadMessages(roomId);
};

window.closeChat = () => {
    state.currentRoom = null;
    DOM.chatView.classList.add('hidden');
};

async function loadMessages(roomId) {
    DOM.chatMessages.innerHTML = '<div class="text-center text-sub text-sm">Loading messages...</div>';
    
    const messages = await api.getMessages(roomId);
    state.messages[roomId] = messages;
    
    if (messages.length === 0) {
        DOM.chatMessages.innerHTML = '<div class="text-center text-sub text-sm">No messages yet. Say hi!</div>';
        return;
    }

    DOM.chatMessages.innerHTML = messages.map(msg => `
        <div class="chat-message ${msg.mine ? 'sent' : 'received'}">
            ${escapeHTML(msg.text)}
        </div>
    `).join('');
    
    scrollToBottom();
}

window.sendMessage = async () => {
    const text = DOM.chatInput.value.trim();
    if (!text || !state.currentRoom) return;

    // Optimistic UI update
    DOM.chatMessages.insertAdjacentHTML('beforeend', `
        <div class="chat-message sent">${escapeHTML(text)}</div>
    `);
    DOM.chatInput.value = '';
    scrollToBottom();

    // Send to backend
    const res = await api.sendMessage({ roomId: state.currentRoom, text });
    if (!res) {
        showToast('Failed to send message', 'error');
        // Optionally remove the optimistic message here if failed
    }
};

function scrollToBottom() {
    DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

// ============================================================================
// 10. STEERAGENT APPLICATION
// ============================================================================

async function handleSteerAgentApplication(e) {
    e.preventDefault();
    
    const vehicleNumber = document.getElementById('sa-vehicle-number').value.trim();
    const vehicleType = document.getElementById('sa-vehicle-type').value;
    const upiId = document.getElementById('sa-upi-id').value.trim();
    const agreement = document.getElementById('sa-agreement').checked;
    
    const licenseFile = document.getElementById('sa-license').files[0];
    const rcFile = document.getElementById('sa-rc').files[0];
    const selfieFile = document.getElementById('sa-selfie').files[0];

    if (!licenseFile || !rcFile || !selfieFile) {
        return showToast('Please upload all required documents.', 'error');
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = 'Uploading documents...';
    btn.disabled = true;

    try {
        // 1. Convert files to Base64
        const licenseBase64 = await fileToBase64(licenseFile);
        const rcBase64 = await fileToBase64(rcFile);
        const selfieBase64 = await fileToBase64(selfieFile);

        // 2. Upload images to Drive via API
        const licenseRes = await api.uploadImage(licenseBase64, 'vehicles');
        const rcRes = await api.uploadImage(rcBase64, 'vehicles');
        const selfieRes = await api.uploadImage(selfieBase64, 'avatars');

        if (!licenseRes || !rcRes || !selfieRes) {
            throw new Error('Image upload failed. Please try again.');
        }

        // 3. Submit application
        btn.textContent = 'Submitting application...';
        const payload = {
            vehicle: vehicleNumber,
            vehicleType: vehicleType,
            vehiclePhoto: rcRes.url, // Using RC as vehicle photo
            photo: selfieRes.url,
            city: 'Default' // Can add a city input to the form
        };

        const res = await api.becomeAgent(payload);
        
        if (res) {
            showToast('Application submitted! Pending admin approval.', 'success');
            closeModal('steer-agent-modal');
            // Update local state to reflect pending status
            state.user.agentStatus = 'pending';
            updateUIForRole();
        } else {
            throw new Error(api.lastError || 'Submission failed');
        }

    } catch (err) {
        console.error(err);
        showToast(err.message, 'error');
    } finally {
        btn.textContent = 'Submit Application';
        btn.disabled = false;
    }
}

// ============================================================================
// 11. MAP & LOCATIONS
// ============================================================================

function initMapPlaceholder() {
    // In production, replace this with Leaflet/Google Maps initialization
    const mapContainer = document.querySelector('.map-placeholder');
    if (!mapContainer) return;

    mapContainer.addEventListener('click', (e) => {
        if (!state.user) return showToast('Sign in to save locations', 'error');
        
        // Simulate getting lat/lng from a click
        // In Leaflet, this would be e.latlng.lat and e.latlng.lng
        state.pendingLocation = {
            lat: 12.9716 + (Math.random() - 0.5) * 0.01,
            lng: 77.5946 + (Math.random() - 0.5) * 0.01
        };
        
        openModal('location-modal');
    });
}

window.confirmSaveLocation = async () => {
    const name = document.getElementById('location-name').value.trim();
    if (!name || !state.pendingLocation) return showToast('Please enter a name', 'error');
    
    const res = await api.savePoint({ 
        ...state.pendingLocation, 
        label: name,
        shared: true // Default to shared
    });

    if (res) {
        showToast(`Location "${name}" saved!`, 'success');
        closeModal('location-modal');
        document.getElementById('location-name').value = '';
        state.pendingLocation = null;
    } else {
        showToast('Failed to save location', 'error');
    }
};

window.reportAlert = async (type) => {
    const res = await api.updatePresence({ 
        type, 
        lat: 12.9716, // Replace with actual current location
        lng: 77.5946 
    });
    if (res) {
        closeModal('report-modal');
        showToast(`${type.toUpperCase()} alert posted!`, 'success');
    }
};

async function handleGhostModeToggle(e) {
    const isGhost = e.target.checked;
    const res = await api.updateMe({ ghostMode: isGhost });
    if (!res) {
        e.target.checked = !isGhost; // Revert UI on failure
        showToast('Failed to update Ghost Mode', 'error');
    }
}

// ============================================================================
// 12. ADMIN PANEL
// ============================================================================

window.loadAdminApplications = async () => {
    if (!state.user?.isAdmin) return;
    DOM.adminApplicationList.innerHTML = '<div class="text-center text-sub text-sm">Loading...</div>';
    
    const apps = await api.adminPendingAgents();
    
    if (!apps || apps.length === 0) {
        DOM.adminApplicationList.innerHTML = '<div class="text-center text-sub text-sm">No pending applications.</div>';
        return;
    }

    DOM.adminApplicationList.innerHTML = apps.map(app => `
        <div class="post-card" style="margin-bottom: 10px;">
            <div class="flex justify-between align-center mb-2">
                <strong>${escapeHTML(app.name)} (${app.phone})</strong>
                <span class="tag tag-warning">Pending</span>
            </div>
            <p class="text-sm text-sub">Vehicle: ${escapeHTML(app.vehicle || 'N/A')} (${app.vehicleType || 'N/A'})</p>
            <p class="text-sm text-sub">City: ${escapeHTML(app.city || 'N/A')}</p>
            <div class="flex gap-2 mt-3" style="display:flex; gap:10px;">
                <button class="btn btn-primary btn-sm w-full" onclick="handleAdminAction('${app.uid}', true)">Approve</button>
                <button class="btn btn-danger btn-sm w-full" onclick="handleAdminAction('${app.uid}', false)">Reject</button>
            </div>
        </div>
    `).join('');
};

window.handleAdminAction = async (uid, approve) => {
    const actionText = approve ? 'Approving' : 'Rejecting';
    showToast(`${actionText} application...`, 'info');
    
    const res = await api.adminApproveAgent(uid, approve);
    if (res) {
        showToast(`Application ${approve ? 'approved' : 'rejected'}!`, 'success');
        loadAdminApplications(); // Refresh list
    } else {
        showToast('Action failed: ' + api.lastError, 'error');
    }
};

// ============================================================================
// 13. UTILITIES
// ============================================================================

/**
 * Convert a File object to a Base64 string.
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

/**
 * Escape HTML to prevent XSS when rendering user-generated content.
 */
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Display a toast notification.
 * (Requires corresponding CSS, but falls back to console/alert if not present)
 */
function showToast(message, type = 'info') {
    console.log(`[Toast - ${type}] ${message}`);
    // Simple fallback: use alert for errors, log for others.
    // Replace this with a proper UI toast library or custom implementation.
    if (type === 'error') {
        alert(`Error: ${message}`);
    }
    // You can inject a toast div into the DOM here if you have CSS for it.
}

/**
 * Format an ISO date string into a relative time (e.g., "2h ago").
 */
function timeAgo(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    
    let interval = Math.floor(seconds / 31536000);
    if (interval > 1) return interval + "y ago";
    interval = Math.floor(seconds / 2592000);
    if (interval > 1) return interval + "mo ago";
    interval = Math.floor(seconds / 86400);
    if (interval > 1) return interval + "d ago";
    interval = Math.floor(seconds / 3600);
    if (interval > 1) return interval + "h ago";
    interval = Math.floor(seconds / 60);
    if (interval > 1) return interval + "m ago";
    return "Just now";
}