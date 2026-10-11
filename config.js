// config.js — Steeradar shared configuration
//
// SECURITY NOTE (v6.1): there is intentionally NO secret in this file.
// Anything in a browser-delivered file is public. Authentication is done with
// per-user session tokens (see js/api.js and Code.gs).
//
// IMPORTANT: after deploying the new Code.gs, paste YOUR new /exec URL below.
// The old URL (and the old "steeradar-secret-2026" key, which is still in git
// history) belong to the previous insecure backend — retire that deployment.
window.STEERADAR = {
  SHEET_API_URL: 'https://script.google.com/macros/s/AKfycbwq7bhzuAaZIon7-uOyDrr-a7dzM6jwFdsRr8vqUwpE5nUGawFB-asoJW8UXZohrKrX/exec',
  CLOUD_SYNC_DEFAULT: true,

  APP_NAME: 'Steeradar',
  APP_VERSION: 'v6.1',
  LOGO_URL: 'https://raw.githubusercontent.com/suryasticsai/Steeradar/main/steerardar-logo.png',

  MAP_STYLE_BRIGHT: 'https://tiles.openfreemap.org/styles/bright',
  MAP_STYLE_DARK:   'https://tiles.openfreemap.org/styles/dark',
  DEFAULT_CENTER:   { lat: 12.9716, lng: 77.5946 },
  DEFAULT_ZOOM:     12,

  CLOUD_POLL_INTERVAL_MS: 15000,
  PRESENCE_INTERVAL_MS:   20000,
  TOAST_DURATION_MS:      2400,
  LOCAL_ROOM_SLOTS:       20,
  GEOHASH_PRECISION:      6,

  VEHICLE_TYPES: [
    { id: 'bus',   label: 'Bus',   emoji: '🚌', seats: 40, color: '#0D9488' },
    { id: 'car',   label: 'Car',   emoji: '🚗', seats: 4,  color: '#4F46E5' },
    { id: 'auto',  label: 'Auto',  emoji: '🛺', seats: 3,  color: '#D97706' },
    { id: 'bike',  label: 'Bike',  emoji: '🏍️', seats: 1,  color: '#DC2626' },
    { id: 'walk',  label: 'Walk',  emoji: '🚶', seats: 1,  color: '#7C3AED' },
    { id: 'event', label: 'Event', emoji: '🎉', seats: 20, color: '#DB2777' },
  ],
};
