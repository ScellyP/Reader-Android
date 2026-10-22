/* =========================================================================
   Novel Reader — main UI script
   =========================================================================
   Everything except audio playback lives here: chapter loading/parsing,
   the reading pane, appearance/theme controls, bookmarks, the reading
   session limit (dial timer), and touch/keyboard gestures. Audio player
   UI wiring is in audio-player.js, loaded before this file, and exposed
   as window.NovelAudio.
   ========================================================================= */
(function () {
  // In-memory reading state. `chapters` is rebuilt every time a novel is
  // (re)loaded; `currentIndex` is this novel's position within it.
  let chapters = [];      // {title, text, filename}
  let currentIndex = -1;
  let fontSize = 19;
  let flipTimer = null;        // pending timeout that clears the flip animation class
  let flipDurationBase = 1200; // ms; user-adjustable via the theme panel slider

  // Sidebar / chapter list elements.
  const chapterListEl = document.getElementById('chapter-list');
  const emptyNote = document.getElementById('empty-note');
  const searchInput = document.getElementById('chapter-search');

  // Reading pane elements.
  const welcomeEl = document.getElementById('welcome');
  const readerEl = document.getElementById('reader');
  const chapterTitleEl = document.getElementById('chapter-title');
  const chapterTextEl = document.getElementById('chapter-text');

  // Prev/next navigation (top bar + bottom-of-chapter buttons).
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const bottomPrev = document.getElementById('bottom-prev');
  const bottomNext = document.getElementById('bottom-next');

  // Sidebar drawer + its mobile scrim/backdrop.
  const toggleSidebarBtn = document.getElementById('toggle-sidebar');
  const sidebar = document.getElementById('sidebar');
  const sidebarScrim = document.getElementById('sidebar-scrim');

  // Novel/folder picking (native bridge driven — see the bridge section below).
  const chaptersFolderStatus = document.getElementById('chapters-folder-status');
  const openChaptersBtn = document.getElementById('open-chapters-btn');
  const novelSelect = document.getElementById('novel-select');
  const readerScrollEl = document.getElementById('reader-scroll');
  const topbarEl = document.getElementById('topbar');
  const statusClockEl = document.getElementById('status-clock');

  /* ---------------------------------------------------------------------
     Status bar "lip" + clock.
     MainActivity reports the exact status bar height (in CSS px) here
     as soon as it's known, and again after the page finishes loading.
     We use it to reserve that much space above the top bar so the
     system notification bar never covers our own controls, and we draw
     a live clock inside that reserved strip, top-right.
  --------------------------------------------------------------------- */
  window.onStatusBarInset = function (px) {
    const value = typeof px === 'number' && px >= 0 ? px : 0;
    document.documentElement.style.setProperty('--status-bar-height', value + 'px');
  };

  /* ---------------------------------------------------------------------
     Companion to onStatusBarInset above, but for the bottom nav bar.
     The WebView itself is already padded by this amount natively, but
     position:fixed elements (like the mobile sidebar overlay) ignore
     that padding since they're positioned against the viewport, not
     their container — so we expose it as a CSS variable too, for
     anything that needs to explicitly avoid the nav bar icons.
  --------------------------------------------------------------------- */
  window.onNavBarInset = function (px) {
    const value = typeof px === 'number' && px >= 0 ? px : 0;
    document.documentElement.style.setProperty('--nav-bar-height', value + 'px');
  };

  function updateStatusClock() {
    // Always 12-hour with AM/PM, computed manually rather than via
    // toLocaleTimeString — so it stays 12-hour even on a device whose
    // system settings are set to 24-hour time.
    const now = new Date();
    let h = now.getHours();
    const m = String(now.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    statusClockEl.textContent = h + ':' + m + ' ' + ampm;
  }
  // Render immediately (so the clock isn't blank for the first 15s) then
  // refresh on a slow interval — a clock doesn't need per-second updates.
  updateStatusClock();
  setInterval(updateStatusClock, 15000);

  // True below the tablet/phone breakpoint (also drives the sidebar's
  // fixed-drawer CSS via the @media query of the same width).
  function isMobileViewport() {
    return window.matchMedia('(max-width: 720px)').matches;
  }

  // Shows/hides the dark backdrop behind the mobile drawer. Only
  // relevant on mobile — on desktop the sidebar is always docked, so the
  // scrim stays permanently hidden there.
  function syncScrim() {
    const open = isMobileViewport() && !sidebar.classList.contains('collapsed');
    sidebarScrim.classList.toggle('visible', open);
    // Tells MainActivity.kt to fully hide the system nav bar while the
    // drawer covers the screen, and restore the normal
    // hidden-status-bar/transparent-nav-bar reading look once it closes.
    // syncScrim() is called from every place the sidebar's collapsed
    // state changes, so this one call site covers all of them.
    if (window.AndroidBridge && window.AndroidBridge.setMenuOpen) {
      window.AndroidBridge.setMenuOpen(open);
    }
  }

  // Start collapsed on phones (a drawer, opened via the ☰ button or
  // swipe) but expanded on tablets/desktop (a permanent side panel).
  if (isMobileViewport()) {
    sidebar.classList.add('collapsed');
  }
  syncScrim();

  // Tapping the dimmed backdrop closes the drawer, same as tapping
  // outside any other panel.
  sidebarScrim.addEventListener('click', () => {
    sidebar.classList.add('collapsed');
    syncScrim();
  });
  // Rotating the device or resizing the window can cross the mobile
  // breakpoint, so re-evaluate whether the scrim should be visible.
  window.addEventListener('resize', syncScrim);

  /* =====================================================================
     UI foundation: icons, themed dialog, launch splash, welcome states.
     Kept in one block so the presentation layer is easy to find and the
     reading / gesture / timer logic below stays untouched by it.
  ===================================================================== */

  // Builds an <svg class="ico"> that points at a symbol in the sprite at
  // the top of index.html, so JS-created buttons share the same icons.
  function svgIcon(id) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ico');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  /* Themed replacement for window.alert(). The native WebChromeClient
     dialog is light-coloured and clashes with the app, so every message
     is drawn in-app instead. Messages that arrive while one is open are
     queued rather than dropped, and the dialog is dismissible with the
     button, a tap on the backdrop, or the Android back gesture. */
  const dialogLayer = document.getElementById('dialog-layer');
  const dialogMessage = document.getElementById('dialog-message');
  const dialogOk = document.getElementById('dialog-ok');
  const dialogQueue = [];
  let dialogOpen = false;

  function showNextDialog() {
    if (dialogOpen || dialogQueue.length === 0) return;
    dialogOpen = true;
    dialogMessage.textContent = dialogQueue.shift();
    dialogLayer.classList.remove('hidden');
    dialogOk.focus({ preventScroll: true });
  }
  function closeDialog() {
    dialogLayer.classList.add('hidden');
    dialogOpen = false;
    showNextDialog();
  }
  function showMessage(text) {
    dialogQueue.push(String(text));
    showNextDialog();
  }
  dialogOk.addEventListener('click', closeDialog);
  dialogLayer.addEventListener('click', (e) => { if (e.target === dialogLayer) closeDialog(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dialogOpen) closeDialog(); });
  // Route the page's own alert() calls through the themed dialog too.
  window.alert = showMessage;

  /* ---- Launch splash ----
     index.html paints #splash on the first frame with no JS. It lifts
     when EITHER (a) the native side has answered about the library, or
     (b) a hard timeout fires. (b) matters: with no bridge (a plain
     browser) or a slow storage scan, the splash must never trap the
     user behind it. A minimum on-screen time keeps it from flashing. */
  const splashEl = document.getElementById('splash');
  const splashStatusEl = document.getElementById('splash-status');
  const SPLASH_MIN_MS = 1500;
  // Long fallback only: the splash normally lifts when the chapters have
  // loaded (or a setup/empty/error state is shown). This just guarantees
  // it can never trap the user if the native side never answers.
  const SPLASH_MAX_MS = 60000;
  const splashShownAt = Date.now();
  let splashDone = false;

  function setSplashStatus(text) {
    if (!splashEl || splashDone || !splashStatusEl) return;
    splashStatusEl.innerHTML = '';
    splashStatusEl.appendChild(document.createTextNode(text));
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    splashStatusEl.appendChild(dots);
  }

  function dismissSplash() {
    if (!splashEl || splashDone) return;
    splashDone = true;
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
    setTimeout(() => {
      splashEl.classList.add('leaving');
      setTimeout(() => splashEl.classList.add('gone'), 650);
    }, wait);
  }
  setTimeout(dismissSplash, SPLASH_MAX_MS);
  // Fonts are bundled, but wait for them so the first visible frame after
  // the splash is set in the right typeface, not a swap.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => setSplashStatus('Loading your chapters'));
  }

  /* ---- Welcome / empty states ----
     One function owns what the reading pane shows before a chapter is
     open, so loading, first-run and error read as three clear states
     rather than one blank screen. */
  function setWelcome(state, detail) {
    const iconId = state === 'error' ? 'i-info' : (state === 'setup' ? 'i-folder' : 'i-moon-stars');
    welcomeEl.classList.toggle('is-loading', state === 'loading');
    let html = '<div class="wl-mark"></div>';
    if (state === 'loading') {
      html += '<h2>Your library is rising</h2><p>Looking for novels in your Novel folder.</p>';
    } else if (state === 'setup') {
      html += '<h2>Let\u2019s find your novels</h2>' +
        '<p>Novel Reader works offline, straight from a folder on your phone.</p>' +
        '<ol class="steps">' +
        '<li><span>Open the chapter list and tap <b>Allow access to your novels</b>. The app then creates the <code>/storage/emulated/0/Novel</code> folder for you.</span></li>' +
        '<li><span>Make a folder for each novel inside <code>Novel</code>.</span></li>' +
        '<li><span>Put that novel\u2019s <b>.txt</b> chapters in its folder. They sort by chapter number automatically.</span></li>' +
        '</ol>';
    } else if (state === 'empty') {
      html += '<h2>No chapters here</h2><p>' + (detail || 'This folder has no .txt chapter files yet.') + '</p>';
    } else {
      html += '<h2>Couldn\u2019t open your library</h2><p>' + (detail || 'Something went wrong while reading your folder.') + '</p>';
    }
    welcomeEl.innerHTML = html;
    // innerHTML above wipes the starfield, so put it back.
    const welcomeSky = document.createElement('div');
    welcomeSky.className = 'sky sm';
    welcomeSky.setAttribute('aria-hidden', 'true');
    welcomeEl.insertBefore(welcomeSky, welcomeEl.firstChild);
    welcomeEl.querySelector('.wl-mark').appendChild(svgIcon(iconId));
    if (detail && state !== 'error' && state !== 'empty') { /* detail unused for these states */ }
  }

  /* ---- Range slider fill ----
     Every <input type="range"> in the app is styled with a CSS
     linear-gradient track driven by a --pct custom property (see
     index.html's shared slider rules), so the filled portion always
     shows progress rather than a flat default groove. One delegated
     listener keeps every slider in sync, including the ones EQ bands
     that audio-player.js builds after this file has already run. */
  function updateSliderFill(el) {
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 100;
    const val = parseFloat(el.value) || 0;
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--pct', Math.max(0, Math.min(100, pct)) + '%');
  }
  function initSliderFills(root) {
    (root || document).querySelectorAll('input[type="range"]').forEach(updateSliderFill);
  }
  document.addEventListener('input', (e) => {
    if (e.target && e.target.type === 'range') updateSliderFill(e.target);
  });
  // Re-sync whenever a slider's .value is set programmatically (restoring
  // saved prefs, syncing the audio panel) rather than moved by the user —
  // those calls don't fire an 'input' event, so this covers the rest.
  document.addEventListener('DOMContentLoaded', () => initSliderFills());
  if (document.readyState !== 'loading') initSliderFills();
  // Sliders inserted after this file's startup scan (by other scripts) get
  // their fill the moment they are added, without those scripts needing to
  // know this one exists.
  new MutationObserver((mutations) => {
    mutations.forEach(m => m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.matches && node.matches('input[type="range"]')) updateSliderFill(node);
      else if (node.querySelectorAll) initSliderFills(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });

  // Migrate a saved reading font that no longer exists. Before the
  // redesign the picker offered Comic Sans / Papyrus / Arial / Calibri /
  // Times; an existing install has one of those stored and it would match
  // no option, leaving the picker blank. Map it to the closest new face.
  (function migrateSavedFont() {
    try {
      const raw = localStorage.getItem('novelReader_appearance');
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (!prefs.fontFamily) return;
      const f = String(prefs.fontFamily).toLowerCase();
      if (f.indexOf('newsreader') !== -1 || f.indexOf('lora') !== -1 ||
          f.indexOf('atkinson') !== -1 || f.indexOf('manrope') !== -1 ||
          f.indexOf('georgia') !== -1) return; // already a current option
      // Old sans faces map to Atkinson (readable sans); everything else,
      // including Times, maps to the new default serif.
      const wasSans = f.indexOf('arial') !== -1 || f.indexOf('calibri') !== -1 || f.indexOf('comic') !== -1;
      prefs.fontFamily = wasSans
        ? "'Atkinson Hyperlegible', Arial, sans-serif"
        : "'Newsreader', Georgia, serif";
      localStorage.setItem('novelReader_appearance', JSON.stringify(prefs));
    } catch (e) { /* unreadable prefs: fall through to defaults */ }
  })();

  const fontSmaller = document.getElementById('font-smaller');
  const fontBigger = document.getElementById('font-bigger');


  /* ---------------------------------------------------------------------
     Parse the standard chapter-file format:
       Line 1: title
       Line 2: "Source: <url>" (optional; skipped, never shown or stored)
       Line 3: "======..." separator (optional)
       Line 4: blank
       rest: chapter text
     Falls back gracefully to plain text files with no header.
  --------------------------------------------------------------------- */
  function parseChapterFile(filename, raw) {
    const lines = raw.split(/\r?\n/);
    let title = filename.replace(/\.txt$/i, "");
    let bodyStart = 0;

    if (lines.length > 0 && lines[0].trim()) {
      title = lines[0].trim();
    }
    let sepIndex = lines.findIndex(l => /^=+$/.test(l.trim()));
    if (sepIndex !== -1) {
      bodyStart = sepIndex + 1;
      while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
        bodyStart++;
      }
    } else {
      bodyStart = 0;
      title = filename.replace(/\.txt$/i, "");
    }

    const text = lines.slice(bodyStart).join("\n").trim() || raw.trim();
    return { title, text, filename };
  }

  // Sorts "chapter2.txt" before "chapter10.txt" (plain string sort would
  // put "10" before "2"), and ignores case.
  function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  // Pulls a chapter number out of a parsed title like "Chapter 2000:
  // Human Beasts" or "Chapter 2009 : A Wolf, a Dog, and a Jackal" (note
  // the inconsistent spacing before the colon in real scraped titles —
  // this doesn't care). Prefers a number immediately following the word
  // "chapter" so a stray number elsewhere in the title (e.g. "Level 99")
  // isn't mistaken for the chapter number; falls back to the first
  // number anywhere in the title if that specific pattern isn't there.
  // Returns null (never 0) when nothing can be found, so unnumbered
  // titles don't silently sort to the very front.
  function extractChapterNumber(title) {
    if (!title) return null;
    const afterWord = /chapter\s*#?\s*(\d+(?:\.\d+)?)/i.exec(title);
    if (afterWord) return parseFloat(afterWord[1]);
    const anyNumber = /(\d+(?:\.\d+)?)/.exec(title);
    return anyNumber ? parseFloat(anyNumber[1]) : null;
  }

  // The actual chapter order used everywhere: compares by the number
  // extracted from each chapter's real title (parsed from its content,
  // not its filename), which is what makes ordering independent of
  // however the files happen to be named or listed by the OS. Falls
  // back to natural filename order only when a number can't be
  // determined for one or both sides — e.g. two chapters that share a
  // title, or a title with no number in it at all — so there's always a
  // stable, predictable order rather than leaving ties to whatever
  // order the filesystem happened to return.
  function compareChapters(a, b) {
    const numA = extractChapterNumber(a.title);
    const numB = extractChapterNumber(b.title);
    if (numA !== null && numB !== null && numA !== numB) return numA - numB;
    if (numA !== null && numB === null) return -1;
    if (numA === null && numB !== null) return 1;
    return naturalCompare(a.filename, b.filename);
  }

  // Filters out paragraphs that are just site-scraper cruft (a repeated
  // "Next Chapter" link, an empty line, the title repeated as its own
  // paragraph) so they don't clutter the reading pane. `title` is passed
  // in so a paragraph that's just the chapter title again also gets
  // dropped.
  function isNoiseParagraph(text, title) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const n = norm(text);
    if (!n) return true;
    if (n === norm(title)) return true;
    const navOnly = new Set([
      'prevchapter', 'nextchapter', 'previouschapter',
      'prevchapternextchapter', 'previouschapternextchapter',
      'nextchapterprevchapter', 'nextchapterpreviouschapter',
      'prev', 'next', 'previous',
      'tableofcontents', 'backtocontents', 'chapterlist',
    ]);
    return navOnly.has(n);
  }

  /* ---- Persistence (last chapter read + removed chapters), per folder ----
     Every key below is namespaced with `libraryKey` (set when a novel
     folder loads) so switching novels can't leak one novel's saved
     position/bookmarks/progress into another's. ---- */

  let libraryKey = 'default';

  function lastChapterStorageKey() { return 'novelReader_lastChapter_' + libraryKey; }
  function deletedStorageKey() { return 'novelReader_deleted_' + libraryKey; }
  function scrollProgressKey(filename) { return 'novelReader_scrollProgress_' + libraryKey + '_' + filename; }

  // "Deleted" chapters (removed from the reader's list, e.g. duplicates)
  // are tracked by filename per novel so they stay hidden across restarts
  // without actually touching the files on disk.
  function getDeletedSet() {
    try {
      return new Set(JSON.parse(localStorage.getItem(deletedStorageKey()) || '[]'));
    } catch (e) {
      return new Set();
    }
  }
  function saveLastChapter(filename) {
    localStorage.setItem(lastChapterStorageKey(), filename);
  }
  function getLastChapter() {
    return localStorage.getItem(lastChapterStorageKey());
  }

  // Scroll progress is stored as a 0-1 fraction of the chapter's
  // scrollable height, not raw pixels, so it still lines up correctly
  // even if font size or screen size changes between sessions.
  function saveScrollProgress(filename, fraction) {
    localStorage.setItem(scrollProgressKey(filename), String(fraction));
  }

  /* ---- Bookmarks (per novel): whole chapters and specific paragraphs ---- */

  function bookmarksStorageKey() { return 'novelReader_bookmarks_' + libraryKey; }

  // All bookmarks for the current novel, chapter- and paragraph-level
  // mixed together in one flat array (see the shape note below).
  function getBookmarks() {
    try {
      return JSON.parse(localStorage.getItem(bookmarksStorageKey()) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveBookmarks(list) {
    localStorage.setItem(bookmarksStorageKey(), JSON.stringify(list));
  }

  // A bookmark is: { filename, chapterTitle, type: 'chapter' | 'paragraph',
  //                  paragraphIndex (only for type 'paragraph'), snippet (only for type 'paragraph') }

  function isChapterBookmarked(filename) {
    return getBookmarks().some(b => b.type === 'chapter' && b.filename === filename);
  }

  // Adds/removes a whole-chapter bookmark for `filename` (toggle, not set).
  function toggleChapterBookmark(filename, chapterTitle) {
    const list = getBookmarks();
    const idx = list.findIndex(b => b.type === 'chapter' && b.filename === filename);
    if (idx !== -1) {
      list.splice(idx, 1);
    } else {
      list.push({ filename, chapterTitle, type: 'chapter' });
    }
    saveBookmarks(list);
  }

  function isParagraphBookmarked(filename, paragraphIndex) {
    return getBookmarks().some(b => b.type === 'paragraph' && b.filename === filename && b.paragraphIndex === paragraphIndex);
  }

  // Adds/removes a bookmark for one specific paragraph (used by the
  // long-press gesture). `snippet` is a short preview shown in the
  // bookmarks list so the user can recognise the spot without opening it.
  function toggleParagraphBookmark(filename, chapterTitle, paragraphIndex, snippet) {
    const list = getBookmarks();
    const idx = list.findIndex(b => b.type === 'paragraph' && b.filename === filename && b.paragraphIndex === paragraphIndex);
    if (idx !== -1) {
      list.splice(idx, 1);
    } else {
      list.push({ filename, chapterTitle, type: 'paragraph', paragraphIndex, snippet });
    }
    saveBookmarks(list);
  }

  // Removes a specific bookmark object (matched by type/filename/index,
  // not by array position, since the list may have been re-rendered).
  function removeBookmark(bookmark) {
    const list = getBookmarks();
    const idx = list.findIndex(b =>
      b.type === bookmark.type &&
      b.filename === bookmark.filename &&
      b.paragraphIndex === bookmark.paragraphIndex
    );
    if (idx !== -1) {
      list.splice(idx, 1);
      saveBookmarks(list);
    }
  }
  function getScrollProgress(filename) {
    const raw = localStorage.getItem(scrollProgressKey(filename));
    const value = raw !== null ? parseFloat(raw) : NaN;
    return isNaN(value) ? 0 : value;
  }

  /* ---------------------------------------------------------------------
     Native bridge: the Android app injects `window.AndroidBridge` with:
       - pickFolder(): requests storage permission if needed, then lists
         every novel subfolder under /storage/emulated/0/Novel via
         window.onNovelsListed(jsonNamesArray)
       - tryAutoReconnect(): if permission was already granted, lists
         novels immediately the same way
       - loadNovel(name): reads every .txt file inside that novel's
         subfolder and delivers it via
         window.onFolderPicked(folderName, jsonFilesArray)
     jsonFilesArray is a JSON string: [{name, text}, ...]
  --------------------------------------------------------------------- */

  function processChapterFiles(fileObjs, folderName) {
    const txtFiles = fileObjs.filter(f => /\.txt$/i.test(f.name));
    if (txtFiles.length === 0) {
      setWelcome('empty', 'There are no .txt chapter files in that folder yet.');
      welcomeEl.style.display = 'block';
      readerEl.style.display = 'none';
      dismissSplash();
      return;
    }

    libraryKey = folderName || 'default';

    // Parse first, sort second — sorting on raw filenames before
    // parsing (the old approach) meant order was only ever as good as
    // however the files happened to be named, which is exactly the
    // "depends on Files app order" problem. Each chapter's real title
    // (and the number in it) only exists after parseChapterFile() reads
    // the file's actual content, so that has to happen before ordering
    // is decided, not after.
    const deleted = getDeletedSet();
    const loaded = [];
    for (const f of txtFiles) {
      if (deleted.has(f.name)) continue;
      loaded.push(parseChapterFile(f.name, f.text));
    }
    loaded.sort(compareChapters);

    chapters = loaded;
    renderChapterList();
    emptyNote.style.display = 'none';

    chaptersFolderStatus.textContent = 'Novel: ' + folderName;
    openChaptersBtn.style.display = 'none';

    if (chapters.length === 0) {
      alert("All chapters in this folder were removed from the reader list. Add files or clear app storage to reset.");
      dismissSplash();
      return;
    }

    const last = getLastChapter();
    const resumeIndex = last ? chapters.findIndex(c => c.filename === last) : -1;
    openChapter(resumeIndex !== -1 ? resumeIndex : 0);
    dismissSplash();
  }

  window.onFolderPicked = function (folderName, filesJson) {
    try {
      const files = JSON.parse(filesJson);
      processChapterFiles(files, folderName);
    } catch (e) {
      console.error('Failed to parse folder contents', e);
      alert('Could not read that folder.');
      dismissSplash();
    }
  };

  window.onFolderPickError = function (message) {
    if (message) {
      chaptersFolderStatus.textContent = message;
    }
    // Permission missing is the normal first-run case, not a fault: show
    // the setup guide. Anything else is a genuine error. The "Allow access"
    // button is hidden by default and only appears when permission is
    // actually missing, never while the app is just launching/loading.
    if (!message || /permission|access|granted/i.test(message)) {
      openChaptersBtn.style.display = '';
      setWelcome('setup');
    } else {
      openChaptersBtn.style.display = 'none';
      setWelcome('error', message);
    }
    welcomeEl.style.display = 'block';
    readerEl.style.display = 'none';
    dismissSplash();
  };

  const CURRENT_NOVEL_KEY = 'novelReader_currentNovel';
  const novelPickerEl = document.getElementById('novel-picker');
  const novelGridEl = document.getElementById('novel-grid');
  const novelPickerSub = document.getElementById('novel-picker-sub');
  const novelPickerCloseBtn = document.getElementById('novel-picker-close');
  const libraryBtn = document.getElementById('library-btn');

  window.onNovelsListed = function (namesJson) {
    let names;
    try {
      names = JSON.parse(namesJson);
    } catch (e) {
      console.error('Failed to parse novel list', e);
      return;
    }

    if (!Array.isArray(names) || names.length === 0) {
      novelSelect.classList.add('hidden');
      novelSelect.innerHTML = '';
      chaptersFolderStatus.textContent = '';
      emptyNote.style.display = '';
      setWelcome('setup');
      dismissSplash();
      return;
    }

    // A novel list only arrives when storage access is granted.
    openChaptersBtn.style.display = 'none';
    novelSelect.innerHTML = '';
    names.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      novelSelect.appendChild(opt);
    });
    // The cover library replaces the dropdown as the way to pick a novel.
    novelSelect.classList.add('hidden');
    libraryBtn.style.display = '';
    libraryNames = names;

    // Already reading something this session (e.g. the list was refreshed
    // after returning from Settings): leave the reader alone.
    if (chosenNovel) return;

    // Fresh launch: show the library. The splash lifts once it is up.
    showNovelPicker(false);
    dismissSplash();
  };

  /* ---- Library screen: pick a novel by its cover ---- */
  let libraryNames = [];
  let chosenNovel = null;
  let coversToken = 0;

  function showNovelPicker(fromReader) {
    novelPickerEl.classList.remove('hidden');
    novelPickerCloseBtn.style.display = (fromReader && chapters.length > 0) ? '' : 'none';
    novelPickerSub.textContent = libraryNames.length + (libraryNames.length === 1 ? ' novel' : ' novels');
    novelPickerEl.scrollTop = 0;
    renderNovelGrid();
  }

  function hideNovelPicker() {
    novelPickerEl.classList.add('hidden');
    coversToken++; // stop any cover loading in progress
  }

  function renderNovelGrid() {
    novelGridEl.innerHTML = '';
    const token = ++coversToken;
    const cards = [];
    libraryNames.forEach((name, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'novel-card';
      card.style.setProperty('--i', Math.min(i, 12));
      card.dataset.name = name;

      const cover = document.createElement('div');
      cover.className = 'novel-cover';
      const ph = document.createElement('div');
      ph.className = 'nc-ph';
      ph.appendChild(svgIcon('i-planet'));
      const initial = document.createElement('b');
      initial.textContent = (name.trim().charAt(0) || '?').toUpperCase();
      ph.appendChild(initial);
      cover.appendChild(ph);

      const title = document.createElement('div');
      title.className = 'novel-name';
      title.textContent = name;

      card.appendChild(cover);
      card.appendChild(title);

      const last = localStorage.getItem('novelReader_lastChapter_' + name);
      if (last) {
        const cap = document.createElement('div');
        cap.className = 'novel-last';
        cap.textContent = last.replace(/\.txt$/i, '');
        card.appendChild(cap);
      }

      card.addEventListener('click', () => chooseNovel(name));
      novelGridEl.appendChild(card);
      cards.push({ name, cover, ph });
    });

    // Covers load one at a time so the grid appears instantly and a big
    // library never freezes the first screen.
    const bridge = window.AndroidBridge;
    if (!bridge || !bridge.getNovelCover) return;
    let idx = 0;
    (function next() {
      if (token !== coversToken || idx >= cards.length) return;
      const c = cards[idx++];
      let uri = '';
      try { uri = bridge.getNovelCover(c.name) || ''; } catch (e) { uri = ''; }
      if (uri) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = uri;
        c.cover.appendChild(img);
        c.ph.style.display = 'none';
      }
      setTimeout(next, 30);
    })();
  }

  function chooseNovel(name) {
    hideNovelPicker();
    // Re-choosing the novel that's already open just returns to it.
    if (name === chosenNovel && chapters.length > 0) return;
    chosenNovel = name;
    novelSelect.value = name;
    chapters = [];
    currentIndex = -1;
    chapterListEl.innerHTML = '';
    setWelcome('loading');
    welcomeEl.style.display = 'block';
    readerEl.style.display = 'none';
    requestNovelLoad(name);
  }

  libraryBtn.addEventListener('click', () => {
    if (window.innerWidth <= 720) {
      const close = document.getElementById('sidebar-close');
      if (close) close.click();
    }
    showNovelPicker(true);
  });
  novelPickerCloseBtn.addEventListener('click', hideNovelPicker);

  /* Android back button/gesture. MainActivity asks this first; returning
     true means "I closed something, don't leave the app". Closes the
     top-most thing: dialog, then the library (when opened from a novel),
     then any open panel (which also closes the menu behind it), then the
     chapter menu itself. At the launch library, or with nothing open,
     it returns false and back leaves the app as usual. */
  window.handleBack = function () {
    if (nightLocked) return false; // locked: back just leaves the app
    if (dialogOpen) { closeDialog(); return true; }
    if (!novelPickerEl.classList.contains('hidden')) {
      if (chapters.length > 0) { hideNovelPicker(); return true; }
      return false;
    }
    if (anyPanelOpen()) { closeAllPanels(); return true; }
    if (sidebarIsOpen()) { sidebar.classList.add('collapsed'); syncScrim(); return true; }
    return false;
  };

  function requestNovelLoad(novelName) {
    localStorage.setItem(CURRENT_NOVEL_KEY, novelName);
    if (window.AndroidBridge && window.AndroidBridge.loadNovel) {
      window.AndroidBridge.loadNovel(novelName);
    }
  }

  novelSelect.addEventListener('change', () => {
    // Switching novels: reset the reading pane until the new novel's
    // chapters arrive, so stale content isn't shown mid-switch.
    chapters = [];
    currentIndex = -1;
    chapterListEl.innerHTML = '';
    welcomeEl.style.display = 'block';
    readerEl.style.display = 'none';
    requestNovelLoad(novelSelect.value);
  });

  function pickChaptersFolder() {
    if (window.AndroidBridge && window.AndroidBridge.pickFolder) {
      window.AndroidBridge.pickFolder();
    } else {
      alert('Storage access is not available. This app needs to run as the installed Android app, not a plain browser tab.');
    }
  }

  openChaptersBtn.addEventListener('click', pickChaptersFolder);

  // On startup, ask the native side to silently reconnect to a
  // previously-granted folder, if any.
  if (window.AndroidBridge && window.AndroidBridge.tryAutoReconnect) {
    window.AndroidBridge.tryAutoReconnect();
  } else {
    // Opened outside the Android app: nothing will ever answer, so show
    // the guide and let the splash go instead of waiting for its timeout.
    setWelcome('setup');
    dismissSplash();
  }

  function renderChapterList(filter) {
    chapterListEl.innerHTML = '';
    const f = (filter || '').toLowerCase();
    chapters.forEach((ch, i) => {
      if (f && !ch.title.toLowerCase().includes(f)) return;
      const li = document.createElement('li');
      li.className = 'chapter-item';

      const label = document.createElement('span');
      label.className = 'chapter-item-label';
      label.textContent = ch.title;
      label.addEventListener('click', () => openChapter(i));

      li.appendChild(label);
      if (i === currentIndex) li.classList.add('active');
      chapterListEl.appendChild(li);
    });
    // Not while searching: a filtered list should start at its first match.
    if (!f) scrollActiveChapterIntoMenu();
  }

  /* Keep the chapter you're on visible in the menu: scrolled to just below
     the top (one chapter of context above it). Near the end of a long
     novel the list can't scroll that far, so the browser clamps it and the
     last chapters simply sit at the bottom with the current one in view. */
  function scrollActiveChapterIntoMenu() {
    const li = chapterListEl.querySelector('li.active');
    if (!li) return;
    const lr = li.getBoundingClientRect();
    if (!lr.height) return; // list not laid out right now; retried on open
    const cr = chapterListEl.getBoundingClientRect();
    chapterListEl.scrollTop += (lr.top - cr.top) - lr.height * 1.5;
  }

  // Re-centre on the current chapter every time the menu is opened, since
  // you may have scrolled the list around last time.
  new MutationObserver(() => {
    if (!sidebar.classList.contains('collapsed')) scrollActiveChapterIntoMenu();
  }).observe(sidebar, { attributes: true, attributeFilter: ['class'] });

  function openChapter(index) {
    if (index < 0 || index >= chapters.length) return;
    const prevIndex = currentIndex;
    currentIndex = index;
    const ch = chapters[index];

    // Page-flip animation: only when actually moving from one chapter
    // to another (not on the very first chapter opened at startup).
    // Jumping several chapters at once (e.g. picking one far down the
    // menu) plays a longer flip than a single-chapter step.
    if (prevIndex !== -1 && prevIndex !== index) {
      const distance = Math.abs(index - prevIndex);
      const duration = Math.min(flipDurationBase + distance * 60, flipDurationBase + 800);
      readerEl.style.setProperty('--flip-duration', duration + 'ms');
      readerEl.classList.remove('flip-next', 'flip-prev');
      // Force reflow so re-adding the class restarts the animation
      // even if a previous flip is still finishing.
      void readerEl.offsetWidth;
      readerEl.classList.add(index > prevIndex ? 'flip-next' : 'flip-prev');
      clearTimeout(flipTimer);
      flipTimer = setTimeout(() => {
        readerEl.classList.remove('flip-next', 'flip-prev');
      }, duration);
    }

    welcomeEl.style.display = 'none';
    readerEl.style.display = 'block';

    chapterTitleEl.textContent = ch.title;
    chapterTextEl.innerHTML = '';
    let paraIndex = 0;
    ch.text.split(/\n\s*\n/).forEach(para => {
      const trimmed = para.trim();
      if (!trimmed) return;
      if (isNoiseParagraph(trimmed, ch.title)) return;
      const p = document.createElement('p');
      p.textContent = trimmed;
      p.dataset.paragraphIndex = paraIndex;
      if (isParagraphBookmarked(ch.filename, paraIndex)) {
        p.classList.add('paragraph-bookmarked');
      }
      chapterTextEl.appendChild(p);
      paraIndex++;
    });

    updateChapterBookmarkButton();
    renderBookmarksList();

    saveLastChapter(ch.filename);

    renderChapterList(searchInput.value);
    updateNavButtons();
    document.getElementById('topbar').classList.remove('hidden');

    // Restore reading progress for this chapter (0 for a chapter never
    // opened before, or one finished/reset). Wait a tick so the browser
    // has laid out the freshly-inserted paragraphs and scrollHeight is
    // accurate before we compute the target scroll position.
    requestAnimationFrame(() => {
      const fraction = getScrollProgress(ch.filename);
      const maxScroll = readerScrollEl.scrollHeight - readerScrollEl.clientHeight;
      readerScrollEl.scrollTop = maxScroll > 0 ? fraction * maxScroll : 0;
    });

    if (isMobileViewport()) {
      sidebar.classList.add('collapsed');
      syncScrim();
    }
  }

  function updateNavButtons() {
    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex < chapters.length - 1;
    [prevBtn, bottomPrev].forEach(b => b.disabled = !hasPrev);
    [nextBtn, bottomNext].forEach(b => b.disabled = !hasNext);

    const openTermuxBtn = document.getElementById('open-termux-btn');
    openTermuxBtn.classList.toggle('hidden', hasNext || currentIndex === -1);
  }

  document.getElementById('open-termux-btn').addEventListener('click', () => {
    if (window.AndroidBridge && window.AndroidBridge.openTermux) {
      window.AndroidBridge.openTermux();
    } else {
      alert('Termux launch is only available in the installed app.');
    }
  });

  prevBtn.addEventListener('click', () => openChapter(currentIndex - 1));
  nextBtn.addEventListener('click', () => openChapter(currentIndex + 1));
  bottomPrev.addEventListener('click', () => openChapter(currentIndex - 1));
  bottomNext.addEventListener('click', () => openChapter(currentIndex + 1));

  searchInput.addEventListener('input', () => renderChapterList(searchInput.value));

  toggleSidebarBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    syncScrim();
  });

  // See the #sidebar-close CSS comment: on mobile, #toggle-sidebar sits
  // inside #topbar's own stacking context and structurally can't be
  // raised above the open drawer, so this separate button (shown only
  // while the drawer is open, positioned outside #topbar) is the one
  // that actually closes it from on-canvas. Same action as the button
  // that opened it.
  const sidebarCloseBtn = document.getElementById('sidebar-close');
  sidebarCloseBtn.addEventListener('click', () => {
    sidebar.classList.add('collapsed');
    syncScrim();
  });

  fontSmaller.addEventListener('click', () => {
    fontSize = Math.max(13, fontSize - 1);
    chapterTextEl.style.fontSize = fontSize + 'px';
    savePreference('fontSize', fontSize);
  });
  fontBigger.addEventListener('click', () => {
    fontSize = Math.min(32, fontSize + 1);
    chapterTextEl.style.fontSize = fontSize + 'px';
    savePreference('fontSize', fontSize);
  });

  const fontFamilySelect = document.getElementById('font-family-select');
  fontFamilySelect.addEventListener('change', () => {
    chapterTextEl.style.fontFamily = fontFamilySelect.value;
    savePreference('fontFamily', fontFamilySelect.value);
  });

  /* ---- Appearance preferences: font size/family + reading colors,
     persisted across app restarts. ---- */

  const PREFS_KEY = 'novelReader_appearance';
  // Defaults match the reference settings screenshot: black background,
  // mid-grey text, slightly tighter line height, a little extra letter
  // spacing and a ~2.35s page flip. "Reset to default" returns here too.
  const DEFAULT_BG = '#0b0d12';
  const DEFAULT_TEXT = '#cfc9bb';
  const DEFAULT_LINE_HEIGHT = 1.7;
  const DEFAULT_LETTER_SPACING = 2.3;
  const DEFAULT_FLIP_DURATION = 1250;
  const DEFAULT_TAP_SCROLL_LINES = 27;
  // How many lines a tap-to-scroll gesture moves the reading pane by —
  // user-adjustable via the same theme panel as the colours (see the
  // "Tap-to-scroll amount" slider). Read by the gesture handler further
  // down; kept as a plain variable (not re-read from localStorage on
  // every tap) for the same reason flipDurationBase is.
  let tapScrollLines = DEFAULT_TAP_SCROLL_LINES;

  // Smart scroll: instead of moving a fixed number of lines, a tap finds
  // whichever paragraph is currently cut off at the edge of the screen
  // and scrolls just far enough to bring it fully into view at the top
  // (or bottom, when scrolling up) — so a tap never leaves you mid­
  // sentence. Off by default since it's a bigger behavior change than
  // the other reading preferences; toggled in the theme panel.
  const DEFAULT_SMART_SCROLL = false;
  let smartScrollEnabled = DEFAULT_SMART_SCROLL;

  // Volume buttons scroll the page while reading (on by default, as it has
  // always behaved). Switch it off in the theme panel to make them change
  // the volume everywhere. Either way they change the volume whenever a
  // menu/panel is open — see window.scrollReaderByVolumeKey().
  const DEFAULT_VOLUME_SCROLL = true;
  let volumeScrollEnabled = DEFAULT_VOLUME_SCROLL;

  // While the audio player panel is open, the volume buttons change the
  // media volume (on by default). Switch it off in the theme panel and they
  // keep scrolling the page even with the audio player open. Other menus
  // (drawer, other panels) always give the buttons to the volume.
  const DEFAULT_AUDIO_VOLUME_KEYS = true;
  let audioVolumeKeysEnabled = DEFAULT_AUDIO_VOLUME_KEYS;

  // Screen brightness follows the phone's light sensor (see AdaptiveBrightness.kt): brighter in
  // strong light, down to the dimmest in a dark room. Off by default, so the phone's own
  // brightness setting applies until it is switched on in the theme panel.
  const DEFAULT_ADAPTIVE_BRIGHTNESS = false;
  let adaptiveBrightnessEnabled = DEFAULT_ADAPTIVE_BRIGHTNESS;

  function loadPreferences() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function savePreference(key, value) {
    const prefs = loadPreferences();
    prefs[key] = value;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }

  /* ---- Colour helpers: the two reading colours drive the WHOLE UI ----
     Page colour -> every surface (menus, panels, borders).
     Text colour -> all text and all icons (including the accent). */
  function hexToRgb(hex) {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n) || h.length !== 6) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  // Moves colour `a` a fraction t of the way towards colour `b`.
  function mixHex(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
  }
  function rgbaHex(hex, alpha) {
    const c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  }
  function luminance(hex) {
    const c = hexToRgb(hex).map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function applyUiTheme(bg, text) {
    const st = document.documentElement.style;
    const isLight = luminance(bg) > 0.4;
    st.setProperty('--bg', bg);
    st.setProperty('--panel', bg);
    st.setProperty('--panel-2', mixHex(bg, text, 0.07));
    st.setProperty('--raised', mixHex(bg, text, 0.12));
    st.setProperty('--border', mixHex(bg, text, 0.17));
    st.setProperty('--border-strong', mixHex(bg, text, 0.27));
    st.setProperty('--text', text);
    st.setProperty('--muted', mixHex(text, bg, 0.28));
    st.setProperty('--faint', mixHex(text, bg, 0.48));
    // Icons use the accent in several places; make it the text colour so
    // every icon matches the text.
    st.setProperty('--accent', text);
    st.setProperty('--accent-strong', mixHex(text, isLight ? '#000000' : '#ffffff', 0.15));
    st.setProperty('--accent-ink', bg);
    st.setProperty('--accent-soft', rgbaHex(text, 0.13));
    st.setProperty('--accent-line', rgbaHex(text, 0.42));
    st.setProperty('--overlay', rgbaHex(bg, 0.93));
    st.setProperty('--overlay-soft', rgbaHex(bg, 0.5));
    st.colorScheme = isLight ? 'light' : 'dark';
    try {
      if (window.AndroidBridge && window.AndroidBridge.setThemeColors) {
        window.AndroidBridge.setThemeColors(bg, isLight);
      }
    } catch (e) { /* native side not available */ }
  }

  function applyReadingColors(bg, text) {
    document.documentElement.style.setProperty('--read-bg', bg);
    document.documentElement.style.setProperty('--read-text', text);
    bgColorInput.value = bg;
    textColorInput.value = text;
    applyUiTheme(bg, text);
    updatePresetButtons(bg, text);
    renderRecentColors();
  }

  function applyLineHeight(value) {
    chapterTextEl.style.lineHeight = value;
    lineHeightInput.value = value;
    updateSliderFill(lineHeightInput);
  }

  function applyLetterSpacing(value) {
    chapterTextEl.style.letterSpacing = value + 'px';
    letterSpacingInput.value = value;
    updateSliderFill(letterSpacingInput);
  }

  function applyFlipDuration(value) {
    flipDurationBase = parseInt(value, 10) || DEFAULT_FLIP_DURATION;
    flipDurationInput.value = flipDurationBase;
    updateSliderFill(flipDurationInput);
  }

  function applyTapScrollLines(value) {
    tapScrollLines = parseInt(value, 10) || DEFAULT_TAP_SCROLL_LINES;
    tapScrollLinesInput.value = tapScrollLines;
    updateSliderFill(tapScrollLinesInput);
  }

  function applySmartScroll(enabled) {
    smartScrollEnabled = !!enabled;
    smartScrollToggle.classList.toggle('on', smartScrollEnabled);
    smartScrollToggle.setAttribute('aria-checked', String(smartScrollEnabled));
    // The fixed line-count slider only governs the fallback path (see
    // computeTapScrollPx's caller), so grey it out rather than remove it
    // — turning smart scroll back off should restore whatever amount
    // was set before, not reset it.
    tapScrollRow.classList.toggle('disabled', smartScrollEnabled);
  }

  // Returns the setting actually in force: it stays off on a phone with no light sensor.
  function applyAdaptiveBrightness(enabled) {
    adaptiveBrightnessEnabled = !!enabled;
    const bridge = window.AndroidBridge;
    if (bridge && bridge.setAdaptiveBrightness) {
      try {
        if (!bridge.setAdaptiveBrightness(adaptiveBrightnessEnabled)) adaptiveBrightnessEnabled = false;
      } catch (e) { adaptiveBrightnessEnabled = false; }
    }
    adaptiveBrightnessToggle.classList.toggle('on', adaptiveBrightnessEnabled);
    adaptiveBrightnessToggle.setAttribute('aria-checked', String(adaptiveBrightnessEnabled));
    return adaptiveBrightnessEnabled;
  }

  function applyVolumeScroll(enabled) {
    volumeScrollEnabled = !!enabled;
    const btn = document.getElementById('volume-scroll-toggle');
    if (btn) {
      btn.classList.toggle('on', volumeScrollEnabled);
      btn.setAttribute('aria-checked', String(volumeScrollEnabled));
    }
    // Native side decides on the key press itself, so it needs to know.
    try {
      if (window.AndroidBridge && window.AndroidBridge.setVolumeScrollEnabled) {
        window.AndroidBridge.setVolumeScrollEnabled(volumeScrollEnabled);
      }
    } catch (e) { /* ignore */ }
  }

  function applyAudioVolumeKeys(enabled) {
    audioVolumeKeysEnabled = !!enabled;
    const btn = document.getElementById('audio-volume-keys-toggle');
    if (btn) {
      btn.classList.toggle('on', audioVolumeKeysEnabled);
      btn.setAttribute('aria-checked', String(audioVolumeKeysEnabled));
    }
    // Tell the native side straight away (reportMenuState isn't ready yet
    // while preferences are first restored at startup, hence the guard).
    try { reportMenuState(); } catch (e) { /* not ready yet */ }
  }

  const themeToggleBtn = document.getElementById('theme-toggle');
  const themePanel = document.getElementById('theme-panel');
  const bgColorInput = document.getElementById('bg-color-input');
  const textColorInput = document.getElementById('text-color-input');
  const lineHeightInput = document.getElementById('line-height-input');
  const letterSpacingInput = document.getElementById('letter-spacing-input');
  const flipDurationInput = document.getElementById('flip-duration-input');
  const tapScrollLinesInput = document.getElementById('tap-scroll-lines-input');
  const tapScrollRow = document.getElementById('tap-scroll-row');
  const smartScrollToggle = document.getElementById('smart-scroll-toggle');
  const adaptiveBrightnessToggle = document.getElementById('adaptive-brightness-toggle');
  const themeResetBtn = document.getElementById('theme-reset-btn');
  const audioToggleBtn = document.getElementById('audio-toggle');
  const audioToggleTopBtn = document.getElementById('audio-toggle-top');
  const audioPanel = document.getElementById('audio-panel');


  /* Open/close helper shared by all three popup panels.
     Two things used to go wrong here and are fixed by this helper:
       1. The old "close when clicking outside" checks compared
          e.target === theButton. That only holds when the button has no
          child elements — the session timer button renders an icon span
          inside it, so a tap landed on the span, the document handler
          decided the click was "outside", and immediately closed the
          panel the button had just opened. Using closest() on the
          button means a tap anywhere inside it counts as the button.
       2. Opening one panel now closes the other two, so they can't end
          up stacked on top of each other. */
  const panelScrim = document.getElementById('panel-scrim');

  function syncPanelScrim() {
    const anyOpen = [themePanel, bookmarksPanel, sessionSettingsPanel, audioPanel]
      .some(p => p && !p.classList.contains('hidden'));
    panelScrim.classList.toggle('visible', isMobileViewport() && anyOpen);
  }

  function closeAllPanels(except) {
    [themePanel, bookmarksPanel, sessionSettingsPanel, audioPanel].forEach(p => {
      if (p && p !== except) p.classList.add('hidden');
    });
    syncPanelScrim();
    // Only when every panel is being closed outright (no `except` — i.e.
    // not just switching from one panel to another): also close the
    // sidebar drawer these panels are opened from on mobile. Otherwise
    // dismissing a panel left the drawer stranded open behind it, its
    // scrim still blocking taps on the page — reachable only by then
    // separately closing the drawer too.
    if (!except && sidebarIsOpen()) {
      sidebar.classList.add('collapsed');
      syncScrim();
    }
  }

  function togglePanel(panel, onOpen) {
    const willOpen = panel.classList.contains('hidden');
    closeAllPanels(panel);
    panel.classList.toggle('hidden', !willOpen);
    syncPanelScrim();
    if (willOpen && typeof onOpen === 'function') onOpen();
  }

  // Tapping the dimmed backdrop closes whichever panel is open, same
  // gesture as the sidebar's own scrim.
  panelScrim.addEventListener('click', () => closeAllPanels());
  window.addEventListener('resize', syncPanelScrim);

  // One delegated listener for every panel's close (✕) button, rather
  // than four separate ones — see the .panel-close CSS comment for why
  // these exist (the panel scrim can cover the icon that opened a
  // panel, so re-tapping it isn't always reachable).
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-panel]')) closeAllPanels();
  });

  /* Swipe the music panel left-to-right to close it, like its ✕ button.
     It only counts as a swipe when the finger moves mostly sideways, far and
     quickly enough, so scrolling the lists, dragging the seek/volume sliders
     and tapping are all unaffected. */
  (function () {
    if (!audioPanel) return;
    const MIN_DX = 70, MAX_MS = 800;
    let sx = 0, sy = 0, st = 0, tracking = false;

    // True when the touch started somewhere that needs sideways drags itself.
    function ownsHorizontalDrag(target) {
      for (let el = target; el && el !== audioPanel; el = el.parentElement) {
        if (el.matches && el.matches('input, textarea, select, #sp-sheet')) return true;
        if (el.scrollWidth > el.clientWidth + 1 && el.scrollLeft > 0) {
          const ox = getComputedStyle(el).overflowX;
          if (ox === 'auto' || ox === 'scroll') return true;
        }
      }
      return false;
    }

    audioPanel.addEventListener('touchstart', (e) => {
      tracking = e.touches.length === 1 && !ownsHorizontalDrag(e.target);
      if (!tracking) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });

    audioPanel.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) tracking = false;
    }, { passive: true });

    audioPanel.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (dx >= MIN_DX && Math.abs(dy) <= dx * 0.6 && Date.now() - st <= MAX_MS) {
        closeAllPanels();
      }
    }, { passive: true });
    audioPanel.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
  })();

  // Close a panel when tapping anywhere outside it and outside its
  // trigger button. `triggers` is a list of CSS selectors.
  function closeOnOutsideClick(panel, triggers) {
    document.addEventListener('click', (e) => {
      if (panel.classList.contains('hidden')) return;
      // e.composedPath() is the click's original ancestor chain, fixed
      // at dispatch time — unlike e.target/e.target.closest(), it stays
      // correct even if an earlier same-event listener (e.g. a queue
      // item's own click handler triggering a re-render) has already
      // removed the clicked element from the document by the time this
      // listener runs. Checking e.target directly here previously meant
      // a rebuilt/detached target always looked "outside" the panel,
      // closing it even for clicks that were clearly inside it.
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.includes(panel)) return;
      if (triggers.some(sel => path.some(el => el.matches && el.matches(sel)))) return;
      panel.classList.add('hidden');
    });
  }

  themeToggleBtn.addEventListener('click', () => togglePanel(themePanel));

  closeOnOutsideClick(themePanel, ['#theme-toggle']);

  /* ---- Audio player panel ----
     The panel's contents are driven by audio-player.js (loaded before
     this file). reader.js owns only the open/close behaviour, so the
     player stays a self-contained module you can keep building on
     without touching the reader. */
  [audioToggleBtn, audioToggleTopBtn].forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      togglePanel(audioPanel, () => {
        if (window.NovelAudio && window.NovelAudio.onPanelOpened) {
          window.NovelAudio.onPanelOpened();
        }
      });
    });
  });

  closeOnOutsideClick(audioPanel, ['#audio-toggle', '#audio-toggle-top']);

  // Hand the player its DOM once, at startup.
  if (window.NovelAudio && window.NovelAudio.init) {
    window.NovelAudio.init();
  }

  bgColorInput.addEventListener('input', () => {
    applyReadingColors(bgColorInput.value, textColorInput.value);
    savePreference('readBg', bgColorInput.value);
  });

  textColorInput.addEventListener('input', () => {
    applyReadingColors(bgColorInput.value, textColorInput.value);
    savePreference('readText', textColorInput.value);
    savePreference('themePreset', 'custom');
  });
  bgColorInput.addEventListener('input', () => savePreference('themePreset', 'custom'));

  /* ---- Presets (light / dark) ---- */
  const THEME_PRESETS = {
    dark:  { bg: DEFAULT_BG,  text: DEFAULT_TEXT },
    light: { bg: '#f6f1e7',   text: '#2b2723' }
  };
  const presetButtons = Array.from(document.querySelectorAll('.preset-btn'));

  function updatePresetButtons(bg, text) {
    presetButtons.forEach(btn => {
      const preset = THEME_PRESETS[btn.dataset.preset];
      const on = !!preset && preset.bg.toLowerCase() === String(bg).toLowerCase() &&
                 preset.text.toLowerCase() === String(text).toLowerCase();
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = THEME_PRESETS[btn.dataset.preset];
      if (!preset) return;
      applyReadingColors(preset.bg, preset.text);
      savePreference('readBg', preset.bg);
      savePreference('readText', preset.text);
      savePreference('themePreset', btn.dataset.preset);
    });
  });

  /* ---- Recently used colours (remembered per picker) ---- */
  const RECENT_MAX = 6;
  const recentContainers = {
    recentBg:   document.getElementById('recent-bg-colors'),
    recentText: document.getElementById('recent-text-colors')
  };

  function rememberColor(prefKey, color) {
    const c = String(color).toLowerCase();
    const prefs = loadPreferences();
    const list = Array.isArray(prefs[prefKey]) ? prefs[prefKey] : [];
    const next = [c].concat(list.filter(x => String(x).toLowerCase() !== c)).slice(0, RECENT_MAX);
    savePreference(prefKey, next);
    renderRecentColors();
  }

  function renderRecentColors() {
    const prefs = loadPreferences();
    [['recentBg', bgColorInput], ['recentText', textColorInput]].forEach(([prefKey, input]) => {
      const box = recentContainers[prefKey];
      if (!box) return;
      const list = Array.isArray(prefs[prefKey]) ? prefs[prefKey] : [];
      box.innerHTML = '';
      list.forEach(color => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'recent-swatch' + (String(input.value).toLowerCase() === String(color).toLowerCase() ? ' current' : '');
        b.style.background = color;
        b.title = color;
        b.setAttribute('aria-label', 'Use colour ' + color);
        b.dataset.color = color;
        b.dataset.pref = prefKey;
        box.appendChild(b);
      });
    });
  }

  Object.keys(recentContainers).forEach(prefKey => {
    const box = recentContainers[prefKey];
    if (!box) return;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.recent-swatch');
      if (!b) return;
      const isBg = prefKey === 'recentBg';
      const bg = isBg ? b.dataset.color : bgColorInput.value;
      const text = isBg ? textColorInput.value : b.dataset.color;
      applyReadingColors(bg, text);
      savePreference(isBg ? 'readBg' : 'readText', b.dataset.color);
      savePreference('themePreset', 'custom');
      rememberColor(prefKey, b.dataset.color);
    });
  });

  // 'change' fires when the picker is dismissed (not on every drag), so
  // only the colour the user actually settled on is remembered.
  bgColorInput.addEventListener('change', () => rememberColor('recentBg', bgColorInput.value));
  textColorInput.addEventListener('change', () => rememberColor('recentText', textColorInput.value));

  lineHeightInput.addEventListener('input', () => {
    applyLineHeight(lineHeightInput.value);
    savePreference('lineHeight', parseFloat(lineHeightInput.value));
  });

  letterSpacingInput.addEventListener('input', () => {
    applyLetterSpacing(letterSpacingInput.value);
    savePreference('letterSpacing', parseFloat(letterSpacingInput.value));
  });

  flipDurationInput.addEventListener('input', () => {
    applyFlipDuration(flipDurationInput.value);
    savePreference('flipDuration', flipDurationBase);
  });

  tapScrollLinesInput.addEventListener('input', () => {
    applyTapScrollLines(tapScrollLinesInput.value);
    savePreference('tapScrollLines', tapScrollLines);
  });

  smartScrollToggle.addEventListener('click', () => {
    applySmartScroll(!smartScrollEnabled);
    savePreference('smartScroll', smartScrollEnabled);
  });

  adaptiveBrightnessToggle.addEventListener('click', () => {
    savePreference('adaptiveBrightness', applyAdaptiveBrightness(!adaptiveBrightnessEnabled));
  });

  document.getElementById('volume-scroll-toggle').addEventListener('click', () => {
    applyVolumeScroll(!volumeScrollEnabled);
    savePreference('volumeScroll', volumeScrollEnabled);
  });

  document.getElementById('audio-volume-keys-toggle').addEventListener('click', () => {
    applyAudioVolumeKeys(!audioVolumeKeysEnabled);
    savePreference('audioVolumeKeys', audioVolumeKeysEnabled);
  });

  themeResetBtn.addEventListener('click', () => {
    applyReadingColors(DEFAULT_BG, DEFAULT_TEXT);
    applyLineHeight(DEFAULT_LINE_HEIGHT);
    applyLetterSpacing(DEFAULT_LETTER_SPACING);
    applyFlipDuration(DEFAULT_FLIP_DURATION);
    applyTapScrollLines(DEFAULT_TAP_SCROLL_LINES);
    applySmartScroll(DEFAULT_SMART_SCROLL);
    applyVolumeScroll(DEFAULT_VOLUME_SCROLL);
    savePreference('volumeScroll', DEFAULT_VOLUME_SCROLL);
    applyAudioVolumeKeys(DEFAULT_AUDIO_VOLUME_KEYS);
    savePreference('audioVolumeKeys', DEFAULT_AUDIO_VOLUME_KEYS);
    applyAdaptiveBrightness(DEFAULT_ADAPTIVE_BRIGHTNESS);
    savePreference('adaptiveBrightness', DEFAULT_ADAPTIVE_BRIGHTNESS);
    savePreference('readBg', DEFAULT_BG);
    savePreference('readText', DEFAULT_TEXT);
    savePreference('lineHeight', DEFAULT_LINE_HEIGHT);
    savePreference('letterSpacing', DEFAULT_LETTER_SPACING);
    savePreference('flipDuration', DEFAULT_FLIP_DURATION);
    savePreference('tapScrollLines', DEFAULT_TAP_SCROLL_LINES);
    savePreference('smartScroll', DEFAULT_SMART_SCROLL);
    savePreference('themePreset', 'dark');
  });


  // Apply saved preferences on startup.
  (function restoreAppearance() {
    const prefs = loadPreferences();

    if (typeof prefs.fontSize === 'number') {
      fontSize = prefs.fontSize;
    }
    chapterTextEl.style.fontSize = fontSize + 'px';

    const fontFamily = prefs.fontFamily || fontFamilySelect.value;
    fontFamilySelect.value = fontFamily;
    chapterTextEl.style.fontFamily = fontFamily;

    applyReadingColors(prefs.readBg || DEFAULT_BG, prefs.readText || DEFAULT_TEXT);
    applyLineHeight(typeof prefs.lineHeight === 'number' ? prefs.lineHeight : DEFAULT_LINE_HEIGHT);
    applyLetterSpacing(typeof prefs.letterSpacing === 'number' ? prefs.letterSpacing : DEFAULT_LETTER_SPACING);
    applyFlipDuration(typeof prefs.flipDuration === 'number' ? prefs.flipDuration : DEFAULT_FLIP_DURATION);
    applyTapScrollLines(typeof prefs.tapScrollLines === 'number' ? prefs.tapScrollLines : DEFAULT_TAP_SCROLL_LINES);
    applySmartScroll(typeof prefs.smartScroll === 'boolean' ? prefs.smartScroll : DEFAULT_SMART_SCROLL);
    applyVolumeScroll(typeof prefs.volumeScroll === 'boolean' ? prefs.volumeScroll : DEFAULT_VOLUME_SCROLL);
    applyAudioVolumeKeys(typeof prefs.audioVolumeKeys === 'boolean' ? prefs.audioVolumeKeys : DEFAULT_AUDIO_VOLUME_KEYS);
    applyAdaptiveBrightness(typeof prefs.adaptiveBrightness === 'boolean' ? prefs.adaptiveBrightness : DEFAULT_ADAPTIVE_BRIGHTNESS);
  })();

  /* ---- Bookmarking UI: chapter toggle button, paragraph long-press,
     and a panel listing every bookmark for the current novel. ---- */

  const bookmarkToggleBtn = document.getElementById('bookmark-toggle');
  const bookmarksPanel = document.getElementById('bookmarks-panel');
  const bookmarkChapterBtn = document.getElementById('bookmark-chapter-btn');
  const bookmarksListEl = document.getElementById('bookmarks-list');
  const bookmarksEmptyEl = document.getElementById('bookmarks-empty');

  function updateChapterBookmarkButton() {
    if (currentIndex === -1) return;
    const ch = chapters[currentIndex];
    const bookmarked = isChapterBookmarked(ch.filename);
    bookmarkChapterBtn.querySelector('span').textContent = bookmarked ? 'Bookmarked' : 'Bookmark this chapter';
    bookmarkChapterBtn.classList.toggle('active', bookmarked);
    bookmarkToggleBtn.classList.toggle('active', bookmarked || getBookmarks().length > 0);
  }

  function renderBookmarksList() {
    const list = getBookmarks();
    bookmarksListEl.innerHTML = '';

    if (list.length === 0) {
      bookmarksEmptyEl.style.display = '';
      return;
    }
    bookmarksEmptyEl.style.display = 'none';

    list.forEach((b) => {
      const li = document.createElement('li');

      // Kind icon: a book for a whole chapter, a pilcrow for one paragraph.
      const kind = svgIcon(b.type === 'chapter' ? 'i-book' : 'i-paragraph');
      kind.classList.add('bookmark-kind');

      const label = document.createElement('span');
      label.className = 'bookmark-item-label';
      label.textContent = b.type === 'chapter'
        ? b.chapterTitle
        : b.chapterTitle + ' \u00b7 ' + b.snippet;
      label.title = label.textContent;
      li.addEventListener('click', () => jumpToBookmark(b));

      const removeBtn = document.createElement('button');
      removeBtn.className = 'bookmark-remove-btn';
      removeBtn.appendChild(svgIcon('i-close'));
      removeBtn.title = 'Remove bookmark';
      removeBtn.setAttribute('aria-label', 'Remove bookmark');
      removeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeBookmark(b);
        renderBookmarksList();
        updateChapterBookmarkButton();
        // Refresh paragraph highlighting if we removed one in the open chapter.
        if (currentIndex !== -1 && chapters[currentIndex].filename === b.filename) {
          refreshParagraphBookmarkHighlights();
        }
      });

      li.appendChild(kind);
      li.appendChild(label);
      li.appendChild(removeBtn);
      bookmarksListEl.appendChild(li);
    });
  }

  function jumpToBookmark(bookmark) {
    const targetIndex = chapters.findIndex(c => c.filename === bookmark.filename);
    if (targetIndex === -1) {
      alert('That chapter is no longer available in this novel.');
      return;
    }
    bookmarksPanel.classList.add('hidden');
    openChapter(targetIndex);
    if (bookmark.type === 'paragraph') {
      // Wait for the chapter's content and scroll-restore to settle, then
      // scroll precisely to the bookmarked paragraph.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const p = chapterTextEl.querySelector(`p[data-paragraph-index="${bookmark.paragraphIndex}"]`);
          if (p) p.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
    }
  }

  function refreshParagraphBookmarkHighlights() {
    if (currentIndex === -1) return;
    const ch = chapters[currentIndex];
    chapterTextEl.querySelectorAll('p[data-paragraph-index]').forEach(p => {
      const idx = parseInt(p.dataset.paragraphIndex, 10);
      p.classList.toggle('paragraph-bookmarked', isParagraphBookmarked(ch.filename, idx));
    });
  }

  bookmarkToggleBtn.addEventListener('click', () => {
    togglePanel(bookmarksPanel, renderBookmarksList);
  });

  closeOnOutsideClick(bookmarksPanel, ['#bookmark-toggle']);

  bookmarkChapterBtn.addEventListener('click', () => {
    if (currentIndex === -1) return;
    const ch = chapters[currentIndex];
    toggleChapterBookmark(ch.filename, ch.title);
    updateChapterBookmarkButton();
    renderBookmarksList();
  });

  // Long-press (~500ms, without much finger movement) on a paragraph
  // toggles a bookmark for that specific paragraph.
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MAX_MOVE = 12;
  let longPressTimer = null;
  let longPressStartX = 0;
  let longPressStartY = 0;
  let longPressTarget = null;
  let longPressFired = false;

  chapterTextEl.addEventListener('touchstart', (e) => {
    const p = e.target.closest && e.target.closest('p[data-paragraph-index]');
    if (!p) return;
    longPressFired = false;
    longPressStartX = e.touches[0].clientX;
    longPressStartY = e.touches[0].clientY;
    longPressTarget = p;
    longPressTimer = setTimeout(() => {
      if (currentIndex === -1) return;
      longPressFired = true;
      const ch = chapters[currentIndex];
      const idx = parseInt(p.dataset.paragraphIndex, 10);
      const snippet = p.textContent.slice(0, 60) + (p.textContent.length > 60 ? '…' : '');
      toggleParagraphBookmark(ch.filename, ch.title, idx, snippet);
      p.classList.toggle('paragraph-bookmarked', isParagraphBookmarked(ch.filename, idx));
      updateChapterBookmarkButton();
      if (navigator.vibrate) navigator.vibrate(30);
    }, LONG_PRESS_MS);
  }, { passive: true });

  chapterTextEl.addEventListener('touchmove', (e) => {
    if (!longPressTimer) return;
    const dx = Math.abs(e.touches[0].clientX - longPressStartX);
    const dy = Math.abs(e.touches[0].clientY - longPressStartY);
    if (dx > LONG_PRESS_MAX_MOVE || dy > LONG_PRESS_MAX_MOVE) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }, { passive: true });

  chapterTextEl.addEventListener('touchend', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }, { passive: true });


  /* ---- Auto-hide top bar on scroll down, reveal on scroll up;
     also save reading progress (debounced) as the user scrolls. ---- */

  let lastScrollTop = 0;
  const SCROLL_HIDE_THRESHOLD = 8; // ignore tiny/jittery scroll movements
  let scrollSaveTimer = null;

  function flushScrollProgress() {
    if (currentIndex === -1) return;
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = null;
    const ch = chapters[currentIndex];
    const maxScroll = readerScrollEl.scrollHeight - readerScrollEl.clientHeight;
    const fraction = maxScroll > 0 ? readerScrollEl.scrollTop / maxScroll : 0;
    saveScrollProgress(ch.filename, fraction);
  }

  readerScrollEl.addEventListener('scroll', () => {
    const currentScrollTop = readerScrollEl.scrollTop;
    const delta = currentScrollTop - lastScrollTop;

    if (currentScrollTop <= 0) {
      // Always show the bar once back at the very top.
      topbarEl.classList.remove('hidden');
    } else if (delta > SCROLL_HIDE_THRESHOLD) {
      topbarEl.classList.add('hidden');
      lastScrollTop = currentScrollTop;
    } else if (delta < -SCROLL_HIDE_THRESHOLD) {
      topbarEl.classList.remove('hidden');
      lastScrollTop = currentScrollTop;
    }

    if (currentIndex !== -1) {
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(flushScrollProgress, 400);
    }
  }, { passive: true });

  // Flush immediately (bypassing the 400ms debounce) whenever the app is
  // about to be backgrounded or closed, so a quick app-switch mid-scroll
  // never loses progress. 'visibilitychange' is the reliable one in
  // Android WebView; 'pagehide' is included as a fallback for good measure.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushScrollProgress();
    }
  });
  window.addEventListener('pagehide', flushScrollProgress);

  /* ---------------------------------------------------------------------
     Reading session limit — countdown timer with a dial picker.

     Reworked from the old "elapsed minutes" model into an explicit
     countdown, the way a phone Clock app's timer works: you dial in
     HH:MM:SS, press Start, and the remaining time ticks down while you
     read. At zero the break overlay appears.

     "Reading" still means the app is in the foreground — the countdown
     pauses itself whenever the app is backgrounded, so time spent in
     other apps is never counted against your limit.

     Two mutually exclusive modes:
       - 'duration': the countdown above.
       - 'time':     fire once at a specific clock time of day.

     Everything is persisted, so a timer survives the app being closed
     and reopened; the remaining time is stored, not the end timestamp,
     precisely because backgrounded time shouldn't count.
  --------------------------------------------------------------------- */

  const SESSION_MODE_KEY = 'novelReader_sessionLimitMode'; // 'time' | 'duration' | 'off'
  const SESSION_TIME_KEY = 'novelReader_sessionLimitTime'; // "HH:MM", 24h
  const SESSION_DURATION_KEY = 'novelReader_sessionLimitSeconds'; // total dialled-in seconds
  const SESSION_REMAINING_KEY = 'novelReader_sessionRemainingMs';
  const SESSION_RUNNING_KEY = 'novelReader_sessionRunning';

  const sessionTimerBtn = document.getElementById('session-timer-btn-sidebar');
  const sessionSettingsPanel = document.getElementById('session-settings-panel');
  const sessionModeTimeBtn = document.getElementById('session-mode-time-btn');
  const sessionModeDurationBtn = document.getElementById('session-mode-duration-btn');
  const sessionModeTimeView = document.getElementById('session-mode-time');
  const sessionModeDurationView = document.getElementById('session-mode-duration');
  const sessionTimeSetBtn = document.getElementById('session-time-set-btn');
  const dialColonSecondsEl = document.getElementById('dial-colon-seconds');
  const sessionAmBtn = document.getElementById('session-am-btn');
  const sessionPmBtn = document.getElementById('session-pm-btn');
  const sessionDurationPresetsEl = document.getElementById('session-duration-presets');
  const sessionStartBtn = document.getElementById('session-start-btn');
  const sessionResetBtn = document.getElementById('session-reset-btn');
  const sessionStatusEl = document.getElementById('session-status');
  const sessionLimitOffBtn = document.getElementById('session-limit-off-btn');
  const sessionLimitOverlay = document.getElementById('session-limit-overlay');
  const sessionLimitDismissBtn = document.getElementById('session-limit-dismiss-btn');

  // Dial elements
  const dialWrap = document.getElementById('dial-wrap');
  const dialSvg = document.getElementById('dial');
  const dialTicksEl = document.getElementById('dial-ticks');
  const dialProgressEl = document.getElementById('dial-progress');
  const dialHandleEl = document.getElementById('dial-handle');
  const dialCenterValueEl = document.getElementById('dial-center-value');
  const dialCenterUnitEl = document.getElementById('dial-center-unit');
  const dialCenterStateEl = document.getElementById('dial-center-state');
  const dialSegEls = Array.from(document.querySelectorAll('.dial-seg'));
  const dialValueEls = {
    hours: document.getElementById('dial-value-hours'),
    minutes: document.getElementById('dial-value-minutes'),
    seconds: document.getElementById('dial-value-seconds'),
  };

  // Geometry of the SVG dial (must match the viewBox in index.html).
  const DIAL_CX = 110;
  const DIAL_CY = 110;
  const DIAL_R = 88;
  const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_R;

  // Max value per unit — hours wrap at 24, minutes/seconds at 60, same
  // as a real clock timer.
  const DIAL_UNIT_MAX = { hours: 24, minutes: 60, seconds: 60 };
  const DIAL_UNIT_LABEL = { hours: 'Hours', minutes: 'Minutes', seconds: 'Seconds' };

  // Daily-time tab: the hours dial is a 12-hour face (12, 1 ... 11) and AM/PM
  // is a separate switch. timeValues.hours stays 24-hour internally (that is
  // what gets saved and compared with the clock), so only the dial and the
  // readouts translate. Countdown mode is untouched.
  function dialMax() {
    return (dialMode === 'time' && dialUnit === 'hours') ? 12 : DIAL_UNIT_MAX[dialUnit];
  }
  function hour12(h24) { return h24 % 12 === 0 ? 12 : h24 % 12; }
  function getDialValue() {
    const vals = activeDialValues();
    return (dialMode === 'time' && dialUnit === 'hours') ? vals.hours % 12 : vals[dialUnit];
  }
  function setDialValue(v) {
    if (dialMode === 'time' && dialUnit === 'hours') {
      timeValues.hours = v + (timeValues.hours >= 12 ? 12 : 0);
    } else {
      activeDialValues()[dialUnit] = v;
    }
  }
  function isPM() { return timeValues.hours >= 12; }
  function setPeriod(pm) { timeValues.hours = (timeValues.hours % 12) + (pm ? 12 : 0); }

  let dialUnit = 'minutes';           // which segment the dial is editing
  let dialValues = { hours: 0, minutes: 0, seconds: 0 };
  // The same dial serves both tabs. 'duration' edits dialValues (h:m:s);
  // 'time' edits timeValues, a 24h clock time (seconds don't exist there).
  let dialMode = 'duration';
  let timeValues = { hours: new Date().getHours(), minutes: new Date().getMinutes() };
  let dialDragging = false;
  let dialLastAngle = null;           // used to detect wrap-around past 12 o'clock

  // Countdown state
  let sessionRemainingMs = 0;
  let sessionRunning = false;
  let sessionLastTickAt = Date.now();
  let sessionLimitReachedAndDismissed = false;
  // Time-of-day reminder: it fires only when the clock actually CROSSES the
  // chosen time while the app is open (last check < target <= now). Setting a
  // time that already passed today, re-saving the same time, opening the app
  // or switching tabs can never fire it. A per-(day, time) record in
  // localStorage also stops it repeating after a restart.
  const SESSION_FIRED_KEY = 'novelReader_sessionTimeFired';
  let sessionTimeLastCheckAt = Date.now();

  /* ---- Persistence helpers ---- */

  function getSessionMode() {
    return localStorage.getItem(SESSION_MODE_KEY) || 'off';
  }
  function saveSessionMode(mode) {
    localStorage.setItem(SESSION_MODE_KEY, mode);
  }

  function getSessionTimeOfDay() {
    return localStorage.getItem(SESSION_TIME_KEY) || '';
  }
  function saveSessionTimeOfDay(hhmm) {
    localStorage.setItem(SESSION_TIME_KEY, hhmm);
  }

  function getSessionTotalSeconds() {
    const raw = localStorage.getItem(SESSION_DURATION_KEY);
    const value = raw !== null ? parseInt(raw, 10) : 0;
    return isNaN(value) || value < 0 ? 0 : value;
  }
  function saveSessionTotalSeconds(seconds) {
    localStorage.setItem(SESSION_DURATION_KEY, String(seconds));
  }

  function persistCountdown() {
    localStorage.setItem(SESSION_REMAINING_KEY, String(Math.max(0, Math.round(sessionRemainingMs))));
    localStorage.setItem(SESSION_RUNNING_KEY, sessionRunning ? '1' : '0');
  }

  /* ---- Value <-> display conversions ---- */

  function dialTotalSeconds() {
    return dialValues.hours * 3600 + dialValues.minutes * 60 + dialValues.seconds;
  }

  function secondsToDialValues(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    return {
      hours: Math.floor(s / 3600) % 24,
      minutes: Math.floor(s / 60) % 60,
      seconds: s % 60,
    };
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Values the dial is currently editing.
  function activeDialValues() { return dialMode === 'time' ? timeValues : dialValues; }
  function timeValuesToHHMM() { return pad2(timeValues.hours) + ':' + pad2(timeValues.minutes); }
  function loadTimeValuesFromStored() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(getSessionTimeOfDay());
    if (m && +m[1] < 24 && +m[2] < 60) timeValues = { hours: +m[1], minutes: +m[2] };
  }

  // "1:05:09" / "5:09" — the compact form a clock app shows.
  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }

  /* ---- Dial rendering ---- */

  // Tick marks are redrawn whenever the selected unit changes, because
  // hours need 24 of them and minutes/seconds need 60.
  function renderDialTicks() {
    const max = dialMax();
    const majorEvery = max === 24 ? 6 : max === 12 ? 3 : 5;
    let markup = '';
    for (let i = 0; i < max; i++) {
      const angle = (i / max) * Math.PI * 2 - Math.PI / 2;
      const isMajor = i % majorEvery === 0;
      const outer = DIAL_R - 13;
      const inner = outer - (isMajor ? 9 : 5);
      const x1 = DIAL_CX + Math.cos(angle) * inner;
      const y1 = DIAL_CY + Math.sin(angle) * inner;
      const x2 = DIAL_CX + Math.cos(angle) * outer;
      const y2 = DIAL_CY + Math.sin(angle) * outer;
      markup += `<line class="dial-tick${isMajor ? ' major' : ''}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"></line>`;
    }
    dialTicksEl.innerHTML = markup;
  }

  // Repaints the arc, the handle and every readout from dialValues.
  function renderDial() {
    const vals = activeDialValues();
    const max = dialMax();
    const value = getDialValue();
    const fraction = value / max;

    // Progress arc (rotated -90deg in CSS so 0 starts at 12 o'clock).
    dialProgressEl.setAttribute('stroke-dasharray', String(DIAL_CIRCUMFERENCE));
    dialProgressEl.setAttribute('stroke-dashoffset', String(DIAL_CIRCUMFERENCE * (1 - fraction)));

    // Handle sits on the ring at the current angle.
    const angle = fraction * Math.PI * 2 - Math.PI / 2;
    dialHandleEl.setAttribute('cx', (DIAL_CX + Math.cos(angle) * DIAL_R).toFixed(2));
    dialHandleEl.setAttribute('cy', (DIAL_CY + Math.sin(angle) * DIAL_R).toFixed(2));

    // Segment cards
    Object.keys(dialValueEls).forEach(unit => {
      if (vals[unit] === undefined) return;
      dialValueEls[unit].textContent = pad2(dialMode === 'time' && unit === 'hours' ? hour12(vals.hours) : vals[unit]);
    });
    dialSegEls.forEach(el => {
      el.classList.toggle('active', el.dataset.unit === dialUnit);
    });

    // Centre readout: while running it shows the live countdown instead
    // of the unit being edited.
    if (dialMode === 'time') {
      // Clock-time mode: the state line shows the 12-hour reading, so
      // 00:00 is plainly "12:00 AM".
      dialCenterValueEl.textContent = pad2(dialUnit === 'hours' ? hour12(timeValues.hours) : value);
      dialCenterUnitEl.textContent = DIAL_UNIT_LABEL[dialUnit];
      dialCenterStateEl.classList.remove('hidden');
      dialCenterStateEl.textContent = formatClockTime12(timeValuesToHHMM());
    } else if (sessionRunning || sessionRemainingMs > 0) {
      dialCenterValueEl.textContent = formatClock(sessionRemainingMs);
      dialCenterUnitEl.textContent = 'remaining';
      dialCenterStateEl.classList.remove('hidden');
      dialCenterStateEl.textContent = sessionRunning ? 'Running' : 'Paused';
    } else {
      dialCenterValueEl.textContent = pad2(value);
      dialCenterUnitEl.textContent = DIAL_UNIT_LABEL[dialUnit];
      dialCenterStateEl.classList.add('hidden');
    }

    // AM / PM switch reflects the picked time.
    if (sessionAmBtn && sessionPmBtn) {
      const pm = isPM();
      sessionAmBtn.classList.toggle('active', !pm);
      sessionPmBtn.classList.toggle('active', pm);
      sessionAmBtn.setAttribute('aria-pressed', String(!pm));
      sessionPmBtn.setAttribute('aria-pressed', String(pm));
    }

    // Presets light up when they match exactly what's dialled in.
    const totalMinutes = dialTotalSeconds() / 60;
    sessionDurationPresetsEl.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.minutes, 10) === totalMinutes);
    });

    sessionStartBtn.disabled = dialTotalSeconds() === 0 && !sessionRunning && sessionRemainingMs === 0;

    // "Set reminder" button: shows the picked time, and rests once that
    // exact time is already the active reminder.
    const picked = formatClockTime12(timeValuesToHHMM());
    const alreadySet = getSessionMode() === 'time' && getSessionTimeOfDay() === timeValuesToHHMM();
    sessionTimeSetBtn.textContent = (alreadySet ? 'Reminder set for ' : 'Set reminder for ') + picked;
    sessionTimeSetBtn.disabled = alreadySet;
  }

  function setDialUnit(unit) {
    if (!DIAL_UNIT_MAX[unit]) return;
    if (dialMode === 'time' && unit === 'seconds') return;
    dialUnit = unit;
    dialLastAngle = null;
    renderDialTicks();
    renderDial();
  }

  function setDialValuesFromSeconds(totalSeconds) {
    dialValues = secondsToDialValues(totalSeconds);
    renderDial();
  }

  /* ---- Dial dragging ----
     Pointer position is converted to an angle around the dial's centre,
     then snapped to the nearest step for the selected unit. Dragging
     past 12 o'clock wraps naturally (59 -> 0), the same as a real
     clock-app dial. */

  function pointerToValue(clientX, clientY) {
    const rect = dialSvg.getBoundingClientRect();
    // Convert the centre of the dial from viewBox units to screen px.
    const cx = rect.left + (DIAL_CX / 220) * rect.width;
    const cy = rect.top + (DIAL_CY / 220) * rect.height;
    // atan2 gives radians from the +x axis; shift so 0 is 12 o'clock
    // and values increase clockwise.
    let angle = Math.atan2(clientY - cy, clientX - cx) + Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;
    const max = dialMax();
    let value = Math.round((angle / (Math.PI * 2)) * max);
    if (value >= max) value = 0;
    return value;
  }

  function beginDialDrag(e) {
    // A drag on the dial always edits the set duration, so an
    // already-running countdown is stopped first — otherwise the user
    // would be dialling a value they can't see.
    if (dialMode === 'duration' && sessionRunning) pauseCountdown();
    dialDragging = true;
    dialWrap.classList.add('dragging');
    dialWrap.setPointerCapture && dialWrap.setPointerCapture(e.pointerId);
    updateDialFromPointer(e);
  }

  function updateDialFromPointer(e) {
    const value = pointerToValue(e.clientX, e.clientY);
    if (getDialValue() !== value) {
      setDialValue(value);
      // Dialling a new duration invalidates any paused countdown.
      if (dialMode === 'duration') sessionRemainingMs = 0;
      renderDial();
      if (navigator.vibrate) navigator.vibrate(4); // light tick feedback
    }
  }

  function endDialDrag(e) {
    if (!dialDragging) return;
    dialDragging = false;
    dialWrap.classList.remove('dragging');
    if (dialWrap.releasePointerCapture && e && e.pointerId !== undefined) {
      try { dialWrap.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    }
    // A clock time only takes effect when "Set reminder" is pressed.
    if (dialMode === 'duration') commitDialDuration(); else renderDial();
  }

  // Persist whatever is dialled in and refresh the status line.
  function commitDialDuration() {
    const seconds = dialTotalSeconds();
    saveSessionTotalSeconds(seconds);
    if (seconds > 0) {
      saveSessionMode('duration');
    } else if (getSessionMode() === 'duration') {
      saveSessionMode('off');
    }
    persistCountdown();
    updateSessionTimerButton();
    renderDial();
  }

  dialWrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    beginDialDrag(e);
  });
  dialWrap.addEventListener('pointermove', (e) => {
    if (!dialDragging) return;
    e.preventDefault();
    updateDialFromPointer(e);
  });
  dialWrap.addEventListener('pointerup', endDialDrag);
  dialWrap.addEventListener('pointercancel', endDialDrag);

  dialSegEls.forEach(el => {
    el.addEventListener('click', () => setDialUnit(el.dataset.unit));
  });

  /* ---- Countdown control ---- */

  function startCountdown() {
    // Resume a paused countdown, or start a fresh one from the dial.
    if (sessionRemainingMs <= 0) {
      const seconds = dialTotalSeconds();
      if (seconds <= 0) return;
      sessionRemainingMs = seconds * 1000;
      saveSessionTotalSeconds(seconds);
    }
    sessionRunning = true;
    sessionLastTickAt = Date.now();
    sessionLimitReachedAndDismissed = false;
    saveSessionMode('duration');
    persistCountdown();
    updateSessionTimerButton();
    renderDial();
  }

  function pauseCountdown() {
    sessionRunning = false;
    persistCountdown();
    updateSessionTimerButton();
    renderDial();
  }

  function resetCountdown() {
    sessionRunning = false;
    sessionRemainingMs = 0;
    sessionLimitReachedAndDismissed = false;
    setDialValuesFromSeconds(getSessionTotalSeconds());
    persistCountdown();
    updateSessionTimerButton();
    renderDial();
  }

  /* ---- Status line + button state ---- */

  function updateSessionTimerButton() {
    const mode = getSessionMode();
    const armed = (mode === 'duration' && (sessionRunning || sessionRemainingMs > 0)) ||
                  (mode === 'time' && !!getSessionTimeOfDay());

    sessionTimerBtn.classList.toggle('limit-active', armed);
    sessionTimerBtn.title = armed
      ? 'Reading session timer (limit active)'
      : 'Reading session timer (no limit set)';

    // Start button doubles as Pause while running.
    sessionStartBtn.textContent = sessionRunning ? 'Pause' : (sessionRemainingMs > 0 ? 'Resume' : 'Start');
    sessionStartBtn.classList.toggle('running', sessionRunning);

    sessionStatusEl.classList.toggle('armed', armed);
    if (mode === 'time' && getSessionTimeOfDay()) {
      sessionStatusEl.innerHTML = 'Break reminder at <strong>' + formatClockTime12(getSessionTimeOfDay()) + '</strong> daily';
    } else if (mode === 'duration' && (sessionRunning || sessionRemainingMs > 0)) {
      sessionStatusEl.innerHTML = (sessionRunning ? 'Break in ' : 'Paused at ') +
        '<strong>' + formatClock(sessionRemainingMs) + '</strong>';
    } else if (mode === 'duration' && dialTotalSeconds() > 0) {
      sessionStatusEl.innerHTML = 'Ready — press Start for <strong>' + formatClock(dialTotalSeconds() * 1000) + '</strong>';
    } else {
      sessionStatusEl.textContent = 'No limit set';
    }
  }

  // Turns the stored "HH:MM" into an actual Date for today, or null if
  // nothing valid is stored.
  function getTodaysTargetDate() {
    const hhmm = getSessionTimeOfDay();
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!match) return null;
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    if (hours > 23 || minutes > 59) return null;
    const d = new Date();
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  function triggerSessionLimitOverlay() {
    if (sessionLimitReachedAndDismissed) return;
    sessionLimitOverlay.classList.remove('hidden');
    // Pause any audio when the break lands — a break reminder that keeps
    // playing music isn't much of a break.
    if (window.NovelAudio && window.NovelAudio.pauseForBreak) {
      window.NovelAudio.pauseForBreak();
    }
  }

  function sessionTick() {
    const now = Date.now();
    // Backgrounded time never counts, in either mode.
    if (document.visibilityState !== 'visible') {
      sessionLastTickAt = now;
      return;
    }

    const mode = getSessionMode();

    if (mode === 'duration' && sessionRunning) {
      sessionRemainingMs -= now - sessionLastTickAt;
      if (sessionRemainingMs <= 0) {
        sessionRemainingMs = 0;
        sessionRunning = false;
        persistCountdown();
        triggerSessionLimitOverlay();
      } else if (Math.round(sessionRemainingMs / 1000) % 15 === 0) {
        // Persist every ~15s rather than every tick, to avoid hammering
        // localStorage while still surviving an unexpected kill.
        persistCountdown();
      }
      updateSessionTimerButton();
      if (!sessionSettingsPanel.classList.contains('hidden')) renderDial();
    } else if (mode === 'time') {
      // Fires on the first tick after the clock crosses the target, so a
      // background pause over the target minute can't skip it, but a
      // target that was already in the past when set can never fire.
      const targetDate = getTodaysTargetDate();
      if (targetDate) {
        const t = targetDate.getTime();
        const firedKey = new Date(now).toDateString() + '|' + getSessionTimeOfDay();
        if (sessionTimeLastCheckAt < t && now >= t &&
            localStorage.getItem(SESSION_FIRED_KEY) !== firedKey) {
          localStorage.setItem(SESSION_FIRED_KEY, firedKey);
          sessionLimitReachedAndDismissed = false;
          // The night lock covers the screen; no reminder on top of it.
          if (!nightLocked) triggerSessionLimitOverlay();
        }
      }
      sessionTimeLastCheckAt = now;
    }

    sessionLastTickAt = now;
  }

  // Reset the "last tick" anchor whenever the app returns to the
  // foreground, so backgrounded time is never counted as active reading.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sessionLastTickAt = Date.now();
    } else {
      persistCountdown();
    }
  });

  function setSessionModeUI(mode) {
    sessionModeTimeBtn.classList.toggle('active', mode === 'time');
    sessionModeDurationBtn.classList.toggle('active', mode === 'duration');
    sessionModeTimeView.classList.toggle('hidden', mode !== 'time');
    sessionModeDurationView.classList.toggle('hidden', mode !== 'duration');

    dialMode = mode === 'time' ? 'time' : 'duration';
    // No seconds on a clock-time dial.
    const secondsEl = dialSegEls.find(el => el.dataset.unit === 'seconds');
    if (secondsEl) secondsEl.style.display = dialMode === 'time' ? 'none' : '';
    dialColonSecondsEl.style.display = dialMode === 'time' ? 'none' : '';
    if (dialMode === 'time' && dialUnit === 'seconds') dialUnit = 'minutes';
    dialLastAngle = null;
    renderDialTicks();
    renderDial();
  }

  /* ---- Restore saved state ---- */

  (function restoreSessionState() {
    const savedMode = getSessionMode();
    setSessionModeUI(savedMode === 'time' ? 'time' : 'duration');
    loadTimeValuesFromStored();

    setDialValuesFromSeconds(getSessionTotalSeconds());
    setDialUnit(dialValues.hours > 0 ? 'hours' : 'minutes');

    const savedRemaining = parseInt(localStorage.getItem(SESSION_REMAINING_KEY) || '0', 10);
    sessionRemainingMs = isNaN(savedRemaining) ? 0 : Math.max(0, savedRemaining);
    // A countdown that was running when the app closed comes back
    // paused, not running — the user wasn't reading in the meantime, and
    // silently resuming would be surprising.
    sessionRunning = false;
    if (sessionRemainingMs > 0) localStorage.setItem(SESSION_RUNNING_KEY, '0');

    // (Nothing to do for the time-of-day limit: it only fires on a live
    // crossing of the clock, so opening the app never triggers it.)
    sessionTimeLastCheckAt = Date.now();

    updateSessionTimerButton();
    renderDial();
  })();

  setInterval(sessionTick, 1000);

  /* ---- Wiring ---- */

  sessionTimerBtn.addEventListener('click', () => {
    togglePanel(sessionSettingsPanel, () => {
      renderDialTicks();
      renderDial();
      updateSessionTimerButton();
    });
  });

  closeOnOutsideClick(sessionSettingsPanel, ['#session-timer-btn-sidebar']);

  // Switching tabs only changes what the dial edits; it never arms or
  // disarms anything. "Start" / "Set reminder" are the explicit actions.
  sessionModeTimeBtn.addEventListener('click', () => {
    setSessionModeUI('time');
    updateSessionTimerButton();
  });

  sessionModeDurationBtn.addEventListener('click', () => {
    setSessionModeUI('duration');
    updateSessionTimerButton();
  });

  // AM / PM switch: changes only the period, never the hour or minutes.
  if (sessionAmBtn && sessionPmBtn) {
    sessionAmBtn.addEventListener('click', () => { setPeriod(false); renderDial(); });
    sessionPmBtn.addEventListener('click', () => { setPeriod(true); renderDial(); });
  }

  sessionTimeSetBtn.addEventListener('click', () => {
    saveSessionTimeOfDay(timeValuesToHHMM());
    saveSessionMode('time');
    // Only a live crossing of this time fires it; a time already past
    // today simply waits for tomorrow.
    sessionTimeLastCheckAt = Date.now();
    sessionLimitReachedAndDismissed = false;
    updateSessionTimerButton();
    renderDial();
  });

  sessionStartBtn.addEventListener('click', () => {
    if (sessionRunning) pauseCountdown();
    else startCountdown();
  });

  sessionResetBtn.addEventListener('click', resetCountdown);

  sessionDurationPresetsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-minutes]');
    if (!btn) return;
    const minutes = parseInt(btn.dataset.minutes, 10);
    const alreadySet = dialTotalSeconds() === minutes * 60;
    // Tapping the active preset clears it back to zero.
    sessionRunning = false;
    sessionRemainingMs = 0;
    setDialValuesFromSeconds(alreadySet ? 0 : minutes * 60);
    // Show the unit the preset most naturally lives in.
    setDialUnit(dialValues.hours > 0 ? 'hours' : 'minutes');
    commitDialDuration();
  });

  sessionLimitOffBtn.addEventListener('click', () => {
    saveSessionMode('off');
    saveSessionTotalSeconds(0);
    sessionRunning = false;
    sessionRemainingMs = 0;
    sessionLimitReachedAndDismissed = false;
    sessionTimeLastCheckAt = Date.now();
    setDialValuesFromSeconds(0);
    persistCountdown();
    updateSessionTimerButton();
    renderDial();
    sessionSettingsPanel.classList.add('hidden');
  });

  sessionLimitDismissBtn.addEventListener('click', () => {
    sessionLimitOverlay.classList.add('hidden');
    sessionLimitReachedAndDismissed = true;
    // Only resumes audio that WE paused for the break (see pauseForBreak
    // in audio-player.js) — music the user had already stopped
    // themselves stays stopped.
    if (window.NovelAudio && window.NovelAudio.resumeAfterBreak) {
      window.NovelAudio.resumeAfterBreak();
    }
  });
  /* ---------------------------------------------------------------------
     Night lock — the app blocks itself overnight.

     Between NIGHT_LOCK_START and NIGHT_LOCK_END (local time, 24h "HH:MM")
     a full-screen lock covers the app and music is paused. It lifts at
     NIGHT_LOCK_END, or after the one-hour Moonlit Lock unlock on eligible days.
     Change the two constants to move the window. (It follows local time.)
  --------------------------------------------------------------------- */

  const NIGHT_LOCK_START = '00:00'; // 12:00 AM
  const NIGHT_LOCK_END = '06:00';   // 6:00 AM

  const nightLockEl = document.getElementById('night-lock');
  const nightLockNowEl = document.getElementById('night-lock-now');
  const nightLockOpensEl = document.getElementById('night-lock-opens');
  let nightLocked = false;

  function hhmmToMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
  }

  // Minutes from `d` until the lock ends, or 0 when not locked. Handles a
  // window that wraps past midnight (e.g. 23:00 -> 06:00) as well as one
  // that doesn't (00:00 -> 06:00).
  function nightLockMinutesLeft(d) {
    const start = hhmmToMinutes(NIGHT_LOCK_START);
    const end = hhmmToMinutes(NIGHT_LOCK_END);
    const nowMin = d.getHours() * 60 + d.getMinutes();
    const inside = start < end ? (nowMin >= start && nowMin < end)
                               : (nowMin >= start || nowMin < end);
    if (!inside) return 0;
    return ((end - nowMin) + 1440) % 1440 || 1440;
  }

  function formatClockTime12(hhmm) {
    const mins = hhmmToMinutes(hhmm);
    const h = Math.floor(mins / 60);
    const mm = String(mins % 60).padStart(2, '0');
    return ((h % 12) || 12) + ':' + mm + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  // Hidden Moonlit Lock test run (Reading panel, faint dot at the bottom): shows the lock
  // with the glass effect on any day, needs 20 taps, and never saves an unlock.
  const moonTestBtn = document.getElementById('moon-test-btn');
  const moonTestExitBtn = document.getElementById('night-lock-test-exit');
  let moonTest = false;

  function startMoonLockTest() {
    if (moonTest || nightLocked || !window.NovelMoonLock) return;
    moonTest = true;
    const readingPanel = document.getElementById('theme-panel');
    if (readingPanel) readingPanel.classList.add('hidden');
    nightLockNowEl.textContent = 'Test mode';
    nightLockOpensEl.textContent = 'Tap the moon, or the ringed star for a puzzle';
    moonTestExitBtn.classList.remove('hidden');
    nightLockEl.classList.remove('hidden');
    window.NovelMoonLock.startSession({ test: true });
  }
  function endMoonLockTest() {
    if (!moonTest) return;
    moonTest = false;
    window.NovelMoonLock.stopSession();
    moonTestExitBtn.classList.add('hidden');
    nightLockEl.classList.add('hidden');
    updateNightLock(); // a real night lock that began meanwhile takes over
  }
  if (moonTestBtn) moonTestBtn.addEventListener('click', startMoonLockTest);
  if (moonTestExitBtn) moonTestExitBtn.addEventListener('click', endMoonLockTest);
  if (window.NovelMoonLock) window.NovelMoonLock.onTestFinished = endMoonLockTest;

  function updateNightLock() {
    if (moonTest) return; // test run owns the overlay until it ends
    // Hidden page: the native side pauses music at night, and the
    // visibilitychange handler below re-runs this the moment the page returns.
    if (document.visibilityState !== 'visible' && !nightLocked) return;
    const d = new Date();
    const left = nightLockMinutesLeft(d);
    const unlocked = window.NovelMoonLock && window.NovelMoonLock.isUnlocked();
    const dismissReady = window.NovelMoonLock && window.NovelMoonLock.canDismiss();
    const shouldLock = left > 0 && !(unlocked && (!nightLocked || dismissReady));

    if (shouldLock) {
      nightLockNowEl.textContent = formatClockTime12(d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'));
      const h = Math.floor(left / 60);
      const m = left % 60;
      nightLockOpensEl.textContent = 'Opens again at ' + formatClockTime12(NIGHT_LOCK_END) +
        ' (in ' + (h ? h + 'h ' : '') + m + 'm)';
      // Music started some other way (headset button, notification) while
      // locked gets stopped again.
      if (window.NovelAudio && window.NovelAudio._state && window.NovelAudio._state.playing) {
        window.NovelAudio.pauseForBreak();
      }
    }

    if (shouldLock === nightLocked) return;
    nightLocked = shouldLock;
    nightLockEl.classList.toggle('hidden', !shouldLock);
    if (shouldLock && window.NovelMoonLock) window.NovelMoonLock.startSession();
    if (shouldLock) {
      // A break reminder underneath the lock would be pointless.
      sessionLimitOverlay.classList.add('hidden');
    } else if (window.NovelAudio && window.NovelAudio._state) {
      // Don't let a pause made for the lock auto-resume music at 6 AM.
      window.NovelAudio._state.duckedForBreak = false;
    }
  }

  if (window.NovelMoonLock) window.NovelMoonLock.onUnlocked = updateNightLock;
  updateNightLock(); // already locked at launch? cover the screen right away
  setInterval(updateNightLock, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Reopened while still locked: new secret star, puzzle put away.
      if (nightLocked && !moonTest && window.NovelMoonLock && window.NovelMoonLock.resetStar) window.NovelMoonLock.resetStar();
      updateNightLock();
    }
  });

  /* ---------------------------------------------------------------------
     Touch gestures (reading pane only, so buttons/sidebar/links keep
     working normally):
       - Swipe left-to-right: open the sidebar menu, but only if the
         swipe *starts* within roughly the menu's own width from the
         left edge (see SIDEBAR_OPEN_SWIPE_ZONE below) — so it behaves
         like a normal edge-swipe drawer instead of the whole screen
         being a trigger for it.
       - Swipe right-to-left: close the sidebar if it's open, otherwise
         advance to the next chapter (no gesture for previous chapter)
       - Single tap on the RIGHT half, TOP half: scroll up one screen
         height (pagination)
       - Single tap on the RIGHT half, BOTTOM half: scroll down one
         screen height (pagination)
       - Tap anywhere on the LEFT half: does nothing, so text can be
         selected and read without accidental page jumps

     MENU AWARENESS
     While any menu is open — the sidebar drawer or any of the popup
     panels (theme, audio, bookmarks, session timer) — page gestures are
     suspended entirely. A tap outside an open menu *only* closes that
     menu: it does not paginate, scroll, change chapter, or hit anything
     underneath. This stops the common annoyance where dismissing a
     panel also jumped the page.

     The one gesture that still works with a menu open is the
     right-to-left swipe that closes the sidebar, since that's a gesture
     aimed at the menu itself rather than at the page.
  --------------------------------------------------------------------- */

  const SWIPE_MIN_DISTANCE = 40;   // px, minimum horizontal travel to count as a swipe
  const EDGE_SWIPE_MIN_DISTANCE = 30; // px, slightly shorter for the menu-open edge swipe
  const TAP_MAX_MOVE = 24;         // px, max finger movement to still count as a tap (not a swipe)

  /* Diagonal tolerance.
     The old test was `absDx > absDy * 1.2`, i.e. roughly a 40° cone. A
     real thumb swipe arcs, so a swipe that starts horizontal and drifts
     downward could fall outside that cone and be silently ignored.
     These are expressed as angles instead, measured from horizontal:
       - 52° for a general swipe (dy up to ~1.28x dx)
       - 60° for the edge swipe that opens the menu, which is the one
         that most needs to feel forgiving
     We also track the *peak* horizontal travel during the move, so a
     swipe that overshoots and springs back still registers. */
  const SWIPE_MAX_ANGLE_DEG = 52;
  const EDGE_SWIPE_MAX_ANGLE_DEG = 60;

  const SIDEBAR_OPEN_SWIPE_ZONE = 0.5;
  // Where the tap zones split, as fractions. X: everything left of this
  // does nothing; right of it paginates. Y: within that right half,
  // above this scrolls up and below it scrolls down.
  const TAP_ZONE_X_SPLIT = 0.5;
  const TAP_ZONE_Y_SPLIT = 0.5;

  // Double tap in the middle of the reading pane: add the current song to Liked.
  const LIKE_ZONE = { left: 0.3, right: 0.7, top: 0.3, bottom: 0.7 };   // share of the pane
  const DOUBLE_TAP_MS = 280;          // longest gap between the two taps
  const DOUBLE_TAP_MAX_MOVE = 48;     // furthest the second tap may land from the first, in px
  // The first tap of a possible double tap, held back (not yet scrolling) until it is clear
  // whether a second tap follows: { x, y, timer }.
  let pendingCentreTap = null;

  // Converts the user's "how many lines" setting into an actual pixel
  // distance, using the reading text's own current computed line height
  // — so the amount scrolled tracks whatever font size/line-height/font
  // family the person is currently reading with, rather than being a
  // fixed fraction of screen height (which used to mean the same
  // "amount" felt different across devices and after changing font
  // size). getComputedStyle returns line-height as an absolute px value
  // even when set as a unitless multiplier in CSS, which is what
  // applyLineHeight() does; the fallback covers the rare case a browser
  // returns "normal" instead of a length.
  /* ---- Smart scroll ----
     Finds whichever paragraph is currently cut off at the edge of the
     reading pane and returns the scroll delta that brings it fully into
     view — the top edge for scrolling down, the bottom edge for
     scrolling up — instead of moving a fixed distance that can stop
     mid-sentence. Returns null when there's nothing to align to (e.g.
     no paragraph actually straddles that edge, or this is the very
     first/last paragraph of the chapter), so the caller can fall back
     to the fixed-line-count scroll rather than doing nothing.
  */
  function computeSmartScrollPx(scrollingDown) {
    // Scrolling up always re-reveals the top bar (see the 'scroll'
    // listener above), which grows #topbar back to full height and
    // pushes every paragraph below it down the page — changing their
    // geometry out from under a target computed before that happens.
    // Forcing the bar into its post-scroll state first means the
    // measurements below already match the layout the scroll will
    // actually land in, rather than the layout right this instant.
    // (Scrolling down can only hide the bar, which is already hidden
    // once you're a full screen past the top, so no equivalent forcing
    // is needed there — and forcing it hidden here would flash it away
    // a frame early even at the very top of the chapter.)
    //
    // #topbar animates that height change (transition: max-height .25s),
    // so simply removing the class isn't enough on its own — a rect
    // measured immediately after still reflects the transition's
    // starting frame, not its end state. Suspending the transition,
    // forcing layout to catch up (the getBoundingClientRect() read),
    // then restoring it produces the same visual result (the reveal
    // still animates, since that isn't done until after this function
    // returns) while measuring against where things will actually end up.
    if (!scrollingDown && topbarEl.classList.contains('hidden')) {
      topbarEl.style.transition = 'none';
      topbarEl.classList.remove('hidden');
      topbarEl.getBoundingClientRect(); // force layout before re-enabling
      topbarEl.style.transition = '';
    }

    const paragraphs = chapterTextEl.querySelectorAll('p');
    if (!paragraphs.length) return null;

    const paneRect = readerScrollEl.getBoundingClientRect();
    // A small tolerance so a paragraph that's already aligned (or off by
    // a sub-pixel rounding amount) isn't treated as "cut off" and doesn't
    // produce a near-zero, pointless scroll.
    const EPSILON = 4;

    if (scrollingDown) {
      // The paragraph straddling the bottom edge: it starts above the
      // edge but ends below it. Walking top-to-bottom and taking the
      // last match handles the (rare) case of a paragraph taller than
      // the whole viewport, where an earlier paragraph could otherwise
      // also technically satisfy "starts above the edge."
      let target = null;
      for (const p of paragraphs) {
        const r = p.getBoundingClientRect();
        if (r.top < paneRect.bottom - EPSILON && r.bottom > paneRect.bottom + EPSILON) {
          target = r;
        }
      }
      if (!target) return null;
      // Distance to move target.top up to paneRect.top.
      return target.top - paneRect.top;
    } else {
      // Mirror case: the paragraph straddling the top edge, scrolling up
      // enough to bring its bottom to the bottom of the pane.
      let target = null;
      for (const p of paragraphs) {
        const r = p.getBoundingClientRect();
        if (r.top < paneRect.top - EPSILON && r.bottom > paneRect.top + EPSILON) {
          target = r;
          break; // topmost match is the right one; no need to keep looking
        }
      }
      if (!target) return null;
      // Negative: moves the pane up so target.bottom reaches paneRect.bottom.
      return target.bottom - paneRect.bottom;
    }
  }

  function computeTapScrollPx() {
    // getComputedStyle is only trustworthy here when it returns an
    // absolute length ("26.6px") — some engines (and jsdom, which this
    // codebase's test suite runs under) instead echo back the unitless
    // multiplier ("1.4") that applyLineHeight() set inline, unconverted.
    // Trusting parseFloat() on that would silently read "1.4" as
    // "1.4px" and produce a near-zero scroll distance, so the px suffix
    // is checked explicitly rather than just testing for NaN.
    const cs = getComputedStyle(chapterTextEl);
    let lineHeightPx = null;
    if (typeof cs.lineHeight === 'string' && cs.lineHeight.endsWith('px')) {
      const parsed = parseFloat(cs.lineHeight);
      if (parsed && !isNaN(parsed)) lineHeightPx = parsed;
    }
    if (lineHeightPx === null) {
      const currentMultiplier = parseFloat(lineHeightInput.value) || DEFAULT_LINE_HEIGHT;
      lineHeightPx = fontSize * currentMultiplier;
    }
    const raw = tapScrollLines * lineHeightPx;
    // Sanity bounds: never less than a small nudge, never more than
    // ~3 screens, regardless of how the slider + font settings combine.
    return Math.max(40, Math.min(raw, window.innerHeight * 3));
  }

  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTarget = null;
  let touchPeakDx = 0;   // largest rightward travel seen during this gesture
  let touchPeakDy = 0;   // vertical drift at the moment of that peak
  let touchStartedWithMenuOpen = false;

  function sidebarIsOpen() {
    return isMobileViewport() && !sidebar.classList.contains('collapsed');
  }

  function anyPanelOpen() {
    return [themePanel, bookmarksPanel, sessionSettingsPanel, audioPanel]
      .some(p => p && !p.classList.contains('hidden'));
  }

  // "Any menu" = the drawer or any popup panel.
  function anyMenuOpen() {
    return sidebarIsOpen() || anyPanelOpen();
  }

  // True when ONLY the audio player is open (no other panel) — used by the
  // "Volume keys in audio player" switch.
  function onlyAudioPanelOpen() {
    return !!audioPanel && !audioPanel.classList.contains('hidden') &&
      [themePanel, bookmarksPanel, sessionSettingsPanel]
        .every(p => !p || p.classList.contains('hidden'));
  }

  // Should the volume buttons change the media volume right now (instead of
  // scrolling the page)? Yes whenever a menu is open — except the audio
  // player alone when the user switched "Volume keys in audio player" off.
  function volumeKeysFree() {
    if (!anyMenuOpen()) return false;
    if (!audioVolumeKeysEnabled && onlyAudioPanelOpen()) return false;
    return true;
  }

  // Tells the native side whenever a menu/panel opens or closes, so
  // MainActivity.onKeyDown() can let the hardware volume buttons change the
  // real media volume while a menu is open (instead of scrolling the reader).
  let lastReportedMenuOpen = null;
  function reportMenuState() {
    const open = volumeKeysFree();
    if (open === lastReportedMenuOpen) return;
    lastReportedMenuOpen = open;
    try {
      if (window.AndroidBridge && window.AndroidBridge.setVolumeKeysFree) {
        window.AndroidBridge.setVolumeKeysFree(open);
      }
    } catch (e) { /* ignore */ }
  }
  (function watchMenus() {
    const mo = new MutationObserver(reportMenuState);
    [sidebar, themePanel, bookmarksPanel, sessionSettingsPanel, audioPanel]
      .forEach(el => { if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] }); });
    window.addEventListener('resize', reportMenuState); // drawer depends on viewport size
    reportMenuState();
  })();

  // Angle of a movement from horizontal, in degrees (0 = pure sideways,
  // 90 = pure vertical).
  function swipeAngleDeg(dx, dy) {
    return Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
  }

  readerScrollEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTarget = e.target;
    touchPeakDx = 0;
    touchPeakDy = 0;
    // Captured at touchstart because the panel may already be closed by
    // the time touchend/click runs.
    touchStartedWithMenuOpen = anyMenuOpen();
  }, { passive: true });

  readerScrollEl.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(touchPeakDx)) {
      touchPeakDx = dx;
      touchPeakDy = dy;
    }
  }, { passive: true });

  readerScrollEl.addEventListener('touchend', (e) => {
    const touch = e.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Use whichever is larger: the final displacement or the peak seen
    // mid-gesture. A swipe that arcs back toward its origin still counts.
    const usePeak = Math.abs(touchPeakDx) > absDx;
    const swipeDx = usePeak ? touchPeakDx : dx;
    const swipeDy = usePeak ? touchPeakDy : dy;
    const swipeAbsDx = Math.abs(swipeDx);
    const angle = swipeAngleDeg(swipeDx, swipeDy);

    const isRightward = swipeDx > 0;
    const isEdgeSwipe = isRightward && touchStartX <= window.innerWidth * SIDEBAR_OPEN_SWIPE_ZONE;
    const minDistance = isEdgeSwipe ? EDGE_SWIPE_MIN_DISTANCE : SWIPE_MIN_DISTANCE;
    const maxAngle = isEdgeSwipe ? EDGE_SWIPE_MAX_ANGLE_DEG : SWIPE_MAX_ANGLE_DEG;
    const isSwipe = swipeAbsDx >= minDistance && angle <= maxAngle;

    if (isSwipe) {
      if (isRightward) {
        // Left-to-right: open the sidebar, but only from the left half
        // and only when no popup panel is in the way.
        if (isEdgeSwipe && !anyPanelOpen()) {
          sidebar.classList.remove('collapsed');
          syncScrim();
        }
      } else {
        // Right-to-left. If a popup panel is open this just closes it.
        if (anyPanelOpen()) {
          closeAllPanels();
        } else if (sidebarIsOpen()) {
          sidebar.classList.add('collapsed');
          syncScrim();
        } else {
          openChapter(currentIndex + 1);
        }
      }
      return; // don't also evaluate this as a tap
    }

    // --- Tap handling ---

    if (absDx > TAP_MAX_MOVE || absDy > TAP_MAX_MOVE) return;

    // A long-press on a paragraph (bookmarking it) just fired for this
    // same touch — don't also treat the release as a pagination tap.
    if (longPressFired) {
      longPressFired = false;
      return;
    }

    // Click-to-close: a tap outside an open menu closes it and stops
    // there. No pagination, no chapter change, nothing underneath.
    if (touchStartedWithMenuOpen) {
      closeAllPanels();
      if (sidebarIsOpen()) {
        sidebar.classList.add('collapsed');
        syncScrim();
      }
      return;
    }

    // Ignore taps on real interactive elements (links) inside the text.
    if (touchStartTarget && touchStartTarget.closest && touchStartTarget.closest('a')) return;

    // The middle of the pane: a double tap likes the current song, so a tap here waits a moment
    // before it scrolls, to see whether a second one follows. Only while there is a song to
    // like; otherwise every tap scrolls at once, as everywhere else.
    if (inLikeZone(touch.clientX, touch.clientY) && window.NovelAudio && window.NovelAudio.hasCurrentTrack()) {
      const first = pendingCentreTap;
      if (first && Math.hypot(touch.clientX - first.x, touch.clientY - first.y) <= DOUBLE_TAP_MAX_MOVE) {
        clearTimeout(first.timer);
        pendingCentreTap = null;
        likeFromDoubleTap();
        return;
      }
      const x = touch.clientX, y = touch.clientY;
      pendingCentreTap = { x, y, timer: setTimeout(() => { pendingCentreTap = null; pageForTap(x, y); }, DOUBLE_TAP_MS) };
      return;
    }

    pageForTap(touch.clientX, touch.clientY);
  }, { passive: true });

  function inLikeZone(x, y) {
    const pane = readerScrollEl.getBoundingClientRect();
    const fx = (x - pane.left) / pane.width, fy = (y - pane.top) / pane.height;
    return fx >= LIKE_ZONE.left && fx <= LIKE_ZONE.right && fy >= LIKE_ZONE.top && fy <= LIKE_ZONE.bottom;
  }

  // A single tap on the text: scroll a page.
  function pageForTap(x, y) {
    // Left half is reserved for reading/selecting — no pagination there.
    if (x < window.innerWidth * TAP_ZONE_X_SPLIT) return;

    // Within the right half, the split is vertical: above the midpoint
    // of the reading pane scrolls up, below it scrolls down.
    const paneRect = readerScrollEl.getBoundingClientRect();
    const midY = paneRect.top + paneRect.height * TAP_ZONE_Y_SPLIT;
    scrollReaderPage(y >= midY);
  }

  function likeFromDoubleTap() {
    if (!window.NovelAudio.likeCurrent()) return;
    const pop = document.getElementById('like-pop');
    pop.classList.remove('show');
    void pop.offsetWidth;            // restart the animation if it is still showing
    pop.classList.add('show');
    if (navigator.vibrate) navigator.vibrate(8);
  }

  // Shared by the tap gesture above and window.scrollReaderByVolumeKey()
  // below (see that function for why it exists) — smart scroll aligns to
  // whichever paragraph is cut off at the relevant edge; falls back to
  // the fixed line-count distance when there's nothing to align to (or
  // the feature is off).
  function scrollReaderPage(scrollingDown) {
    let delta = smartScrollEnabled ? computeSmartScrollPx(scrollingDown) : null;
    if (delta === null) {
      const pageHeight = computeTapScrollPx();
      delta = scrollingDown ? pageHeight : -pageHeight;
    }
    readerScrollEl.scrollBy({ top: delta, behavior: 'smooth' });
  }

  // Called from MainActivity.kt's onKeyDown() when the user presses a
  // volume key while the app is in the foreground (see that function for
  // the native half) — repurposes the hardware volume buttons as page
  // scroll while reading, instead of adjusting media volume.
  window.scrollReaderByVolumeKey = function (scrollingDown) {
    // A menu/panel is open, or the user switched volume scrolling off:
    // don't scroll. Returning 'volume' tells MainActivity.kt to let the
    // key change the media volume instead.
    if (volumeKeysFree() || !volumeScrollEnabled) return 'volume';
    scrollReaderPage(!!scrollingDown);
    return 'scrolled';
  };

  /* Keyboard chapter navigation is also suspended while a menu is open,
     so arrow keys inside a panel (e.g. nudging a range input) don't
     flip chapters behind it. */
  document.addEventListener('keydown', (e) => {
    if (anyMenuOpen()) return;
    if (e.key === 'ArrowRight') openChapter(currentIndex + 1);
    if (e.key === 'ArrowLeft') openChapter(currentIndex - 1);
  });
})();
