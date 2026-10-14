// ==========================================
// STEERRADAR NEW FEATURES LOGIC
// ==========================================

// --- STATE MANAGEMENT ---
let currentSelectedAgent = null;
let currentOfferAmount = 0;

// ==========================================
// 1. MAP INTERACTION & BOTTOM SHEET
// ==========================================

/**
 * Call this function from your map-ui.js when a user clicks a map pin.
 * Example usage in map-ui.js: 
 * marker.on('click', () => showLaneDetails(agentData));
 */
window.showLaneDetails = function(agent) {
    currentSelectedAgent = agent;
    
    // Format the fare breakdown dynamically
    const baseFare = agent.baseFare || 10;
    const distance = agent.distance || 5;
    const perKm = agent.perKm || 2;
    const totalFare = agent.totalFare || (baseFare + (distance * perKm));
    const occupancy = agent.occupancy || 78;
    const startTime = agent.startTime || '10:45 AM';
    const route = agent.route || 'Koramangala to Indiranagar';
    const avatar = agent.avatar || 'https://i.pravatar.cc/150?img=12';
    const name = agent.name || 'Agent B';

    const content = `
        <div class="flex justify-between align-center mb-3">
            <div class="flex align-center gap-2">
                <img src="${avatar}" alt="${name}" class="user-avatar" style="width: 40px; height: 40px;">
                <div>
                    <h3 style="font-weight: 700; font-size: 16px;">${name}</h3>
                    <div class="text-sub text-xs">⭐ ${agent.rating || '4.8'}</div>
                </div>
            </div>
            <button onclick="closeBottomSheet()" class="icon-btn"><i class="fas fa-times"></i></button>
        </div>

        <div class="post-card mb-3" style="background: #f8fafc; padding: 12px; border-radius: 12px; border: 1px solid #e2e8f0;">
            <p style="font-weight: 600; margin-bottom: 8px; color: var(--text-main);">${route}</p>
            <div class="flex justify-between text-sm text-sub">
                <span><i class="fas fa-clock" style="color: var(--primary);"></i> Starts: ${startTime}</span>
                <span><i class="fas fa-users" style="color: #f59e0b;"></i> ${occupancy}% Full</span>
            </div>
        </div>

        <div class="mb-4">
            <h4 class="text-sub text-xs font-bold mb-2" style="letter-spacing: 0.5px;">FARE BREAKDOWN</h4>
            <div class="flex justify-between text-sm mb-1 text-sub">
                <span>Base Fare</span>
                <span>₹${baseFare}</span>
            </div>
            <div class="flex justify-between text-sm mb-2 text-sub">
                <span>Distance (${distance} km @ ₹${perKm}/km)</span>
                <span>₹${distance * perKm}</span>
            </div>
            <div class="flex justify-between font-bold pt-2" style="border-top: 1px solid #e2e8f0; color: var(--text-main);">
                <span>Total Fare</span>
                <span style="color: var(--primary); font-size: 18px;">₹${totalFare}</span>
            </div>
        </div>

        <div class="flex gap-2">
            <button onclick="openNegotiation(${totalFare})" class="btn btn-secondary flex-1" style="padding: 12px;">Negotiate Fare</button>
            <button onclick="openChat('${name}', '${avatar}')" class="btn btn-primary flex-1" style="padding: 12px;">Book Seat</button>
        </div>
    `;
    
    document.getElementById('bottom-sheet-content').innerHTML = content;
    
    // Show Bottom Sheet
    const sheet = document.getElementById('map-bottom-sheet');
    sheet.classList.remove('hidden');
    
    // Add slide-up animation class if you have it in CSS
    const sheetInner = sheet.querySelector('.bottom-sheet');
    if (sheetInner) sheetInner.classList.add('slide-up');
}

window.closeBottomSheet = function(event) {
    // Prevent closing if user clicked inside the sheet content
    if (event && event.target !== event.currentTarget && !event.target.closest('.bottom-sheet-handle')) return;
    
    const sheet = document.getElementById('map-bottom-sheet');
    const sheetInner = sheet.querySelector('.bottom-sheet');
    
    if (sheetInner) sheetInner.classList.remove('slide-up');
    sheet.classList.add('hidden');
}


// ==========================================
// 2. FARE NEGOTIATION LOGIC (- digit +)
// ==========================================

window.openNegotiation = function(standardFare) {
    currentOfferAmount = standardFare - 2; // Default discount offer
    
    document.getElementById('neg-standard-fare').innerText = '₹' + standardFare;
    document.getElementById('neg-offer-display').innerText = '₹' + currentOfferAmount;
    
    // Hide bottom sheet and open modal
    closeBottomSheet();
    
    // Assuming openModal is globally available from your app.js
    if (typeof window.openModal === 'function') {
        window.openModal('negotiation-modal');
    } else {
        document.getElementById('negotiation-modal').classList.remove('hidden');
    }
}

window.updateOffer = function(amount) {
    currentOfferAmount += amount;
    if (currentOfferAmount < 5) currentOfferAmount = 5; // Minimum fare limit
    document.getElementById('neg-offer-display').innerText = '₹' + currentOfferAmount;
}

window.sendOffer = function() {
    if (!currentSelectedAgent) return;
    
    // Simulate sending the offer (Replace with actual API call)
    alert(`Offer of ₹${currentOfferAmount} sent to ${currentSelectedAgent.name || 'Agent'}!`);
    
    // Close modal
    if (typeof window.closeModal === 'function') {
        window.closeModal('negotiation-modal');
    } else {
        document.getElementById('negotiation-modal').classList.add('hidden');
    }
}


// ==========================================
// 3. CHAT UI WITH AVATARS
// ==========================================

window.openChat = function(agentName, agentAvatar) {
    document.getElementById('chat-room-title').innerText = `Chat with ${agentName}`;
    document.getElementById('chat-header-avatar').src = agentAvatar || 'https://i.pravatar.cc/150?img=12';
    
    // Clear previous messages and add initial mock messages with avatars
    const container = document.getElementById('chat-messages-container');
    container.innerHTML = `
        <div class="chat-message agent">
            <img src="${agentAvatar}" class="chat-avatar" alt="Agent" onerror="this.src='https://i.pravatar.cc/150?img=12'">
            <div>
                <div class="chat-bubble">Hello! I have accepted your offer. Please be at the pickup point by 10:40 AM.</div>
                <div class="text-sub text-xs mt-1">10:32 AM</div>
            </div>
        </div>
        <div class="chat-message user">
            <img src="https://i.pravatar.cc/150?img=11" class="chat-avatar" alt="You">
            <div>
                <div class="chat-bubble">Great, I will be there. Is there space for a small bag?</div>
                <div class="text-sub text-xs mt-1">10:33 AM</div>
            </div>
        </div>
        <div class="chat-message agent">
            <img src="${agentAvatar}" class="chat-avatar" alt="Agent" onerror="this.src='https://i.pravatar.cc/150?img=12'">
            <div>
                <div class="chat-bubble">Yes, there is space in the back. See you soon.</div>
                <div class="text-sub text-xs mt-1">10:34 AM</div>
            </div>
        </div>
    `;
    
    // Show chat overlay
    document.getElementById('hive-chat-view').classList.remove('hidden');
    
    // Hide bottom sheet if open
    closeBottomSheet();
}

window.openChatFromAgentProfile = function() {
    if (currentSelectedAgent) {
        openChat(currentSelectedAgent.name, currentSelectedAgent.avatar);
    }
}

// Extend the existing sendMessage function to include avatars
// (Note: If you already have a sendMessage in app.js, you should merge this logic there)
window.sendMessage = function() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    const container = document.getElementById('chat-messages-container');
    
    // Create user message with avatar
    const msgHTML = `
        <div class="chat-message user">
            <img src="https://i.pravatar.cc/150?img=11" class="chat-avatar" alt="You">
            <div>
                <div class="chat-bubble">${text}</div>
                <div class="text-sub text-xs mt-1">Just now</div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', msgHTML);
    input.value = '';
    
    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;

    // Simulate Agent Reply (Optional)
    setTimeout(() => {
        const replyHTML = `
            <div class="chat-message agent">
                <img src="${currentSelectedAgent?.avatar || 'https://i.pravatar.cc/150?img=12'}" class="chat-avatar" alt="Agent">
                <div>
                    <div class="chat-bubble">Got it!</div>
                    <div class="text-sub text-xs mt-1">Just now</div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', replyHTML);
        container.scrollTop = container.scrollHeight;
    }, 1500);
}


// ==========================================
// 4. AGENT PROFILE MODAL
// ==========================================

window.viewAgentProfile = function(agent) {
    currentSelectedAgent = agent;
    
    document.getElementById('agent-profile-avatar').src = agent.avatar || 'https://i.pravatar.cc/150?img=12';
    document.getElementById('agent-profile-name').innerText = agent.name || 'Agent B';
    document.getElementById('agent-profile-rating').innerText = `⭐ ${agent.rating || '4.8'} (120 Rides)`;
    document.getElementById('agent-vehicle-model').innerText = agent.vehicleModel || 'Maruti Suzuki Ertiga';
    document.getElementById('agent-vehicle-color').innerText = agent.vehicleColor || 'White';
    document.getElementById('agent-vehicle-plate').innerText = agent.licensePlate || 'KA-01-AB-1234';
    
    // Populate Application Images Gallery (Mock Data)
    const gallery = document.getElementById('agent-images-gallery');
    const images = [
        { label: 'Front View', color: '#bfdbfe', icon: 'fa-car-side' },
        { label: 'Back View', color: '#bbf7d0', icon: 'fa-car' },
        { label: 'Interior', color: '#fef08a', icon: 'fa-chair' },
        { label: 'License', color: '#e9d5ff', icon: 'fa-id-card' }
    ];
    
    gallery.innerHTML = images.map(img => `
        <div style="min-width: 110px; height: 85px; background: ${img.color}; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; border: 1px solid rgba(0,0,0,0.05);">
            <i class="fas ${img.icon}" style="color: #475569; font-size: 18px; margin-bottom: 4px;"></i>
            <span style="font-size: 10px; font-weight: 600; color: #333;">${img.label}</span>
        </div>
    `).join('');
    
    if (typeof window.openModal === 'function') {
        window.openModal('agent-profile-modal');
    } else {
        document.getElementById('agent-profile-modal').classList.remove('hidden');
    }
}