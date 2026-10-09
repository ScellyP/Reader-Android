/* =========================================================================
   Novel Reader — settings file

   Mirrors the app's saved settings to a plain text file in the novel
   directory:   /storage/emulated/0/Novel/settings.txt

   • On startup the file is read FIRST (this script loads before the
     others) and its values are copied into localStorage, so the rest of
     the app picks them up exactly as if they had been saved normally.
     The file wins over whatever is currently in localStorage.
   • Whenever a tracked setting changes, the file is rewritten (debounced).
   • You can edit the file by hand while the app is closed.

   Format: one `key = value` per line, value written as JSON.
   Lines starting with # are comments.  Example:
       appearance.fontSize = 20
       audio.volume = 0.8
       sessionLimitMode = "off"
       lastChapter.Shadow Slave = "Chapter 0412.txt"   (chapter you're on, per novel)
   ========================================================================= */

(function () {
  'use strict';

  var bridge = window.AndroidBridge;
  if (!bridge || !bridge.readSettingsFile || !bridge.writeSettingsFile) return; // not inside the app

  // localStorage keys holding a JSON object -> flattened as "<prefix>.<field>"
  var OBJECT_KEYS = {
    'novelReader_appearance': 'appearance',
    'novelReader_audioPrefs': 'audio'
  };
  // localStorage keys holding a plain string
  var STRING_KEYS = {
    'novelReader_sessionLimitMode': 'sessionLimitMode',
    'novelReader_sessionLimitTime': 'sessionLimitTime',
    'novelReader_sessionLimitSeconds': 'sessionLimitSeconds',
    'novelReader_currentNovel': 'currentNovel'
  };

  // Per-novel "chapter I'm on": localStorage key novelReader_lastChapter_<novel>
  // <-> file line  lastChapter.<novel> = "<chapter file name>"
  var LAST_CHAPTER_LS_PREFIX = 'novelReader_lastChapter_';
  var LAST_CHAPTER_FILE_PREFIX = 'lastChapter.';

  // Novel names can contain '=' or odd characters; keep each line parseable.
  function escName(n) {
    return String(n).replace(/%/g, '%25').replace(/=/g, '%3D').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  }
  function unescName(n) {
    return String(n).replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%3D/g, '=').replace(/%25/g, '%');
  }

  var HEADER = [
    '# Novel Reader settings',
    '# One "key = value" per line (values are JSON). Edit while the app is closed.',
    '# Delete a line to go back to that setting\'s default.',
    ''
  ].join('\n');

  var rawGet = Storage.prototype.getItem;
  var rawSet = Storage.prototype.setItem;
  var rawRemove = Storage.prototype.removeItem;

  function isTracked(key) {
    return Object.prototype.hasOwnProperty.call(OBJECT_KEYS, key) ||
           Object.prototype.hasOwnProperty.call(STRING_KEYS, key) ||
           String(key).indexOf(LAST_CHAPTER_LS_PREFIX) === 0;
  }

  /* ---------- localStorage -> text ---------- */
  function buildText() {
    var lines = [];
    Object.keys(OBJECT_KEYS).forEach(function (lsKey) {
      var obj = {};
      try { obj = JSON.parse(rawGet.call(localStorage, lsKey) || '{}') || {}; } catch (e) { obj = {}; }
      Object.keys(obj).sort().forEach(function (field) {
        lines.push(OBJECT_KEYS[lsKey] + '.' + field + ' = ' + JSON.stringify(obj[field]));
      });
    });
    Object.keys(STRING_KEYS).forEach(function (lsKey) {
      var v = rawGet.call(localStorage, lsKey);
      if (v !== null && v !== undefined) lines.push(STRING_KEYS[lsKey] + ' = ' + JSON.stringify(v));
    });
    var chapterLines = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(LAST_CHAPTER_LS_PREFIX) === 0) {
        var v = rawGet.call(localStorage, k);
        if (v !== null && v !== undefined) {
          chapterLines.push(LAST_CHAPTER_FILE_PREFIX + escName(k.slice(LAST_CHAPTER_LS_PREFIX.length)) +
                            ' = ' + JSON.stringify(v));
        }
      }
    }
    chapterLines.sort();
    return HEADER + lines.concat(chapterLines).join('\n') + '\n';
  }

  /* ---------- text -> localStorage ---------- */
  function parseValue(raw) {
    raw = raw.trim();
    try { return JSON.parse(raw); } catch (e) { return raw; } // tolerate hand-typed bare words
  }

  // Returns true if any stored value actually changed.
  function applyText(text) {
    var objs = {};   // prefix -> {field: value}
    var strs = {};   // name -> string
    var lasts = {};  // novel name -> chapter file name
    text.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) === '#') return;
      var eq = line.indexOf('=');
      if (eq < 1) return;
      var key = line.slice(0, eq).trim();
      var val = parseValue(line.slice(eq + 1));
      if (key.indexOf(LAST_CHAPTER_FILE_PREFIX) === 0) {
        lasts[unescName(key.slice(LAST_CHAPTER_FILE_PREFIX.length))] = typeof val === 'string' ? val : String(val);
        return;
      }
      var dot = key.indexOf('.');
      if (dot > 0) {
        var prefix = key.slice(0, dot), field = key.slice(dot + 1);
        (objs[prefix] = objs[prefix] || {})[field] = val;
      } else {
        strs[key] = typeof val === 'string' ? val : String(val);
      }
    });

    var changed = false;
    Object.keys(OBJECT_KEYS).forEach(function (lsKey) {
      var prefix = OBJECT_KEYS[lsKey];
      if (!objs[prefix]) return;
      var current = {};
      try { current = JSON.parse(rawGet.call(localStorage, lsKey) || '{}') || {}; } catch (e) { current = {}; }
      var merged = Object.assign({}, current, objs[prefix]);
      var next = JSON.stringify(merged);
      if (next !== JSON.stringify(current)) { rawSet.call(localStorage, lsKey, next); changed = true; }
    });
    Object.keys(STRING_KEYS).forEach(function (lsKey) {
      var name = STRING_KEYS[lsKey];
      if (!Object.prototype.hasOwnProperty.call(strs, name)) return;
      if (rawGet.call(localStorage, lsKey) !== strs[name]) { rawSet.call(localStorage, lsKey, strs[name]); changed = true; }
    });
    Object.keys(lasts).forEach(function (novel) {
      var lsKey = LAST_CHAPTER_LS_PREFIX + novel;
      if (rawGet.call(localStorage, lsKey) !== lasts[novel]) { rawSet.call(localStorage, lsKey, lasts[novel]); changed = true; }
    });
    return changed;
  }

  /* ---------- saving ---------- */
  var lastWritten = null;
  var saveTimer = null;
  var retryCount = 0;

  function save() {
    var text = buildText();
    if (text === lastWritten) return;
    var ok = false;
    try { ok = !!bridge.writeSettingsFile(text); } catch (e) { ok = false; }
    if (ok) {
      lastWritten = text;
      retryCount = 0;
    } else if (retryCount < 12) {
      // Storage permission may not be granted yet — try again shortly.
      retryCount++;
      scheduleSave(10000);
    }
  }

  function scheduleSave(ms) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, ms == null ? 600 : ms);
  }

  // Watch writes to the tracked keys; everything else is left alone.
  Storage.prototype.setItem = function (key, value) {
    rawSet.apply(this, arguments);
    if (this === window.localStorage && isTracked(key)) scheduleSave();
  };
  Storage.prototype.removeItem = function (key) {
    rawRemove.apply(this, arguments);
    if (this === window.localStorage && isTracked(key)) scheduleSave();
  };

  // Make sure nothing is lost if the app is backgrounded mid-debounce.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { clearTimeout(saveTimer); save(); }
  });

  /* ---------- startup ---------- */
  var initial = null;
  try { initial = bridge.readSettingsFile(); } catch (e) { initial = null; }

  if (typeof initial === 'string' && initial.trim()) {
    applyText(initial);
    lastWritten = initial; // don't rewrite an unchanged file
  } else if (initial === null) {
    // No storage access yet: poll for the file once access appears.
    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      var t = null;
      try { t = bridge.readSettingsFile(); } catch (e) { t = null; }
      if (t === null && tries < 12) return;
      clearInterval(poll);
      if (typeof t === 'string' && t.trim()) {
        if (applyText(t) && !sessionStorage.getItem('settingsFileReloaded')) {
          sessionStorage.setItem('settingsFileReloaded', '1');
          lastWritten = t;
          location.reload(); // re-run startup with the file's values applied
        }
      }
    }, 5000);
  }

  // Create the file shortly after launch if it doesn't exist yet.
  setTimeout(save, 2500);
})();
