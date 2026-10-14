// ============================================================
// STEERRADAR MAP UI MODULE (v2.0)
// Handles: Leaflet init, custom pins, search, filters, location
// Connects to: features.js (showLaneDetails, negotiation)
// ============================================================

import { logger } from './app.js'; // If you have logger in app.js

// ========== 1. GLOBAL STATE ==========
let map = null;
let markersLayer = null;
let routeLayer = null;
let userLocationMarker = null;
let currentFilter = 'live';
let isTripActive = false;
let isGhostMode = false;
let searchTimeout = null;

// Mock agent data - replace with real data from your backend
const MOCK_AGENTS = [
    {
        id: 'agent-1',
        name: 'Agent A',
        avatar: 'https://i.pravatar.cc/150?img=5',
        rating: 4.8,
        route: 'Koramangala to Jayanagar',
        startTime: '10:30 AM',
        occupancy: 41,
        baseFare: 10,
        distance: 5,
        perKm: 1,
        totalFare: 15,
        vehicleModel: 'Honda Activa',
        vehicleColor: 'Grey',
        licensePlate: 'KA-05-XY-9876',
        lat: 12.9352,
        lng: 77.6245,
        isLive: true,
        hasSeats: true
    },
    {
        id: 'agent-2',
        name: 'Agent B',
        avatar: 'https://i.pravatar.cc/150?img=12',
        rating: 4.9,
        route: 'Koramangala to Indiranagar via 12th Main',
        startTime: '10:45 AM',
        occupancy: 78,
        baseFare: 10,
        distance: 5,
        perKm: 2,
        totalFare: 20,
        vehicleModel: 'Maruti Suzuki Ertiga',
        vehicleColor: 'White',
        licensePlate: 'KA-01-AB-1234',
        lat: 12.9784,
        lng: 77.6408,
        isLive: true,
        hasSeats: true
    },
    {
        id: 'agent-3',
        name: 'Agent C',
        avatar: 'https://i.pravatar.cc/150?img=8',
        rating: 4.7,
        route: 'Koramangala to Whitefield',
        startTime: '11:00 AM',
        occupancy: 90,
        baseFare: 15,
        distance: 10,
        perKm: 1,
        totalFare: 25,
        vehicleModel: 'Toyota Innova',
        vehicleColor: 'Silver',
        licensePlate: 'KA-03-CD-5678',
        lat: 12.9698,
        lng: 77.7500,
        isLive: true,
        hasSeats: false
    }
];

// ========== 2. INITIALIZE MAP ==========
function initMap() {
    const mapEl = document.getElementById('map');
    if (!mapEl) {
        console.warn('[map-ui] #map not found, skipping init.');
        return;
    }

    // Initialize Leaflet
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        center: [12.9716, 77.5946], // Bangalore
        zoom: 13,
        preferCanvas: true
    });

    // Tile layer (OpenStreetMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        minZoom: 10
    }).addTo(map);

    // Layer groups
    markersLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);

    // Render the agents
    renderAgents(MOCK_AGENTS);

    // Bind search input
    bindSearchInput();

    // Detect movement to hide search results
    map.on('dragstart', () => {
        const results = document.getElementById('map-search-results');
        if (results) results.classList.add('hidden');
    });

    if (logger) logger.info('[map-ui] Map initialized');
}

// ========== 3. RENDER AGENT MARKERS (Custom Pulsing Pins) ==========
function renderAgents(agents) {
    if (!markersLayer) return;
    markersLayer.clearLayers();

    agents.forEach(agent => {
        // Filter logic
        if (currentFilter === 'live' && !agent.isLive) return;
        if (currentFilter === 'seats' && !agent.hasSeats) return;
        if (currentFilter === 'mine') return; // TODO: filter by current user

        const marker = createAgentMarker(agent);
        markersLayer.addLayer(marker);
    });
}

function createAgentMarker(agent) {
    // Custom HTML for the pulsing pin
    const iconHtml = `
        <div class="custom-map-pin" data-agent-id="${agent.id}">
            <div class="pin-pulse"></div>
            <div class="pin-icon">🚗</div>
            <div class="pin-label">
                <i class="fas fa-clock" style="color: var(--primary);"></i>
                ${agent.startTime}
            </div>
        </div>
    `;

    const customIcon = L.divIcon({
        html: iconHtml,
        className: 'custom-div-icon',
        iconSize: [60, 70],
        iconAnchor: [30, 60]
    });

    const marker = L.marker([agent.lat, agent.lng], {
        icon: customIcon,
        riseOnHover: true
    });

    // ⭐ KEY: Click handler triggers the bottom sheet via features.js
    marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        
        if (typeof window.showLaneDetails === 'function') {
            window.showLaneDetails(agent);
        } else {
            console.warn('[map-ui] showLaneDetails not found. Is features.js loaded?');
        }
    });

    // Optional: hover effect
    marker.on('mouseover', function() {
        this.getElement()?.querySelector('.custom-map-pin')?.style.setProperty('transform', 'scale(1.1)');
    });
    marker.on('mouseout', function() {
        this.getElement()?.querySelector('.custom-map-pin')?.style.setProperty('transform', 'scale(1)');
    });

    return marker;
}

// ========== 4. SEARCH FUNCTIONALITY ==========
function bindSearchInput() {
    const input = document.getElementById('map-search-input');
    const clearBtn = document.getElementById('map-search-clear');
    const resultsBox = document.getElementById('map-search-results');

    if (!input || !resultsBox) return;

    input.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        
        if (clearBtn) {
            clearBtn.classList.toggle('hidden', !query);
        }

        if (query.length < 2) {
            resultsBox.classList.add('hidden');
            return;
        }

        // Debounce search
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => performSearch(query), 350);
    });

    input.addEventListener('focus', () => {
        if (input.value.trim().length >= 2) {
            resultsBox.classList.remove('hidden');
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.map-search-bar') && !e.target.closest('.map-search-results')) {
            resultsBox.classList.add('hidden');
        }
    });
}

async function performSearch(query) {
    const resultsBox = document.getElementById('map-search-results');
    if (!resultsBox) return;

    resultsBox.classList.remove('hidden');
    resultsBox.innerHTML = `<div class="search-loading"><div class="spinner"></div> Searching...</div>`;

    try {
        // Using Nominatim (OpenStreetMap) - free geocoding
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=in`;
        const res = await fetch(url, {
            headers: { 'Accept-Language': 'en' }
        });
        const data = await res.json();

        if (!data || data.length === 0) {
            resultsBox.innerHTML = `<div class="search-empty"><i class="fas fa-search"></i> No results found</div>`;
            return;
        }

        resultsBox.innerHTML = data.map(place => `
            <div class="search-result" data-lat="${place.lat}" data-lng="${place.lon}" data-name="${place.display_name}">
                <i class="fas fa-map-marker-alt"></i>
                <div class="search-result-info">
                    <div class="search-result-title">${place.name || place.display_name.split(',')[0]}</div>
                    <div class="search-result-sub">${place.display_name}</div>
                </div>
            </div>
        `).join('');

        // Bind click handlers
        resultsBox.querySelectorAll('.search-result').forEach(el => {
            el.addEventListener('click', () => {
                const lat = parseFloat(el.dataset.lat);
                const lng = parseFloat(el.dataset.lng);
                map.flyTo([lat, lng], 15, { duration: 1.2 });
                resultsBox.classList.add('hidden');
            });
        });

    } catch (err) {
        console.error('[search] error:', err);
        resultsBox.innerHTML = `<div class="search-empty"><i class="fas fa-exclamation-triangle"></i> Search failed</div>`;
    }
}

// ========== 5. MAP MODULE (Exposed to HTML) ==========
const mapModule = {
    recenter() {
        if (!map) return;
        map.flyTo([12.9716, 77.5946], 13, { duration: 0.8 });
    },

    locateUser(showToast = false) {
        if (!map) return;
        
        if (!navigator.geolocation) {
            if (showToast) alert('Geolocation not supported');
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                
                if (userLocationMarker) {
                    userLocationMarker.setLatLng([latitude, longitude]);
                } else {
                    userLocationMarker = L.circleMarker([latitude, longitude], {
                        radius: 8,
                        fillColor: '#4F46E5',
                        color: '#fff',
                        weight: 3,
                        fillOpacity: 1
                    }).addTo(map);
                }

                map.flyTo([latitude, longitude], 15, { duration: 1 });
            },
            (err) => {
                console.error('[geolocation] error:', err);
                if (showToast) alert('Could not get your location');
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    },

    zoomIn() { if (map) map.zoomIn(); },
    zoomOut() { if (map) map.zoomOut(); },

    clearSearch() {
        const input = document.getElementById('map-search-input');
        const clearBtn = document.getElementById('map-search-clear');
        const resultsBox = document.getElementById('map-search-results');
        
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        if (resultsBox) resultsBox.classList.add('hidden');
    },

    cancelRoute() {
        if (routeLayer) routeLayer.clearLayers();
        isTripActive = false;
        
        const banner = document.getElementById('map-trip-banner');
        if (banner) banner.classList.add('hidden');
        
        const tripBtn = document.getElementById('ctrl-trip');
        if (tripBtn) {
            tripBtn.classList.remove('active');
            tripBtn.querySelector('i').className = 'fas fa-play';
        }
    }
};

// Expose globally
window.mapModule = mapModule;

// ========== 6. FILTER CHIPS ==========
window.setMapFilter = function(filter, btn) {
    currentFilter = filter;
    
    // Update active chip styling
    document.querySelectorAll('.map-chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');

    // Re-render
    renderAgents(MOCK_AGENTS);
};

// ========== 7. GHOST MODE TOGGLE (SteerAgent only) ==========
window.toggleGhostMode = function() {
    isGhostMode = !isGhostMode;
    const btn = document.getElementById('ctrl-ghost');
    
    if (btn) {
        btn.classList.toggle('active', isGhostMode);
        btn.style.background = isGhostMode ? 'var(--warning)' : '';
    }
    
    if (window.showToast) {
        window.showToast(isGhostMode ? 'Ghost mode ON' : 'Ghost mode OFF', 'info');
    }
};

// ========== 8. TRIP TOGGLE (SteerAgent only) ==========
window.toggleTrip = function() {
    isTripActive = !isTripActive;
    const btn = document.getElementById('ctrl-trip');
    const banner = document.getElementById('map-trip-banner');

    if (btn) {
        btn.classList.toggle('active', isTripActive);
        const icon = btn.querySelector('i');
        if (icon) icon.className = isTripActive ? 'fas fa-stop' : 'fas fa-play';
    }

    if (banner) {
        banner.classList.toggle('hidden', !isTripActive);
    }

    if (window.showToast) {
        window.showToast(isTripActive ? 'Trip started' : 'Trip ended', 'success');
    }
};

// ========== 9. REPORT ALERT (used from report modal) ==========
window.reportAlert = function(type) {
    const icons = {
        traffic: '🚧',
        pothole: '🕳️',
        police: '🚓',
        accident: '⚠️'
    };

    const center = map ? map.getCenter() : { lat: 12.9716, lng: 77.5946 };
    
    const alertMarker = L.marker([center.lat, center.lng], {
        icon: L.divIcon({
            html: `<div style="font-size: 24px;">${icons[type] || '⚠️'}</div>`,
            className: 'custom-alert-icon',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        })
    }).addTo(map);

    // Auto-remove after 5 minutes
    setTimeout(() => alertMarker.remove(), 5 * 60 * 1000);

    // Close modal
    if (typeof window.closeModal === 'function') {
        window.closeModal('report-modal');
    }

    if (window.showToast) {
        window.showToast(`Reported: ${type}`, 'success');
    }
};

// ========== 10. AUTO-INIT ==========
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMap);
} else {
    // Small delay to ensure DOM is fully ready
    setTimeout(initMap, 100);
}

// Export for module use
export { map, mapModule, renderAgents };