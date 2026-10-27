/* =========================================================================
   In-app updates — the page half. The native half is AppUpdater.kt.

   Bridge (window.AndroidBridge): checkForUpdate(), downloadUpdate(), installUpdate(),
   updateState(), getAutoUpdate(), setAutoUpdate(on).
   Native -> page: window.onUpdateState(json)
     json = {status, step, current, version, percent, message, manual}
     status: checking | uptodate | available | downloading | ready | needpermission |
             installing | failed
     step (failed only): check | download | install

   What the page shows: a bar (#update-bar) at the bottom of the side menu, plus a small dot on the
   menu button (body.has-update) while there is something to act on. Tapping the version number
   (#app-version) checks right now. The bar also holds the "Update automatically" switch.
   An automatic check that finds nothing, or fails (no network at start-up), shows nothing at all.
   ========================================================================= */
(function (root) {
  'use strict';

  /* What the bar should show for a native state. Pure, so the tests can run it.
     Returns {show, text, progress (0-100 or null), action ({label, call} or null),
              dot (true when the menu button should carry the "something to do" dot),
              autoHide (true when the bar goes away by itself)}. */
  function plan(s) {
    s = s || {};
    var quiet = { show: false, text: '', progress: null, action: null, dot: false, autoHide: false };
    var version = s.version || '';
    switch (s.status) {
      case 'checking':
        return s.manual ? { show: true, text: 'Checking for updates…', progress: null, action: null, dot: false, autoHide: false } : quiet;
      case 'uptodate':
        return s.manual
          ? { show: true, text: "You're up to date" + (s.current ? ' (' + s.current + ')' : ''), progress: null, action: null, dot: false, autoHide: true }
          : quiet;
      case 'available':
        return { show: true, text: 'Update ' + version + ' available', progress: null, action: { label: 'Download', call: 'downloadUpdate' }, dot: true, autoHide: false };
      case 'downloading': {
        var pct = Math.max(0, Math.min(100, Math.round(Number(s.percent) || 0)));
        return { show: true, text: 'Downloading ' + version + '… ' + pct + '%', progress: pct, action: null, dot: true, autoHide: false };
      }
      case 'ready':
        return { show: true, text: s.message || ('Update ' + version + ' is ready to install'), progress: null, action: { label: 'Install', call: 'installUpdate' }, dot: true, autoHide: false };
      case 'needpermission':
        return { show: true, text: s.message || 'Allow installing apps from Novel Reader, then come back.', progress: null, action: { label: 'Open settings', call: 'installUpdate' }, dot: true, autoHide: false };
      case 'installing':
        return { show: true, text: 'Installing…', progress: null, action: null, dot: true, autoHide: false };
      case 'failed': {
        if (s.step === 'check' && !s.manual) return quiet;
        var retry = s.step === 'download' ? 'downloadUpdate' : s.step === 'install' ? 'installUpdate' : 'checkForUpdate';
        return { show: true, text: s.message || 'The update failed.', progress: null, action: { label: 'Try again', call: retry }, dot: false, autoHide: false };
      }
      default:
        return quiet;
    }
  }

  var api = { plan: plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  var bar = document.getElementById('update-bar');
  var textEl = document.getElementById('update-text');
  var progressEl = document.getElementById('update-progress');
  var fillEl = document.getElementById('update-progress-fill');
  var actionBtn = document.getElementById('update-action');
  var autoBox = document.getElementById('update-auto');
  var versionEl = document.getElementById('app-version');
  if (!bar || !textEl || !actionBtn || !autoBox) return;

  var hideTimer = null;
  var currentAction = null;

  function bridge() { return root.AndroidBridge || null; }
  function call(name, arg) {
    var b = bridge();
    if (!b || typeof b[name] !== 'function') return undefined;
    try { return arg === undefined ? b[name]() : b[name](arg); } catch (e) { return undefined; }
  }

  function render(state) {
    var p = plan(state);
    clearTimeout(hideTimer);
    document.body.classList.toggle('has-update', p.dot);
    bar.classList.toggle('hidden', !p.show);
    if (!p.show) return;
    textEl.textContent = p.text;
    if (p.progress === null) {
      progressEl.classList.add('hidden');
    } else {
      progressEl.classList.remove('hidden');
      fillEl.style.width = p.progress + '%';
    }
    currentAction = p.action;
    actionBtn.classList.toggle('hidden', !p.action);
    if (p.action) actionBtn.textContent = p.action.label;
    if (p.autoHide) {
      hideTimer = setTimeout(function () { bar.classList.add('hidden'); }, 8000);
    }
  }

  root.onUpdateState = function (json) {
    var state;
    try { state = JSON.parse(json); } catch (e) { return; }
    render(state);
  };

  actionBtn.addEventListener('click', function () {
    if (currentAction) call(currentAction.call);
  });

  autoBox.addEventListener('change', function () {
    clearTimeout(hideTimer); // the person is using the bar: keep it
    call('setAutoUpdate', !!autoBox.checked);
  });

  function checkNow() {
    call('checkForUpdate');
  }
  if (versionEl) {
    versionEl.addEventListener('click', checkNow);
    versionEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); checkNow(); }
    });
  }

  // Catch up with whatever the app already knows (the check may have finished before this loaded).
  var auto = call('getAutoUpdate');
  autoBox.checked = auto === undefined ? true : !!auto;
  var raw = call('updateState');
  if (raw) root.onUpdateState(raw);

  api.render = render;
})(typeof window !== 'undefined' ? window : this);
