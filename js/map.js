/**
 * ============================================================================
 * STEERADAR MAP MODULE (v10.0) - Full Featured
 * ============================================================================
 * Features:
 *  - MapLibre GL dark vector tiles (keyless) with OSM fallback
 *  - Zoom in/out controls
 *  - Drop & save markers with custom icons
 *  - Navigate to location (Google Maps + in-app)
 *  - Distance calculation (Haversine + polyline total)
 *  - Live trip polyline drawing
 *  - Alert markers (traffic/pothole/police/accident)
 *  - Vehicle presence markers
 *  - User location tracking
 * 
 * DEPENDENCIES (loaded in index.html BEFORE app.js):
 *  - Leaflet.js
 *  - MapLibre GL JS
 *  - leaflet-maplibre-gl plugin
 *  - window.STEERADAR config object
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
let userLocationMarker = null;
let userLocationGlow = null;
let navigationLine = null;
let tempMarkers = [];
let mapInitialized = false;

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

/**
 * Haversine distance between two points in km.
 */
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

// ============================================================================
// EXPORTED MODULE
// ============================================================================
export const mapModule = {
    // ========================================================================
    // INITIALIZATION
    // ========================================================================
    init: (containerId, onMapClick) => {
        const container = document.getElementById(containerId);
        if (!container) {
            console.error('[map] Container not found:', containerId);
            return null;
        }
        if (typeof L === 'undefined') {
            console.error('[map] Leaflet.js not loaded.');
            return null;
        }
        if (mapInitialized && map) return map;

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

            // Try MapLibre GL dark vector tiles (keyless)
            const mapLibreReady = typeof L.maplibreGL === 'function' && typeof maplibregl !== 'undefined';
            const styleUrl = CONFIG.MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark';

            if (mapLibreReady) {
                try {
                    L.maplibreGL({ style: styleUrl, interactive: false }).addTo(map);
                    console.log('[map] MapLibre GL dark tiles loaded');
                } catch (err) {
                    console.warn('[map] MapLibre failed, using OSM fallback:', err);
                    mapModule.addOsmFallback();
                }
            } else {
                console.warn('[map] MapLibre unavailable, using OSM fallback');
                mapModule.addOsmFallback();
            }

            // Zoom controls bottom-right
            L.control.zoom({ position: 'bottomright' }).addTo(map);

            // Map click handler
            map.on('click', (e) => {
                if (typeof onMapClick === 'function') {
                    onMapClick(e.latlng.lat, e.latlng.lng);
                }
            });

            // Handle MapLibre runtime errors gracefully
            map.on('layerremove', (e) => {
                if (e.layer && e.layer._maplibreGL) {
                    console.warn('[map] MapLibre layer removed, adding fallback');
                    mapModule.addOsmFallback();
                }
            });

            // Force re-layout after mount (mobile safe)
            setTimeout(() => map.invalidateSize(), 100);
            setTimeout(() => map.invalidateSize(), 500);
            setTimeout(() => map.invalidateSize(), 1500);

            mapInitialized = true;
            console.log('[map] Initialized at', lat, lng);
            return map;

        } catch (err) {
            console.error('[map] Init failed:', err);
            return null;
        }
    },

    /**
     * Fallback to OpenStreetMap tiles with dark CSS filter.
     */
    addOsmFallback: () => {
        if (!map) return;
        const existing = map.getContainer().querySelector('.leaflet-tile-pane');
        if (existing && existing.querySelector('img')) return;

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap',
            maxZoom: 19,
            subdomains: 'abc'
        }).addTo(map);
        console.log('[map] OSM fallback added');
    },

    getMap: () => map,
    isReady: () => !!map,

    // ========================================================================
    // ZOOM CONTROLS
    // ========================================================================
    zoomIn: () => { if (ensureMap()) map.zoomIn(); },
    zoomOut: () => { if (ensureMap()) map.zoomOut(); },
    setZoom: (level) => { if (ensureMap()) map.setZoom(level); },
    getZoom: () => map ? map.getZoom() : 0,

    /**
     * Fit map to bounds of coordinates. Accepts array of [lat, lng].
     */
    fitBounds: (coords, padding = [50, 50]) => {
        if (!ensureMap() || !coords || coords.length < 2) return;
        map.fitBounds(coords, { padding });
    },

    // ========================================================================
    // MARKERS
    // ========================================================================
    /**
     * Drop a saveable marker with custom green icon.
     */
    dropMarker: (lat, lng, popupHTML) => {
        if (!ensureMap()) return null;
        if (savedMarker) {
            map.removeLayer(savedMarker);
            savedMarker = null;
        }

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
        if (savedMarker && map) {
            map.removeLayer(savedMarker);
            savedMarker = null;
        }
    },

    /**
     * Add a temporary marker (auto-clears on next click if desired).
     */
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

        // Auto-remove after 1 hour
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
    // NAVIGATION
    // ========================================================================
    /**
     * Navigate to a destination. Opens Google Maps in a new tab.
     * If fromLat/fromLng are provided, uses them as origin.
     */
    navigateTo: (destLat, destLng, fromLat = null, fromLng = null) => {
        const dest = `${destLat},${destLng}`;
        let url;
        if (fromLat != null && fromLng != null) {
            url = `https://www.google.com/maps/dir/?api=1&origin=${fromLat},${fromLng}&destination=${dest}&travelmode=driving`;
        } else {
            url = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
        }
        window.open(url, '_blank');
    },

    /**
     * Show an in-app navigation line from user to destination.
     * Returns the distance in km.
     */
    showRoute: (fromLat, fromLng, toLat, toLng) => {
        if (!ensureMap()) return null;

        // Clear previous navigation
        if (navigationLine) {
            map.removeLayer(navigationLine);
            navigationLine = null;
        }

        // Dashed line
        navigationLine = L.polyline(
            [[fromLat, fromLng], [toLat, toLng]],
            {
                color: '#4F46E5',
                weight: 4,
                opacity: 0.85,
                dashArray: '10, 10',
                lineCap: 'round'
            }
        ).addTo(map);

        // Fit bounds
        map.fitBounds(navigationLine.getBounds(), { padding: [60, 60] });

        // Distance
        const distance = haversine(fromLat, fromLng, toLat, toLng);
        const midpoint = [(fromLat + toLat) / 2, (fromLng + toLng) / 2];

        // Distance label
        L.marker(midpoint, {
            icon: L.divIcon({
                className: 'distance-label',
                html: `<div style="
                    background: #1a1a1a;
                    color: #00d4a0;
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 700;
                    border: 1px solid #00d4a0;
                    white-space: nowrap;
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
    // DISTANCE CALCULATION
    // ========================================================================
    /**
     * Calculate straight-line distance between two coordinates (km).
     */
    calculateDistance: (lat1, lng1, lat2, lng2) => {
        return haversine(lat1, lng1, lat2, lng2);
    },

    /**
     * Calculate total distance of a polyline from array of [lat, lng].
     */
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
            color, weight: 14, opacity: 0.15, smoothFactor: 1,
            lineCap: 'round', lineJoin: 'round'
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
    // VEHICLES
    // ========================================================================
    renderVehicles: (vehicles = []) => {
        if (!ensureMap() || !Array.isArray(vehicles)) return;

        vehicleMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        vehicleMarkers = [];

        vehicles.forEach(v => {
            if (!v.lat || !v.lng) return;
            const color = v.mine ? '#00d4a0' : '#4F46E5';
            const icon = customIcon(`
                <div style="
                    width: 42px; height: 42px;
                    border-radius: 50%;
                    border: 2px solid ${color};
                    background: #1a1a1a;
                    display: flex; align-items: center; justify-content: center;
                    box-shadow: 0 0 12px ${color}80;
                    overflow: hidden;
                "><img src="${v.photo || 'https://i.pravatar.cc/150?img=12'}"
                    style="width:100%; height:100%; object-fit:cover;"
                    onerror="this.src='https://i.pravatar.cc/150?img=12'"></div>
            `, 42, [21, 21]);

            const marker = L.marker([v.lat, v.lng], { icon }).addTo(map);
            marker.bindPopup(`
                <div style="font-family:sans-serif; padding:4px; min-width:140px;">
                    <strong style="color:#00d4a0;">${v.ownerName || 'Driver'}</strong><br>
                    <span style="font-size:11px; color:#a0a0a0;">
                        ${v.vehicle ? '🚗 ' + v.vehicle : 'On the road'}
                    </span>
                </div>
            `);
            vehicleMarkers.push(marker);
        });
    },

    clearVehicles: () => {
        if (!map) return;
        vehicleMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
        vehicleMarkers = [];
    },

    // ========================================================================
    // GEOLOCATION
    // ========================================================================
    locateUser: () => {
        return new Promise((resolve, reject) => {
            if (!ensureMap()) return reject(new Error('Map not ready'));
            if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const { latitude, longitude } = pos.coords;
                    map.setView([latitude, longitude], 15, { animate: true });

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
                (err) => {
                    console.warn('[map] Location error:', err.message);
                    reject(err);
                },
                { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
            );
        });
    },

    watchUser: (callback) => {
        if (!navigator.geolocation) return null;
        return navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                if (typeof callback === 'function') callback({ lat: latitude, lng: longitude });
            },
            (err) => console.warn('[map] Watch error:', err.message),
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
        );
    },

    // ========================================================================
    // UTILITIES
    // ========================================================================
    centerOn: (lat, lng, zoom = 15) => {
        if (ensureMap()) map.setView([lat, lng], zoom, { animate: true });
    },

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
    }
};

// ============================================================================
// INJECT CUSTOM CSS FOR MAP
// ============================================================================
(function injectMapStyles() {
    if (document.getElementById('steeradar-map-styles')) return;
    const style = document.createElement('style');
    style.id = 'steeradar-map-styles';
    style.textContent = `
        /* Map background */
        .leaflet-container { background: #0a0a0a !important; font-family: inherit !important; }

        /* Zoom controls */
        .leaflet-control-zoom {
            margin-bottom: 110px !important;
            margin-right: 20px !important;
            border: none !important;
        }
        .leaflet-control-zoom a {
            background: #1a1a1a !important;
            color: #ffffff !important;
            border-color: #2a2a2a !important;
            width: 44px !important;
            height: 44px !important;
            line-height: 44px !important;
            font-size: 22px !important;
            font-weight: 700 !important;
            transition: all 0.2s ease !important;
            border-radius: 10px !important;
            margin-bottom: 6px !important;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
        }
        .leaflet-control-zoom a:hover {
            background: #252525 !important;
            color: #00d4a0 !important;
            transform: scale(1.05);
        }
        .leaflet-control-zoom a:first-child { border-top-left-radius: 10px !important; border-top-right-radius: 10px !important; }
        .leaflet-control-zoom a:last-child  { border-bottom-left-radius: 10px !important; border-bottom-right-radius: 10px !important; }

        /* Popups */
        .leaflet-popup-content-wrapper {
            background: #1a1a1a !important;
            color: #ffffff !important;
            border-radius: 12px !important;
            box-shadow: 0 8px 24px rgba(0,0,0,0.6) !important;
            border: 1px solid #2a2a2a !important;
        }
        .leaflet-popup-tip { background: #1a1a1a !important; border: 1px solid #2a2a2a !important; }
        .leaflet-popup-content { margin: 12px 14px !important; font-size: 13px !important; }
        .leaflet-popup-close-button { color: #a0a0a0 !important; padding: 8px !important; }
        .leaflet-popup-close-button:hover { color: #ffffff !important; }

        /* Custom markers */
        .custom-saved-marker, .custom-alert-icon, .custom-vehicle-marker, .custom-map-icon {
            background: transparent !important;
            border: none !important;
        }

        /* Distance label */
        .distance-label { background: transparent !important; border: none !important; }

        /* Smooth transitions */
        .leaflet-marker-icon { transition: transform 0.3s ease; }

        /* OSM dark fallback */
        .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.95) contrast(1.05) saturate(0.7); }

        /* MapLibre override (when active, remove filter) */
        .leaflet-container.maplibre-active .leaflet-tile-pane { filter: none; }
    `;
    document.head.appendChild(style);
})();

console.log('[map] Module v10.0 loaded');