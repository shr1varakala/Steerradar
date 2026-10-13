/**
 * ============================================================================
 * STEERADAR FRONTEND CONTROLLER (v9.1) - Email + Phone Login
 * ============================================================================
 */

import { api } from './api.js';
import { mapModule } from './map.js';

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
const CONFIG = window.STEERADAR || {};
const POLL_INTERVAL = 20000;
const PRESENCE_INTERVAL = 20000;
const CHAT_POLL_INTERVAL = 5000;
const TOAST_DURATION = CONFIG.TOAST_DURATION_MS || 2400;

// ============================================================================
// 2. STATE
// ============================================================================
const state = {
    user: null,
    session: null,
    activeTab: 'lanes',
    currentRoom: null,
    lanes: [],
    hive: [],
    messages: {},
    savedPoints: [],
    activeVehicles: [],
    signupData: null,
    pendingLocation: null,
    userLocation: null,
    activeTrip: null,
    tripPolyline: null,
    tripPoints: [],
    tripWatchId: null,
    intervals: { poll: null, presence: null, chat: null },
    isLoading: { lanes: false, hive: false, chat: false },
    isOnline: navigator.onLine
};

// ============================================================================
// 3. DOM CACHE
// ============================================================================
const DOM = {
    views: document.querySelectorAll('.view-section'),
    navButtons: document.querySelectorAll('#bottom-nav button'),
    headerAvatar: document.getElementById('header-avatar'),
    adminBtn: document.getElementById('admin-panel-btn'),
    profileName: document.getElementById('profile-name-display'),
    profileRole: document.getElementById('profile-role-display'),
    profileAvatar: document.getElementById('profile-avatar-img'),
    becomeAgentSection: document.getElementById('become-steer-agent-section'),
    pendingAgentSection: document.getElementById('steer-agent-pending-section'),
    steerAgentControls: document.getElementById('steer-agent-controls'),
    tripControls: document.getElementById('trip-controls'),
    tripBtn: document.getElementById('trip-btn'),
    chatView: document.getElementById('hive-chat-view'),
    chatMessages: document.getElementById('chat-messages-container'),
    chatInput: document.getElementById('chat-input'),
    chatTitle: document.getElementById('chat-room-title'),
    adminApplicationList: document.getElementById('admin-application-list')
};

// ============================================================================
// 4. INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('%c SteerRadar v9.1 booted ', 
        'background:#00d4a0;color:#000;font-weight:800;padding:4px 10px;border-radius:4px;');
    
    setupEventListeners();
    setupNetworkHandlers();
    setupVisibilityHandlers();
    setupPWAInstallPrompt();
    initMap();
    
    await checkSession();
});

// ============================================================================
// 5. EVENT LISTENERS
// ============================================================================
function setupEventListeners() {
    document.getElementById('signin-form')?.addEventListener('submit', handleSignIn);
    document.getElementById('signup-form')?.addEventListener('submit', handleSignupStep1);
    document.getElementById('otp-code')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') verifyOTP();
    });
    
    document.getElementById('steer-agent-form')?.addEventListener('submit', handleSteerAgentApplication);
    document.getElementById('create-lane-form')?.addEventListener('submit', handleCreateLane);
    document.getElementById('create-hive-form')?.addEventListener('submit', handleCreateHivePost);
    document.getElementById('edit-profile-form')?.addEventListener('submit', handleEditProfile);
    document.getElementById('toggle-ghost-mode')?.addEventListener('change', handleGhostModeToggle);
    
    DOM.chatInput?.addEventListener('keypress', (e) => { 
        if (e.key === 'Enter') sendMessage(); 
    });
    
    DOM.tripBtn?.addEventListener('click', toggleTrip);
    
    document.getElementById('lane-photo')?.addEventListener('change', (e) => previewImage(e, 'lane-photo-preview'));
    document.getElementById('hive-photo')?.addEventListener('change', (e) => previewImage(e, 'hive-photo-preview'));
    document.getElementById('edit-avatar')?.addEventListener('change', (e) => previewImage(e, 'edit-avatar-preview'));
    
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.add('hidden');
        });
    });
}

// ============================================================================
// 6. NETWORK & VISIBILITY
// ============================================================================
function setupNetworkHandlers() {
    window.addEventListener('online', () => {
        state.isOnline = true;
        showToast('Back online', 'success');
        refreshAll();
    });
    window.addEventListener('offline', () => {
        state.isOnline = false;
        showToast('You are offline', 'warning');
    });
}

function setupVisibilityHandlers() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPolling();
        } else {
            startAutoRefresh();
            refreshAll();
        }
    });
}

// ============================================================================
// 7. SESSION & AUTH
// ============================================================================
async function checkSession() {
    try {
        const res = await api.checkSession();
        if (res && res.valid) {
            state.user = res.user;
            api.setSession({ phone: state.user.phone, token: api.token, user: state.user });
            updateUIForRole();
        } else {
            openModal('auth-modal');
        }
    } catch (err) {
        console.error('Session check failed:', err);
        openModal('auth-modal');
    }
}

// ====== UPDATED: handleSignIn accepts email OR phone ======
async function handleSignIn(e) {
    e.preventDefault();
    const identity = document.getElementById('signin-identity').value.trim();
    const password = document.getElementById('signin-password').value;

    if (!identity || !password) return showToast('Please fill in all fields', 'warning');

    // Smart validation: email OR phone
    const isEmail = identity.includes('@');
    if (isEmail) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)) {
            return showToast('Enter a valid email address', 'error');
        }
    } else {
        const cleanPhone = identity.replace(/\D/g, '');
        if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
            return showToast('Enter a valid 10-digit mobile number starting with 6-9', 'error');
        }
    }

    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Signing in...');

    // Backend accepts 'phone' field for both phone/email identity
    const res = await api.login({ phone: identity, password });
    resetButton(btn, 'Sign In');

    if (res && res.token) {
        // CRITICAL: Save the real phone number from backend to localStorage
        api.setSession({
            token: res.token,
            phone: res.user.phone,
            user: res.user
        });
        state.user = res.user;
        closeModal('auth-modal');
        updateUIForRole();
        showToast(`Welcome back, ${state.user.name.split(' ')[0]}!`, 'success');
    } else {
        showToast(api.lastError || 'Login failed', 'error');
    }
}

async function handleSignupStep1(e) {
    e.preventDefault();
    const data = {
        name: document.getElementById('signup-name').value.trim(),
        phone: document.getElementById('signup-phone').value.trim(),
        email: document.getElementById('signup-email').value.trim(),
        password: document.getElementById('signup-password').value,
        confirmPassword: document.getElementById('signup-confirm-password').value
    };
    
    if (!data.name || !data.phone || !data.email || !data.password) {
        return showToast('Please fill in all fields', 'warning');
    }
    if (data.password.length < 6) return showToast('Password must be at least 6 characters', 'warning');
    if (data.password !== data.confirmPassword) return showToast('Passwords do not match', 'error');
    if (!/^[6-9]\d{9}$/.test(data.phone)) return showToast('Enter a valid 10-digit Indian mobile number', 'warning');
    
    state.signupData = data;
    
    const btn = document.getElementById('signup-submit-btn');
    setButtonLoading(btn, 'Sending OTP...');
    
    const res = await api.sendOtp(data.phone, data.email, 'register');
    resetButton(btn, 'Send OTP');
    
    if (res && res.sent) {
        document.getElementById('otp-message').textContent = 
            `Enter the 6-digit code sent to ${res.to || data.email}`;
        openModal('otp-modal');
        setTimeout(() => document.getElementById('otp-code')?.focus(), 300);
    } else {
        showToast(api.lastError || 'Failed to send OTP', 'error');
    }
}

window.verifyOTP = async () => {
    const code = document.getElementById('otp-code').value.trim();
    if (!code || code.length !== 6) return showToast('Enter a valid 6-digit code', 'warning');
    if (!state.signupData) return showToast('Session expired. Please try again.', 'error');
    
    const btn = document.querySelector('#otp-modal button');
    setButtonLoading(btn, 'Verifying...');
    
    const verifyRes = await api.verifyOtp(state.signupData.phone, code);
    if (!verifyRes || !verifyRes.verified) {
        resetButton(btn, 'Verify & Create Account');
        return showToast(api.lastError || 'Invalid OTP', 'error');
    }
    
    const regRes = await api.register(state.signupData);
    resetButton(btn, 'Verify & Create Account');
    
    if (regRes && regRes.token) {
        api.setSession({
            token: regRes.token,
            phone: regRes.user.phone,
            user: regRes.user
        });
        state.user = regRes.user;
        state.signupData = null;
        closeModal('otp-modal');
        closeModal('auth-modal');
        updateUIForRole();
        showToast('Account created successfully!', 'success');
    } else {
        showToast(api.lastError || 'Registration failed', 'error');
    }
};

window.handleLogout = async () => {
    if (!confirm('Are you sure you want to log out?')) return;
    stopPolling();
    await api.logout();
    api.clearSession();
    window.location.reload();
};

// ============================================================================
// 8. ROLE-BASED UI
// ============================================================================
function updateUIForRole() {
    if (!state.user) return;
    
    const avatar = state.user.photo || `https://i.pravatar.cc/150?u=${state.user.phone}`;
    
    if (DOM.headerAvatar) {
        DOM.headerAvatar.src = avatar;
        DOM.headerAvatar.onerror = () => { DOM.headerAvatar.src = 'https://i.pravatar.cc/150?img=11'; };
    }
    if (DOM.profileName) DOM.profileName.textContent = state.user.name;
    if (DOM.profileRole) DOM.profileRole.textContent = 
        state.user.role === 'agent' ? 'SteerAgent' : 'RearAgent';
    if (DOM.profileAvatar) DOM.profileAvatar.src = avatar;
    
    toggleVisibility(DOM.adminBtn, state.user.isAdmin);
    toggleVisibility(DOM.steerAgentControls, state.user.role === 'agent');
    toggleVisibility(DOM.tripControls, state.user.role === 'agent');
    
    if (state.user.role === 'agent') {
        toggleVisibility(DOM.becomeAgentSection, false);
        toggleVisibility(DOM.pendingAgentSection, false);
    } else if (state.user.agentStatus === 'pending') {
        toggleVisibility(DOM.becomeAgentSection, false);
        toggleVisibility(DOM.pendingAgentSection, true);
    } else {
        toggleVisibility(DOM.becomeAgentSection, true);
        toggleVisibility(DOM.pendingAgentSection, false);
    }
    
    const ghostToggle = document.getElementById('toggle-ghost-mode');
    if (ghostToggle) ghostToggle.checked = !!state.user.ghostMode;
    
    const greeting = document.getElementById('hive-greeting');
    if (greeting) {
        const hour = new Date().getHours();
        const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        greeting.textContent = `${timeGreeting}, ${state.user.name.split(' ')[0]} 👋`;
    }
    
    refreshAll();
}

// ============================================================================
// 9. NAVIGATION
// ============================================================================
window.switchTab = (tabName) => {
    state.activeTab = tabName;
    
    DOM.navButtons.forEach(btn => btn.classList.remove('active'));
    document.getElementById(`nav-${tabName}`)?.classList.add('active');
    
    DOM.views.forEach(view => view.classList.remove('active'));
    document.getElementById(`view-${tabName}`)?.classList.add('active');
    
    if (tabName === 'map') {
        setTimeout(() => mapModule.refreshSize?.(), 150);
    }
    if (tabName === 'hive') loadHive();
    if (tabName === 'lanes') loadLanes();
    if (tabName === 'profile') loadSavedPoints();
};

// ============================================================================
// 10. MODAL UTILITIES
// ============================================================================
window.openModal = (id) => {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('hidden');
    
    if (id === 'admin-modal') loadAdminApplications();
    if (id === 'trips-modal') loadTrips();
    
    setTimeout(() => modal.querySelector('input:not([type=file]), textarea')?.focus(), 250);
};

window.closeModal = (id) => document.getElementById(id)?.classList.add('hidden');

window.switchAuthTab = (tab) => {
    document.getElementById('tab-signin').classList.toggle('active', tab === 'signin');
    document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
    document.getElementById('signin-form').classList.toggle('hidden', tab !== 'signin');
    document.getElementById('signup-form').classList.toggle('hidden', tab !== 'signup');
};

// ============================================================================
// 11. AUTO-REFRESH & POLLING
// ============================================================================
function startAutoRefresh() {
    stopPolling();
    
    state.intervals.poll = setInterval(() => {
        if (!state.isOnline) return;
        if (state.activeTab === 'lanes') loadLanes(true);
        if (state.activeTab === 'hive') loadHive(true);
    }, POLL_INTERVAL);
    
    if (state.user?.role === 'agent') {
        state.intervals.presence = setInterval(broadcastPresence, PRESENCE_INTERVAL);
        broadcastPresence();
    }
}

function stopPolling() {
    Object.keys(state.intervals).forEach(k => {
        if (state.intervals[k]) clearInterval(state.intervals[k]);
        state.intervals[k] = null;
    });
}

function refreshAll() {
    startAutoRefresh();
    if (state.activeTab === 'lanes') loadLanes();
    if (state.activeTab === 'hive') loadHive();
}

// ============================================================================
// 12. LANES
// ============================================================================
async function loadLanes(silent = false) {
    if (!state.isOnline || state.isLoading.lanes) return;
    state.isLoading.lanes = true;
    
    const container = getLanesContainer();
    if (!silent && container && !container.querySelector('.lane-card')) {
        container.innerHTML = skeletonCards(2);
    }
    
    const lanes = await api.listLanes();
    state.lanes = lanes;
    state.isLoading.lanes = false;
    
    if (!container) return;
    
    if (!lanes.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-bus"></i>
                <p>No active lanes right now.</p>
                ${state.user?.role === 'agent' 
                    ? '<p class="text-xs mt-2">Tap <b>+</b> to create your first lane!</p>' 
                    : ''}
            </div>`;
        return;
    }
    
    container.innerHTML = lanes.map(createLaneCardHTML).join('');
}

function getLanesContainer() {
    const header = document.querySelector('#view-lanes .section-header');
    if (!header) return null;
    let container = document.getElementById('lanes-list');
    if (!container) {
        container = document.createElement('div');
        container.id = 'lanes-list';
        container.className = 'stagger';
        header.parentElement.appendChild(container);
    }
    return container;
}

function createLaneCardHTML(lane) {
    const seats = parseInt(lane.seats) || 0;
    const maxSeats = 10;
    const progress = Math.min((seats / maxSeats) * 100, 100);
    const color = seats > 5 ? 'var(--primary)' : (seats > 2 ? 'var(--warning)' : 'var(--danger)');
    
    return `
        <div class="lane-card">
            <div class="lane-header">
                <div class="seat-indicator" style="--progress: ${progress}%; --color: ${color};">
                    <div class="seat-inner">
                        <span class="seat-count">${seats}</span>
                        <span class="seat-label">Seats</span>
                    </div>
                </div>
                <div class="lane-details">
                    <div class="lane-title">${escapeHTML(lane.title || 'Untitled Route')}</div>
                    <div class="lane-route">
                        <i class="fas fa-route"></i> ${escapeHTML(lane.description || 'No description')}
                    </div>
                    <div class="lane-tags">
                        <span class="tag tag-live">LIVE</span>
                        <span class="tag tag-fare">${escapeHTML(lane.vehicleType || 'Any')}</span>
                    </div>
                </div>
            </div>
            <div class="lane-footer">
                <div class="driver-info">
                    <img src="${lane.photo || 'https://i.pravatar.cc/150?img=12'}" 
                        class="driver-avatar" 
                        onerror="this.src='https://i.pravatar.cc/150?img=12'">
                    <div>
                        <div class="driver-name">${escapeHTML(lane.ownerName || 'Driver')}</div>
                        <div class="driver-rating"><i class="fas fa-star"></i> SteerAgent</div>
                    </div>
                </div>
                <div class="lane-actions">
                    <button class="btn btn-secondary btn-sm" 
                        onclick="openChat('${lane.id}', '${escapeHTML(lane.ownerName || 'Driver')}')">
                        <i class="fas fa-comment"></i> Chat
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="requestSeat('${lane.id}')">
                        <i class="fas fa-chair"></i> Request
                    </button>
                </div>
            </div>
        </div>`;
}

window.requestSeat = (laneId) => {
    if (!state.user) return showToast('Please sign in first', 'error');
    showToast('Seat request sent! The driver will respond in chat.', 'success');
};

// ============================================================================
// 13. HIVE
// ============================================================================
async function loadHive(silent = false) {
    if (!state.isOnline || state.isLoading.hive) return;
    state.isLoading.hive = true;
    
    const container = getHiveContainer();
    if (!silent && container && !container.querySelector('.post-card')) {
        container.innerHTML = skeletonCards(3);
    }
    
    const posts = await api.listHive();
    state.hive = posts;
    state.isLoading.hive = false;
    
    if (!container) return;
    
    if (!posts.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-comments"></i>
                <p>No posts yet. Be the first to share!</p>
            </div>`;
        return;
    }
    
    container.innerHTML = posts.map(createHivePostHTML).join('');
    
    if (window.instgrm) setTimeout(() => window.instgrm.Embeds.process(), 100);
}

function getHiveContainer() {
    const subtitle = document.querySelector('#view-hive .section-subtitle');
    if (!subtitle) return null;
    let container = document.getElementById('hive-list');
    if (!container) {
        container = document.createElement('div');
        container.id = 'hive-list';
        container.className = 'stagger';
        subtitle.parentElement.appendChild(container);
    }
    return container;
}

function createHivePostHTML(post) {
    let mediaHTML = '';
    
    if (post.photo) {
        mediaHTML = `<div class="post-image"><img src="${post.photo}" alt="Post" onerror="this.style.display='none'"></div>`;
    } else if (post.mediaType === 'youtube' && post.mediaUrl) {
        const vid = extractYouTubeId(post.mediaUrl);
        if (vid) {
            mediaHTML = `<div style="margin-bottom:12px; border-radius:12px; overflow:hidden;">
                <iframe width="100%" height="200" 
                    src="https://www.youtube.com/embed/${vid}" 
                    frameborder="0" allowfullscreen loading="lazy"></iframe>
            </div>`;
        }
    } else if (post.mediaType === 'instagram' && post.mediaUrl) {
        mediaHTML = `<div style="margin-bottom:12px;">
            <blockquote class="instagram-media" 
                data-instgrm-permalink="${post.mediaUrl}" 
                data-instgrm-version="14" 
                style="width:100%; margin:0;"></blockquote>
        </div>`;
    }
    
    const avatar = `https://i.pravatar.cc/150?u=${post.owner || post.userPhone || Math.random()}`;
    
    return `
        <div class="post-card">
            <div class="post-header">
                <img src="${avatar}" class="driver-avatar avatar-lg" 
                    onerror="this.src='https://i.pravatar.cc/150?img=5'">
                <div>
                    <div class="post-user">
                        ${escapeHTML(post.ownerName || 'User')}
                        <i class="fas fa-check-circle verified-badge"></i>
                    </div>
                    <div class="post-time">${timeAgo(post.createdAt)}</div>
                </div>
            </div>
            <div class="post-content">${escapeHTML(post.text || '')}</div>
            ${mediaHTML}
            <div class="post-actions">
                <div class="post-action" onclick="toggleLike('${post.id}', ${post.likes || 0})">
                    <i class="far fa-heart"></i> <span id="likes-${post.id}">${post.likes || 0}</span>
                </div>
                <div class="post-action"><i class="far fa-comment"></i> Comment</div>
                <div class="post-action"><i class="fas fa-share"></i> Share</div>
            </div>
        </div>`;
}

window.toggleLike = async (postId, currentLikes) => {
    if (!state.user) return showToast('Sign in to like posts', 'error');
    
    const el = document.getElementById(`likes-${postId}`);
    if (!el) return;
    const wasLiked = el.dataset.liked === 'true';
    const delta = wasLiked ? -1 : 1;
    
    el.textContent = Math.max(0, currentLikes + delta);
    el.dataset.liked = (!wasLiked).toString();
    el.parentElement.style.color = wasLiked ? '' : 'var(--primary)';
    
    await api.like('hive', postId, delta);
};

// ============================================================================
// 14. CHAT
// ============================================================================
window.openChat = async (roomId, name) => {
    state.currentRoom = roomId;
    DOM.chatTitle.textContent = name || 'Hive Chat';
    DOM.chatView.classList.remove('hidden');
    
    await loadMessages(roomId);
    
    if (state.intervals.chat) clearInterval(state.intervals.chat);
    state.intervals.chat = setInterval(() => loadMessages(roomId, true), CHAT_POLL_INTERVAL);
};

window.closeChat = () => {
    state.currentRoom = null;
    DOM.chatView.classList.add('hidden');
    if (state.intervals.chat) {
        clearInterval(state.intervals.chat);
        state.intervals.chat = null;
    }
};

async function loadMessages(roomId, silent = false) {
    if (!silent) {
        DOM.chatMessages.innerHTML = `
            <div class="text-center text-sub text-sm" style="padding:20px;">
                <div class="spinner"></div>
            </div>`;
    }
    
    const messages = await api.getMessages(roomId);
    state.messages[roomId] = messages;
    
    if (!messages.length) {
        DOM.chatMessages.innerHTML = `
            <div class="empty-state" style="padding: 40px 20px;">
                <i class="fas fa-comment-dots"></i>
                <p>No messages yet. Say hi! 👋</p>
            </div>`;
        return;
    }
    
    const html = messages.map(msg => `
        <div class="chat-message ${msg.mine ? 'sent' : 'received'}">${escapeHTML(msg.text)}</div>
    `).join('');
    
    if (DOM.chatMessages.innerHTML !== html) {
        DOM.chatMessages.innerHTML = html;
        scrollToBottom();
    }
}

window.sendMessage = async () => {
    const text = DOM.chatInput.value.trim();
    if (!text || !state.currentRoom) return;
    
    DOM.chatInput.value = '';
    
    DOM.chatMessages.insertAdjacentHTML('beforeend', `
        <div class="chat-message sent">${escapeHTML(text)}</div>
    `);
    scrollToBottom();
    
    const res = await api.sendMessage({ roomId: state.currentRoom, text });
    if (!res) showToast('Failed to send message', 'error');
};

function scrollToBottom() {
    DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

// --- NEIGHBORHOOD CHAT ---
function getNeighborhoodRoomId() {
    const lat = state.userLocation?.lat || CONFIG.DEFAULT_CENTER?.lat || 17.3850;
    const lng = state.userLocation?.lng || CONFIG.DEFAULT_CENTER?.lng || 78.4867;
    return `local_${lat.toFixed(2)}_${lng.toFixed(2)}`;
}

window.openNeighborhoodChat = async () => {
    if (!state.user) return showToast('Please sign in first', 'error');
    
    showToast('Finding riders near you...', 'info');
    
    try {
        const loc = await mapModule.locateUser();
        state.userLocation = loc;
    } catch (e) {
        console.warn('Using default location for neighborhood chat:', e);
    }
    
    const roomId = getNeighborhoodRoomId();
    openChat(roomId, '🏘️ Neighborhood Chat');
};

// ============================================================================
// 15. FAB
// ============================================================================
window.handleFABClick = () => {
    if (!state.user) return showToast('Please sign in first', 'error');
    
    if (state.activeTab === 'lanes') {
        if (state.user.role !== 'agent') {
            return showToast('Only SteerAgents can create lanes. Apply in Profile.', 'warning');
        }
        openModal('create-lane-modal');
    } else {
        openModal('create-hive-modal');
    }
};

// ============================================================================
// 16. CREATE LANE
// ============================================================================
async function handleCreateLane(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Posting...');
    
    try {
        const photoFile = document.getElementById('lane-photo').files[0];
        let photoUrl = '';
        
        if (photoFile) {
            const b64 = await fileToBase64(photoFile);
            const upload = await api.uploadImage(b64, 'lanes');
            if (upload?.url) photoUrl = upload.url;
        }
        
        const payload = {
            title: document.getElementById('lane-title').value.trim(),
            description: document.getElementById('lane-description').value.trim(),
            seats: document.getElementById('lane-seats').value,
            vehicleType: document.getElementById('lane-vehicle-type').value,
            photo: photoUrl,
            lat: CONFIG.DEFAULT_CENTER?.lat || 17.3850,
            lng: CONFIG.DEFAULT_CENTER?.lng || 78.4867
        };
        
        const res = await api.insertLane(payload);
        if (res) {
            showToast('Lane posted successfully!', 'success');
            closeModal('create-lane-modal');
            e.target.reset();
            loadLanes();
        } else {
            throw new Error(api.lastError || 'Failed to post lane');
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        resetButton(btn, 'Post Lane');
    }
}

// ============================================================================
// 17. CREATE HIVE POST
// ============================================================================
async function handleCreateHivePost(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Posting...');
    
    try {
        const photoFile = document.getElementById('hive-photo').files[0];
        const embedUrl = document.getElementById('hive-embed-url').value.trim();
        const text = document.getElementById('hive-text').value.trim();
        
        if (!text && !photoFile && !embedUrl) {
            throw new Error('Add some text or media');
        }
        
        let photoUrl = '';
        let mediaType = '';
        let mediaUrl = '';
        
        if (photoFile) {
            const b64 = await fileToBase64(photoFile);
            const upload = await api.uploadImage(b64, 'hive');
            if (upload?.url) { photoUrl = upload.url; mediaType = 'image'; }
        } else if (embedUrl) {
            mediaUrl = embedUrl;
            if (/youtube\.com|youtu\.be/.test(embedUrl)) mediaType = 'youtube';
            else if (/instagram\.com/.test(embedUrl)) mediaType = 'instagram';
            else mediaType = 'link';
        }
        
        const payload = {
            text,
            photo: photoUrl,
            mediaUrl,
            mediaType,
            lat: CONFIG.DEFAULT_CENTER?.lat || 17.3850,
            lng: CONFIG.DEFAULT_CENTER?.lng || 78.4867
        };
        
        const res = await api.insertHive(payload);
        if (res) {
            showToast('Posted to Hive! 🎉', 'success');
            closeModal('create-hive-modal');
            e.target.reset();
            loadHive();
        } else {
            throw new Error(api.lastError || 'Failed to post');
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        resetButton(btn, 'Post to Hive');
    }
}

// ============================================================================
// 18. PROFILE EDIT
// ============================================================================
window.openEditProfile = () => {
    if (!state.user) return;
    document.getElementById('edit-name').value = state.user.name || '';
    document.getElementById('edit-upi').value = state.user.upiId || '';
    openModal('edit-profile-modal');
};

async function handleEditProfile(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Saving...');
    
    try {
        const avatarFile = document.getElementById('edit-avatar').files[0];
        let photoUrl = state.user.photo || '';
        
        if (avatarFile) {
            const b64 = await fileToBase64(avatarFile);
            const upload = await api.uploadImage(b64, 'avatars');
            if (upload?.url) photoUrl = upload.url;
        }
        
        const patch = {
            name: document.getElementById('edit-name').value.trim(),
            upiId: document.getElementById('edit-upi').value.trim(),
            photo: photoUrl
        };
        
        const res = await api.updateMe(patch);
        if (res) {
            state.user = { ...state.user, ...res };
            api.setSession({ phone: state.user.phone, token: api.token, user: state.user });
            showToast('Profile updated!', 'success');
            closeModal('edit-profile-modal');
            updateUIForRole();
        } else {
            throw new Error(api.lastError || 'Failed to update');
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        resetButton(btn, 'Save Changes');
    }
}

// ============================================================================
// 19. STEERAGENT APPLICATION
// ============================================================================
async function handleSteerAgentApplication(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Uploading documents...');
    
    try {
        const licenseFile = document.getElementById('sa-license').files[0];
        const rcFile = document.getElementById('sa-rc').files[0];
        const selfieFile = document.getElementById('sa-selfie').files[0];
        
        if (!licenseFile || !rcFile || !selfieFile) {
            throw new Error('Please upload all required documents');
        }
        
        const [licenseRes, rcRes, selfieRes] = await Promise.all([
            api.uploadImage(await fileToBase64(licenseFile), 'vehicles'),
            api.uploadImage(await fileToBase64(rcFile), 'vehicles'),
            api.uploadImage(await fileToBase64(selfieFile), 'avatars')
        ]);
        
        if (!licenseRes || !rcRes || !selfieRes) {
            throw new Error('Document upload failed. Please try again.');
        }
        
        setButtonLoading(btn, 'Submitting application...');
        
        const payload = {
            vehicle: document.getElementById('sa-vehicle-number').value.trim(),
            vehicleType: document.getElementById('sa-vehicle-type').value,
            vehiclePhoto: rcRes.url,
            photo: selfieRes.url,
            city: 'Hyderabad'
        };
        
        const res = await api.becomeAgent(payload);
        
        if (res) {
            const upi = document.getElementById('sa-upi-id').value.trim();
            if (upi) await api.updateMe({ upiId: upi });
            
            showToast('Application submitted! Awaiting admin approval.', 'success');
            closeModal('steer-agent-modal');
            state.user.agentStatus = 'pending';
            updateUIForRole();
        } else {
            throw new Error(api.lastError || 'Submission failed');
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        resetButton(btn, 'Submit Application');
    }
}

// ============================================================================
// 20. ADMIN PANEL
// ============================================================================
window.loadAdminApplications = async () => {
    if (!state.user?.isAdmin) return;
    
    DOM.adminApplicationList.innerHTML = `
        <div class="text-center text-sub text-sm" style="padding:20px;">
            <div class="spinner"></div>
        </div>`;
    
    const apps = await api.adminPendingAgents();
    
    if (!apps || !apps.length) {
        DOM.adminApplicationList.innerHTML = `
            <div class="empty-state" style="padding: 20px;">
                <i class="fas fa-check-circle" style="color:var(--primary);"></i>
                <p>No pending applications.</p>
            </div>`;
        return;
    }
    
    DOM.adminApplicationList.innerHTML = apps.map(app => `
        <div class="post-card" style="margin-bottom: 10px;">
            <div class="flex justify-between align-center mb-2">
                <strong>${escapeHTML(app.name || 'Applicant')}</strong>
                <span class="tag tag-warning">Pending</span>
            </div>
            <p class="text-sm text-sub">📱 ${escapeHTML(app.phone || 'N/A')}</p>
            <p class="text-sm text-sub">🚗 ${escapeHTML(app.vehicle || 'N/A')} (${escapeHTML(app.vehicleType || 'N/A')})</p>
            <p class="text-sm text-sub">📍 ${escapeHTML(app.city || 'N/A')}</p>
            <div class="flex gap-2 mt-3" style="display:flex; gap:10px;">
                <button class="btn btn-primary btn-sm w-full" onclick="handleAdminAction('${app.uid}', true)">
                    <i class="fas fa-check"></i> Approve
                </button>
                <button class="btn btn-danger btn-sm w-full" onclick="handleAdminAction('${app.uid}', false)">
                    <i class="fas fa-times"></i> Reject
                </button>
            </div>
        </div>
    `).join('');
};

window.handleAdminAction = async (uid, approve) => {
    showToast(`${approve ? 'Approving' : 'Rejecting'}...`, 'info');
    const res = await api.adminApproveAgent(uid, approve);
    if (res) {
        showToast(`Application ${approve ? 'approved' : 'rejected'}!`, 'success');
        loadAdminApplications();
    } else {
        showToast('Action failed: ' + api.lastError, 'error');
    }
};

// ============================================================================
// 21. MAP INTEGRATION
// ============================================================================
function initMap() {
    mapModule.init('map', handleMapClick);
}

function handleMapClick(lat, lng) {
    if (!state.user) return showToast('Sign in to save locations', 'error');
    
    state.pendingLocation = { lat, lng };
    
    mapModule.dropMarker(lat, lng, `
        <div style="text-align:center; font-family:sans-serif; padding: 4px;">
            <p style="margin:5px 0; font-size:12px; color:#a0a0a0;">
                ${lat.toFixed(4)}, ${lng.toFixed(4)}
            </p>
            <button onclick="openModal('location-modal')" 
                style="background:#00d4a0; color:#000; border:none; padding:8px 16px; 
                border-radius:6px; cursor:pointer; font-weight:bold; font-size:13px;">
                <i class="fas fa-bookmark"></i> Save Location
            </button>
        </div>
    `);
}

window.confirmSaveLocation = async () => {
    const name = document.getElementById('location-name').value.trim();
    if (!name || !state.pendingLocation) return showToast('Enter a name for this location', 'warning');
    
    const res = await api.savePoint({ 
        ...state.pendingLocation, 
        label: name, 
        shared: true 
    });
    
    if (res) {
        showToast(`"${name}" saved!`, 'success');
        closeModal('location-modal');
        document.getElementById('location-name').value = '';
        state.pendingLocation = null;
        loadSavedPoints();
    } else {
        showToast('Failed to save location', 'error');
    }
};

async function loadSavedPoints() {
    if (!state.user) return;
    const points = await api.myPoints();
    state.savedPoints = points || [];
}

// ============================================================================
// 22. LIVE PRESENCE
// ============================================================================
async function broadcastPresence() {
    if (!state.user || state.user.role !== 'agent' || state.user.ghostMode) return;
    if (!navigator.geolocation) return;
    
    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const { latitude, longitude, heading, speed } = pos.coords;
            state.userLocation = { lat: latitude, lng: longitude };
            
            await api.updatePresence({
                lat: latitude,
                lng: longitude,
                heading: heading || '',
                speed: speed || '',
                vehicle: state.user.vehicle || ''
            });
            
            if (state.activeTrip) {
                const point = [latitude, longitude];
                const last = state.tripPoints[state.tripPoints.length - 1];
                if (!last || calculateDistance([last, point]) > 0.01) {
                    state.tripPoints.push(point);
                    mapModule.updatePolyline?.(state.tripPoints);
                }
            }
            
            const vehicles = await api.activeVehicles();
            state.activeVehicles = vehicles;
            mapModule.renderVehicles?.(vehicles);
        },
        (err) => console.warn('Location error:', err.message),
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    );
}

// ============================================================================
// 23. ALERTS
// ============================================================================
window.reportAlert = async (type) => {
    if (!state.user) return showToast('Sign in first', 'error');
    
    const lat = state.userLocation?.lat || CONFIG.DEFAULT_CENTER?.lat || 17.3850;
    const lng = state.userLocation?.lng || CONFIG.DEFAULT_CENTER?.lng || 78.4867;
    
    const res = await api.reportAlert({ type, lat, lng });
    if (res) {
        mapModule.addAlertMarker?.(lat, lng, type);
        closeModal('report-modal');
        showToast(`${type.toUpperCase()} alert posted!`, 'success');
    } else {
        showToast('Failed to post alert', 'error');
    }
};

// ============================================================================
// 24. GHOST MODE
// ============================================================================
async function handleGhostModeToggle(e) {
    const isGhost = e.target.checked;
    const res = await api.updateMe({ ghostMode: isGhost });
    
    if (res) {
        state.user.ghostMode = isGhost;
        if (isGhost) {
            await api.removePresence();
            showToast('Ghost mode ON — you are hidden', 'info');
        } else {
            broadcastPresence();
            showToast('Ghost mode OFF — visible to others', 'info');
        }
    } else {
        e.target.checked = !isGhost;
        showToast('Failed to update Ghost Mode', 'error');
    }
}

// ============================================================================
// 25. TRIP MANAGEMENT
// ============================================================================
window.toggleTrip = async () => {
    if (!state.user || state.user.role !== 'agent') {
        return showToast('Only SteerAgents can start trips', 'warning');
    }
    
    const btn = DOM.tripBtn;
    
    if (state.activeTrip) {
        setButtonLoading(btn, '');
        const endLat = state.userLocation?.lat || null;
        const endLng = state.userLocation?.lng || null;
        
        const res = await api.endTrip(state.activeTrip.id, {
            endLat,
            endLng,
            distanceKm: calculateDistance(state.tripPoints)
        });
        
        resetButton(btn, '<i class="fas fa-play"></i>');
        btn.classList.remove('active');
        
        if (res) {
            showToast(`Trip ended! Distance: ${calculateDistance(state.tripPoints)} km`, 'success');
            state.activeTrip = null;
            state.tripPoints = [];
            state.tripPolyline = null;
            mapModule.clearPolylines?.();
            
            if (state.tripWatchId !== null) {
                navigator.geolocation.clearWatch(state.tripWatchId);
                state.tripWatchId = null;
            }
        } else {
            showToast('Failed to end trip', 'error');
        }
    } else {
        setButtonLoading(btn, '');
        const startLat = state.userLocation?.lat || CONFIG.DEFAULT_CENTER?.lat || 17.3850;
        const startLng = state.userLocation?.lng || CONFIG.DEFAULT_CENTER?.lng || 78.4867;
        
        const res = await api.startTrip({ startLat, startLng });
        resetButton(btn, '<i class="fas fa-stop"></i>');
        
        if (res) {
            showToast('Trip started! Share your route.', 'success');
            state.activeTrip = res;
            state.tripPoints = [[startLat, startLng]];
            btn.classList.add('active');
            state.tripPolyline = mapModule.drawPolyline?.(state.tripPoints);
            startTripTracking();
        } else {
            showToast('Failed to start trip', 'error');
        }
    }
};

function startTripTracking() {
    if (!navigator.geolocation) return;
    
    state.tripWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            const { latitude, longitude } = pos.coords;
            const point = [latitude, longitude];
            const last = state.tripPoints[state.tripPoints.length - 1];
            if (last && calculateDistance([last, point]) < 0.01) return;
            
            state.tripPoints.push(point);
            mapModule.updatePolyline?.(state.tripPoints);
            
            api.updatePresence({
                lat: latitude,
                lng: longitude,
                vehicle: state.user.vehicle || ''
            });
        },
        (err) => console.warn('Trip tracking error:', err.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
}

function calculateDistance(points) {
    if (!points || points.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const [lat1, lon1] = points[i-1];
        const [lat2, lon2] = points[i];
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + 
                  Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * 
                  Math.sin(dLon/2)**2;
        total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    return Math.round(total * 100) / 100;
}

window.loadTrips = async () => {
    const container = document.getElementById('trips-list');
    if (!container) return;
    
    container.innerHTML = `
        <div class="text-center text-sub text-sm" style="padding:20px;">
            <div class="spinner"></div>
        </div>`;
    
    const trips = await api.myTrips();
    if (!trips || !trips.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-route"></i>
                <p>No trips yet.</p>
            </div>`;
        return;
    }
    
    container.innerHTML = trips.map(trip => {
        const isActive = trip.status === 'active';
        const start = trip.startedAt ? new Date(trip.startedAt).toLocaleString() : 'Unknown';
        const end = trip.endedAt ? new Date(trip.endedAt).toLocaleString() : 'Ongoing';
        const distance = trip.distanceKm ? `${trip.distanceKm} km` : '—';
        
        return `
            <div class="trip-card">
                <div class="trip-header">
                    <span class="trip-status ${isActive ? 'active' : 'ended'}">
                        ${isActive ? 'ACTIVE' : 'ENDED'}
                    </span>
                    <span class="trip-time">${timeAgo(trip.createdAt)}</span>
                </div>
                <div class="trip-route">
                    <i class="fas fa-map-pin"></i>
                    <span>${start} → ${end}</span>
                </div>
                <div class="trip-distance">
                    <i class="fas fa-road"></i> ${distance}
                </div>
            </div>
        `;
    }).join('');
};

// ============================================================================
// 26. IMAGE PREVIEW
// ============================================================================
function previewImage(event, previewId) {
    const file = event.target.files?.[0];
    if (!file) return;
    
    let preview = document.getElementById(previewId);
    if (!preview) {
        preview = document.createElement('img');
        preview.id = previewId;
        preview.style.cssText = 'width:100%; max-height:160px; object-fit:cover; border-radius:12px; margin-top:10px;';
        event.target.parentElement.appendChild(preview);
    }
    
    const reader = new FileReader();
    reader.onload = (e) => preview.src = e.target.result;
    reader.readAsDataURL(file);
}

// ============================================================================
// 27. TOASTS
// ============================================================================
function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${escapeHTML(message)}</span>`;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, TOAST_DURATION);
}

// ============================================================================
// 28. UTILITIES
// ============================================================================
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
    });
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function timeAgo(isoString) {
    if (!isoString) return '';
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    let i = Math.floor(seconds / 31536000); if (i > 0) return i + 'y ago';
    i = Math.floor(seconds / 2592000); if (i > 0) return i + 'mo ago';
    i = Math.floor(seconds / 86400); if (i > 0) return i + 'd ago';
    i = Math.floor(seconds / 3600); if (i > 0) return i + 'h ago';
    i = Math.floor(seconds / 60); if (i > 0) return i + 'm ago';
    return 'Just now';
}

function extractYouTubeId(url) {
    const match = url.match(
        /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/
    );
    return match ? match[1] : null;
}

function setButtonLoading(btn, text) {
    if (!btn) return;
    btn.disabled = true;
    if (!btn.dataset.originalText) {
        btn.dataset.originalText = btn.innerHTML;
    }
    btn.innerHTML = text ? `<span class="spinner"></span> ${text}` : '<span class="spinner"></span>';
}

function resetButton(btn, fallback) {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = btn.dataset.originalText || fallback;
}

function toggleVisibility(el, show) {
    if (!el) return;
    el.classList.toggle('hidden', !show);
}

function skeletonCards(count) {
    return Array.from({ length: count }).map(() => 
        `<div class="skeleton skeleton-card"></div>`
    ).join('');
}

// ============================================================================
// 29. PWA INSTALL PROMPT
// ============================================================================
function setupPWAInstallPrompt() {
    let deferredPrompt = null;
    
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        
        setTimeout(() => {
            if (!document.getElementById('pwa-install-btn') && deferredPrompt) {
                const btn = document.createElement('button');
                btn.id = 'pwa-install-btn';
                btn.className = 'btn btn-primary';
                btn.style.cssText = `
                    position:fixed; bottom:180px; right:20px; z-index:200; 
                    box-shadow: 0 8px 24px rgba(0,212,160,0.5); 
                    padding: 10px 16px; font-size: 13px;
                `;
                btn.innerHTML = '<i class="fas fa-download"></i> Install App';
                btn.onclick = async () => {
                    if (!deferredPrompt) return;
                    deferredPrompt.prompt();
                    const { outcome } = await deferredPrompt.userChoice;
                    console.log('[PWA] Install outcome:', outcome);
                    deferredPrompt = null;
                    btn.remove();
                };
                document.body.appendChild(btn);
                setTimeout(() => btn.remove(), 30000);
            }
        }, 3000);
    });
    
    window.addEventListener('appinstalled', () => {
        showToast('SteerRadar installed! 🎉', 'success');
        document.getElementById('pwa-install-btn')?.remove();
    });
}

// ============================================================================
// 30. GLOBAL EXPORTS
// ============================================================================
window.toggleGhostMode = () => {
    const checkbox = document.getElementById('toggle-ghost-mode');
    if (checkbox) checkbox.click();
};

console.log('[app] All handlers initialized');