/**
 * ============================================================================
 * js/map-ui.js — Map UI Enhancements (v2.0)
 * ============================================================================
 * - Bottom sheet that slides up when a map marker is tapped
 * - Convenience builders for pin / vehicle / lane bottom sheets
 * - Hooks into map.js marker taps
 *
 * Depends on globals from app.js (state, mapModule, openModal, etc.)
 * ============================================================================
 */

// ============================================================================
// BOTTOM SHEET — Core
// ============================================================================
window.openBottomSheet = function (data) {
    const overlay = document.getElementById('map-bottom-sheet');
    const content = document.getElementById('bottom-sheet-content');
    if (!overlay || !content) {
        console.warn('[map-ui] Bottom sheet container missing');
        return;
    }

    // ---------- Media ----------
    let mediaHTML = '';
    if (data.image) {
        mediaHTML = `<img class="bs-img" src="${escapeHtml(data.image)}" alt=""
            onerror="this.onerror=null; this.style.display='none';">`;
    }

    // ---------- Tags ----------
    let tagsHTML = '';
    if (data.tags && data.tags.length) {
        tagsHTML = '<div class="bs-tag-row">' +
            data.tags
                .filter(t => t !== undefined && t !== null && String(t).trim() !== '')
                .map(t => `<span class="tag tag-fare">${escapeHtml(String(t))}</span>`)
                .join('') +
            '</div>';
    }

    // ---------- Info rows ----------
    let infoRows = '';
    if (data.info && data.info.length) {
        infoRows = data.info
            .filter(row => row && row.label !== undefined && row.value !== undefined && String(row.value).trim() !== '')
            .map(row => `
                <div class="bs-info-row">
                    <span class="bs-info-label">${escapeHtml(row.label)}</span>
                    <span class="bs-info-value">${escapeHtml(String(row.value))}</span>
                </div>
            `).join('');
    }

    // ---------- Actions ----------
    let actionsHTML = '';
    if (data.actions && data.actions.length) {
        actionsHTML = '<div class="bs-actions">' +
            data.actions.map(a => `
                <button class="btn ${a.style || 'btn-secondary'}" onclick="${a.onclick}">
                    <i class="fas ${a.icon}"></i> ${escapeHtml(a.label)}
                </button>
            `).join('') +
            '</div>';
    }

    // ---------- Compose ----------
    content.innerHTML = `
        <div class="bs-header">
            <div>
                <div class="bs-title">${escapeHtml(data.title || 'Details')}</div>
                ${data.subtitle ? `<div class="bs-sub">${escapeHtml(data.subtitle)}</div>` : ''}
            </div>
            <button class="bs-close" onclick="closeBottomSheet()">&times;</button>
        </div>
        ${mediaHTML}
        ${tagsHTML}
        ${infoRows}
        ${actionsHTML}
    `;

    overlay.classList.remove('hidden');

    // Haptic feedback (if supported)
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) {} }
};

// ============================================================================
// BOTTOM SHEET — Close
// ============================================================================
window.closeBottomSheet = function (event) {
    // If clicked inside the .bottom-sheet content, don't close
    if (event && event.target && event.target.closest && event.target.closest('.bottom-sheet')) {
        return;
    }
    const overlay = document.getElementById('map-bottom-sheet');
    if (overlay) overlay.classList.add('hidden');
};

// ============================================================================
// CONVENIENCE BUILDER — Dropped Pin
// ============================================================================
window.showPinBottomSheet = function (lat, lng, distanceInfo) {
    const coords = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const info = [{ label: 'Coordinates', value: coords }];

    if (distanceInfo && distanceInfo.length) {
        info.push(...distanceInfo);
    }

    window.openBottomSheet({
        title: '📍 Dropped Pin',
        subtitle: 'Choose an action',
        info: info,
        actions: [
            {
                label: 'Save',
                icon: 'fa-bookmark',
                style: 'btn-primary',
                onclick: `openModal('location-modal')`
            },
            {
                label: 'Navigate',
                icon: 'fa-directions',
                style: 'btn-secondary',
                onclick: `navigateToPoint(${lat},${lng})`
            },
            {
                label: 'Clear',
                icon: 'fa-times',
                style: 'btn-secondary',
                onclick: `closeBottomSheet(); if(window.mapModule){ mapModule.clearSavedMarker(); if(mapModule.clearRoadRoute) mapModule.clearRoadRoute(); }`
            }
        ]
    });
};

// ============================================================================
// CONVENIENCE BUILDER — Live Vehicle / SteerAgent
// ============================================================================
window.showVehicleBottomSheet = function (vehicle, myLocation) {
    const name = vehicle.ownerName || vehicle.name || 'Driver';
    const phone = vehicle.phone || vehicle.owner || '';
    const info = [];

    if (vehicle.vehicle) info.push({ label: 'Vehicle', value: vehicle.vehicle });
    if (vehicle.vehicleType) info.push({ label: 'Type', value: vehicle.vehicleType });

    // Distance from me
    if (myLocation && vehicle.lat && vehicle.lng && window.mapModule) {
        try {
            const km = mapModule.calculateDistance(
                myLocation.lat, myLocation.lng, vehicle.lat, vehicle.lng
            );
            info.push({ label: 'Distance', value: mapModule.formatDistance(km) });
        } catch (e) {}
    }

    // Last seen
    if (vehicle.lastSeen || vehicle.updatedAt) {
        const ts = vehicle.lastSeen || vehicle.updatedAt;
        info.push({ label: 'Updated', value: timeAgo(ts) });
    }

    const safeName = name.replace(/'/g, "\\'");

    window.openBottomSheet({
        title: name,
        subtitle: vehicle.vehicle || 'SteerAgent on the road',
        image: vehicle.photo || vehicle.avatar || '',
        tags: ['SteerAgent'],
        info: info,
        actions: [
            {
                label: 'Message',
                icon: 'fa-comment',
                style: 'btn-primary',
                onclick: `mapModule.messageAgent('${phone}', '${safeName}'); closeBottomSheet();`
            },
            {
                label: 'Where to?',
                icon: 'fa-question-circle',
                style: 'btn-secondary',
                onclick: `mapModule.askWhereTo('${phone}'); closeBottomSheet();`
            }
        ]
    });
};

// ============================================================================
// CONVENIENCE BUILDER — Lane
// ============================================================================
window.showLaneBottomSheet = function (lane) {
    const info = [];

    if (lane.description) info.push({ label: 'Route', value: lane.description });
    if (lane.seats != null) info.push({ label: 'Seats left', value: String(lane.seats) });
    if (lane.fare != null && Number(lane.fare) > 0) info.push({ label: 'Fare', value: '₹ ' + lane.fare });
    if (lane.vehicleType) info.push({ label: 'Vehicle', value: lane.vehicleType });

    // Distance
    if (window.state && state.userLocation && lane.lat && lane.lng && window.mapModule) {
        try {
            const km = mapModule.calculateDistance(
                state.userLocation.lat, state.userLocation.lng, lane.lat, lane.lng
            );
            info.push({ label: 'Distance', value: mapModule.formatDistance(km) });
        } catch (e) {}
    }

    const safeOwner = (lane.ownerName || 'Driver').replace(/'/g, "\\'");

    window.openBottomSheet({
        title: lane.title || 'Lane',
        subtitle: lane.ownerName || 'Driver',
        image: lane.photo || '',
        tags: [
            lane.vehicleType || 'Any',
            (lane.seats || 0) + ' seats'
        ],
        info: info,
        actions: [
            {
                label: 'Chat',
                icon: 'fa-comment',
                style: 'btn-secondary',
                onclick: `openChat('${lane.id}', '${safeOwner}'); closeBottomSheet();`
            },
            {
                label: 'Navigate',
                icon: 'fa-directions',
                style: 'btn-primary',
                onclick: `navigateToLane('${lane.id}'); closeBottomSheet();`
            }
        ]
    });
};

// ============================================================================
// CONVENIENCE BUILDER — Trip Summary
// ============================================================================
window.showTripBottomSheet = function (trip) {
    const info = [];
    if (trip.distanceKm) info.push({ label: 'Distance', value: trip.distanceKm + ' km' });
    if (trip.fare) info.push({ label: 'Fare', value: '₹ ' + trip.fare });
    if (trip.startedAt) info.push({ label: 'Started', value: new Date(trip.startedAt).toLocaleString() });
    if (trip.endedAt) info.push({ label: 'Ended', value: new Date(trip.endedAt).toLocaleString() });

    window.openBottomSheet({
        title: 'Trip ' + (trip.status === 'active' ? 'in progress' : 'completed'),
        subtitle: trip.id || '',
        tags: [trip.status || 'unknown'],
        info: info,
        actions: []
    });
};

// ============================================================================
// HELPERS
// ============================================================================
function escapeHtml(str) {
    if (window.escapeHTML) return window.escapeHTML(str);
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function timeAgo(ts) {
    if (!ts) return '';
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    const secs = Math.floor((Date.now() - d.getTime()) / 1000);
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return Math.floor(secs / 86400) + 'd ago';
}

// ============================================================================
// HOOK — Patch map.js vehicle rendering to make markers tap to bottom-sheet
// ============================================================================
(function patchVehicleTap() {
    // Wait for mapModule to be ready
    let attempts = 0;
    const maxAttempts = 20;

    function tryPatch() {
        if (!window.mapModule || typeof window.mapModule.renderVehicles !== 'function') {
            if (++attempts < maxAttempts) return setTimeout(tryPatch, 250);
            return;
        }

        const original = window.mapModule.renderVehicles.bind(window.mapModule);

        window.mapModule.renderVehicles = function (vehicles, myLocation) {
            // Call original first
            original(vehicles, myLocation);

            // Now attach bottom-sheet tap handlers
            // (The original binds a Leaflet popup; we also want an inline tap)
            try {
                const map = window.mapModule.getMap && window.mapModule.getMap();
                if (!map) return;

                map.eachLayer(function (layer) {
                    if (!layer || !layer.getLatLng) return;
                    const latlng = layer.getLatLng();
                    // Find the matching vehicle data
                    const match = (vehicles || []).find(v =>
                        Math.abs(Number(v.lat) - latlng.lat) < 0.0001 &&
                        Math.abs(Number(v.lng) - latlng.lng) < 0.0001
                    );
                    if (!match) return;

                    // Replace popup with bottom-sheet trigger
                    layer.off('click');
                    layer.on('click', function () {
                        window.showVehicleBottomSheet(match, myLocation);
                    });
                });
            } catch (e) {
                console.warn('[map-ui] vehicle patch error:', e);
            }
        };

        console.log('[map-ui] Patched renderVehicles for tap-to-sheet');
    }

    tryPatch();
})();

// ============================================================================
// READY LOG
// ============================================================================
console.log('[map-ui] v2.0 loaded');