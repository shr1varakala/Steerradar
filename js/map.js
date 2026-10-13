/**
 * ============================================================================
 * STEERADAR MAP MODULE (v11.0)
 * ============================================================================
 * Features:
 *  - MapLibre GL dark vector tiles (keyless) with OSM fallback
 *  - Zoom in/out controls
 *  - Live location + recenter
 *  - Live SteerAgent markers with info popups (distance + message button)
 *  - Save & recall pins
 *  - Location search (Nominatim, no API key)
 *  - Live pickup route line (agent → rider pickup point)
 *  - Trip polyline drawing
 *  - Alert markers
 *  - Vehicle presence markers
 * ============================================================================
 */

const CONFIG = window.STEERADAR || {};

// ============ MODULE STATE ============
let map = null;
let savedMarker = null;
let alertMarkers = [];
let tripPolyline = null;
let tripGlowPolyline = null;
let vehicleMarkers = [];
let vehicleMarkersData = [];
let userLocationMarker = null;
let userLocationGlow = null;
let pickupPolyline = null;
let pickupGlowPolyline = null;
let pickupEndMarker = null;
let navigationLine = null;
let tempMarkers = [];
let searchMarker = null;
let mapInitialized = false;
let liveLocationWatchId = null;

// External callback for "message this agent" clicks
let onMessageAgent = null;

// ============ HELPERS ============
function ensureMap() {
    if (!map) {
        console.warn('[map] Map not ready');
        return false;
    }
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

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============================================================================
// EXPORTED MODULE
// ============================================================================
export const mapModule = {
    // ========================================================================
    // INITIALIZATION
    // ========================================================================
    init: (containerId, onMapClick, options = {}) => {
        const container = document.getElementById(containerId);
        if (!container) { console.error('[map] Container not found'); return null; }
        if (typeof L === 'undefined') { console.error('[map] Leaflet.js not loaded'); return null; }
        if (mapInitialized && map) return map;

        onMessageAgent = options.onMessageAgent || null;

        const lat = CONFIG.DEFAULT_CENTER?.lat || 17.3850;
        const lng = CONFIG.DEFAULT_CENTER?.lng || 78.4867;
        const zoom = CONFIG.DEFAULT_ZOOM || 13;

        container.style.height = '100%';
        container.style.width = '100%';
        container.style.minHeight = '400px';
        container.style.background = '#0a0a0a';

        try {
            map = L.map(containerId, {
                zoomControl: false,
                attributionControl: false,
                preferCanvas: true,
                fadeAnimation: true,
                zoomAnimation: true
            }).setView([lat, lng], zoom);

            const mapLibreReady = typeof L.maplibreGL === 'function' && typeof maplibregl !== 'undefined';
            const styleUrl = CONFIG.MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark';

            if (mapLibreReady) {
                try {
                    L.maplibreGL({ style: styleUrl, interactive: false }).addTo(map);
                    console.log('[map] MapLibre GL dark tiles loaded');
                } catch (err) {
                    console.warn('[map] MapLibre failed:', err);
                    mapModule.addOsmFallback();
                }
            } else {
                mapModule.addOsmFallback();
            }

            L.control.zoom({ position: 'bottomright' }).addTo(map);

            map.on('click', (e) => {
                if (typeof onMapClick === 'function') {
                    onMapClick(e.latlng.lat, e.latlng.lng);
                }
            });

            setTimeout(() => map.invalidateSize(), 100);
            setTimeout(() => map.invalidateSize(), 500);
            setTimeout(() => map.invalidateSize(), 1500);

            // Wire search input
            setTimeout(() => mapModule.wireSearch(), 300);

            mapInitialized = true;
            console.log('[map] Initialized at', lat, lng);
            return map;

        } catch (err) {
            console.error('[map] Init failed:', err);
            return null;
        }
    },

    addOsmFallback: () => {
        if (!map) return;
        const existing = map.getContainer().querySelector('.leaflet-tile-pane');
        if (existing && existing.querySelector('img')) return;
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap',
            maxZoom: 19,
            subdomains: 'abc'
        }).addTo(map);
    },

    getMap: () => map,
    isReady: () => !!map,

    // ========================================================================
    // ZOOM
    // ========================================================================
    zoomIn: () => { if (ensureMap()) map.zoomIn(); },
    zoomOut: () => { if (ensureMap()) map.zoomOut(); },
    setZoom: (level) => { if (ensureMap()) map.setZoom(level); },
    getZoom: () => map ? map.getZoom() : 0,

    fitBounds: (coords, padding = [50, 50]) => {
        if (!ensureMap() || !coords || coords.length < 2) return;
        map.fitBounds(coords, { padding });
    },

    centerOn: (lat, lng, zoom = 15) => {
        if (ensureMap()) map.setView([lat, lng], zoom, { animate: true });
    },

    // ========================================================================
    // RECENTER & LIVE LOCATION
    // ========================================================================
    /**
     * Recenter map to user's current GPS position.
     */
    recenter: async () => {
        try {
            const loc = await mapModule.locateUser(false);
            if (loc) {
                map.setView([loc.lat, loc.lng], 15, { animate: true });
            }
        } catch (e) {
            console.warn('[map] Recenter failed:', e);
        }
    },

    /**
     * Get user's GPS location and draw the marker.
     * @param {boolean} centerIfFound - Whether to center the map
     * @returns {Promise<{lat,lng}>}
     */
    locateUser: (centerIfFound = false) => {
        return new Promise((resolve, reject) => {
            if (!ensureMap()) return reject(new Error('Map not ready'));
            if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const { latitude, longitude } = pos.coords;

                    if (centerIfFound) {
                        map.setView([latitude, longitude], 15, { animate: true });
                    }

                    if (userLocationMarker) {
                        userLocationMarker.setLatLng([latitude, longitude]);
                        if (userLocationGlow) userLocationGlow.setLatLng([latitude, longitude]);
                    } else {
                        userLocationMarker = L.circleMarker([latitude, longitude], {
                            radius: 8, color: '#00d4a0', fillColor: '#00d4a0',
                            fillOpacity: 1, weight: 3
                        }).addTo(map);

                        userLocationGlow = L.circleMarker([latitude, longitude], {
                            radius: 20, color: '#00d4a0', fillColor: '#00d4a0',
                            fillOpacity: 0.15, weight: 1
                        }).addTo(map);
                    }
                    resolve({ lat: latitude, lng: longitude });
                },
                (err) => reject(err),
                { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
            );
        });
    },

    /**
     * Start watching user's location live.
     */
    startLiveLocation: () => {
        if (!navigator.geolocation || liveLocationWatchId !== null) return;
        liveLocationWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                if (userLocationMarker) {
                    userLocationMarker.setLatLng([latitude, longitude]);
                    if (userLocationGlow) userLocationGlow.setLatLng([latitude, longitude]);
                }
                window.dispatchEvent(new CustomEvent('userLocationUpdate', {
                    detail: { lat: latitude, lng: longitude }
                }));
            },
            (err) => console.warn('[map] Watch error:', err.message),
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
        );
    },

    stopLiveLocation: () => {
        if (liveLocationWatchId !== null) {
            navigator.geolocation.clearWatch(liveLocationWatchId);
            liveLocationWatchId = null;
        }
    },

    // ========================================================================
    // SEARCH (Nominatim — free, no key)
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

        // Click outside closes results
        document.addEventListener('click', (e) => {
            const results = document.getElementById('map-search-results');
            const bar = document.querySelector('.map-search-bar');
            if (!results || !bar) return;
            if (!bar.contains(e.target) && !results.contains(e.target)) {
                mapModule.hideSearchResults();
            }
        });
    },

    /**
     * Search location via Nominatim (OpenStreetMap). No API key needed.
     * Biases results toward the current map center.
     */
    searchLocation: async (query) => {
        const results = document.getElementById('map-search-results');
        if (!results) return;

        // Bias toward current map view
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

            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' }
            });
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

            // Cache the current results for click handler
            mapModule._lastSearchResults = data;

        } catch (err) {
            console.warn('[map] Search error:', err);
            results.innerHTML = `<div class="search-empty">Search failed. Check your connection.</div>`;
        }
    },

    pickSearchResult: (idx) => {
        const data = mapModule._lastSearchResults || [];
        const place = data[idx];
        if (!place) return;

        const lat = parseFloat(place.lat);
        const lng = parseFloat(place.lon);

        map.setView([lat, lng], 16, { animate: true });

        // Drop a search marker
        if (searchMarker) map.removeLayer(searchMarker);
        const icon = customIcon(`
            <div style="
                width: 40px; height: 40px;
                background: linear-gradient(135deg, #4F46E5, #7C3AED);
                border: 3px solid #0a0a0a;
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                box-shadow: 0 4px 12px rgba(79,70,229,0.5);
                display: flex; align-items: center; justify-content: center;
            "><i class="fas fa-search" style="
                color: #fff; font-size: 14px; transform: rotate(45deg);
            "></i></div>
        `, 40, [20, 40]);

        searchMarker = L.marker([lat, lng], { icon }).addTo(map);
        searchMarker.bindPopup(`
            <div style="min-width: 180px; text-align:center; padding:4px;">
                <div style="font-weight:700; margin-bottom:6px; color:#4F46E5;">
                    ${escapeHTML(place.name || place.display_name.split(',')[0])}
                </div>
                <div style="font-size:11px; color:#a0a0a0; margin-bottom:10px;">
                    ${escapeHTML(place.display_name).slice(0, 100)}
                </div>
                <button onclick="mapModule.navigateToSearch()" style="
                    background:#00d4a0; color:#000; border:none; padding:8px 14px;
                    border-radius:6px; cursor:pointer; font-weight:bold; font-size:12px;
                    margin-right:4px;
                "><i class="fas fa-directions"></i> Navigate</button>
                <button onclick="mapModule.saveSearchAsPin()" style="
                    background:#1a1a1a; color:#fff; border:1px solid #2a2a2a; padding:8px 14px;
                    border-radius:6px; cursor:pointer; font-weight:bold; font-size:12px;
                "><i class="fas fa-bookmark"></i> Save</button>
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
        // Trigger app.js save flow
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
            <div style="
                width: 36px; height: 36px;
                background: linear-gradient(135deg, #00d4a0, #00b88a);
                border: 3px solid #0a0a0a;
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                box-shadow: 0 4px 12px rgba(0,212,160,0.5);
                display: flex; align-items: center; justify-content: center;
            "><i class="fas fa-map-marker-alt" style="
                color: #000; font-size: 14px; transform: rotate(45deg);
            "></i></div>
        `, 36, [18, 36]);

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
            <div style="
                width: 24px; height: 24px;
                background: #4F46E5;
                border: 3px solid #fff;
                border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            "></div>
        `, 24, [12, 12]);
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
    // ALERTS
    // ========================================================================
    addAlertMarker: (lat, lng, type) => {
        if (!ensureMap()) return null;
        const icons = { traffic: '🚧', pothole: '🕳️', police: '🚓', accident: '⚠️' };
        const icon = customIcon(`
            <div style="
                background: #1a1a1a;
                border: 2px solid #ffc107;
                border-radius: 50%;
                width: 38px; height: 38px;
                display: flex; align-items: center; justify-content: center;
                font-size: 18px;
                box-shadow: 0 0 12px rgba(255,193,7,0.6);
            ">${icons[type] || '⚠️'}</div>
        `, 38, [19, 19]);

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
    // VEHICLE MARKERS (Live SteerAgents)
    // ========================================================================
    /**
     * Render live SteerAgent markers with rich popups (distance + message button).
     * @param {Array} vehicles - [{ lat, lng, ownerName, vehicle, phone, ... }]
     * @param {{lat,lng}} myLocation - user's current location for distance calc
     */
    renderVehicles: (vehicles = [], myLocation = null) => {
        if (!ensureMap() || !Array.isArray(vehicles)) return;

        vehicleMarkersData = vehicles;
        vehicleMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        vehicleMarkers = [];

        vehicles.forEach(v => {
            if (!v.lat || !v.lng) return;
            const isMine = v.mine;
            const color = isMine ? '#00d4a0' : '#4F46E5';

            // Distance from me
            let distanceHTML = '';
            if (myLocation && !isMine) {
                const km = haversine(myLocation.lat, myLocation.lng, v.lat, v.lng);
                distanceHTML = `<div style="color:#00d4a0; font-weight:700; font-size:12px; margin-top:4px;">
                    <i class="fas fa-route"></i> ${formatDistance(km)} away
                </div>`;
            }

            const name = escapeHTML(v.ownerName || v.name || 'Driver');
            const vehicleNum = escapeHTML(v.vehicle || '');
            const phone = v.phone || v.owner || '';

            const popupHTML = `
                <div style="font-family:inherit; padding:4px; min-width:200px;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                        <div style="
                            width:40px; height:40px; border-radius:50%;
                            background:${color}; color:#000; font-weight:800;
                            display:flex; align-items:center; justify-content:center;
                            font-size:14px; border:2px solid #0a0a0a;
                        ">${(v.name || 'DR').substring(0,2).toUpperCase()}</div>
                        <div>
                            <div style="font-weight:700; color:#fff; font-size:14px;">${name}</div>
                            <div style="font-size:11px; color:#a0a0a0;">
                                ${vehicleNum ? '🚗 ' + vehicleNum : 'On the road'}
                            </div>
                        </div>
                    </div>
                    ${distanceHTML}
                    <div style="display:flex; gap:6px; margin-top:10px; padding-top:10px; border-top:1px solid #2a2a2a;">
                        <button onclick="mapModule.messageAgent('${phone}', '${name.replace(/'/g, "\\'")}')" 
                            style="flex:1; background:#00d4a0; color:#000; border:none; padding:8px; border-radius:6px; cursor:pointer; font-weight:700; font-size:12px;">
                            <i class="fas fa-comment"></i> Message
                        </button>
                        <button onclick="mapModule.askWhereTo('${phone}')" 
                            style="flex:1; background:#1a1a1a; color:#fff; border:1px solid #2a2a2a; padding:8px; border-radius:6px; cursor:pointer; font-weight:700; font-size:12px;">
                            <i class="fas fa-question-circle"></i> Where to?
                        </button>
                    </div>
                </div>
            `;

            const icon = customIcon(`
                <div style="
                    width: 44px; height: 44px;
                    border-radius: 50%;
                    border: 3px solid ${color};
                    background: #1a1a1a;
                    display: flex; align-items: center; justify-content: center;
                    box-shadow: 0 0 14px ${color}80;
                    overflow: hidden;
                "><img src="${v.photo || 'https://i.pravatar.cc/150?img=12'}"
                    style="width:100%; height:100%; object-fit:cover;"
                    onerror="this.src='https://i.pravatar.cc/150?img=12'"></div>
            `, 44, [22, 22]);

            const marker = L.marker([v.lat, v.lng], { icon }).addTo(map);
            marker.bindPopup(popupHTML);
            vehicleMarkers.push(marker);
        });
    },

    clearVehicles: () => {
        if (!map) return;
        vehicleMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        vehicleMarkers = [];
    },

    /**
     * Called when user clicks "Message" on a SteerAgent popup.
     */
    messageAgent: (phone, name) => {
        if (typeof onMessageAgent === 'function') {
            onMessageAgent({ phone, name, action: 'message' });
        } else {
            window.dispatchEvent(new CustomEvent('messageAgent', {
                detail: { phone, name, action: 'message' }
            }));
        }
    },

    /**
     * Called when user clicks "Where to?" — sends a quick preset message.
     */
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
    // NAVIGATION & ROUTING
    // ========================================================================
    navigateTo: (destLat, destLng, fromLat = null, fromLng = null) => {
        const dest = `${destLat},${destLng}`;
        const url = (fromLat != null && fromLng != null)
            ? `https://www.google.com/maps/dir/?api=1&origin=${fromLat},${fromLng}&destination=${dest}&travelmode=driving`
            : `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
        window.open(url, '_blank');
    },

    showRoute: (fromLat, fromLng, toLat, toLng) => {
        if (!ensureMap()) return null;
        if (navigationLine) { map.removeLayer(navigationLine); navigationLine = null; }

        navigationLine = L.polyline(
            [[fromLat, fromLng], [toLat, toLng]],
            { color: '#4F46E5', weight: 4, opacity: 0.85, dashArray: '10, 10', lineCap: 'round' }
        ).addTo(map);

        map.fitBounds(navigationLine.getBounds(), { padding: [60, 60] });

        const distance = haversine(fromLat, fromLng, toLat, toLng);
        const midpoint = [(fromLat + toLat) / 2, (fromLng + toLng) / 2];

        L.marker(midpoint, {
            icon: L.divIcon({
                className: 'distance-label',
                html: `<div style="
                    background: #1a1a1a; color: #00d4a0; padding: 6px 12px;
                    border-radius: 20px; font-size: 12px; font-weight: 700;
                    border: 1px solid #00d4a0; white-space: nowrap;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.6);
                ">${formatDistance(distance)}</div>`,
                iconSize: [100, 30],
                iconAnchor: [50, 15]
            })
        }).addTo(map);

        return distance;
    },

    clearRoute: () => {
        if (navigationLine && map) {
            map.removeLayer(navigationLine);
            navigationLine = null;
        }
    },

    // ========================================================================
    // PICKUP ROUTE (SteerAgent driving toward a pickup point)
    // ========================================================================
    /**
     * Draw the pickup route from the agent's current position to a pickup point.
     * Call this repeatedly as the agent moves — the line updates live.
     * 
     * @param {number} fromLat
     * @param {number} fromLng
     * @param {number} toLat
     * @param {number} toLng
     * @param {string} label - Pickup label (e.g., driver name)
     */
    drawPickupRoute: (fromLat, fromLng, toLat, toLng, label = 'Pickup') => {
        if (!ensureMap()) return null;

        // Clear existing route
        if (pickupPolyline) { map.removeLayer(pickupPolyline); pickupPolyline = null; }
        if (pickupGlowPolyline) { map.removeLayer(pickupGlowPolyline); pickupGlowPolyline = null; }
        if (pickupEndMarker) { map.removeLayer(pickupEndMarker); pickupEndMarker = null; }

        // Pickup destination marker
        const destIcon = customIcon(`
            <div style="
                width: 32px; height: 32px;
                background: linear-gradient(135deg, #FF6B6B, #DC2626);
                border: 3px solid #0a0a0a;
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                box-shadow: 0 4px 12px rgba(220,38,38,0.5);
                display: flex; align-items: center; justify-content: center;
            "><i class="fas fa-flag-checkered" style="
                color: #fff; font-size: 12px; transform: rotate(45deg);
            "></i></div>
        `, 32, [16, 32]);

        pickupEndMarker = L.marker([toLat, toLng], { icon: destIcon }).addTo(map);
        pickupEndMarker.bindTooltip(label, { permanent: false });

        // Route line
        pickupPolyline = L.polyline(
            [[fromLat, fromLng], [toLat, toLng]],
            { color: '#00d4a0', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }
        ).addTo(map);

        pickupGlowPolyline = L.polyline(
            [[fromLat, fromLng], [toLat, toLng]],
            { color: '#00d4a0', weight: 14, opacity: 0.15, lineCap: 'round' }
        ).addTo(map);

        const distance = haversine(fromLat, fromLng, toLat, toLng);
        mapModule.showTripBanner(label, distance);

        return distance;
    },

    /**
     * Update the pickup route as the agent moves.
     */
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
        mapModule.clearRoute();
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
    drawPolyline: (coords, color = '#00d4a0') => {
        if (!ensureMap() || !coords || coords.length < 2) return null;
        if (tripPolyline) { map.removeLayer(tripPolyline); tripPolyline = null; }
        if (tripGlowPolyline) { map.removeLayer(tripGlowPolyline); tripGlowPolyline = null; }

        tripPolyline = L.polyline(coords, {
            color, weight: 5, opacity: 0.9, smoothFactor: 1,
            lineCap: 'round', lineJoin: 'round'
        }).addTo(map);

        tripGlowPolyline = L.polyline(coords, {
            color, weight: 14, opacity: 0.15, smoothFactor: 1
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
    // DISTANCE
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

    // ========================================================================
    // UTILITIES
    // ========================================================================
    refreshSize: () => {
        if (!map) return;
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => { if (map) map.invalidateSize(); }, 250);
    },

    clearAll: () => {
        mapModule.clearSavedMarker();
        mapModule.clearAlerts();
        mapModule.clearPolylines();
        mapModule.clearVehicles();
        mapModule.clearTempMarkers();
        mapModule.clearRoute();
        mapModule.clearPickupRoute();
        mapModule.clearSearch();
    }
};

// ============================================================================
// INJECT CUSTOM CSS
// ============================================================================
(function injectMapStyles() {
    if (document.getElementById('steeradar-map-styles')) return;
    const style = document.createElement('style');
    style.id = 'steeradar-map-styles';
    style.textContent = `
        .leaflet-container { background: #0a0a0a !important; font-family: inherit !important; }
        .leaflet-control-zoom { margin-bottom: 200px !important; margin-right: 20px !important; border: none !important; }
        .leaflet-control-zoom a {
            background: #1a1a1a !important; color: #fff !important; border-color: #2a2a2a !important;
            width: 44px !important; height: 44px !important; line-height: 44px !important;
            font-size: 22px !important; font-weight: 700 !important;
            border-radius: 10px !important; margin-bottom: 6px !important;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
        }
        .leaflet-control-zoom a:hover { background: #252525 !important; color: #00d4a0 !important; }
        .leaflet-popup-content-wrapper {
            background: #1a1a1a !important; color: #fff !important;
            border-radius: 12px !important; box-shadow: 0 8px 24px rgba(0,0,0,0.6) !important;
            border: 1px solid #2a2a2a !important;
        }
        .leaflet-popup-tip { background: #1a1a1a !important; border: 1px solid #2a2a2a !important; }
        .leaflet-popup-content { margin: 12px 14px !important; font-size: 13px !important; }
        .leaflet-popup-close-button { color: #a0a0a0 !important; padding: 8px !important; }
        .custom-saved-marker, .custom-alert-icon, .custom-vehicle-marker, .custom-map-icon { background: transparent !important; border: none !important; }
        .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.95) contrast(1.05) saturate(0.7); }
    `;
    document.head.appendChild(style);
})();

console.log('[map] Module v11.0 loaded');