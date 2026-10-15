/* ============================================================================
   STEERADAR LOGGER (v2.0)
   ============================================================================
   Features:
     • Levels: log / info / warn / error / success
     • In-memory buffer (max 500) + localStorage persistence
     • Live render into #logContent when log modal is open
     • Fetch interceptor → logs every failed code.gs call with action + status
     • Global window.onerror + unhandledrejection capture
     • Exposed on window.logger so inline onclick handlers work
     • Copy-to-clipboard with HTTP fallback
     • Clear button wipes both memory and localStorage
   ============================================================================ */

const STORAGE_KEY = 'steeradar-log';
const MAX_ENTRIES = 500;
const RENDER_DEBOUNCE_MS = 120;

/* --------------------------- STATE --------------------------- */
let entries = [];
let renderTimer = null;
let isBound = false;

/* --------------------------- BOOTSTRAP --------------------------- */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveToStorage() {
  try {
    // Keep the buffer bounded before persisting
    const trimmed = entries.slice(-MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    // Storage full or unavailable — silently ignore
  }
}

entries = loadFromStorage();

/* --------------------------- HELPERS --------------------------- */
function pad2(n) { return String(n).padStart(2, '0'); }

function timeStamp() {
  const d = new Date();
  return (
    pad2(d.getHours()) + ':' +
    pad2(d.getMinutes()) + ':' +
    pad2(d.getSeconds()) + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
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

/* --------------------------- CORE LOG --------------------------- */
function addEntry(level, args) {
  const text = Array.from(args).map(normalizeArg).join(' ');
  const entry = { ts: Date.now(), level: level || 'info', msg: text };
  entries.push(entry);

  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }

  // Mirror to console with original args (keeps stack traces intact)
  try {
    if (level === 'error') console.error.apply(console, args);
    else if (level === 'warn') console.warn.apply(console, args);
    else console.log.apply(console, args);
  } catch (e) { /* console may be unavailable */ }

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

  // Newest entries at the top for easier reading
  const html = entries
    .slice()
    .reverse()
    .map(function (e) {
      const d = new Date(e.ts);
      const stamp =
        pad2(d.getHours()) + ':' +
        pad2(d.getMinutes()) + ':' +
        pad2(d.getSeconds());
      const level = e.level || 'info';
      return (
        '<div class="log-line log-' + escapeHtml(level) + '">' +
          '<span class="log-time">' + stamp + '</span>' +
          '<span class="log-msg">' + escapeHtml(e.msg) + '</span>' +
        '</div>'
      );
    })
    .join('');

  box.innerHTML = html;
}

/* --------------------------- PUBLIC API --------------------------- */
export const logger = {
  log:   function () { addEntry('info',    arguments); },
  info:  function () { addEntry('info',    arguments); },
  warn:  function () { addEntry('warn',    arguments); },
  error: function () { addEntry('error',   arguments); },
  success: function () { addEntry('info',  arguments); },

  /* Return a plain array of entries (safe copy) */
  getAll: function () { return entries.slice(); },

  /* Wipe memory + storage + UI */
  clear: function () {
    entries = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    renderNow();
    return { ok: true };
  },

  /* Export as plain text (used by Copy button) */
  export: async function () {
    const text = entries.map(function (e) {
      const d = new Date(e.ts);
      const iso = d.toISOString();
      return '[' + iso + '] [' + (e.level || 'info').toUpperCase() + '] ' + e.msg;
    }).join('\n');

    // Try clipboard API first (needs HTTPS + permission)
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text || '(no logs)');
        logger.success('Log copied to clipboard');
        return { ok: true };
      }
    } catch (e) {
      // fall through to legacy method
    }

    // Legacy fallback — hidden textarea
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
      // Last resort — show prompt so user can copy manually
      try { window.prompt('Copy logs:', text || '(no logs)'); } catch (e2) {}
      return { ok: false };
    }
  },

  /* Force a re-render (called when the log modal opens) */
  refresh: function () { renderNow(); }
};

/* --------------------------- GLOBAL BINDINGS --------------------------- */
function bindGlobalHandlers() {
  if (isBound) return;
  isBound = true;

  // Uncaught errors
  window.addEventListener('error', function (evt) {
    const msg = evt && (evt.message || (evt.error && evt.error.message));
    const src = evt && evt.filename ? (' @ ' + evt.filename + ':' + (evt.lineno || 0)) : '';
    if (msg) addEntry('error', ['[uncaught] ' + msg + src]);
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', function (evt) {
    const reason = evt && evt.reason;
    const msg = reason && (reason.message || reason.stack || String(reason));
    if (msg) addEntry('error', ['[unhandled promise] ' + msg]);
  });

  // Intercept fetch → log every non-OK response (esp. code.gs calls)
  const nativeFetch = window.fetch;
  if (nativeFetch && !nativeFetch.__steerWrapped) {
    const wrapped = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const isApi = url.indexOf('script.google.com') !== -1 || url.indexOf('/macros/') !== -1;

      // Try to extract action name from POST body
      let action = '';
      try {
        if (init && init.body && typeof init.body === 'string') {
          const parsed = JSON.parse(init.body);
          action = parsed && parsed.action ? String(parsed.action) : '';
        }
      } catch (e) { /* not JSON */ }

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
// Inline onclick handlers in index.html (logger.export(), logger.clear())
// need the API on window since this file is an ES module.
if (typeof window !== 'undefined') {
  window.logger = logger;
}

/* --------------------------- INIT --------------------------- */
bindGlobalHandlers();

// Render on load if the modal somehow starts visible
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    if (logModalIsOpen()) renderNow();
  });
} else {
  if (logModalIsOpen()) renderNow();
}

// Auto-render whenever the log modal opens (via MutationObserver).
// This catches `openModal('log-modal')` regardless of caller.
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

/* --------------------------- SELF-TEST --------------------------- */
logger.info('Logger v2.0 initialized — ' + entries.length + ' entries restored');

export default logger;