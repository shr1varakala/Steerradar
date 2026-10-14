/**
 * ============================================================================
 * STEERADAR FRONTEND CONTROLLER (v13.0)
 * ============================================================================
 * Compatible with index.html v13, map-ui.js v2, api.js v11
 * Features: theme toggle, map themes, road routing, bottom sheet,
 *           debounced presence, compressed+sequential uploads
 * ============================================================================
 */

import { api } from './api.js';
import { mapModule } from './map.js';
import { logger } from './logger.js';

// ============================================================================
// 1. CONFIG
// ============================================================================
const CONFIG = window.STEERADAR || {};
const POLL_INTERVAL = 20000;
const PRESENCE_INTERVAL = 20000;
const PRESENCE_MIN_GAP = 15000;
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
    allLanes: [],
    hive: [],
    messages: {},
    savedPoints: [],
    activeVehicles: [],
    signupData: null,
    pendingLocation: null,
    userLocation: null,
    activeTrip: null,
    tripPoints: [],
    tripWatchId: null,
    activeMapFilter: 'live',
    activeMapTheme: 'bright',
    intervals: { poll: null, presence: null, chat: null },
    isLoading: { lanes: false, hive: false, chat: false },
    isOnline: navigator.onLine
};

let _lastPresenceSent = 0;
let _presenceInFlight = false;

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
    ctrlAlert: document.getElementById('ctrl-alert'),
    ctrlGhost: document.getElementById('ctrl-ghost'),
    ctrlTrip: document.getElementById('ctrl-trip'),
    chatView: document.getElementById('hive-chat-view'),
    chatMessages: document.getElementById('chat-messages-container'),
    chatInput: document.getElementById('chat-input'),
    chatTitle: document.getElementById('chat-room-title'),
    adminApplicationList: document.getElementById('admin-application-list'),
    logoTrigger: document.getElementById('logo-trigger'),
    themeToggle: document.getElementById('toggle-theme'),
    mapThemeSelect: document.getElementById('map-theme-select')
};

// ============================================================================
// 4. BOOT
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
    logger.init();

    console.log('%c SteerRadar v13.0 booted ',
        'background:#00d4a0;color:#000;font-weight:800;padding:4px 10px;border-radius:4px;');

    applyTheme();

    try {
        state.activeMapTheme = localStorage.getItem('steeradar-maptheme') || 'bright';
    } catch (e) {}

    setupEventListeners();
    setupNetworkHandlers();
    setupVisibilityHandlers();
    setupLogoLongPress();
    initMap();

    await checkSession();
});

// ============================================================================
// THEME
// ============================================================================
function applyTheme() {
    let theme = 'light';
    try { theme = localStorage.getItem('steeradar-theme') || 'light'; } catch (e) {}
    document.documentElement.setAttribute('data-theme', theme);
    if (DOM.themeToggle) DOM.themeToggle.checked = theme === 'light';
}

window.handleThemeToggle = function (input) {
    const theme = input.checked ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('steeradar-theme', theme); } catch (e) {}
    console.log('[theme]', theme);
};

window.handleMapThemeChange = function (value) {
    state.activeMapTheme = value;
    if (window.mapModule && mapModule.setMapTheme) mapModule.setMapTheme(value);
    showToast('Map: ' + value, 'success');
    try { localStorage.setItem('steeradar-maptheme', value); } catch (e) {}
};

// ============================================================================
// MAP FILTERS
// ============================================================================
window.setMapFilter = function (type, btn) {
    state.activeMapFilter = type;
    document.querySelectorAll('.map-chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');

    if (!state.allLanes.length) { loadLanes(); return; }

    let filtered = [...state.allLanes];
    if (type === 'seats') filtered = filtered.filter(l => l.seats > 0);
    if (type === 'mine') filtered = filtered.filter(l => l.own);
    if (type === 'live') filtered = filtered.filter(l => l.status === 'live' || !l.status);

    state.lanes = filtered;

    const container = getLanesContainer();
    if (!container) return;
    if (!filtered.length) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-bus"></i><p>No lanes match this filter.</p></div>`;
    } else {
        container.innerHTML = filtered.map(createLaneCardHTML).join('');
    }
};

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
    DOM.chatInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
    DOM.ctrlTrip?.addEventListener('click', toggleTrip);
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
// LOGO LONG-PRESS
// ============================================================================
function setupLogoLongPress() {
    const logo = DOM.logoTrigger;
    if (!logo) return;
    let timer = null, startX = 0, startY = 0;

    const start = (e) => {
        const pt = e.touches ? e.touches[0] : e;
        startX = pt.clientX; startY = pt.clientY;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            if (navigator.vibrate) { try { navigator.vibrate(30); } catch (x) {} }
            window.openModal('log-modal');
            logger.render();
        }, 800);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const move = (e) => {
        if (!timer) return;
        const pt = e.touches ? e.touches[0] : e;
        if (Math.abs(pt.clientX - startX) > 10 || Math.abs(pt.clientY - startY) > 10) cancel();
    };

    logo.addEventListener('touchstart', start, { passive: true });
    logo.addEventListener('touchend', cancel);
    logo.addEventListener('touchcancel', cancel);
    logo.addEventListener('touchmove', move, { passive: true });
    logo.addEventListener('mousedown', start);
    logo.addEventListener('mouseup', cancel);
    logo.addEventListener('mouseleave', cancel);
    logo.addEventListener('mousemove', move);
    logo.addEventListener('contextmenu', (e) => e.preventDefault());
    logo.addEventListener('click', () => {
        if (state.activeTab !== 'lanes') switchTab('lanes');
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
            if (mapModule.stopLiveLocation) mapModule.stopLiveLocation();
        } else {
            startAutoRefresh();
            refreshAll();
            if (mapModule.startLiveLocation) mapModule.startLiveLocation();
        }
    });
}

// ============================================================================
// 7. AUTH
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

async function handleSignIn(e) {
    e.preventDefault();
    const identity = document.getElementById('signin-identity').value.trim();
    const password = document.getElementById('signin-password').value;
    if (!identity || !password) return showToast('Please fill in all fields', 'warning');

    const isEmail = identity.includes('@');
    if (isEmail) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)) return showToast('Enter a valid email', 'error');
    } else {
        if (!/^[6-9]\d{9}$/.test(identity.replace(/\D/g, ''))) return showToast('Enter a valid 10-digit mobile number', 'error');
    }

    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Signing in...');
    const res = await api.login({ phone: identity, password });
    resetButton(btn, 'Sign In');

    if (res && res.token) {
        api.setSession({ token: res.token, phone: res.user.phone, user: res.user });
        state.user = res.user;
        closeModal('auth-modal');
        updateUIForRole();
        showToast('Welcome back, ' + state.user.name.split(' ')[0] + '!', 'success');
    } else {
        showToast((res && res.error) || api.lastError || 'Login failed', 'error');
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

    if (!data.name || !data.phone || !data.email || !data.password) return showToast('Please fill in all fields', 'warning');
    if (data.password.length < 6) return showToast('Password must be at least 6 characters', 'warning');
    if (data.password !== data.confirmPassword) return showToast('Passwords do not match', 'error');
    if (!/^[6-9]\d{9}$/.test(data.phone)) return showToast('Enter a valid 10-digit mobile number', 'warning');

    state.signupData = data;
    const btn = document.getElementById('signup-submit-btn');
    setButtonLoading(btn, 'Sending OTP...');

    const res = await api.sendOtp(data.phone, data.email, 'register');
    resetButton(btn, 'Send OTP');

    const lastErr = api.lastError || '';
    const timedOut = lastErr.includes('Timed out') || lastErr.includes('aborted') || lastErr.includes('Failed to fetch');

    if (res && res.ok) {
        document.getElementById('otp-message').textContent = 'Enter the 6-digit code sent to ' + (res.sentTo || data.email);
        openModal('otp-modal');
        setTimeout(() => document.getElementById('otp-code')?.focus(), 300);
    } else if (res && res.error === 'cooldown') {
        document.getElementById('otp-message').textContent = 'An OTP was recently sent to ' + data.email + '. Enter it here.';
        openModal('otp-modal');
    } else if (res && res.error === 'phone_exists') {
        showToast('This phone number is already registered.', 'warning');
    } else if (res && res.error === 'email_taken') {
        showToast('This email is already registered.', 'warning');
    } else if (timedOut) {
        document.getElementById('otp-message').textContent = 'If you received a code at ' + data.email + ', enter it below.';
        openModal('otp-modal');
    } else {
        showToast((res && res.error) || lastErr || 'Failed to send OTP', 'error');
    }
}

window.verifyOTP = async function () {
    const code = document.getElementById('otp-code').value.trim();
    if (!code || code.length !== 6) return showToast('Enter a valid 6-digit code', 'warning');
    if (!state.signupData) return showToast('Session expired. Please try again.', 'error');

    const btn = document.querySelector('#otp-modal button');
    setButtonLoading(btn, 'Verifying...');

    const verifyRes = await api.verifyOtp(state.signupData.phone, code);
    if (!verifyRes || !verifyRes.ok) {
        resetButton(btn, 'Verify & Create Account');
        return showToast((verifyRes && verifyRes.error) || api.lastError || 'Invalid OTP', 'error');
    }

    setButtonLoading(btn, 'Creating account...');
    const regRes = await api.register(state.signupData);
    resetButton(btn, 'Verify & Create Account');

    if (regRes && regRes.token) {
        api.setSession({ token: regRes.token, phone: regRes.user.phone, user: regRes.user });
        state.user = regRes.user;
        state.signupData = null;
        closeModal('otp-modal');
        closeModal('auth-modal');
        updateUIForRole();
        showToast('Account created successfully!', 'success');
    } else {
        showToast((regRes && regRes.error) || api.lastError || 'Registration failed', 'error');
    }
};

window.handleLogout = async function () {
    if (!confirm('Are you sure you want to log out?')) return;
    stopPolling();
    if (mapModule.stopLiveLocation) mapModule.stopLiveLocation();
    await api.logout();
    api.clearSession();
    window.location.reload();
};

// ============================================================================
// 8. ROLE UI
// ============================================================================
function updateUIForRole() {
    if (!state.user) return;

    const avatar = state.user.photo || ('https://i.pravatar.cc/150?u=' + state.user.phone);

    if (DOM.headerAvatar) {
        DOM.headerAvatar.src = avatar;
        DOM.headerAvatar.onerror = () => { DOM.headerAvatar.src = 'https://i.pravatar.cc/150?img=11'; };
    }
    if (DOM.profileName) DOM.profileName.textContent = state.user.name;
    if (DOM.profileRole) DOM.profileRole.textContent = state.user.role === 'agent' ? 'SteerAgent' : 'RearAgent';
    if (DOM.profileAvatar) DOM.profileAvatar.src = avatar;

    toggleVisibility(DOM.adminBtn, state.user.isAdmin);

    const isAgent = state.user.role === 'agent';
    toggleVisibility(DOM.ctrlAlert, isAgent);
    toggleVisibility(DOM.ctrlGhost, isAgent);
    toggleVisibility(DOM.ctrlTrip, isAgent);

    if (isAgent) {
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

    if (DOM.mapThemeSelect) {
        let saved = 'bright';
        try { saved = localStorage.getItem('steeradar-maptheme') || 'bright'; } catch (e) {}
        DOM.mapThemeSelect.value = saved;
    }

    const greeting = document.getElementById('hive-greeting');
    if (greeting) {
        const hour = new Date().getHours();
        const tg = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        greeting.textContent = tg + ', ' + state.user.name.split(' ')[0] + ' 👋';
    }

    refreshAll();
}

// ============================================================================
// 9. NAVIGATION
// ============================================================================
window.switchTab = function (tabName) {
    state.activeTab = tabName;
    DOM.navButtons.forEach(btn => btn.classList.remove('active'));
    document.getElementById('nav-' + tabName)?.classList.add('active');
    DOM.views.forEach(view => view.classList.remove('active'));
    document.getElementById('view-' + tabName)?.classList.add('active');

    if (tabName === 'map') {
        setTimeout(() => mapModule.refreshSize && mapModule.refreshSize(), 150);
        setTimeout(() => mapModule.refreshSize && mapModule.refreshSize(), 500);
        setTimeout(() => mapModule.startLiveLocation && mapModule.startLiveLocation(), 300);
    }
    if (tabName === 'hive') loadHive();
    if (tabName === 'lanes') loadLanes();
    if (tabName === 'profile') loadSavedPoints();
};

// ============================================================================
// 10. MODALS
// ============================================================================
window.openModal = function (id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('hidden');
    if (id === 'admin-modal') loadAdminApplications();
    if (id === 'trips-modal') loadTrips();
    if (id === 'log-modal') logger.render();
    setTimeout(() => modal.querySelector('input:not([type=file]), textarea')?.focus(), 250);
};

window.closeModal = function (id) { document.getElementById(id)?.classList.add('hidden'); };

window.switchAuthTab = function (tab) {
    document.getElementById('tab-signin').classList.toggle('active', tab === 'signin');
    document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
    document.getElementById('signin-form').classList.toggle('hidden', tab !== 'signin');
    document.getElementById('signup-form').classList.toggle('hidden', tab !== 'signup');
};

// ============================================================================
// 11. AUTO-REFRESH
// ============================================================================
function startAutoRefresh() {
    stopPolling();
    state.intervals.poll = setInterval(() => {
        if (!state.isOnline) return;
        if (state.activeTab === 'lanes') loadLanes(true);
        if (state.activeTab === 'hive') loadHive(true);
    }, POLL_INTERVAL);

    if (state.user && state.user.role === 'agent') {
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
async function loadLanes(silent) {
    if (!state.isOnline || state.isLoading.lanes) return;
    state.isLoading.lanes = true;
    const container = getLanesContainer();
    if (!silent && container && !container.querySelector('.lane-card')) container.innerHTML = skeletonCards(2);

    const lanes = await api.listLanes();
    state.allLanes = lanes;
    state.isLoading.lanes = false;

    let filtered = [...lanes];
    if (state.activeMapFilter === 'seats') filtered = filtered.filter(l => l.seats > 0);
    if (state.activeMapFilter === 'mine') filtered = filtered.filter(l => l.own);
    if (state.activeMapFilter === 'live') filtered = filtered.filter(l => l.status === 'live' || !l.status);
    state.lanes = filtered;

    if (!container) return;
    if (!filtered.length) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-bus"></i><p>No active lanes right now.</p></div>';
        return;
    }
    container.innerHTML = filtered.map(createLaneCardHTML).join('');
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

    let distanceHTML = '';
    if (state.userLocation && lane.lat && lane.lng) {
        const km = mapModule.calculateDistance(state.userLocation.lat, state.userLocation.lng, lane.lat, lane.lng);
        if (km > 0) distanceHTML = '<span class="distance-pill mt-2"><i class="fas fa-route"></i> ' + mapModule.formatDistance(km) + '</span>';
    }

    return `
        <div class="lane-card">
            <div class="lane-header">
                <div class="seat-indicator" style="--progress: ${progress}%; --color: ${color};">
                    <div class="seat-inner"><span class="seat-count">${seats}</span><span class="seat-label">Seats</span></div>
                </div>
                <div class="lane-details">
                    <div class="lane-title">${escapeHTML(lane.title || 'Untitled Route')}</div>
                    <div class="lane-route"><i class="fas fa-route"></i> ${escapeHTML(lane.description || '')}</div>
                    <div class="lane-tags">
                        <span class="tag tag-live">LIVE</span>
                        <span class="tag tag-fare">${escapeHTML(lane.vehicleType || 'Any')}</span>
                        ${distanceHTML}
                    </div>
                </div>
            </div>
            <div class="lane-footer">
                <div class="driver-info">
                    <img src="${lane.photo || 'https://i.pravatar.cc/150?img=12'}" class="driver-avatar" onerror="this.src='https://i.pravatar.cc/150?img=12'">
                    <div><div class="driver-name">${escapeHTML(lane.ownerName || 'Driver')}</div><div class="driver-rating"><i class="fas fa-star"></i> SteerAgent</div></div>
                </div>
                <div class="lane-actions">
                    <button class="btn btn-secondary btn-sm" onclick="showLaneBottomSheetById('${lane.id}')"><i class="fas fa-info-circle"></i></button>
                    <button class="btn btn-secondary btn-sm" onclick="openChat('${lane.id}', '${escapeHTML(lane.ownerName || 'Driver')}')"><i class="fas fa-comment"></i></button>
                    <button class="btn btn-primary btn-sm" onclick="requestSeat('${lane.id}')"><i class="fas fa-chair"></i></button>
                </div>
            </div>
        </div>`;
}

window.showLaneBottomSheetById = function (laneId) {
    const lane = state.allLanes.find(l => l.id === laneId);
    if (!lane) return showToast('Lane not found', 'error');
    if (window.showLaneBottomSheet) {
        window.showLaneBottomSheet(lane);
    } else {
        // Fallback if map-ui not loaded
        showLaneOnMap(laneId);
    }
};

window.requestSeat = function (laneId) {
    if (!state.user) return showToast('Please sign in first', 'error');
    showToast('Seat request sent! The driver will respond in chat.', 'success');
};

window.showLaneOnMap = function (laneId) {
    const lane = state.allLanes.find(l => l.id === laneId);
    if (!lane) return;
    if (!lane.lat || !lane.lng) return showToast('No location available', 'warning');
    switchTab('map');
    setTimeout(() => {
        mapModule.centerOn(lane.lat, lane.lng, 15);
        if (window.showLaneBottomSheet) {
            window.showLaneBottomSheet(lane);
        }
    }, 400);
};

window.navigateToLane = function (laneId) {
    const lane = state.allLanes.find(l => l.id === laneId);
    if (!lane) return;
    const fromLat = state.userLocation && state.userLocation.lat || null;
    const fromLng = state.userLocation && state.userLocation.lng || null;
    mapModule.navigateTo(lane.lat, lane.lng, fromLat, fromLng);
};

// ============================================================================
// 13. HIVE
// ============================================================================
async function loadHive(silent) {
    if (!state.isOnline || state.isLoading.hive) return;
    state.isLoading.hive = true;
    const container = getHiveContainer();
    if (!silent && container && !container.querySelector('.post-card')) container.innerHTML = skeletonCards(3);

    const posts = await api.listHive();
    state.hive = posts;
    state.isLoading.hive = false;
    if (!container) return;

    if (!posts.length) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><p>No posts yet. Be the first to share!</p></div>';
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
        mediaHTML = '<div class="post-image"><img src="' + post.photo + '" alt="Post" onerror="this.onerror=null; this.style.display=\'none\';"></div>';
    } else if (post.mediaType === 'youtube' && post.mediaUrl) {
        const vid = extractYouTubeId(post.mediaUrl);
        if (vid) mediaHTML = '<div style="margin-bottom:10px; border-radius:12px; overflow:hidden;"><iframe width="100%" height="190" src="https://www.youtube.com/embed/' + vid + '" frameborder="0" allowfullscreen loading="lazy"></iframe></div>';
    } else if (post.mediaType === 'instagram' && post.mediaUrl) {
        mediaHTML = '<div style="margin-bottom:10px;"><blockquote class="instagram-media" data-instgrm-permalink="' + post.mediaUrl + '" data-instgrm-version="14" style="width:100%; margin:0;"></blockquote></div>';
    }
    const avatar = 'https://i.pravatar.cc/150?u=' + (post.owner || post.userPhone || Math.random());

    return `
        <div class="post-card">
            <div class="post-header">
                <img src="${avatar}" class="driver-avatar avatar-lg" onerror="this.src='https://i.pravatar.cc/150?img=5'">
                <div>
                    <div class="post-user">${escapeHTML(post.ownerName || 'User')} <i class="fas fa-check-circle verified-badge"></i></div>
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

window.toggleLike = async function (postId, currentLikes) {
    if (!state.user) return showToast('Sign in to like posts', 'error');
    if (!postId || postId === 'undefined') return;
    const el = document.getElementById('likes-' + postId);
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
window.openChat = async function (roomId, name) {
    state.currentRoom = roomId;
    DOM.chatTitle.textContent = name || 'Hive Chat';
    DOM.chatView.classList.remove('hidden');
    await loadMessages(roomId);
    if (state.intervals.chat) clearInterval(state.intervals.chat);
    state.intervals.chat = setInterval(() => loadMessages(roomId, true), CHAT_POLL_INTERVAL);
};

window.closeChat = function () {
    state.currentRoom = null;
    DOM.chatView.classList.add('hidden');
    if (state.intervals.chat) { clearInterval(state.intervals.chat); state.intervals.chat = null; }
};

async function loadMessages(roomId, silent) {
    if (!silent) DOM.chatMessages.innerHTML = '<div class="text-center text-sub text-sm" style="padding:20px;"><div class="spinner"></div></div>';
    const messages = await api.getMessages(roomId);
    state.messages[roomId] = messages;

    if (!messages.length) {
        DOM.chatMessages.innerHTML = '<div class="empty-state" style="padding:40px 20px;"><i class="fas fa-comment-dots"></i><p>No messages yet. Say hi! 👋</p></div>';
        return;
    }
    const html = messages.map(m => '<div class="chat-message ' + (m.mine ? 'sent' : 'received') + '">' + escapeHTML(m.text) + '</div>').join('');
    if (DOM.chatMessages.innerHTML !== html) {
        DOM.chatMessages.innerHTML = html;
        scrollToBottom();
    }
}

window.sendMessage = async function () {
    const text = DOM.chatInput.value.trim();
    if (!text || !state.currentRoom) return;
    DOM.chatInput.value = '';
    DOM.chatMessages.insertAdjacentHTML('beforeend', '<div class="chat-message sent">' + escapeHTML(text) + '</div>');
    scrollToBottom();
    const res = await api.sendMessage({ roomId: state.currentRoom, text: text });
    if (!res) showToast('Failed to send message', 'error');
};

function scrollToBottom() { DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight; }

// ============================================================================
// 15. NEIGHBORHOOD CHAT
// ============================================================================
function getNeighborhoodRoomId() {
    const lat = state.userLocation && state.userLocation.lat || CONFIG.DEFAULT_CENTER && CONFIG.DEFAULT_CENTER.lat || 17.3850;
    const lng = state.userLocation && state.userLocation.lng || CONFIG.DEFAULT_CENTER && CONFIG.DEFAULT_CENTER.lng || 78.4867;
    return 'local_' + lat.toFixed(2) + '_' + lng.toFixed(2);
}

window.openNeighborhoodChat = async function () {
    if (!state.user) return showToast('Please sign in first', 'error');
    showToast('Finding riders near you...', 'info');
    try {
        const loc = await mapModule.locateUser();
        state.userLocation = loc;
    } catch (e) {}
    openChat(getNeighborhoodRoomId(), '🏘️ Neighborhood Chat');
};

// ============================================================================
// 16. FAB
// ============================================================================
window.handleFABClick = function () {
    if (!state.user) return showToast('Please sign in first', 'error');
    if (state.activeTab === 'lanes') {
        if (state.user.role !== 'agent') return showToast('Only SteerAgents can create lanes', 'warning');
        openModal('create-lane-modal');
    } else {
        openModal('create-hive-modal');
    }
};

// ============================================================================
// 17. CREATE LANE
// ============================================================================
async function handleCreateLane(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Posting...');
    try {
        const photoFile = document.getElementById('lane-photo').files[0];
        let photoUrl = '';
        if (photoFile) {
            setButtonLoading(btn, 'Compressing photo...');
            const b64 = await compressImage(photoFile, 800, 0.7);
            const title = sanitizeFilename(document.getElementById('lane-title').value.trim(), 20) || 'lane';
            setButtonLoading(btn, 'Uploading photo...');
            const upload = await api.uploadImage(b64, 'lanes', 'lane_' + title + '_' + state.user.phone + '_' + Date.now());
            if (upload && upload.url) photoUrl = upload.url;
        }
        const payload = {
            title: document.getElementById('lane-title').value.trim(),
            description: document.getElementById('lane-description').value.trim(),
            seats: document.getElementById('lane-seats').value,
            total: document.getElementById('lane-seats').value,
            vehicleType: document.getElementById('lane-vehicle-type').value,
            photo: photoUrl,
            lat: state.userLocation && state.userLocation.lat || CONFIG.DEFAULT_CENTER && CONFIG.DEFAULT_CENTER.lat || 17.3850,
            lng: state.userLocation && state.userLocation.lng || CONFIG.DEFAULT_CENTER && CONFIG.DEFAULT_CENTER.lng || 78.4867
        };
        const res = await api.insertLane(payload);
        if (res) {
            showToast('Lane posted!', 'success');
            closeModal('create-lane-modal');
            e.target.reset();
            loadLanes();
        } else throw new Error(api.lastError || 'Failed');
    } catch (err) { showToast(err.message, 'error'); }
    finally { resetButton(btn, 'Post Lane'); }
}

// ============================================================================
// 18. CREATE HIVE POST
// ============================================================================
async function handleCreateHivePost(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Posting...');
    try {
        const photoFile = document.getElementById('hive-photo').files[0];
        const embedUrl = document.getElementById('hive-embed-url').value.trim();
        const text = document.getElementById('hive-text').value.trim();
        if (!text && !photoFile && !embedUrl) throw new Error('Add some text or media');

        let photoUrl = '', mediaType = '', mediaUrl = '';
        if (photoFile) {
            setButtonLoading(btn, 'Compressing photo...');
            const b64 = await compressImage(photoFile, 900, 0.75);
            setButtonLoading(btn, 'Uploading photo...');
            const upload = await api.uploadImage(b64, 'hive', 'hive_' + state.user.phone + '_' + Date.now());
            if (upload && upload.url) { photoUrl = upload.url; mediaType = 'image'; }
        } else if (embedUrl) {
            mediaUrl = embedUrl;
            if (/youtube\.com|youtu\.be/.test(embedUrl)) mediaType = 'youtube';
            else if (/instagram\.com/.test(embedUrl)) mediaType = 'instagram';
            else mediaType = 'link';
        }
        const payload = {
            text: text, photo: photoUrl, mediaUrl: mediaUrl, mediaType: mediaType,
            lat: state.userLocation && state.userLocation.lat || 17.3850,
            lng: state.userLocation && state.userLocation.lng || 78.4867
        };
        const res = await api.insertHive(payload);
        if (res) {
            showToast('Posted!', 'success');
            closeModal('create-hive-modal');
            e.target.reset();
            loadHive();
        } else throw new Error(api.lastError || 'Failed');
    } catch (err) { showToast(err.message, 'error'); }
    finally { resetButton(btn, 'Post to Hive'); }
}

// ============================================================================
// 19. EDIT PROFILE
// ============================================================================
window.openEditProfile = function () {
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
            setButtonLoading(btn, 'Uploading avatar...');
            const b64 = await compressImage(avatarFile, 400, 0.8);
            const upload = await api.uploadImage(b64, 'avatars', 'avatar_' + sanitizeFilename(state.user.name, 15) + '_' + state.user.phone + '_' + Date.now());
            if (upload && upload.url) photoUrl = upload.url;
        }
        const patch = {
            name: document.getElementById('edit-name').value.trim(),
            upiId: document.getElementById('edit-upi').value.trim(),
            photo: photoUrl
        };
        const res = await api.updateMe(patch);
        if (res) {
            state.user = Object.assign({}, state.user, res);
            const fresh = await api.getMe();
            if (fresh) state.user = fresh;
            api.setSession({ phone: state.user.phone, token: api.token, user: state.user });
            showToast('Profile updated!', 'success');
            closeModal('edit-profile-modal');
            updateUIForRole();
        } else throw new Error(api.lastError || 'Failed');
    } catch (err) { showToast(err.message, 'error'); }
    finally { resetButton(btn, 'Save Changes'); }
}

// ============================================================================
// 20. STEERAGENT APPLICATION
// ============================================================================
async function handleSteerAgentApplication(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setButtonLoading(btn, 'Preparing...');
    try {
        const licenseFile = document.getElementById('sa-license').files[0];
        const rcFile = document.getElementById('sa-rc').files[0];
        const selfieFile = document.getElementById('sa-selfie').files[0];
        if (!licenseFile || !rcFile || !selfieFile) throw new Error('Please upload all required documents');

        const vehicleNum = sanitizeFilename(document.getElementById('sa-vehicle-number').value.trim().toUpperCase(), 15) || 'vehicle';
        const phone = state.user.phone || 'unknown';
        const name = sanitizeFilename(state.user.name, 15);
        const ts = Date.now();

        setButtonLoading(btn, 'Compressing photos...');
        const licenseB64 = await compressImage(licenseFile, 800, 0.7);
        const rcB64 = await compressImage(rcFile, 800, 0.7);
        const selfieB64 = await compressImage(selfieFile, 800, 0.7);

        setButtonLoading(btn, 'Uploading license (1/3)...');
        const licenseRes = await api.uploadImage(licenseB64, 'vehicles', 'license_' + vehicleNum + '_' + phone + '_' + ts);
        if (!licenseRes || !licenseRes.url) throw new Error('License upload failed');

        setButtonLoading(btn, 'Uploading RC (2/3)...');
        const rcRes = await api.uploadImage(rcB64, 'vehicles', 'rc_' + vehicleNum + '_' + phone + '_' + ts);
        if (!rcRes || !rcRes.url) throw new Error('RC upload failed');

        setButtonLoading(btn, 'Uploading selfie (3/3)...');
        const selfieRes = await api.uploadImage(selfieB64, 'avatars', 'selfie_' + name + '_' + phone + '_' + ts);
        if (!selfieRes || !selfieRes.url) throw new Error('Selfie upload failed');

        setButtonLoading(btn, 'Submitting...');
        const res = await api.becomeAgent({
            vehicle: document.getElementById('sa-vehicle-number').value.trim(),
            vehicleType: document.getElementById('sa-vehicle-type').value,
            vehiclePhoto: rcRes.url,
            photo: selfieRes.url,
            license: licenseRes.url,
            selfie: selfieRes.url,
            rc: rcRes.url,
            upiId: document.getElementById('sa-upi-id').value.trim(),
            city: 'Hyderabad'
        });
        if (res) {
            showToast('Application submitted! Awaiting admin approval.', 'success');
            closeModal('steer-agent-modal');
            state.user.agentStatus = 'pending';
            updateUIForRole();
        } else throw new Error(api.lastError || 'Submission failed');
    } catch (err) { showToast(err.message, 'error'); }
    finally { resetButton(btn, 'Submit Application'); }
}

// ============================================================================
// 21. ADMIN
// ============================================================================
window.loadAdminApplications = async function () {
    if (!state.user || !state.user.isAdmin) return;
    DOM.adminApplicationList.innerHTML = '<div class="text-center text-sub text-sm" style="padding:20px;"><div class="spinner"></div></div>';
    const apps = await api.adminPendingAgents();
    if (!apps || !apps.length) {
        DOM.adminApplicationList.innerHTML = '<div class="empty-state" style="padding:20px;"><i class="fas fa-check-circle" style="color:var(--primary);"></i><p>No pending applications.</p></div>';
        return;
    }
    DOM.adminApplicationList.innerHTML = apps.map(a => `
        <div class="post-card" style="margin-bottom:10px;">
            <div class="flex justify-between align-center mb-2"><strong>${escapeHTML(a.name || 'Applicant')}</strong><span class="tag tag-warning">Pending</span></div>
            <p class="text-sm text-sub">📱 ${escapeHTML(a.phone || 'N/A')}</p>
            <p class="text-sm text-sub">🚗 ${escapeHTML(a.vehicle || 'N/A')} (${escapeHTML(a.vehicleType || 'N/A')})</p>
            <p class="text-sm text-sub">💰 UPI: ${escapeHTML(a.upiId || 'N/A')}</p>
            <div class="flex gap-2 mt-3" style="display:flex; gap:10px;">
                <button class="btn btn-primary btn-sm w-full" onclick="handleAdminAction('${a.uid}', true)"><i class="fas fa-check"></i> Approve</button>
                <button class="btn btn-danger btn-sm w-full" onclick="handleAdminAction('${a.uid}', false)"><i class="fas fa-times"></i> Reject</button>
            </div>
        </div>
    `).join('');
};

window.handleAdminAction = async function (uid, approve) {
    showToast((approve ? 'Approving' : 'Rejecting') + '...', 'info');
    const res = await api.adminApproveAgent(uid, approve);
    if (res) {
        showToast('Application ' + (approve ? 'approved' : 'rejected') + '!', 'success');
        loadAdminApplications();
    } else showToast('Action failed: ' + api.lastError, 'error');
};

// ============================================================================
// 22. MAP
// ============================================================================
function initMap() {
    mapModule.init('map', handleMapClick, {
        onMessageAgent: async function (data) {
            const myPhone = state.user && state.user.phone || '';
            const ids = [myPhone, data.phone].sort();
            const roomId = 'dm-' + ids[0] + '-' + ids[1];
            await openChat(roomId, data.name || 'SteerAgent');
            if (data.action === 'quick' && data.text) {
                DOM.chatInput.value = data.text;
                setTimeout(() => sendMessage(), 400);
            }
        }
    });

    try {
        const savedTheme = localStorage.getItem('steeradar-maptheme') || 'bright';
        state.activeMapTheme = savedTheme;
        if (mapModule.setMapTheme) mapModule.setMapTheme(savedTheme);
    } catch (e) {}

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => { state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
            () => {},
            { enableHighAccuracy: false, maximumAge: 60000, timeout: 5000 }
        );
    }

    window.addEventListener('savePin', (e) => {
        state.pendingLocation = e.detail;
        openModal('location-modal');
    });
    window.addEventListener('userLocationUpdate', (e) => { state.userLocation = e.detail; });
    window.addEventListener('routeCalculated', (e) => {
        const d = e.detail;
        console.log('[route]', mapModule.formatDistance(d.distance), '·', mapModule.formatDuration(d.duration));
    });

    mapModule.startLiveLocation && mapModule.startLiveLocation();
}

function handleMapClick(lat, lng) {
    if (!state.user) return showToast('Sign in to save locations', 'error');
    state.pendingLocation = { lat: lat, lng: lng };
    mapModule.dropMarker(lat, lng);

    const myLoc = state.userLocation;
    if (myLoc && mapModule.showRoadRoute) {
        mapModule.showRoadRoute(myLoc.lat, myLoc.lng, lat, lng).then(route => {
            const info = [];
            if (route) {
                info.push({ label: 'Road distance', value: mapModule.formatDistance(route.distance) });
                info.push({ label: 'Estimated time', value: mapModule.formatDuration(route.duration) });
            } else {
                const straight = mapModule.calculateDistance(myLoc.lat, myLoc.lng, lat, lng);
                info.push({ label: 'Straight-line', value: mapModule.formatDistance(straight) });
            }
            if (window.showPinBottomSheet) {
                window.showPinBottomSheet(lat, lng, info);
            }
        });
    } else if (window.showPinBottomSheet) {
        window.showPinBottomSheet(lat, lng, []);
    }
}

window.navigateToPoint = function (lat, lng) {
    const fromLat = state.userLocation && state.userLocation.lat || null;
    const fromLng = state.userLocation && state.userLocation.lng || null;
    mapModule.navigateTo(lat, lng, fromLat, fromLng);
};

window.confirmSaveLocation = async function () {
    const name = document.getElementById('location-name').value.trim();
    if (!name || !state.pendingLocation) return showToast('Enter a name', 'warning');
    const res = await api.savePoint(Object.assign({}, state.pendingLocation, { label: name, shared: true }));
    if (res) {
        showToast('"' + name + '" saved!', 'success');
        closeModal('location-modal');
        document.getElementById('location-name').value = '';
        state.pendingLocation = null;
        loadSavedPoints();
    } else showToast('Failed to save location', 'error');
};

async function loadSavedPoints() {
    if (!state.user) return;
    const points = await api.myPoints();
    state.savedPoints = points || [];
}

// ============================================================================
// 23. LIVE PRESENCE (debounced)
// ============================================================================
async function broadcastPresence() {
    if (!state.user || state.user.role !== 'agent' || state.user.ghostMode) return;
    if (!navigator.geolocation) return;
    const now = Date.now();
    if (now - _lastPresenceSent < PRESENCE_MIN_GAP) return;
    if (_presenceInFlight) return;

    _presenceInFlight = true;
    _lastPresenceSent = now;

    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const c = pos.coords;
            state.userLocation = { lat: c.latitude, lng: c.longitude };
            await api.updatePresence({
                lat: c.latitude, lng: c.longitude,
                heading: c.heading || '', speed: c.speed || '',
                vehicle: state.user.vehicle || ''
            });
            if (state.activeTrip) {
                const point = [c.latitude, c.longitude];
                const last = state.tripPoints[state.tripPoints.length - 1];
                if (!last || mapModule.calculateDistance(last[0], last[1], c.latitude, c.longitude) > 0.01) {
                    state.tripPoints.push(point);
                    if (mapModule.updatePolyline) mapModule.updatePolyline(state.tripPoints);
                }
            }
            const vehicles = await api.activeVehicles();
            state.activeVehicles = vehicles;
            if (mapModule.renderVehicles) mapModule.renderVehicles(vehicles, state.userLocation);
            _presenceInFlight = false;
        },
        (err) => { console.warn('Location error:', err.message); _presenceInFlight = false; },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    );
}

// ============================================================================
// 24. ALERTS
// ============================================================================
window.reportAlert = async function (type) {
    if (!state.user) return showToast('Sign in first', 'error');
    const lat = state.userLocation && state.userLocation.lat || 17.3850;
    const lng = state.userLocation && state.userLocation.lng || 78.4867;
    const res = await api.reportAlert({ type: type, lat: lat, lng: lng });
    if (res) {
        if (mapModule.addAlertMarker) mapModule.addAlertMarker(lat, lng, type);
        closeModal('report-modal');
        showToast(type.toUpperCase() + ' alert posted!', 'success');
    } else showToast('Failed to post alert', 'error');
};

// ============================================================================
// 25. GHOST MODE
// ============================================================================
async function handleGhostModeToggle(e) {
    const isGhost = e.target.checked;
    const res = await api.updateMe({ ghostMode: isGhost });
    if (res) {
        state.user.ghostMode = isGhost;
        if (isGhost) {
            await api.removePresence();
            showToast('Ghost mode ON', 'info');
        } else {
            broadcastPresence();
            showToast('Ghost mode OFF', 'info');
        }
    } else {
        e.target.checked = !isGhost;
        showToast('Failed to update Ghost Mode', 'error');
    }
}

// ============================================================================
// 26. TRIPS
// ============================================================================
window.toggleTrip = async function () {
    if (!state.user || state.user.role !== 'agent') return showToast('Only SteerAgents can start trips', 'warning');
    const btn = DOM.ctrlTrip;

    if (state.activeTrip) {
        setButtonLoading(btn, '');
        const distance = mapModule.calculatePolylineDistance(state.tripPoints);
        const res = await api.endTrip(state.activeTrip.id, {
            endLat: state.userLocation && state.userLocation.lat,
            endLng: state.userLocation && state.userLocation.lng,
            distanceKm: distance
        });
        resetButton(btn, '<i class="fas fa-play"></i>');
        btn.classList.remove('active');
        if (res) {
            showToast('Trip ended! ' + mapModule.formatDistance(distance), 'success');
            state.activeTrip = null;
            state.tripPoints = [];
            if (mapModule.clearPolylines) mapModule.clearPolylines();
            if (state.tripWatchId !== null) { navigator.geolocation.clearWatch(state.tripWatchId); state.tripWatchId = null; }
        } else showToast('Failed to end trip', 'error');
    } else {
        setButtonLoading(btn, '');
        const startLat = state.userLocation && state.userLocation.lat || 17.3850;
        const startLng = state.userLocation && state.userLocation.lng || 78.4867;
        const res = await api.startTrip({ startLat: startLat, startLng: startLng });
        resetButton(btn, '<i class="fas fa-stop"></i>');
        if (res && res.id) {
            showToast('Trip started!', 'success');
            state.activeTrip = res;
            state.tripPoints = [[startLat, startLng]];
            btn.classList.add('active');
            if (mapModule.drawPolyline) mapModule.drawPolyline(state.tripPoints);
            startTripTracking();
        } else showToast('Failed to start trip', 'error');
    }
};

function startTripTracking() {
    if (!navigator.geolocation) return;
    state.tripWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            const point = [pos.coords.latitude, pos.coords.longitude];
            const last = state.tripPoints[state.tripPoints.length - 1];
            if (last && mapModule.calculateDistance(last[0], last[1], point[0], point[1]) < 0.01) return;
            state.tripPoints.push(point);
            if (mapModule.updatePolyline) mapModule.updatePolyline(state.tripPoints);
            api.updatePresence({ lat: point[0], lng: point[1], vehicle: state.user.vehicle || '' });
        },
        (err) => console.warn('Trip tracking error:', err.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
}

window.loadTrips = async function () {
    const container = document.getElementById('trips-list');
    if (!container) return;
    container.innerHTML = '<div class="text-center text-sub text-sm" style="padding:20px;"><div class="spinner"></div></div>';
    const trips = await api.myTrips();
    if (!trips || !trips.length) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-route"></i><p>No trips yet.</p></div>';
        return;
    }
    container.innerHTML = trips.map(t => {
        const isActive = t.status === 'active';
        const start = t.startedAt ? new Date(t.startedAt).toLocaleString() : 'Unknown';
        const end = t.endedAt ? new Date(t.endedAt).toLocaleString() : 'Ongoing';
        const distance = t.distanceKm ? (t.distanceKm + ' km') : '—';
        return '<div class="trip-card" onclick="if(window.showTripBottomSheet) showTripBottomSheet(' + JSON.stringify(t).replace(/"/g, '&quot;') + ')">' +
            '<div class="trip-header"><span class="trip-status ' + (isActive ? 'active' : 'ended') + '">' + (isActive ? 'ACTIVE' : 'ENDED') + '</span>' +
            '<span class="trip-time">' + timeAgo(t.createdAt) + '</span></div>' +
            '<div class="trip-route"><i class="fas fa-map-pin"></i><span>' + start + ' → ' + end + '</span></div>' +
            '<div class="trip-distance"><i class="fas fa-road"></i> ' + distance + '</div></div>';
    }).join('');
};

// ============================================================================
// 27. IMAGE PREVIEW
// ============================================================================
function previewImage(event, previewId) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    let preview = document.getElementById(previewId);
    if (!preview) {
        preview = document.createElement('img');
        preview.id = previewId;
        preview.style.cssText = 'width:100%; max-height:140px; object-fit:cover; border-radius:12px; margin-top:8px;';
        event.target.parentElement.appendChild(preview);
    }
    const reader = new FileReader();
    reader.onload = (e) => { preview.src = e.target.result; };
    reader.readAsDataURL(file);
}

// ============================================================================
// 28. TOASTS
// ============================================================================
function showToast(message, type) {
    type = type || 'info';
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = '<i class="fas ' + (icons[type] || icons.info) + '"></i><span>' + escapeHTML(message) + '</span>';
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, TOAST_DURATION);
}

// ============================================================================
// 29. UTILITIES
// ============================================================================
function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 800;
    quality = quality || 0.7;
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                let w = img.width, h = img.height;
                if (w > h) { if (w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; } }
                else { if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; } }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => reject(new Error('Image load failed'));
            img.src = ev.target.result;
        };
        reader.onerror = () => reject(new Error('File read failed'));
    });
}

function sanitizeFilename(s, max) {
    max = max || 20;
    return String(s || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, max) || 'file';
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
window.escapeHTML = escapeHTML;

function timeAgo(isoString) {
    if (!isoString) return '';
    const s = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    let i = Math.floor(s / 31536000); if (i > 0) return i + 'y ago';
    i = Math.floor(s / 2592000); if (i > 0) return i + 'mo ago';
    i = Math.floor(s / 86400); if (i > 0) return i + 'd ago';
    i = Math.floor(s / 3600); if (i > 0) return i + 'h ago';
    i = Math.floor(s / 60); if (i > 0) return i + 'm ago';
    return 'Just now';
}

function extractYouTubeId(url) {
    const m = url.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    return m ? m[1] : null;
}

function setButtonLoading(btn, text) {
    if (!btn) return;
    btn.disabled = true;
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.innerHTML;
    btn.innerHTML = text ? '<span class="spinner"></span> ' + text : '<span class="spinner"></span>';
}

function resetButton(btn, fallback) {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = btn.dataset.originalText || fallback;
}

function toggleVisibility(el, show) { if (el) el.classList.toggle('hidden', !show); }

function skeletonCards(count) {
    return Array.from({ length: count }).map(() => '<div class="skeleton skeleton-card"></div>').join('');
}

// ============================================================================
// 30. GLOBAL EXPORTS
// ============================================================================
window.mapModule = mapModule;
window.api = api;
window.logger = logger;
window.state = state;

window.toggleGhostMode = function () {
    const checkbox = document.getElementById('toggle-ghost-mode');
    if (checkbox) checkbox.click();
};

console.log('[app] All handlers initialized');