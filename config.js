window.STEERADAR = {
  SHEET_API_URL: 'https://script.google.com/macros/s/AKfycbw5UWlyeTZ8-uJhsaaoIUGr0iPeTfmfJaiKc7_k6m8wTddlG3NlJ7qh9ShBjRCxoggL/exec',

  CLOUD_SYNC_DEFAULT: true,
  APP_NAME: 'Steeradar',
  APP_VERSION: 'v10.0',
  LOGO_URL: 'https://raw.githubusercontent.com/suryasticsai/Steeradar/main/steeradar-logo.png',

  MAP_STYLE_DARK: 'https://tiles.openfreemap.org/styles/dark',
  DEFAULT_CENTER: { lat: 17.3850, lng: 78.4867 },
  DEFAULT_ZOOM: 13,

  TOAST_DURATION_MS: 2400,

  VEHICLE_TYPES: [
    { id: 'bus', label: 'Bus', emoji: '🚌', seats: 40, color: '#0D9488' },
    { id: 'car', label: 'Car', emoji: '🚗', seats: 4, color: '#4F46E5' },
    { id: 'auto', label: 'Auto', emoji: '🛺', seats: 3, color: '#D97706' },
    { id: 'bike', label: 'Bike', emoji: '🏍️', seats: 1, color: '#DC2626' },
    { id: 'walk', label: 'Walk', emoji: '🚶', seats: 1, color: '#7C3AED' },
    { id: 'event', label: 'Event', emoji: '🎉', seats: 20, color: '#DB2777' },
  ],
};