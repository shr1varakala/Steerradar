/**
 * ============================================================================
 * STEERADAR MAP MODULE (v7.5)
 * ============================================================================
 * Wraps Leaflet.js and provides a clean API for the main app.
 * Handles: initialization, markers, polylines (trip routes), alerts,
 * geolocation, and vehicle rendering.
 * ============================================================================
 */

const CONFIG = window.STEERADAR || {};

let map = null;
let savedMarker = null;
let alertMarkers = [];
let tripPolyline = null;
let vehicleMarkers = [];
let userLocationMarker = null;

export const mapModule = {
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

        // Default to Hyderabad if config missing
        const lat = CONFIG.DEFAULT_CENTER?.lat || 17.3850;
        const lng = CONFIG.DEFAULT_CENTER?.lng || 78.4867;
        const zoom = CONFIG.DEFAULT_ZOOM || 13;

        map = L.map(containerId, {
            zoomControl: false,
            attributionControl: false
        }).setView([lat, lng], zoom);

        // Dark theme tiles (CartoDB Dark Matter)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap &copy; CARTO',
            maxZoom: 19,
            subdomains: 'abcd'
        }).addTo(map);

        // Zoom control at bottom-right
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // Map click handler
        map.on('click', (e) => {
            if (typeof onMapClick === 'function') {
                onMapClick(e.latlng.lat, e.latlng.lng);
            }
        });

        // Fix sizing issues on mobile
        setTimeout(() => map.invalidateSize(), 100);

        console.log('[map] Initialized at', lat, lng);
        return map;
    },

    /**
     * Get the raw Leaflet map instance (advanced use).
     */
    getMap: () => map,

    // ========================================================================
    // MARKERS
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

        savedMarker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'custom-saved-marker',
                html: `<div style="
                    width:36px; height:36px; 
                    background: linear-gradient(135deg, #00d4a0, #00b88a);
                    border: 3px solid #0a0a0a;
                    border-radius: 50% 50% 50% 0;
                    transform: rotate(-45deg);
                    box-shadow: 0 4px 12px rgba(0,212,160,0.5);
                    display: flex; align-items: center; justify-content: center;
                "><i class="fas fa-map-marker-alt" style="
                    color:#000; font-size:14px; transform: rotate(45deg);
                "></i></div>`,
                iconSize: [36, 36],
                iconAnchor: [18, 36]
            })
        }).addTo(map);

        if (popupHTML) savedMarker.bindPopup(popupHTML).openPopup();
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
                background-color:#1a1a1a; 
                border:2px solid #ffc107; 
                border-radius:50%; 
                width:38px; height:38px; 
                display:flex; align-items:center; justify-content:center; 
                font-size:18px; 
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
        alertMarkers.forEach(m => map.removeLayer(m));
        alertMarkers = [];
    },

    // ========================================================================
    // TRIP POLYLINES
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
        }

        tripPolyline = L.polyline(coords, {
            color: color,
            weight: 5,
            opacity: 0.85,
            smoothFactor: 1,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(map);

        // Add subtle glow under it
        L.polyline(coords, {
            color: color,
            weight: 12,
            opacity: 0.15,
            smoothFactor: 1
        }).addTo(map);

        return tripPolyline;
    },

    /**
     * Update an existing trip polyline with new points.
     */
    updatePolyline: (coords) => {
        if (!tripPolyline || !coords) return;
        tripPolyline.setLatLngs(coords);
    },

    /**
     * Clear all trip polylines.
     */
    clearPolylines: () => {
        if (!map) return;
        map.eachLayer(layer => {
            if (layer instanceof L.Polyline) {
                map.removeLayer(layer);
            }
        });
        tripPolyline = null;
    },

    // ========================================================================
    // VEHICLES (Live Presence)
    // ========================================================================

    /**
     * Render live vehicle markers from presence data.
     * @param {Array} vehicles - Array of presence objects from api.activeVehicles()
     */
    renderVehicles: (vehicles = []) => {
        if (!map) return;

        // Clear old vehicle markers
        vehicleMarkers.forEach(m => map.removeLayer(m));
        vehicleMarkers = [];

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
                    onerror="this.style.display='none'"></div>`,
                iconSize: [42, 42],
                iconAnchor: [21, 21]
            });

            const marker = L.marker([v.lat, v.lng], { icon }).addTo(map);
            marker.bindPopup(`
                <div style="font-family:sans-serif; padding:4px; min-width:140px;">
                    <strong>${v.ownerName || 'Driver'}</strong><br>
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
        vehicleMarkers.forEach(m => map.removeLayer(m));
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
            if (!map) return reject('Map not initialized');
            if (!navigator.geolocation) return reject('Geolocation not supported');

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const { latitude, longitude } = pos.coords;

                    // Center map on user
                    map.setView([latitude, longitude], 15);

                    // Update / add user location marker
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
     * Invalidate the map size (fixes rendering glitches when tab switches).
     */
    refreshSize: () => {
        if (map) setTimeout(() => map.invalidateSize(), 100);
    }
};