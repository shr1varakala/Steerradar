/**
 * ============================================================================
 * STEERADAR MAP MODULE (v9.0)
 * ============================================================================
 * Wraps Leaflet.js and provides a clean API for the main app.
 * Handles: initialization, markers, polylines (trip routes), alerts,
 * geolocation, vehicle rendering, and dark theme styling.
 * 
 * DEPENDENCIES:
 * - Leaflet.js loaded globally (via <script> tag in index.html)
 * - window.STEERADAR config object (from config.js)
 * ============================================================================
 */

const CONFIG = window.STEERADAR || {};

// Module-level state
let map = null;
let savedMarker = null;
let alertMarkers = [];
let tripPolyline = null;
let tripGlowPolyline = null;
let vehicleMarkers = [];
let userLocationMarker = null;

export const mapModule = {
    // ========================================================================
    // INITIALIZATION
    // ========================================================================
    /**
     * Initialize the Leaflet map with dark theme tiles.
     * @param {string} containerId - The DOM element ID where the map renders.
     * @param {Function} onMapClick - Callback fired when the user clicks the map.
     */
    init: (containerId, onMapClick) => {
        const container = document.getElementById(containerId);
        if (!container) {
            console.error('[map] Container not found:', containerId);
            return null;
        }

        // Verify Leaflet is loaded
        if (typeof L === 'undefined') {
            console.error('[map] Leaflet.js is not loaded! Add the Leaflet script tag.');
            return null;
        }

        // Fallback coordinates (Hyderabad)
        const lat = CONFIG.DEFAULT_CENTER?.lat || 17.3850;
        const lng = CONFIG.DEFAULT_CENTER?.lng || 78.4867;
        const zoom = CONFIG.DEFAULT_ZOOM || 13;

        // CRITICAL FIX: Ensure container has explicit height BEFORE Leaflet init
        container.style.height = '100%';
        container.style.width = '100%';
        container.style.minHeight = '400px';

        try {
            map = L.map(containerId, {
                zoomControl: false,
                attributionControl: false,
                preferCanvas: true // Better performance for many markers
            }).setView([lat, lng], zoom);

            // Dark theme tiles (CartoDB Dark Matter)
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap &copy; CARTO',
                maxZoom: 19,
                subdomains: 'abcd',
                crossOrigin: true
            }).addTo(map);

            // Zoom control at bottom-right
            L.control.zoom({ position: 'bottomright' }).addTo(map);

            // Map click handler
            map.on('click', (e) => {
                if (typeof onMapClick === 'function') {
                    onMapClick(e.latlng.lat, e.latlng.lng);
                }
            });

            // CRITICAL FIX: Force Leaflet to recalculate its size after layout settles
            // Mobile browsers and tab switches can cause the container to have 0 size initially
            setTimeout(() => map.invalidateSize(), 100);
            setTimeout(() => map.invalidateSize(), 500);
            setTimeout(() => map.invalidateSize(), 1500);

            console.log('[map] Initialized at', lat, lng);
            return map;

        } catch (err) {
            console.error('[map] Initialization failed:', err);
            return null;
        }
    },

    /**
     * Get the raw Leaflet map instance.
     */
    getMap: () => map,

    /**
     * Force Leaflet to recalculate its container size.
     * Call this after switching tabs or resizing the window.
     */
    refreshSize: () => {
        if (!map) return;
        requestAnimationFrame(() => {
            map.invalidateSize();
        });
        setTimeout(() => {
            if (map) map.invalidateSize();
        }, 250);
    },

    // ========================================================================
    // SAVED MARKERS (for saving locations)
    // ========================================================================
    /**
     * Drop a single saveable marker (used for saving locations).
     */
    dropMarker: (lat, lng, popupHTML) => {
        if (!map) return null;

        // Remove existing saved marker
        if (savedMarker) {
            map.removeLayer(savedMarker);
            savedMarker = null;
        }

        const customIcon = L.divIcon({
            className: 'custom-saved-marker',
            html: `<div style="
                width: 36px; height: 36px;
                background: linear-gradient(135deg, #00d4a0, #00b88a);
                border: 3px solid #0a0a0a;
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                box-shadow: 0 4px 12px rgba(0,212,160,0.5);
                display: flex; align-items: center; justify-content: center;
            "><i class="fas fa-map-marker-alt" style="
                color: #000; font-size: 14px; transform: rotate(45deg);
            "></i></div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 36],
            popupAnchor: [0, -36]
        });

        savedMarker = L.marker([lat, lng], { icon: customIcon }).addTo(map);

        if (popupHTML) {
            savedMarker.bindPopup(popupHTML, {
                closeButton: false,
                className: 'custom-popup'
            }).openPopup();
        }

        return savedMarker;
    },

    /**
     * Clear the currently saved marker.
     */
    clearSavedMarker: () => {
        if (savedMarker && map) {
            map.removeLayer(savedMarker);
            savedMarker = null;
        }
    },

    // ========================================================================
    // ALERT MARKERS (Road conditions)
    // ========================================================================
    /**
     * Add a temporary road alert marker (Pothole, Traffic, etc.).
     * Auto-expires after 1 hour.
     */
    addAlertMarker: (lat, lng, type) => {
        if (!map) return null;

        const icons = {
            traffic: '🚧',
            pothole: '🕳️',
            police: '🚓',
            accident: '⚠️'
        };

        const icon = L.divIcon({
            className: 'custom-alert-icon',
            html: `<div style="
                background-color: #1a1a1a;
                border: 2px solid #ffc107;
                border-radius: 50%;
                width: 38px; height: 38px;
                display: flex; align-items: center; justify-content: center;
                font-size: 18px;
                box-shadow: 0 0 12px rgba(255,193,7,0.6);
            ">${icons[type] || '⚠️'}</div>`,
            iconSize: [38, 38],
            iconAnchor: [19, 19]
        });

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

    /**
     * Clear all alert markers.
     */
    clearAlerts: () => {
        if (!map) return;
        alertMarkers.forEach(m => {
            if (map.hasLayer(m)) map.removeLayer(m);
        });
        alertMarkers = [];
    },

    // ========================================================================
    // TRIP POLYLINES (Route drawing)
    // ========================================================================
    /**
     * Draw a polyline representing a trip route.
     * @param {Array} coords - Array of [lat, lng] pairs.
     * @param {string} color - Stroke color (hex).
     */
    drawPolyline: (coords, color = '#00d4a0') => {
        if (!map || !coords || coords.length < 2) return null;

        // Remove existing trip polyline if any
        if (tripPolyline) {
            map.removeLayer(tripPolyline);
            tripPolyline = null;
        }
        if (tripGlowPolyline) {
            map.removeLayer(tripGlowPolyline);
            tripGlowPolyline = null;
        }

        // Main visible line
        tripPolyline = L.polyline(coords, {
            color: color,
            weight: 5,
            opacity: 0.9,
            smoothFactor: 1,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(map);

        // Subtle glow underneath
        tripGlowPolyline = L.polyline(coords, {
            color: color,
            weight: 14,
            opacity: 0.15,
            smoothFactor: 1,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(map);

        return tripPolyline;
    },

    /**
     * Update an existing trip polyline with new points.
     */
    updatePolyline: (coords) => {
        if (!coords || coords.length < 2) return;
        if (tripPolyline) tripPolyline.setLatLngs(coords);
        if (tripGlowPolyline) tripGlowPolyline.setLatLngs(coords);
    },

    /**
     * Clear all polylines.
     */
    clearPolylines: () => {
        if (!map) return;
        map.eachLayer(layer => {
            if (layer instanceof L.Polyline) {
                map.removeLayer(layer);
            }
        });
        tripPolyline = null;
        tripGlowPolyline = null;
    },

    // ========================================================================
    // VEHICLE MARKERS (Live Presence)
    // ========================================================================
    /**
     * Render live vehicle markers from presence data.
     * @param {Array} vehicles - Array of presence objects from api.activeVehicles()
     */
    renderVehicles: (vehicles = []) => {
        if (!map) return;

        // Clear old vehicle markers
        vehicleMarkers.forEach(m => {
            if (map.hasLayer(m)) map.removeLayer(m);
        });
        vehicleMarkers = [];

        if (!Array.isArray(vehicles)) return;

        vehicles.forEach(v => {
            if (!v.lat || !v.lng) return;

            const isMine = v.mine;
            const color = isMine ? '#00d4a0' : '#4F46E5';

            const icon = L.divIcon({
                className: 'custom-vehicle-marker',
                html: `<div style="
                    width: 42px; height: 42px;
                    border-radius: 50%;
                    border: 2px solid ${color};
                    background: #1a1a1a;
                    display: flex; align-items: center; justify-content: center;
                    box-shadow: 0 0 12px ${color}80;
                    overflow: hidden;
                "><img src="${v.photo || 'https://i.pravatar.cc/150?img=12'}" 
                    style="width:100%; height:100%; object-fit:cover;" 
                    onerror="this.src='https://i.pravatar.cc/150?img=12'"></div>`,
                iconSize: [42, 42],
                iconAnchor: [21, 21]
            });

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

    /**
     * Clear all vehicle markers.
     */
    clearVehicles: () => {
        if (!map) return;
        vehicleMarkers.forEach(m => {
            if (map.hasLayer(m)) map.removeLayer(m);
        });
        vehicleMarkers = [];
    },

    // ========================================================================
    // GEOLOCATION
    // ========================================================================
    /**
     * Get the user's current GPS location and center the map.
     * Returns a promise with { lat, lng }.
     */
    locateUser: () => {
        return new Promise((resolve, reject) => {
            if (!map) return reject(new Error('Map not initialized'));
            if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const { latitude, longitude } = pos.coords;

                    // Center map on user
                    map.setView([latitude, longitude], 15, { animate: true });

                    // Update / add user location marker (pulsing blue dot)
                    if (userLocationMarker) {
                        userLocationMarker.setLatLng([latitude, longitude]);
                    } else {
                        userLocationMarker = L.circleMarker([latitude, longitude], {
                            radius: 8,
                            color: '#00d4a0',
                            fillColor: '#00d4a0',
                            fillOpacity: 1,
                            weight: 3
                        }).addTo(map);

                        // Add a pulsing outer ring
                        L.circleMarker([latitude, longitude], {
                            radius: 20,
                            color: '#00d4a0',
                            fillColor: '#00d4a0',
                            fillOpacity: 0.15,
                            weight: 1
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

    /**
     * Watch user's location continuously.
     * @param {Function} callback - Called with { lat, lng } on each update.
     * @returns {number} The watch ID (use navigator.geolocation.clearWatch to stop).
     */
    watchUser: (callback) => {
        if (!navigator.geolocation) return null;
        return navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                if (typeof callback === 'function') {
                    callback({ lat: latitude, lng: longitude });
                }
            },
            (err) => console.warn('[map] Watch error:', err.message),
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
        );
    },

    /**
     * Center the map on a specific coordinate.
     */
    centerOn: (lat, lng, zoom = 15) => {
        if (!map) return;
        map.setView([lat, lng], zoom, { animate: true });
    },

    /**
     * Fit the map bounds to a set of coordinates.
     */
    fitBounds: (coords) => {
        if (!map || !coords || coords.length < 2) return;
        map.fitBounds(coords, { padding: [50, 50] });
    }
};

// ============================================================================
// INJECT CUSTOM CSS FOR LEAFLET DARK THEME
// ============================================================================
(function injectMapStyles() {
    if (document.getElementById('steeradar-map-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'steeradar-map-styles';
    style.textContent = `
        /* Leaflet dark theme overrides */
        .leaflet-container {
            background: #0a0a0a !important;
            font-family: inherit !important;
        }
        
        .leaflet-control-zoom {
            margin-bottom: 110px !important;
            margin-right: 20px !important;
        }
        
        .leaflet-control-zoom a {
            background: #1a1a1a !important;
            color: #ffffff !important;
            border-color: #2a2a2a !important;
            width: 40px !important;
            height: 40px !important;
            line-height: 40px !important;
            font-size: 20px !important;
            transition: all 0.2s ease !important;
        }
        
        .leaflet-control-zoom a:hover {
            background: #252525 !important;
            color: #00d4a0 !important;
        }
        
        .leaflet-popup-content-wrapper {
            background: #1a1a1a !important;
            color: #ffffff !important;
            border-radius: 12px !important;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6) !important;
            border: 1px solid #2a2a2a !important;
        }
        
        .leaflet-popup-tip {
            background: #1a1a1a !important;
            border: 1px solid #2a2a2a !important;
        }
        
        .leaflet-popup-content {
            margin: 12px 14px !important;
            font-size: 13px !important;
        }
        
        .leaflet-popup-close-button {
            color: #a0a0a0 !important;
            padding: 8px !important;
        }
        
        .leaflet-popup-close-button:hover {
            color: #ffffff !important;
        }
        
        /* Remove default icon backgrounds */
        .custom-saved-marker,
        .custom-alert-icon,
        .custom-vehicle-marker {
            background: transparent !important;
            border: none !important;
        }
        
        /* Smooth marker transitions */
        .leaflet-marker-icon {
            transition: transform 0.3s ease;
        }
    `;
    document.head.appendChild(style);
})();

console.log('[map] Module loaded');