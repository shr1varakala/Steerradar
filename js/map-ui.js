/**
 * js/map-ui.js — Map UI Enhancements (v1.0)
 * - Bottom sheet that slides up when a map marker/lane is tapped
 * - Helper to open/close it from anywhere
 * - No dependencies (uses globals from app.js / map.js)
 */

// ============================================================================
// BOTTOM SHEET
// ============================================================================
window.openBottomSheet = function(data) {
    const overlay = document.getElementById('map-bottom-sheet');
    const content = document.getElementById('bottom-sheet-content');
    if (!overlay || !content) return;

    let mediaHTML = '';
    if (data.image) {
        mediaHTML = `<img class="bs-img" src="${data.image}" alt=""
            onerror="this.onerror=null; this.style.display='none';">`;
    }

    let tagsHTML = '';
    if (data.tags && data.tags.length) {
        tagsHTML = '<div class="bs-tag-row">' +
            data.tags.map(t => `<span class="tag tag-fare">${escapeHtml(t)}</span>`).join('') +
            '</div>';
    }

    let infoRows = '';
    if (data.info && data.info.length) {
        infoRows = data.info.map(row => `
            <div class="bs-info-row">
                <span class="bs-info-label">${escapeHtml(row.label)}</span>
                <span class="bs-info-value">${escapeHtml(String(row.value))}</span>
            </div>
        `).join('');
    }

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
};

window.closeBottomSheet = function(event) {
    // If clicked inside .bottom-sheet, don't close
    if (event && event.target && event.target.closest && event.target.closest('.bottom-sheet')) return;
    const overlay = document.getElementById('map-bottom-sheet');
    if (overlay) overlay.classList.add('hidden');
};

// ============================================================================
// CONVENIENCE BUILDERS
// ============================================================================
window.showPinBottomSheet = function(lat, lng, distanceInfo) {
    const coords = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const info = [{ label: 'Coordinates', value: coords }];
    if (distanceInfo) info.push(...distanceInfo);

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
                onclick: `closeBottomSheet(); mapModule.clearSavedMarker(); mapModule.clearRoadRoute && mapModule.clearRoadRoute();`
            }
        ]
    });
};

window.showVehicleBottomSheet = function(v, myLoc) {
    const name = v.ownerName || v.name || 'Driver';
    const phone = v.phone || v.owner || '';
    const info = [];

    if (v.vehicle) info.push({ label: 'Vehicle', value: v.vehicle });
    if (v.vehicleType) info.push({ label: 'Type', value: v.vehicleType });
    if (myLoc && v.lat && v.lng && window.mapModule) {
        const km = mapModule.calculateDistance(myLoc.lat, myLoc.lng, v.lat, v.lng);
        info.push({ label: 'Distance', value: mapModule.formatDistance(km) });
    }

    window.openBottomSheet({
        title: name,
        subtitle: v.vehicle || 'On the road',
        image: v.photo || '',
        tags: ['SteerAgent'],
        info: info,
        actions: [
            {
                label: 'Message',
                icon: 'fa-comment',
                style: 'btn-primary',
                onclick: `mapModule.messageAgent('${phone}', '${name.replace(/'/g, "\\'")}'); closeBottomSheet();`
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

window.showLaneBottomSheet = function(lane) {
    const info = [];
    if (lane.description) info.push({ label: 'Route', value: lane.description });
    if (lane.seats != null) info.push({ label: 'Seats left', value: String(lane.seats) });
    if (lane.fare) info.push({ label: 'Fare', value: '₹ ' + lane.fare });
    if (lane.vehicleType) info.push({ label: 'Vehicle', value: lane.vehicleType });
    if (window.state && state.userLocation && lane.lat && lane.lng && window.mapModule) {
        const km = mapModule.calculateDistance(state.userLocation.lat, state.userLocation.lng, lane.lat, lane.lng);
        info.push({ label: 'Distance', value: mapModule.formatDistance(km) });
    }

    window.openBottomSheet({
        title: lane.title || 'Lane',
        subtitle: lane.ownerName || 'Driver',
        image: lane.photo || '',
        tags: [lane.vehicleType || 'Any', lane.seats + ' seats'],
        info: info,
        actions: [
            {
                label: 'Chat',
                icon: 'fa-comment',
                style: 'btn-secondary',
                onclick: `openChat('${lane.id}', '${(lane.ownerName || 'Driver').replace(/'/g, "\\'")}'); closeBottomSheet();`
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
// HTML ESCAPE (local, in case not available)
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

console.log('[map-ui] Loaded');