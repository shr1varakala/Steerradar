/* ============================================================================
   STEERADAR LOGGER (v2.2)
   ============================================================================
   v2.2 changes:
     • Duplicate suppression — identical consecutive messages collapse
     • Silence patterns — noisy errors (geolocation Timeout expired / denied)
       logged ONCE per session, then suppressed
     • logger.silence(pattern) / logger.unsilence(pattern) — runtime control
     • safeTs() — any malformed timestamp is replaced with Date.now()
   v2.1:
     • logger.init() / logger.render() aliases for app.js backward compat
     • Sanitizes entries restored from localStorage
   ============================================================================ */

const STORAGE_KEY = 'steeradar-log';
const MAX_ENTRIES = 500;
const RENDER_DEBOUNCE_MS = 120;
const DUPLICATE_WINDOW_MS = 5000; // collapse same-message within 5 s

/* --------------------------- STATE --------------------------- */
let entries = [];
let renderTimer = null;
let isBound = false;
let lastEntry = null; // { msg, level, ts, count }

/**
 * Patterns that are logged only ONCE per session even if they recur.
 * Matches against the raw message string.
 */
const SILENCE_PATTERNS = [
  /User denied Geolocation/i,
  /Timeout expired/i,
  /signal is aborted without reason/i,
  /Failed to fetch/i,
  /Request timed out/i
];
const silenced = new Set(); // indices into SILENCE_PATTERNS that already fired

/* --------------------------- SAFE DATE --------------------------- */
function safeTs(v) {
  if (v == null || v === '') return Date.now();
  if (typeof v === 'number' && isFinite(v) && v > 0) return v;
  const n = Number(v);
  if (isFinite(n) && n > 0 && n < 1e15) return n;
  const d = new Date(v);
  const t = d.getTime();
  if (isFinite(t)) return t;
  return Date.now();
}

/* --------------------------- LOAD / SAVE --------------------------- */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const VALID_LEVELS = ['info', 'warn', 'error', 'success'];

    return parsed
      .filter(function (e) { return e && typeof e === 'object'; })
      .map(function (e) {
        return {
          ts: safeTs(e.ts),
          level: VALID_LEVELS.indexOf(e.level) >= 0 ? e.level : 'info',
          msg: String(e.msg == null ? '' : e.msg).slice(0, 4000),
          count: typeof e.count === 'number' && e.count > 1 ? e.count : 1
        };
      })
      .slice(-MAX_ENTRIES);
  } catch (e) {
    return [];
  }
}

function saveToStorage() {
  try {
    const trimmed = entries.slice(-MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) { /* quota / private mode — ignore */ }
}

entries = loadFromStorage();
if (entries.length) lastEntry = entries[entries.length - 1];

/* --------------------------- HELPERS --------------------------- */
function pad2(n) {
  const v = Number(n);
  return (isFinite(v) ? String(Math.floor(v)) : '00').padStart(2, '0');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function normalizeArg(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
  try { return JSON.stringify(v); }
  catch (e) { return String(v); }
}

function logModalIsOpen() {
  const el = document.getElementById('log-modal');
  return !!el && !el.classList.contains('hidden');
}

/**
 * Should this message be suppressed?
 * Returns { silent: true, pattern } if it matches a silence pattern
 * that has already fired this session.
 */
function shouldSilence(msg, level) {
  // Only silence warnings/errors — never user-visible info
  if (level !== 'error' && level !== 'warn') return false;
  for (let i = 0; i < SILENCE_PATTERNS.length; i++) {
    if (SILENCE_PATTERNS[i].test(msg)) {
      if (silenced.has(i)) return true;
      silenced.add(i);
      return false; // log once, then silence
    }
  }
  return false;
}

/* --------------------------- CORE LOG --------------------------- */
function addEntry(level, args) {
  const text = Array.from(args).map(normalizeArg).join(' ');
  const now = Date.now();

  // Silence known-noisy errors after their first occurrence
  if (shouldSilence(text, level)) {
    // Bump a hidden counter so "Clear" still works, but don't render
    return;
  }

  // Duplicate collapse — same message + level within 5 s
  if (
    lastEntry &&
    lastEntry.msg === text &&
    lastEntry.level === level &&
    now - lastEntry.ts < DUPLICATE_WINDOW_MS
  ) {
    lastEntry.ts = now;
    lastEntry.count = (lastEntry.count || 1) + 1;
    // Update the last in-memory entry in place
    if (entries.length) {
      entries[entries.length - 1].ts = now;
      entries[entries.length - 1].count = lastEntry.count;
    }
    saveToStorage();
    scheduleRender();
    return;
  }

  const entry = { ts: now, level: level || 'info', msg: text, count: 1 };
  entries.push(entry);
  lastEntry = entry;

  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }

  try {
    if (level === 'error') console.error.apply(console, args);
    else if (level === 'warn') console.warn.apply(console, args);
    else console.log.apply(console, args);
  } catch (e) {}

  saveToStorage();
  scheduleRender();
}

/* --------------------------- RENDER --------------------------- */
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(function () {
    renderTimer = null;
    if (logModalIsOpen()) renderNow();
  }, RENDER_DEBOUNCE_MS);
}

function renderNow() {
  const box = document.getElementById('logContent');
  if (!box) return;

  if (!entries.length) {
    box.innerHTML = '<div class="log-empty">No logs yet.</div>';
    return;
  }

  const html = entries
    .slice()
    .reverse()
    .map(function (e) {
      const d = new Date(safeTs(e.ts));
      const stamp =
        pad2(d.getHours()) + ':' +
        pad2(d.getMinutes()) + ':' +
        pad2(d.getSeconds());
      const level = e.level || 'info';
      const count = (e.count && e.count > 1)
        ? ' <span style="opacity:0.6; font-weight:700;">×' + e.count + '</span>'
        : '';
      return (
        '<div class="log-line log-' + escapeHtml(level) + '">' +
          '<span class="log-time">' + stamp + '</span>' +
          '<span class="log-msg">' + escapeHtml(e.msg) + count + '</span>' +
        '</div>'
      );
    })
    .join('');

  box.innerHTML = html;
}

/* --------------------------- PUBLIC API --------------------------- */
export const logger = {

  init: function () {
    bindGlobalHandlers();
    if (logModalIsOpen()) renderNow();
    return { ok: true };
  },

  log:     function () { addEntry('info',    arguments); },
  info:    function () { addEntry('info',    arguments); },
  warn:    function () { addEntry('warn',    arguments); },
  error:   function () { addEntry('error',   arguments); },
  success: function () { addEntry('info',    arguments); },

  render:  function () { renderNow(); return { ok: true }; },
  refresh: function () { renderNow(); return { ok: true }; },

  getAll: function () { return entries.slice(); },

  /**
   * Silence a custom pattern at runtime.
   * Pass a RegExp or a string.
   */
  silence: function (pattern) {
    const re = (pattern instanceof RegExp) ? pattern : new RegExp(String(pattern), 'i');
    SILENCE_PATTERNS.push(re);
    // Reset the "already silenced" tracking so the next match registers
    silenced.clear();
    return { ok: true, total: SILENCE_PATTERNS.length };
  },

  /** Forget all user-added silence patterns. */
  unsilenceAll: function () {
    SILENCE_PATTERNS.length = 4; // keep the 4 defaults
    silenced.clear();
    return { ok: true };
  },

  clear: function () {
    entries = [];
    lastEntry = null;
    silenced.clear();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    renderNow();
    return { ok: true };
  },

  export: async function () {
    const text = entries.map(function (e) {
      const d = new Date(safeTs(e.ts));
      const iso = d.toISOString();
      const count = (e.count && e.count > 1) ? ' (×' + e.count + ')' : '';
      return '[' + iso + '] [' + (e.level || 'info').toUpperCase() + '] ' + e.msg + count;
    }).join('\n');

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text || '(no logs)');
        logger.success('Log copied to clipboard');
        return { ok: true };
      }
    } catch (e) {}

    try {
      const ta = document.createElement('textarea');
      ta.value = text || '(no logs)';
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      logger.success('Log copied to clipboard');
      return { ok: true };
    } catch (e) {
      try { window.prompt('Copy logs:', text || '(no logs)'); } catch (e2) {}
      return { ok: false };
    }
  }
};

/* --------------------------- GLOBAL BINDINGS --------------------------- */
function bindGlobalHandlers() {
  if (isBound) return;
  isBound = true;

  window.addEventListener('error', function (evt) {
    const msg = evt && (evt.message || (evt.error && evt.error.message));
    const src = evt && evt.filename ? (' @ ' + evt.filename + ':' + (evt.lineno || 0)) : '';
    if (msg) addEntry('error', ['[uncaught] ' + msg + src]);
  });

  window.addEventListener('unhandledrejection', function (evt) {
    const reason = evt && evt.reason;
    const msg = reason && (reason.message || reason.stack || String(reason));
    if (msg) addEntry('error', ['[unhandled promise] ' + msg]);
  });

  const nativeFetch = window.fetch;
  if (nativeFetch && !nativeFetch.__steerWrapped) {
    const wrapped = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const isApi = url.indexOf('script.google.com') !== -1 || url.indexOf('/macros/') !== -1;

      let action = '';
      try {
        if (init && init.body && typeof init.body === 'string') {
          const parsed = JSON.parse(init.body);
          action = parsed && parsed.action ? String(parsed.action) : '';
        }
      } catch (e) {}

      return nativeFetch.apply(this, arguments)
        .then(function (res) {
          if (!res.ok && isApi) {
            addEntry('warn', ['API ' + (action || url) + ' → HTTP ' + res.status]);
          }
          return res;
        })
        .catch(function (err) {
          if (isApi) {
            addEntry('error', ['API ' + (action || url) + ' → network error: ' + (err && err.message ? err.message : err)]);
          }
          throw err;
        });
    };
    wrapped.__steerWrapped = true;
    window.fetch = wrapped;
  }
}

/* --------------------------- EXPOSE GLOBALLY --------------------------- */
if (typeof window !== 'undefined') {
  window.logger = logger;
}

/* --------------------------- AUTO-INIT --------------------------- */
bindGlobalHandlers();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    if (logModalIsOpen()) renderNow();
  });
} else {
  if (logModalIsOpen()) renderNow();
}

(function watchLogModal() {
  function attach() {
    const modal = document.getElementById('log-modal');
    if (!modal) { setTimeout(attach, 300); return; }
    const obs = new MutationObserver(function () {
      if (!modal.classList.contains('hidden')) renderNow();
    });
    obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
})();

logger.info('Logger v2.2 initialized — ' + entries.length + ' entries restored');

export default logger;