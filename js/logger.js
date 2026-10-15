/* ============================================================================
   STEERADAR LOGGER (v2.1)
   ============================================================================
   v2.1 changes:
     • Added logger.init()  — no-op for backward compat (app.js calls it)
     • Added logger.render() — alias for refresh()
     • Sanitize every entry loaded from localStorage (old versions wrote
       entries without a valid `ts`, causing "Invalid time value" crashes)
     • safeTs() guards all Date construction
     • Every log method accepts any number of args
   ============================================================================ */

const STORAGE_KEY = 'steeradar-log';
const MAX_ENTRIES = 500;
const RENDER_DEBOUNCE_MS = 120;

/* --------------------------- STATE --------------------------- */
let entries = [];
let renderTimer = null;
let isBound = false;

/* --------------------------- SAFE DATE --------------------------- */
/**
 * Return a valid millisecond timestamp.
 * Accepts: number | numeric string | ISO string | anything
 * Falls back to Date.now() if the input can't be parsed.
 */
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
          msg: String(e.msg == null ? '' : e.msg).slice(0, 4000)
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

/* --------------------------- HELPERS --------------------------- */
function pad2(n) {
  const v = Number(n);
  return (isFinite(v) ? String(Math.floor(v)) : '00').padStart(2, '0');
}

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

  /* v14 backward-compat: app.js calls logger.init() on boot */
  init: function () {
    // Bind global error handlers if not already bound
    bindGlobalHandlers();
    // Render if modal is already open
    if (logModalIsOpen()) renderNow();
    return { ok: true };
  },

  log:     function () { addEntry('info',    arguments); },
  info:    function () { addEntry('info',    arguments); },
  warn:    function () { addEntry('warn',    arguments); },
  error:   function () { addEntry('error',   arguments); },
  success: function () { addEntry('info',    arguments); },

  /* v14 backward-compat: app.js calls logger.render() */
  render: function () { renderNow(); return { ok: true }; },

  /* Clearer alias (my v2.0 naming) */
  refresh: function () { renderNow(); return { ok: true }; },

  getAll: function () { return entries.slice(); },

  clear: function () {
    entries = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    renderNow();
    return { ok: true };
  },

  export: async function () {
    const text = entries.map(function (e) {
      const d = new Date(safeTs(e.ts));
      const iso = d.toISOString();
      return '[' + iso + '] [' + (e.level || 'info').toUpperCase() + '] ' + e.msg;
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

logger.info('Logger v2.1 initialized — ' + entries.length + ' entries restored');

export default logger;