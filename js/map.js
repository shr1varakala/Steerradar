/**
 * ============================================================================
 * STEERADAR MAP MODULE (v14.0)
 * ============================================================================
 * v14.0 changes:
 *   + Long-press on map → dispatches 'steeradar:longpress' (quick-pin sheet)
 *   + GPS accuracy ring + heading indicator on user location
 *   + enableGPS() — start live tracking (toggles .tracking class on #btn-enable-gps)
 *   + recenterMap() — smooth recenter + refit bounds
 *   + Graceful handling of permission denials (fires 'steeradar:gps-denied')
 *   + refreshSize() also re-fits bounds around markers
 * Retains v13.1:
 *   + Vehicle-type icons on pins (bike/auto/car/bus/walk)
 *   + Everything from v13.0 (routing, search, alerts, trips, presence)
 * ============================================================================
 */

const CONFIG = window.STEERADAR || {};

// ============ THEME DEFINITIONS ============
const MAP_THEMES = {
    bright: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attr: '&copy; OpenStreetMap',
        subdomains: 'abc',
        filter: 'none'
    },
    dark: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attr: '&copy; OpenStreetMap',
        subdomains: 'abc',
        filter: 'invert(1) hue-rotate(180deg) brightness(0.95) contrast(1.05) saturate(0.7)'
    },
    satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attr: '&copy; Esri, Maxar, Earthstar Geographics',
        subdomains: '',
        filter: 'none'
    },
    terrain: {
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        attr: '&copy; OpenTopoMap (CC-BY-SA)',
        subdomains: 'abc',
        filter: 'none'
    }
};

// ============ MOCK AGENTS ============
const MOCK_AGENTS = [
    {
        id: 'agent-1', name: 'Agent A',
        avatar: 'https://i.pravatar.cc/150?img=5',
        rating: 4.8, route: 'Koramangala to Jayanagar',
        startTime: '10:30 AM', occupancy: 41,
        baseFare: 10, distance: 5, perKm: 1, totalFare: 15,
        vehicleModel: 'Honda Activa', vehicleColor: 'Grey',
        licensePlate: 'KA-05-XY-9876',
        lat: 12.9352, lng: 77.6245,
        isLive: true, hasSeats: true, vehicleIcon: '🚗'
    },
    {
        id: 'agent-2', name: 'Agent B',
        avatar: 'https://i.pravatar.cc/150?img=12',
        rating: 4.9, route: 'Koramangala to Indiranagar via 12th Main',
        startTime: '10:45 AM', occupancy: 78,
        baseFare: 10, distance: 5, perKm: 2, totalFare: 20,
        vehicleModel: 'Maruti Suzuki Ertiga', vehicleColor: 'White',
        licensePlate: 'KA-01-AB-1234',
        lat: 12.9784, lng: 77.6408,
        isLive: true, hasSeats: true, vehicleIcon: '🚗'
    }
];

// ============ MODULE STATE ============
let map = null;
let tileLayer = null;
let currentTheme = 'bright';
let savedMarker = null;
let alertMarkers = [];
let tripPolyline = null;
let tripGlowPolyline = null;
let vehicleMarkers = [];
let vehicleMarkersData = [];
let userLocationMarker = null;
let userLocationGlow = null;
let userAccuracyCircle = null;
let userHeadingMarker = null;
let pickupPolyline = null;
let pickupGlowPolyline = null;
let pickupEndMarker = null;
let navigationLine = null;
let navigationGlow = null;
let routeMarkers = [];
let tempMarkers = [];
let searchMarker = null;
let mapInitialized = false;
let liveLocationWatchId = null;
let onMessageAgent = null;
let longPressTimer = null;
let longPressStart = null;
let longPressTriggered = false;
let lastKnownPosition = null;
let gpsEnabled = false;

let agentMarkers = [];

const VEHICLE_ICONS = {
    bike: '🛵',
    'two-wheeler': '🛵',
    auto: '🛺',
    car: '🚗',
    bus: '🚌',
    walk: '🚶',
    event: '🎉'
};

// ============ HELPERS ============
function ensureMap() {
    if (!map) { console.warn('[map] Not ready'); return false; }
    return true;
}

function customIcon(html, size = 36, anchor = null) {
    return L.divIcon({
        className: 'custom-map-icon',
        html: html,
        iconSize: [size, size],
        iconAnchor: anchor || [size / 2, size]
    });
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(km) {
    if (km < 1) return Math.round(km * 1000) + ' m';
    if (km < 10) return km.toFixed(2) + ' km';
    return km.toFixed(1) + ' km';
}

function formatDuration(mins) {
    if (mins < 60) return Math.round(mins) + ' min';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h + 'h ' + (m ? m + 'm' : '');
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function buildPulsingPinHTML(agent) {
    const icon = agent.vehicleIcon || '🚗';
    const label = agent.startTime || 'Now';
    return `
        <div class="custom-map-pin" data-agent-id="${escapeHTML(agent.id || '')}">
            <div class="pin-pulse"></div>
            <div class="pin-icon">${icon}</div>
            <div class="pin-label">
                <i class="fas fa-clock" style="color: var(--primary);"></i>
                ${escapeHTML(label)}
            </div>
        </div>
    `;
}

function getGpsButton() {
    return document.getElementById('btn-enable-gps');
}

function setGpsButtonState(state) {
    const btn = getGpsButton();
    if (!btn) return;
    btn.classList.remove('tracking', 'locating');
    if (state === 'tracking') btn.classList.add('tracking');
    if (state === 'locating') btn.classList.add('locating');
}

// ============================================================================
// EXPORTED MODULE
// ============================================================================
export const mapModule = {

    // ========================================================================
    // INIT
    // ========================================================================
    init: (containerId, onMapClick, options = {}) => {
        const container = document.getElementById(containerId);
        if (!container) { console.error('[map] Container not found'); return null; }
        if (typeof L === 'undefined') { console.error('[map] Leaflet.js not loaded'); return null; }
        if (mapInitialized && map) return map;

        onMessageAgent = options.onMessageAgent || null;

        try { currentTheme = localStorage.getItem('steeradar-maptheme') || 'bright'; } catch (e) {}

        const lat = CONFIG.DEFAULT_CENTER?.lat || 17.3850;
        const lng = CONFIG.DEFAULT_CENTER?.lng || 78.4867;
        const zoom = CONFIG.DEFAULT_ZOOM || 13;

        container.style.height = '100%';
        container.style.width = '100%';
        container.style.background = '#e5e3df';

        try {
            map = L.map(containerId, {
                zoomControl: false,
                attributionControl: false,
                preferCanvas: true
            }).setView([lat, lng], zoom);

            mapModule.setMapTheme(currentTheme);

            L.control.zoom({ position: 'bottomright' }).addTo(map);

            map.on('click', (e) => {
                if (longPressTriggered) { longPressTriggered = false; return; }
                if (typeof onMapClick === 'function') {
                    onMapClick(e.latlng.lat, e.latlng.lng);
                }
            });

            // ⭐ v14: LONG-PRESS → dispatch event for quick-pin sheet
            map.on('mousedown', (e) => {
                longPressStart = { lat: e.latlng.lat, lng: e.latlng.lng, time: Date.now() };
                longPressTriggered = false;
                if (longPressTimer) clearTimeout(longPressTimer);
                longPressTimer = setTimeout(() => {
                    longPressTriggered = true;
                    longPressTimer = null;
                    // Small haptic tick
                    if (navigator.vibrate) { try { navigator.vibrate(25); } catch (x) {} }
                    // Notify the app
                    try {
                        window.dispatchEvent(new CustomEvent('steeradar:longpress', {
                            detail: { lat: e.latlng.lat, lng: e.latlng.lng }
                        }));
                    } catch (x) {}
                }, 600);
            });

            const cancelLongPress = () => {
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            };
            map.on('mouseup', cancelLongPress);
            map.on('dragstart', cancelLongPress);
            map.on('zoomstart', cancelLongPress);
            map.on('move', cancelLongPress);
            map.on('mouseout', cancelLongPress);

            // Touch long-press (mobile)
            map.on('touchstart', (e) => {
                if (!e.latlng) return;
                longPressStart = { lat: e.latlng.lat, lng: e.latlng.lng, time: Date.now() };
                longPressTriggered = false;
                if (longPressTimer) clearTimeout(longPressTimer);
                longPressTimer = setTimeout(() => {
                    longPressTriggered = true;
                    longPressTimer = null;
                    if (navigator.vibrate) { try { navigator.vibrate(25); } catch (x) {} }
                    try {
                        window.dispatchEvent(new CustomEvent('steeradar:longpress', {
                            detail: { lat: e.latlng.lat, lng: e.latlng.lng }
                        }));
                    } catch (x) {}
                }, 600);
            });
            map.on('touchend', cancelLongPress);
            map.on('touchmove', cancelLongPress);

            map.on('dragstart', () => mapModule.hideSearchResults());

            setTimeout(() => map.invalidateSize(), 100);
            setTimeout(() => map.invalidateSize(), 500);
            setTimeout(() => map.invalidateSize(), 1500);

            setTimeout(() => mapModule.wireSearch(), 300);

            mapInitialized = true;
            console.log('[map] Initialized at', lat, lng, '(theme:', currentTheme + ')');
            return map;

        } catch (err) {
            console.error('[map] Init failed:', err);
            return null;
        }
    },

    // ========================================================================
    // MAP THEMES
    // ========================================================================
    setMapTheme: (themeName) => {
        if (!map) return;
        const theme = MAP_THEMES[themeName] || MAP_THEMES.bright;
        currentTheme = themeName;

        if (tileLayer) {
            map.removeLayer(tileLayer);
            tileLayer = null;
        }

        const opts = { attribution: theme.attr, maxZoom: 19 };
        if (theme.subdomains) opts.subdomains = theme.subdomains;

        tileLayer = L.tileLayer(theme.url, opts);
        tileLayer.addTo(map);

        const pane = map.getContainer().querySelector('.leaflet-tile-pane');
        if (pane) {
            pane.style.filter = theme.filter || 'none';
            pane.style.transition = 'filter 0.3s ease';
        }

        const container = map.getContainer();
        container.style.background = themeName === 'dark' ? '#0a0a0a' : '#e5e3df';

        try { localStorage.setItem('steeradar-maptheme', themeName); } catch (e) {}

        console.log('[map] Theme set to:', themeName);
    },

    getMapTheme: () => currentTheme,

    // ========================================================================
    // ROAD ROUTING (OSRM)
    // ========================================================================
    fetchRoadRoute: async (fromLat, fromLng, toLat, toLng) => {
        const url = `https://router.project-osrm.org/route/v1/driving/` +
            `${fromLng},${fromLat};${toLng},${toLat}` +
            `?overview=full&geometries=geojson&steps=false`;

        try {
            const res = await fetch(url, { method: 'GET' });
            if (!res.ok) throw new Error('OSRM request failed');
            const data = await res.json();

            if (!data.routes || !data.routes[0]) throw new Error('No route found');

            const route = data.routes[0];
            const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);

            return {
                distance: route.distance / 1000,
                duration: route.duration / 60,
                coords: coords
            };
        } catch (err) {
            console.warn('[map] OSRM routing failed:', err.message);
            return null;
        }
    },

    showRoadRoute: async (fromLat, fromLng, toLat, toLng) => {
        if (!ensureMap()) return null;
        mapModule.clearRoadRoute();

        const route = await mapModule.fetchRoadRoute(fromLat, fromLng, toLat, toLng);

        if (!route) {
            navigationLine = L.polyline(
                [[fromLat, fromLng], [toLat, toLng]],
                { color: '#4F46E5', weight: 5, opacity: 0.85, dashArray: '10,10' }
            ).addTo(map);
            return null;
        }

        navigationGlow = L.polyline(route.coords, {
            color: '#4F46E5', weight: 12, opacity: 0.15, lineCap: 'round'
        }).addTo(map);

        navigationLine = L.polyline(route.coords, {
            color: '#4F46E5', weight: 6, opacity: 0.95,
            lineCap: 'round', lineJoin: 'round'
        }).addTo(map);

        const originMarker = L.marker([fromLat, fromLng], {
            icon: customIcon(`
                <div style="width: 16px; height: 16px; background: #fff;
                    border: 3px solid #6b7280; border-radius: 50%;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.4);"></div>
            `, 16, [8, 8])
        }).addTo(map);
        routeMarkers.push(originMarker);

        const destMarker = L.marker([toLat, toLng], {
            icon: customIcon(`
                <div style="width: 34px; height: 34px;
                    background: linear-gradient(135deg, #ef4444, #dc2626);
                    border: 3px solid #fff; border-radius: 50% 50% 50% 0;
                    transform: rotate(-45deg);
                    box-shadow: 0 4px 12px rgba(220,38,38,0.5);
                    display: flex; align-items: center; justify-content: center;">
                <i class="fas fa-map-marker-alt" style="color: #fff; font-size: 13px; transform: rotate(45deg);"></i></div>
            `, 34, [17, 34])
        }).addTo(map);
        routeMarkers.push(destMarker);

        const midIdx = Math.floor(route.coords.length / 2);
        const mid = route.coords[midIdx];

        const etaBadge = L.marker(mid, {
            icon: L.divIcon({
                className: 'route-eta-badge',
                html: `
                    <div style="background: #4F46E5; color: #fff; padding: 6px 12px;
                        border-radius: 20px; font-size: 12px; font-weight: 700;
                        white-space: nowrap; box-shadow: 0 4px 12px rgba(79,70,229,0.5);
                        display: flex; align-items: center; gap: 6px; font-family: -apple-system, sans-serif;">
                        <i class="fas fa-car" style="font-size: 11px;"></i>
                        ${formatDuration(route.duration)}
                    </div>
                `,
                iconSize: [100, 30],
                iconAnchor: [50, 15]
            })
        }).addTo(map);
        routeMarkers.push(etaBadge);

        map.fitBounds(navigationLine.getBounds(), { padding: [70, 70] });

        window.dispatchEvent(new CustomEvent('routeCalculated', {
            detail: {
                distance: route.distance,
                duration: route.duration,
                fromLat, fromLng, toLat, toLng
            }
        }));

        return route;
    },

    clearRoadRoute: () => {
        if (!map) return;
        if (navigationLine) { map.removeLayer(navigationLine); navigationLine = null; }
        if (navigationGlow) { map.removeLayer(navigationGlow); navigationGlow = null; }
        routeMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        routeMarkers = [];
    },

    // ========================================================================
    // SEARCH (Nominatim)
    // ========================================================================
    wireSearch: () => {
        const input = document.getElementById('map-search-input');
        const clearBtn = document.getElementById('map-search-clear');
        if (!input || input.dataset.wired) return;
        input.dataset.wired = '1';

        let debounceTimer = null;

        input.addEventListener('input', () => {
            const q = input.value.trim();
            if (clearBtn) clearBtn.classList.toggle('hidden', !q);
            if (debounceTimer) clearTimeout(debounceTimer);
            if (q.length < 3) { mapModule.hideSearchResults(); return; }
            debounceTimer = setTimeout(() => mapModule.searchLocation(q), 400);
        });

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const q = input.value.trim();
                if (q.length >= 3) mapModule.searchLocation(q);
            }
        });

        document.addEventListener('click', (e) => {
            const results = document.getElementById('map-search-results');
            const bar = document.querySelector('.map-search-bar');
            if (!results || !bar) return;
            if (!bar.contains(e.target) && !results.contains(e.target)) {
                mapModule.hideSearchResults();
            }
        });
    },

    searchLocation: async (query) => {
        const results = document.getElementById('map-search-results');
        if (!results) return;

        const center = map ? map.getCenter() : { lat: 17.385, lng: 78.486 };
        const viewbox = [
            center.lng - 0.5, center.lat + 0.5,
            center.lng + 0.5, center.lat - 0.5
        ].join(',');

        results.classList.remove('hidden');
        results.innerHTML = `
            <div class="search-loading">
                <div class="spinner"></div> Searching...
            </div>`;

        try {
            const url = `https://nominatim.openstreetmap.org/search?` +
                `q=${encodeURIComponent(query)}` +
                `&format=json&limit=6&addressdetails=1` +
                `&viewbox=${viewbox}&bounded=0`;

            const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) throw new Error('Search failed');
            const data = await res.json();

            if (!data || !data.length) {
                results.innerHTML = `<div class="search-empty">No places found</div>`;
                return;
            }

            results.innerHTML = data.map((place, idx) => {
                const name = escapeHTML(place.display_name || place.name || 'Unknown');
                const short = name.split(',').slice(0, 3).join(', ');
                return `
                    <div class="search-result" onclick="mapModule.pickSearchResult(${idx})" data-idx="${idx}">
                        <i class="fas fa-map-marker-alt"></i>
                        <div class="search-result-info">
                            <div class="search-result-title">${short}</div>
                            <div class="search-result-sub">${name}</div>
                        </div>
                    </div>
                `;
            }).join('');

            mapModule._lastSearchResults = data;

        } catch (err) {
            console.warn('[map] Search error:', err);
            results.innerHTML = `<div class="search-empty">Search failed. Check connection.</div>`;
        }
    },

    pickSearchResult: (idx) => {
        const data = mapModule._lastSearchResults || [];
        const place = data[idx];
        if (!place) return;

        const lat = parseFloat(place.lat);
        const lng = parseFloat(place.lon);

        map.setView([lat, lng], 16, { animate: true });

        if (searchMarker) map.removeLayer(searchMarker);
        const icon = customIcon(`
            <div style="width: 34px; height: 34px;
                background: linear-gradient(135deg, #4F46E5, #7C3AED);
                border: 3px solid #fff; border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                box-shadow: 0 4px 12px rgba(79,70,229,0.5);
                display: flex; align-items: center; justify-content: center;">
            <i class="fas fa-search" style="color: #fff; font-size: 12px; transform: rotate(45deg);"></i></div>
        `, 34, [17, 34]);

        searchMarker = L.marker([lat, lng], { icon }).addTo(map);
        searchMarker.bindPopup(`
            <div style="min-width: 170px; text-align:center; padding:4px;">
                <div style="font-weight:700; margin-bottom:5px; color:#4F46E5; font-size:12px;">
                    ${escapeHTML(place.name || place.display_name.split(',')[0])}
                </div>
                <div style="font-size:10px; color:#6b7280; margin-bottom:8px;">
                    ${escapeHTML(place.display_name).slice(0, 90)}
                </div>
                <button onclick="mapModule.navigateToSearch()" style="background:#00b88a; color:#fff; border:none; padding:6px 12px;
                    border-radius:6px; cursor:pointer; font-weight:bold; font-size:11px; margin-right:4px;">
                    <i class="fas fa-directions"></i> Navigate
                </button>
                <button onclick="mapModule.saveSearchAsPin()" style="background:#f3f4f6; color:#111; border:1px solid #e5e7eb; padding:6px 12px;
                    border-radius:6px; cursor:pointer; font-weight:bold; font-size:11px;">
                    <i class="fas fa-bookmark"></i> Save
                </button>
            </div>
        `).openPopup();

        mapModule.hideSearchResults();
    },

    navigateToSearch: () => {
        if (!searchMarker) return;
        const latlng = searchMarker.getLatLng();
        mapModule.navigateTo(latlng.lat, latlng.lng);
    },

    saveSearchAsPin: () => {
        if (!searchMarker) return;
        const latlng = searchMarker.getLatLng();
        window.dispatchEvent(new CustomEvent('savePin', {
            detail: { lat: latlng.lat, lng: latlng.lng }
        }));
    },

    clearSearch: () => {
        const input = document.getElementById('map-search-input');
        const clearBtn = document.getElementById('map-search-clear');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
        mapModule.hideSearchResults();
    },

    hideSearchResults: () => {
        const results = document.getElementById('map-search-results');
        if (results) results.classList.add('hidden');
    },

    // ========================================================================
    // MARKERS
    // ========================================================================
    dropMarker: (lat, lng, popupHTML) => {
        if (!ensureMap()) return null;
        if (savedMarker) { map.removeLayer(savedMarker); savedMarker = null; }

        const icon = customIcon(`
            <div style="width: 32px; height: 32px;
                background: linear-gradient(135deg, #00b88a, #00a37a);
                border: 3px solid #fff; border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                box-shadow: 0 4px 12px rgba(0,184,138,0.5);
                display: flex; align-items: center; justify-content: center;">
            <i class="fas fa-map-marker-alt" style="color: #fff; font-size: 12px; transform: rotate(45deg);"></i></div>
        `, 32, [16, 32]);

        savedMarker = L.marker([lat, lng], { icon }).addTo(map);
        if (popupHTML) {
            savedMarker.bindPopup(popupHTML, {
                closeButton: false,
                className: 'custom-popup'
            }).openPopup();
        }
        return savedMarker;
    },

    clearSavedMarker: () => {
        if (savedMarker && map) { map.removeLayer(savedMarker); savedMarker = null; }
    },

    addTempMarker: (lat, lng, label = '') => {
        if (!ensureMap()) return null;
        const icon = customIcon(`
            <div style="width: 22px; height: 22px; background: #4F46E5;
                border: 3px solid #fff; border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);"></div>
        `, 22, [11, 11]);
        const m = L.marker([lat, lng], { icon }).addTo(map);
        if (label) m.bindTooltip(label, { permanent: false });
        tempMarkers.push(m);
        return m;
    },

    clearTempMarkers: () => {
        if (!map) return;
        tempMarkers.forEach(m => map.removeLayer(m));
        tempMarkers = [];
    },

    // ========================================================================
    // AGENTS
    // ========================================================================
    renderAgents: (agents = MOCK_AGENTS) => {
        if (!ensureMap() || !Array.isArray(agents)) return;
        mapModule.clearAgents();

        agents.forEach(agent => {
            if (!agent.lat || !agent.lng) return;

            const iconHtml = buildPulsingPinHTML(agent);
            const customIconObj = L.divIcon({
                html: iconHtml,
                className: 'custom-div-icon',
                iconSize: [60, 70],
                iconAnchor: [30, 60]
            });

            const marker = L.marker([agent.lat, agent.lng], {
                icon: customIconObj,
                riseOnHover: true
            }).addTo(map);

            marker.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                if (typeof window.showLaneDetails === 'function') {
                    window.showLaneDetails(agent);
                } else {
                    console.warn('[map] showLaneDetails not found. Is features.js loaded?');
                }
            });

            marker.on('mouseover', function() {
                const el = this.getElement()?.querySelector('.custom-map-pin');
                if (el) el.style.transform = 'scale(1.08)';
            });
            marker.on('mouseout', function() {
                const el = this.getElement()?.querySelector('.custom-map-pin');
                if (el) el.style.transform = 'scale(1)';
            });

            agentMarkers.push(marker);
        });
    },

    clearAgents: () => {
        if (!map) return;
        agentMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        agentMarkers = [];
    },

    // ========================================================================
    // ALERTS
    // ========================================================================
    addAlertMarker: (lat, lng, type) => {
        if (!ensureMap()) return null;
        const icons = { traffic: '🚧', pothole: '🕳️', police: '🚓', accident: '⚠️' };
        const icon = customIcon(`
            <div style="background: #fff; border: 2px solid #f59e0b;
                border-radius: 50%; width: 32px; height: 32px;
                display: flex; align-items: center; justify-content: center;
                font-size: 15px; box-shadow: 0 3px 10px rgba(245,158,11,0.5);">
            ${icons[type] || '⚠️'}</div>
        `, 32, [16, 16]);

        const marker = L.marker([lat, lng], { icon }).addTo(map);
        alertMarkers.push(marker);
        setTimeout(() => {
            if (map && map.hasLayer(marker)) {
                map.removeLayer(marker);
                alertMarkers = alertMarkers.filter(m => m !== marker);
            }
        }, 3600000);
        return marker;
    },

    clearAlerts: () => {
        if (!map) return;
        alertMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        alertMarkers = [];
    },

    // ========================================================================
    // VEHICLE MARKERS
    // ========================================================================
    renderVehicles: (vehicles = [], myLocation = null) => {
        if (!ensureMap() || !Array.isArray(vehicles)) return;
        vehicleMarkersData = vehicles;
        vehicleMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        vehicleMarkers = [];

        vehicles.forEach(v => {
            if (!v.lat || !v.lng) return;
            const isMine = v.mine;
            const color = isMine ? '#00b88a' : '#4F46E5';
            const vehicleIcon = VEHICLE_ICONS[v.vehicleType] || '🚗';

            const agentData = {
                id: v.id || v.phone,
                name: v.ownerName || v.name || 'SteerAgent',
                phone: v.phone || v.owner || '',
                avatar: v.photo || v.avatar || 'https://i.pravatar.cc/150?img=12',
                rating: v.rating || 4.8,
                route: v.route || v.description || 'On the road',
                startTime: v.startTime || 'Now',
                occupancy: v.occupancy || 60,
                baseFare: v.baseFare || 10,
                distance: v.distance || 5,
                perKm: v.perKm || 2,
                totalFare: v.totalFare || (10 + 5 * 2),
                vehicleModel: v.vehicleModel || 'Vehicle',
                vehicleColor: v.vehicleColor || '—',
                licensePlate: v.vehicle || 'N/A',
                vehicleType: v.vehicleType || 'car',
                vehicleIcon: vehicleIcon,
                vehiclePhoto: v.vehiclePhoto || '',
                platePhoto:   v.platePhoto   || '',
                selfie:       v.selfie       || ''
            };

            const iconHtml = buildPulsingPinHTML(agentData);
            const pinIcon = L.divIcon({
                html: iconHtml,
                className: 'custom-div-icon',
                iconSize: [60, 70],
                iconAnchor: [30, 60]
            });

            const marker = L.marker([v.lat, v.lng], {
                icon: pinIcon,
                riseOnHover: true
            }).addTo(map);

            let distanceHTML = '';
            if (myLocation && !isMine) {
                const km = haversine(myLocation.lat, myLocation.lng, v.lat, v.lng);
                distanceHTML = `<div style="color:#00b88a; font-weight:700; font-size:11px; margin-top:4px;">
                    <i class="fas fa-route"></i> ${formatDistance(km)} away
                </div>`;
            }

            const name = escapeHTML(v.ownerName || v.name || 'Driver');
            const vehicleNum = escapeHTML(v.vehicle || '');
            const phone = v.phone || v.owner || '';

            const popupHTML = `
                <div style="padding:4px; min-width:180px;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                        <div style="width:34px; height:34px; border-radius:50%;
                            background:${color}; color:#fff; font-weight:800;
                            display:flex; align-items:center; justify-content:center;
                            font-size:12px; border:2px solid #fff;">${(v.name || 'DR').substring(0,2).toUpperCase()}</div>
                        <div>
                            <div style="font-weight:700; color:#111; font-size:13px;">${name}</div>
                            <div style="font-size:10px; color:#6b7280;">${vehicleNum ? vehicleIcon + ' ' + vehicleNum : 'On the road'}</div>
                        </div>
                    </div>
                    ${distanceHTML}
                    <div style="display:flex; gap:5px; margin-top:8px; padding-top:8px; border-top:1px solid #e5e7eb;">
                        <button onclick="mapModule.messageAgent('${phone}', '${name.replace(/'/g, "\\'")}')"
                            style="flex:1; background:#00b88a; color:#fff; border:none; padding:7px; border-radius:6px; cursor:pointer; font-weight:700; font-size:11px;">
                            <i class="fas fa-comment"></i> Message
                        </button>
                        <button onclick="mapModule.askWhereTo('${phone}')"
                            style="flex:1; background:#f3f4f6; color:#111; border:1px solid #e5e7eb; padding:7px; border-radius:6px; cursor:pointer; font-weight:700; font-size:11px;">
                            <i class="fas fa-question-circle"></i> Where?
                        </button>
                    </div>
                </div>
            `;

            marker.bindPopup(popupHTML);

            marker.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                if (typeof window.showLaneDetails === 'function') {
                    window.showLaneDetails(agentData);
                }
            });

            vehicleMarkers.push(marker);
        });
    },

    clearVehicles: () => {
        if (!map) return;
        vehicleMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        vehicleMarkers = [];
    },

    messageAgent: (phone, name) => {
        if (typeof onMessageAgent === 'function') {
            onMessageAgent({ phone, name, action: 'message' });
        } else {
            window.dispatchEvent(new CustomEvent('messageAgent', {
                detail: { phone, name, action: 'message' }
            }));
        }
    },

    askWhereTo: (phone) => {
        const presetMessage = 'Hi, where are you heading right now?';
        if (typeof onMessageAgent === 'function') {
            onMessageAgent({ phone, action: 'quick', text: presetMessage });
        } else {
            window.dispatchEvent(new CustomEvent('messageAgent', {
                detail: { phone, action: 'quick', text: presetMessage }
            }));
        }
    },

    // ========================================================================
    // NAVIGATION
    // ========================================================================
    navigateTo: (destLat, destLng, fromLat = null, fromLng = null) => {
        const dest = `${destLat},${destLng}`;
        const url = (fromLat != null && fromLng != null)
            ? `https://www.google.com/maps/dir/?api=1&origin=${fromLat},${fromLng}&destination=${dest}&travelmode=driving`
            : `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
        window.open(url, '_blank');
    },

    // ========================================================================
    // PICKUP ROUTE
    // ========================================================================
    drawPickupRoute: (fromLat, fromLng, toLat, toLng, label = 'Pickup') => {
        if (!ensureMap()) return null;
        mapModule.clearPickupRoute();

        const destIcon = customIcon(`
            <div style="width: 30px; height: 30px;
                background: linear-gradient(135deg, #ef4444, #dc2626);
                border: 3px solid #fff; border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                box-shadow: 0 4px 12px rgba(220,38,38,0.5);
                display: flex; align-items: center; justify-content: center;">
            <i class="fas fa-flag-checkered" style="color: #fff; font-size: 11px; transform: rotate(45deg);"></i></div>
        `, 30, [15, 30]);

        pickupEndMarker = L.marker([toLat, toLng], { icon: destIcon }).addTo(map);
        pickupEndMarker.bindTooltip(label, { permanent: false });

        pickupPolyline = L.polyline(
            [[fromLat, fromLng], [toLat, toLng]],
            { color: '#00b88a', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }
        ).addTo(map);

        pickupGlowPolyline = L.polyline(
            [[fromLat, fromLng], [toLat, toLng]],
            { color: '#00b88a', weight: 14, opacity: 0.15 }
        ).addTo(map);

        const distance = haversine(fromLat, fromLng, toLat, toLng);
        mapModule.showTripBanner(label, distance);
        return distance;
    },

    updatePickupRoute: (fromLat, fromLng, toLat, toLng, label = 'Pickup') => {
        if (!pickupPolyline || !pickupGlowPolyline) {
            return mapModule.drawPickupRoute(fromLat, fromLng, toLat, toLng, label);
        }
        pickupPolyline.setLatLngs([[fromLat, fromLng], [toLat, toLng]]);
        pickupGlowPolyline.setLatLngs([[fromLat, fromLng], [toLat, toLng]]);
        const distance = haversine(fromLat, fromLng, toLat, toLng);
        mapModule.showTripBanner(label, distance);
        return distance;
    },

    clearPickupRoute: () => {
        if (pickupPolyline) { map.removeLayer(pickupPolyline); pickupPolyline = null; }
        if (pickupGlowPolyline) { map.removeLayer(pickupGlowPolyline); pickupGlowPolyline = null; }
        if (pickupEndMarker) { map.removeLayer(pickupEndMarker); pickupEndMarker = null; }
        mapModule.hideTripBanner();
    },

    cancelRoute: () => {
        mapModule.clearPickupRoute();
        mapModule.clearRoadRoute();
        window.dispatchEvent(new CustomEvent('routeCancelled'));
    },

    // ========================================================================
    // TRIP BANNER
    // ========================================================================
    showTripBanner: (title, distance) => {
        const banner = document.getElementById('map-trip-banner');
        const titleEl = document.getElementById('trip-banner-title');
        const subEl = document.getElementById('trip-banner-sub');
        if (!banner) return;
        banner.classList.remove('hidden');
        if (titleEl) titleEl.textContent = title;
        if (subEl) subEl.textContent = `${formatDistance(distance)} away`;
    },

    hideTripBanner: () => {
        const banner = document.getElementById('map-trip-banner');
        if (banner) banner.classList.add('hidden');
    },

    // ========================================================================
    // TRIP POLYLINES
    // ========================================================================
    drawPolyline: (coords, color = '#00b88a') => {
        if (!ensureMap() || !coords || coords.length < 2) return null;
        if (tripPolyline) { map.removeLayer(tripPolyline); tripPolyline = null; }
        if (tripGlowPolyline) { map.removeLayer(tripGlowPolyline); tripGlowPolyline = null; }

        tripPolyline = L.polyline(coords, {
            color, weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
        }).addTo(map);

        tripGlowPolyline = L.polyline(coords, {
            color, weight: 14, opacity: 0.15
        }).addTo(map);

        return tripPolyline;
    },

    updatePolyline: (coords) => {
        if (!coords || coords.length < 2) return;
        if (tripPolyline) tripPolyline.setLatLngs(coords);
        if (tripGlowPolyline) tripGlowPolyline.setLatLngs(coords);
    },

    clearPolylines: () => {
        if (!map) return;
        map.eachLayer(layer => {
            if (layer instanceof L.Polyline) map.removeLayer(layer);
        });
        tripPolyline = null;
        tripGlowPolyline = null;
    },

    // ========================================================================
    // DISTANCE & UTILITIES
    // ========================================================================
    calculateDistance: (lat1, lng1, lat2, lng2) => haversine(lat1, lng1, lat2, lng2),

    calculatePolylineDistance: (coords) => {
        if (!coords || coords.length < 2) return 0;
        let total = 0;
        for (let i = 1; i < coords.length; i++) {
            total += haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
        }
        return total;
    },

    formatDistance: (km) => formatDistance(km),
    formatDuration: (mins) => formatDuration(mins),

    // ========================================================================
    // RECENTER / LIVE LOCATION
    // ========================================================================

    /** Recenter the map on the user's location, smooth animation. */
    recenter: async () => {
        try {
            const loc = await mapModule.locateUser(false);
            if (loc) {
                map.setView([loc.lat, loc.lng], Math.max(map.getZoom(), 15), { animate: true });
            }
        } catch (e) {
            console.warn('[map] Recenter failed:', e);
            // Bubble up for the app to toast
            window.dispatchEvent(new CustomEvent('steeradar:gps-denied', {
                detail: { reason: e && e.message ? e.message : 'Location unavailable' }
            }));
        }
    },

    /**
     * Get the current position once.
     * @param {boolean} centerIfFound — if true, the map centers on the user
     */
    locateUser: (centerIfFound = false) => {
        return new Promise((resolve, reject) => {
            if (!ensureMap()) return reject(new Error('Map not ready'));
            if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const { latitude, longitude, accuracy, heading } = pos.coords;
                    lastKnownPosition = { lat: latitude, lng: longitude, accuracy };

                    if (centerIfFound) {
                        map.setView([latitude, longitude], Math.max(map.getZoom(), 15), { animate: true });
                    }
                    mapModule._renderUserLocation(latitude, longitude, accuracy, heading);
                    resolve({ lat: latitude, lng: longitude, accuracy });
                },
                (err) => {
                    const msg = (err && err.message) || 'Location denied';
                    console.warn('[map] locateUser:', msg);
                    setGpsButtonState('off');
                    gpsEnabled = false;
                    window.dispatchEvent(new CustomEvent('steeradar:gps-denied', {
                        detail: { reason: msg, code: err && err.code }
                    }));
                    reject(err);
                },
                { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
            );
        });
    },

    /** Renders the user's dot + accuracy ring + heading marker. */
    _renderUserLocation: (latitude, longitude, accuracy, heading) => {
        if (!map) return;

        // Dot
        if (userLocationMarker) {
            userLocationMarker.setLatLng([latitude, longitude]);
        } else {
            userLocationMarker = L.circleMarker([latitude, longitude], {
                radius: 8, color: '#00b88a', fillColor: '#00b88a',
                fillOpacity: 1, weight: 3
            }).addTo(map);
        }

        // Glow
        if (userLocationGlow) {
            userLocationGlow.setLatLng([latitude, longitude]);
        } else {
            userLocationGlow = L.circleMarker([latitude, longitude], {
                radius: 20, color: '#00b88a', fillColor: '#00b88a',
                fillOpacity: 0.15, weight: 1
            }).addTo(map);
        }

        // ⭐ v14: accuracy circle (radius in meters)
        if (isFinite(accuracy) && accuracy > 0 && accuracy < 2000) {
            if (userAccuracyCircle) {
                userAccuracyCircle.setLatLng([latitude, longitude]);
                userAccuracyCircle.setRadius(accuracy);
            } else {
                userAccuracyCircle = L.circle([latitude, longitude], {
                    radius: accuracy,
                    color: '#00b88a',
                    weight: 1,
                    opacity: 0.4,
                    fillColor: '#00b88a',
                    fillOpacity: 0.08
                }).addTo(map);
            }
        }

        // ⭐ v14: heading indicator (if supported and heading is valid)
        if (isFinite(heading) && heading >= 0) {
            const headingHTML = `
                <div style="
                    width: 0; height: 0;
                    border-left: 6px solid transparent;
                    border-right: 6px solid transparent;
                    border-bottom: 10px solid #00b88a;
                    transform: rotate(${heading}deg);
                    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
                "></div>`;
            const headingIcon = L.divIcon({
                className: 'user-heading-marker',
                html: headingHTML,
                iconSize: [12, 12],
                iconAnchor: [6, 6]
            });
            if (userHeadingMarker) {
                userHeadingMarker.setLatLng([latitude, longitude]);
                userHeadingMarker.setIcon(headingIcon);
            } else {
                userHeadingMarker = L.marker([latitude, longitude], {
                    icon: headingIcon,
                    interactive: false
                }).addTo(map);
            }
        }
    },

    /** Start live GPS tracking. Toggles the GPS button state. */
    startLiveLocation: () => {
        if (!navigator.geolocation) {
            setGpsButtonState('off');
            return;
        }
        if (liveLocationWatchId !== null) return; // already tracking

        setGpsButtonState('locating');

        liveLocationWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude, accuracy, heading } = pos.coords;
                lastKnownPosition = { lat: latitude, lng: longitude, accuracy };

                mapModule._renderUserLocation(latitude, longitude, accuracy, heading);

                gpsEnabled = true;
                setGpsButtonState('tracking');

                window.dispatchEvent(new CustomEvent('userLocationUpdate', {
                    detail: { lat: latitude, lng: longitude, accuracy }
                }));
            },
            (err) => {
                console.warn('[map] Watch error:', err.message);
                // If the user denied permission, don't keep retrying silently
                if (err && (err.code === 1 || /denied/i.test(err.message))) {
                    mapModule.stopLiveLocation();
                    setGpsButtonState('off');
                    gpsEnabled = false;
                    window.dispatchEvent(new CustomEvent('steeradar:gps-denied', {
                        detail: { reason: 'Location permission denied', code: err.code }
                    }));
                }
            },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
        );
    },

    stopLiveLocation: () => {
        if (liveLocationWatchId !== null) {
            navigator.geolocation.clearWatch(liveLocationWatchId);
            liveLocationWatchId = null;
        }
        setGpsButtonState('off');
        gpsEnabled = false;
    },

    /** Toggle — used by the map control bar's Enable GPS button. */
    toggleLiveLocation: () => {
        if (liveLocationWatchId !== null) {
            mapModule.stopLiveLocation();
            return { tracking: false };
        }
        mapModule.startLiveLocation();
        return { tracking: true };
    },

    isGpsTracking: () => liveLocationWatchId !== null,

    getLastKnownPosition: () => lastKnownPosition,

    // ========================================================================
    // MISC
    // ========================================================================
    centerOn: (lat, lng, zoom = 15) => {
        if (ensureMap()) map.setView([lat, lng], zoom, { animate: true });
    },

    zoomIn: () => { if (ensureMap()) map.zoomIn(); },
    zoomOut: () => { if (ensureMap()) map.zoomOut(); },
    setZoom: (level) => { if (ensureMap()) map.setZoom(level); },
    getZoom: () => map ? map.getZoom() : 0,
    getMap: () => map,
    isReady: () => !!map,

    fitBounds: (coords, padding = [50, 50]) => {
        if (!ensureMap() || !coords || coords.length < 2) return;
        map.fitBounds(coords, { padding });
    },

    /** ⭐ v14: refreshSize also re-fits bounds to visible markers. */
    refreshSize: () => {
        if (!map) return;
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => { if (map) map.invalidateSize(); }, 250);

        // After resize, if we have markers, gently refit to them
        setTimeout(() => {
            if (!map) return;
            const all = [].concat(vehicleMarkers, agentMarkers, tempMarkers);
            if (all.length) {
                try {
                    const group = L.featureGroup(all);
                    map.fitBounds(group.getBounds().pad(0.15), { animate: true, maxZoom: 16 });
                } catch (e) { /* ignore */ }
            }
        }, 450);
    },

    clearAll: () => {
        mapModule.clearSavedMarker();
        mapModule.clearAlerts();
        mapModule.clearPolylines();
        mapModule.clearVehicles();
        mapModule.clearTempMarkers();
        mapModule.clearRoadRoute();
        mapModule.clearPickupRoute();
        mapModule.clearSearch();
        mapModule.clearAgents();
    },

    MOCK_AGENTS: MOCK_AGENTS
};

console.log('[map] Module v14.0 loaded');