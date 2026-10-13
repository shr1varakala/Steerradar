// config.js - Steeradar shared configuration
window.STEERADAR = {
  // Backend URL only - no secret. v6.1 uses per-user tokens.
  SHEET_API_URL: 'https://script.google.com/macros/s/AKfycbzh5O7qjA4aWOgMwgHLJ2BlY8GM6a23LPw56VcTE1cJPCkecomoc61j68OR7VI3BJQ7/exec',

  CLOUD_SYNC_DEFAULT: true,
  APP_NAME: 'Steeradar',
  APP_VERSION: 'v7.0',
  LOGO_URL: './steeradar-logo.png', // Fixed typo

  // Updated to Hyderabad
  MAP_STYLE_BRIGHT: 'https://tiles.openfreemap.org/styles/bright',
  MAP_STYLE_DARK:   'https://tiles.openfreemap.org/styles/dark',
  DEFAULT_CENTER:   { lat: 17.3850, lng: 78.4867 }, // Hyderabad Coordinates
  DEFAULT_ZOOM:     13,

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