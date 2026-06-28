/**
 * common.js — shared utilities for all score-keeper pages.
 * Provides: PIN pad overlay, auth helpers, socket setup, timer formatting, toast notifications.
 * Uses DOM methods throughout (no innerHTML) to avoid XSS surface.
 */

/* global io */

// ─── Toast notifications ──────────────────────────────────────────────────────

(function initToasts() {
  const container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);

  window.showToast = function showToast(msg, type, ms) {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(function() { t.remove(); }, ms || 3000);
  };
})();

// ─── Timer formatting ─────────────────────────────────────────────────────────

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m + ':' + String(rem).padStart(2, '0');
}

// ─── PIN pad overlay ──────────────────────────────────────────────────────────

/**
 * Show a full-screen PIN pad. Checks existing auth first; resolves true on success.
 * For `role === 'admin'`, uses a text-password input instead of a numeric PIN.
 */
function mountPinPad(role, label) {
  return new Promise(function(resolve) {
    fetch('/api/auth/check?role=' + encodeURIComponent(role))
      .then(function(r) { return r.ok ? resolve(true) : showPad(); })
      .catch(showPad);

    function showPad() {
      var overlay = document.getElementById('pin-overlay') || createOverlay();
      overlay.textContent = '';
      overlay.classList.remove('hidden');

      // Header
      var headerWrap = document.createElement('div');
      headerWrap.style.cssText = 'text-align:center;margin-bottom:1.5rem';
      var subLabel = document.createElement('div');
      subLabel.style.cssText = 'font-size:.9rem;color:var(--text2);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.3rem';
      subLabel.textContent = 'Access Required';
      var mainLabel = document.createElement('div');
      mainLabel.style.cssText = 'font-size:1.4rem;font-weight:700';
      mainLabel.textContent = label;
      headerWrap.appendChild(subLabel);
      headerWrap.appendChild(mainLabel);
      overlay.appendChild(headerWrap);

      if (role === 'admin') {
        buildTextPad(overlay, resolve);
      } else {
        buildNumericPad(overlay, role, resolve);
      }
    }

    function createOverlay() {
      var el = document.createElement('div');
      el.id = 'pin-overlay';
      el.style.cssText = 'position:fixed;inset:0;background:var(--bg);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column';
      document.body.appendChild(el);
      return el;
    }
  });
}

function buildTextPad(overlay, resolve) {
  // Admin uses text password
  var input = document.createElement('input');
  input.type = 'password';
  input.placeholder = 'Admin password';
  input.style.cssText = 'font-size:1.2rem;padding:.8rem 1rem;margin-bottom:.75rem;width:260px;text-align:center';
  overlay.appendChild(input);

  var errorEl = document.createElement('div');
  errorEl.className = 'pin-error';
  overlay.appendChild(errorEl);

  var submitBtn = document.createElement('button');
  submitBtn.className = 'pin-btn submit';
  submitBtn.style.cssText = 'width:260px;margin-top:.5rem;font-size:1.2rem';
  submitBtn.textContent = 'Login';
  overlay.appendChild(submitBtn);

  function tryLogin() {
    var pw = input.value;
    fetch('/api/auth/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then(function(r) {
      if (r.ok) {
        overlay.classList.add('hidden');
        resolve(true);
      } else {
        errorEl.textContent = 'Wrong password. Try again.';
        input.value = '';
        input.focus();
      }
    }).catch(function() {
      errorEl.textContent = 'Network error.';
    });
  }

  submitBtn.addEventListener('click', tryLogin);
  input.addEventListener('keydown', function(e) { if (e.key === 'Enter') tryLogin(); });
  setTimeout(function() { input.focus(); }, 50);
}

function buildNumericPad(overlay, role, resolve) {
  var display = document.createElement('div');
  display.className = 'pin-display';
  display.textContent = '_ _ _ _';
  overlay.appendChild(display);

  var pad = document.createElement('div');
  pad.className = 'pin-pad';
  overlay.appendChild(pad);

  var errorEl = document.createElement('div');
  errorEl.className = 'pin-error';
  overlay.appendChild(errorEl);

  var entered = '';

  function renderDisplay() {
    var dots = entered.split('').map(function() { return '\u25CF'; }).join(' ');
    var blanks = Array(Math.max(0, 4 - entered.length)).fill('_').join(' ');
    display.textContent = dots + (dots && blanks ? ' ' : '') + blanks || '_ _ _ _';
  }

  function handleKey(key) {
    errorEl.textContent = '';
    if (key === 'CLR') { entered = ''; renderDisplay(); return; }
    if (key === 'OK') { doSubmit(); return; }
    if (/^\d$/.test(key) && entered.length < 4) {
      entered += key;
      renderDisplay();
      if (entered.length === 4) doSubmit();
    }
  }

  function doSubmit() {
    fetch('/api/auth/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: role, pin: entered }),
    }).then(function(r) {
      if (r.ok) {
        overlay.classList.add('hidden');
        resolve(true);
      } else {
        errorEl.textContent = 'Wrong PIN. Try again.';
        entered = '';
        renderDisplay();
      }
    }).catch(function() {
      errorEl.textContent = 'Network error.';
      entered = '';
      renderDisplay();
    });
  }

  var keys = ['1','2','3','4','5','6','7','8','9','CLR','0','OK'];
  keys.forEach(function(key) {
    var btn = document.createElement('button');
    btn.className = 'pin-btn' + (key === 'CLR' ? ' clear' : '') + (key === 'OK' ? ' submit' : '');
    btn.textContent = key;
    btn.addEventListener('click', function() { handleKey(key); });
    pad.appendChild(btn);
  });

  document.addEventListener('keydown', function kd(e) {
    if (/^\d$/.test(e.key)) { handleKey(e.key); }
    if (e.key === 'Enter') { handleKey('OK'); }
    if (e.key === 'Backspace') { entered = entered.slice(0, -1); errorEl.textContent = ''; renderDisplay(); }
    if (e.key === 'Escape') { entered = ''; renderDisplay(); }
  });

  renderDisplay();
}

// ─── Logout helper ────────────────────────────────────────────────────────────

function addLogoutButton(container) {
  var btn = document.createElement('button');
  btn.className = 'logout-btn';
  btn.textContent = 'Logout';
  btn.addEventListener('click', function() {
    fetch('/api/auth/logout', { method: 'POST' }).finally(function() { location.reload(); });
  });
  container.appendChild(btn);
}

// ─── Socket.io client ─────────────────────────────────────────────────────────

function connectSocket() {
  if (typeof io === 'undefined') { console.error('Socket.io not loaded'); return null; }
  return io();
}

// ─── Timer state ──────────────────────────────────────────────────────────────

function applyTimerState(state, timerEl, periodEl) {
  if (!state) return;
  var t = typeof state.timeRemaining === 'number' ? state.timeRemaining : 0;
  var period = state.period;

  if (timerEl) {
    timerEl.textContent = state.matchId ? formatTime(t) : '0:00';
    timerEl.className = 'timer-display';
    if (period) {
      if (period.type === 'ENDGAME') timerEl.classList.add('endgame');
      if (t <= 10 && period.type !== 'TRANSITION' && period.type !== 'BUZZER') timerEl.classList.add('final');
    }
  }

  if (periodEl && period) {
    periodEl.textContent = period.name + (period.cycle ? ' (Cycle ' + period.cycle + ')' : '');
    periodEl.className = 'period-label ' + (period.type || '').toLowerCase();
  } else if (periodEl && !period) {
    periodEl.textContent = 'Waiting';
    periodEl.className = 'period-label';
  }
}

// ─── Buzzer sound (Web Audio API) ────────────────────────────────────────────

function playBuzzer() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.setValueAtTime(300, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch (e) { /* silent fail if audio not available */ }
}

// ─── Public API ───────────────────────────────────────────────────────────────

window.SK = {
  formatTime: formatTime,
  mountPinPad: mountPinPad,
  addLogoutButton: addLogoutButton,
  connectSocket: connectSocket,
  applyTimerState: applyTimerState,
  playBuzzer: playBuzzer,
};
