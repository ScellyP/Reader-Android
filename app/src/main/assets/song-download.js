/* =========================================================================
   Download songs tab (music panel -> bottom bar -> "Download")
   -------------------------------------------------------------------------
   The page half only. Paste links, pick a playlist (folder) chip or
   "+ New playlist", press Download. With "Check names before saving" on
   (the default) each link is first looked up for its song name; the names
   then appear as editable fields, and "Save songs" downloads them under the
   names shown (leave a name alone to keep it). Jobs run one at a time; each
   shows Waiting / Downloading / Done / Failed (Retry), with a Stop button.

   The download itself runs natively: MainActivity's AndroidBridge hands each
   job to Termux, which runs song_dl.py (yt-dlp). The contract:

     page   -> AndroidBridge.lookupSongTitle(jobId, url)
               AndroidBridge.downloadSong(jobId, url, folder, name)   folder "" = none,
                                                                       name "" = keep the song's own
               AndroidBridge.cancelSongDownload()                      (optional)
     native -> window.onSongDownloadStatus(jobId, "running"|"done"|"failed", message)
               exactly one done/failed per job; for a lookup, the message of
               "done" is the song's name.

   Without the native hook a job fails at once with "Not connected to Termux
   yet". After a batch with at least one finished song, NovelAudio.rescan()
   refreshes the library.

   Playlist and song names are cleaned here (cleanFolderName, cleanSongName)
   and are always passed on as separate arguments, never joined into a shell
   string.

   The pure helpers (parseLinks, cleanFolderName, cleanSongName, createQueue,
   shortLink) are exported for tests/song-download.test.js.
   ========================================================================= */
(function (root) {
  'use strict';

  const MAX_LINKS = 50;
  const NEW_PLAYLIST = '@new';

  /* =======================================================================
     Pure helpers (tested)
     ======================================================================= */

  // Letters, digits, space and _ - ( ) . & ' , only. Same rule as song_dl.py clean_folder().
  // Leading/trailing dots go so ".." can never climb out of the Audio folder.
  function cleanFolderName(name) {
    return String(name == null ? '' : name)
      .replace(/[^A-Za-z0-9 _\-().&',]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .trim()
      .slice(0, 60);
  }

  // A song's file name: any language is fine, but not the characters a file name cannot hold
  // (/ \ : * ? " < > |); tabs, line breaks and other control characters become spaces. At most 120 characters. Same rule as
  // clean_song_name in song_dl.py.
  function cleanSongName(name) {
    const tidy = String(name == null ? '' : name)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .trim();
    return Array.from(tidy).slice(0, 120).join('');
  }

  // Splits pasted text into web links: one per line (or separated by spaces), duplicates dropped.
  // Returns { links, skipped } where skipped counts the pieces that were not http(s) links.
  function parseLinks(text) {
    const links = [];
    const seen = new Set();
    let skipped = 0;
    String(text == null ? '' : text).split(/[\s,]+/).forEach((piece) => {
      if (!piece) return;
      if (!/^https?:\/\/\S+$/i.test(piece)) { skipped++; return; }
      if (seen.has(piece)) return;
      seen.add(piece);
      links.push(piece);
    });
    return { links: links.slice(0, MAX_LINKS), skipped: skipped + Math.max(0, links.length - MAX_LINKS) };
  }

  // The download queue. One job runs at a time.
  //   start(job)   begins a job; return false (or throw) when it cannot start
  //   cancel()     asks the native side to stop the running job
  //   onChange(jobs)           after any change
  //   onBatchDone({done, failed, stopped})   when the queue runs empty
  // A job is { id, url, folder, state, phase, message, title, name } with state
  //   waiting | running | named | done | failed | stopped
  // and phase "title" (look the song's name up) or "download" (save it).
  // add(urls, folder, true) first looks the names up: each job ends in "named" and waits there,
  // with its name editable through rename(), until confirm() sends them on to be downloaded.
  function createQueue({ start, cancel, onChange, onBatchDone } = {}) {
    const jobs = [];
    let nextId = 1;
    let current = null;
    let batchOpen = false;

    const emit = () => { if (onChange) onChange(jobs.slice()); };
    const count = (state) => jobs.filter((j) => j.state === state).length;

    function pump() {
      if (current) return;
      const job = jobs.find((j) => j.state === 'waiting');
      if (!job) {
        // Names found and waiting for the user's go-ahead: the batch is not over yet.
        if (batchOpen && !jobs.some((j) => j.state === 'named')) {
          batchOpen = false;
          if (onBatchDone) onBatchDone({ done: count('done'), failed: count('failed'), stopped: count('stopped') });
        }
        return;
      }
      current = job;
      job.state = 'running';
      job.message = '';
      let started = false;
      let why = '';
      try { started = !!start && start(job) !== false; } catch (e) { why = e && e.message ? e.message : ''; }
      if (!started) { settle(job, false, why || 'Could not start the download'); return; }
      emit();
    }

    // The one place a running job ends. A late or repeated report changes nothing.
    function settle(job, ok, message) {
      if (job.state !== 'running') return;
      if (job.phase === 'title' && ok && !job.stopRequested) {
        job.title = message || '';
        job.name = cleanSongName(job.title);
        job.state = 'named';
        job.message = '';
      } else {
        const stopped = !!job.stopRequested && (!ok || job.phase === 'title');
        job.state = stopped ? 'stopped' : (ok ? 'done' : 'failed');
        job.message = stopped ? 'Stopped' : (message || '');
      }
      if (current === job) current = null;
      emit();
      pump();
    }

    const find = (id) => jobs.find((j) => String(j.id) === String(id));

    return {
      jobs,
      add(urls, folder, review) {
        if (!batchOpen && !current) {
          // A fresh batch: forget the old finished rows so the list stays about this one.
          for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].state !== 'waiting') jobs.splice(i, 1);
        }
        urls.forEach((url) => {
          jobs.push({
            id: 'j' + nextId++, url, folder: folder || '', state: 'waiting', message: '',
            phase: review ? 'title' : 'download', title: '', name: '',
          });
        });
        batchOpen = true;
        emit();
        pump();
      },
      // The native side answers here.
      report(id, status, message) {
        const job = find(id);
        if (!job) return;
        if (status === 'running') { if (job.state === 'running') { job.message = message || ''; emit(); } return; }
        if (status === 'done') settle(job, true, message);
        else if (status === 'failed') settle(job, false, message);
      },
      // The name the user typed for a job that is waiting for the go-ahead. Does not redraw:
      // the user is typing in the field.
      rename(id, text) {
        const job = find(id);
        if (job && job.state === 'named') job.name = String(text == null ? '' : text);
      },
      // The go-ahead: every named job is downloaded under its (cleaned) name. Returns how many.
      confirm() {
        let n = 0;
        jobs.forEach((j) => {
          if (j.state !== 'named') return;
          j.name = cleanSongName(j.name);
          j.phase = 'download';
          j.state = 'waiting';
          j.message = '';
          n++;
        });
        if (n) { batchOpen = true; emit(); pump(); }
        return n;
      },
      // Drops the jobs that are waiting for the go-ahead.
      discard() {
        for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].state === 'named') jobs.splice(i, 1);
        emit();
        pump();
      },
      retry(id) {
        const job = find(id);
        if (!job || (job.state !== 'failed' && job.state !== 'stopped')) return;
        job.state = 'waiting';
        job.message = '';
        job.stopRequested = false;
        batchOpen = true;
        emit();
        pump();
      },
      // Waiting jobs are dropped at once; the running one is asked to stop and reports back.
      stop() {
        jobs.forEach((j) => {
          if (j.state === 'waiting' || j.state === 'named') { j.state = 'stopped'; j.message = 'Stopped'; }
        });
        if (current) {
          current.stopRequested = true;
          try { if (cancel) cancel(); } catch (e) { /* the job still ends by itself */ }
        }
        emit();
        if (!current) pump();
      },
      busy() { return jobs.some((j) => j.state === 'waiting' || j.state === 'running'); },
      reviewing() { return jobs.some((j) => j.state === 'named'); },
      summary() {
        return { total: jobs.length, waiting: count('waiting'), running: count('running'), named: count('named'),
                 done: count('done'), failed: count('failed'), stopped: count('stopped') };
      },
    };
  }

  // A short title for a link: host + path, without the scheme or tracking query.
  function shortLink(url) {
    const bare = String(url).replace(/^https?:\/\/(www\.)?/i, '').split(/[?#]/)[0].replace(/\/$/, '');
    return bare.length > 48 ? bare.slice(0, 47) + '…' : bare;
  }

  const api = { parseLinks, cleanFolderName, cleanSongName, createQueue, shortLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !document.getElementById) return;

  /* =======================================================================
     The tab
     ======================================================================= */

  const $ = (id) => document.getElementById(id);
  const view = $('sp-view-download');
  if (!view) return;
  const panel = $('audio-panel');

  const el = {
    links: $('dl-links'), note: $('dl-links-note'), clear: $('dl-clear'), paste: $('dl-paste'),
    folders: $('dl-folders'), newName: $('dl-new-name'), folderNote: $('dl-folder-note'),
    review: $('dl-review'), go: $('dl-go'), start: $('dl-start'),
    summary: $('dl-summary'), stop: $('dl-stop'), jobs: $('dl-jobs'),
  };

  let chosen = '';              // '' = no playlist, NEW_PLAYLIST, or a folder name
  let lastJobs = [];

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + name);
    svg.appendChild(use);
    return svg;
  }

  function button(label, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    if (className) b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  const playlists = () => {
    try { return (root.NovelAudio && root.NovelAudio.getPlaylists && root.NovelAudio.getPlaylists()) || []; }
    catch (e) { return []; }
  };

  // The playlist the jobs will go to ('' for none).
  function targetFolder() {
    return chosen === NEW_PLAYLIST ? cleanFolderName(el.newName.value) : chosen;
  }

  const queue = createQueue({
    start(job) {
      const bridge = root.AndroidBridge;
      const call = job.phase === 'title' ? 'lookupSongTitle' : 'downloadSong';
      if (!bridge || typeof bridge[call] !== 'function') throw new Error('Not connected to Termux yet');
      return job.phase === 'title'
        ? bridge.lookupSongTitle(job.id, job.url)
        : bridge.downloadSong(job.id, job.url, job.folder, job.name || '');
    },
    cancel() {
      const bridge = root.AndroidBridge;
      if (bridge && typeof bridge.cancelSongDownload === 'function') bridge.cancelSongDownload();
    },
    onChange(jobs) { lastJobs = jobs; renderJobs(); updateGo(); },
    onBatchDone(result) {
      if (result.done > 0) {
        try { if (root.NovelAudio && root.NovelAudio.rescan) root.NovelAudio.rescan(); } catch (e) { /* ignore */ }
        renderFolders();
      }
    },
  });

  // The native side calls this.
  root.onSongDownloadStatus = function (jobId, status, message) { queue.report(jobId, status, message); };

  function renderFolders() {
    const names = playlists();
    if (chosen && chosen !== NEW_PLAYLIST && names.indexOf(chosen) < 0) chosen = '';
    el.folders.textContent = '';
    const chip = (label, value) => {
      const b = button(label, chosen === value ? 'on' : '', () => {
        chosen = value;
        el.newName.classList.toggle('hidden', chosen !== NEW_PLAYLIST);
        if (chosen === NEW_PLAYLIST) el.newName.focus();
        renderFolders();
        updateGo();
      });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', chosen === value ? 'true' : 'false');
      el.folders.appendChild(b);
    };
    chip('No playlist', '');
    names.forEach((name) => chip(name, name));
    chip('+ New playlist', NEW_PLAYLIST);
    updateFolderNote();
  }

  function updateFolderNote() {
    if (chosen === NEW_PLAYLIST) {
      const typed = el.newName.value.trim();
      const cleaned = cleanFolderName(typed);
      if (!typed) el.folderNote.textContent = 'Name the new playlist.';
      else if (!cleaned) el.folderNote.textContent = 'Use letters, numbers and spaces.';
      else if (cleaned !== typed) el.folderNote.textContent = 'Will be saved as “' + cleaned + '”.';
      else el.folderNote.textContent = 'Creates the playlist “' + cleaned + '”.';
    } else if (chosen) {
      el.folderNote.textContent = 'Saved in the “' + chosen + '” playlist.';
    } else {
      el.folderNote.textContent = 'Saved with your other songs, in no playlist.';
    }
  }

  function updateLinks() {
    const parsed = parseLinks(el.links.value);
    const n = parsed.links.length;
    let text = n === 0 ? '' : (n === 1 ? '1 link' : n + ' links');
    if (parsed.skipped > 0) text += (text ? ' · ' : '') + parsed.skipped + ' skipped (not a web link)';
    el.note.textContent = text;
    el.clear.hidden = el.links.value === '';
    updateGo();
    return parsed;
  }

  function updateGo() {
    const hasLinks = parseLinks(el.links.value).links.length > 0;
    const needsName = chosen === NEW_PLAYLIST && !cleanFolderName(el.newName.value);
    el.go.disabled = !hasLinks || needsName;
  }

  // What the "name" line under a field says while the user edits it.
  function nameHint(text) {
    const cleaned = cleanSongName(text);
    if (!cleaned) return 'Empty: the song keeps its own name.';
    if (cleaned !== String(text).trim()) return 'Will be saved as “' + cleaned + '”.';
    return 'Change the name, or leave it as it is.';
  }

  function renderJobs() {
    // Re-drawing the list must not take the keyboard away from a name being typed.
    const active = document.activeElement;
    const typing = active && active.classList && active.classList.contains('dl-name') ? active : null;
    const typingId = typing ? typing.getAttribute('data-job-id') : null;
    const selStart = typing ? typing.selectionStart : 0;
    const selEnd = typing ? typing.selectionEnd : 0;

    el.jobs.textContent = '';
    lastJobs.forEach((job) => {
      const li = document.createElement('li');
      li.className = 'dl-job dl-' + job.state;

      const mark = document.createElement('span');
      mark.className = 'dl-mark' + (job.state === 'running' ? ' dl-spin' : '');
      if (job.state === 'done') mark.appendChild(icon('i-check'));
      else if (job.state === 'failed' || job.state === 'stopped') mark.appendChild(icon('i-close'));
      li.appendChild(mark);

      const text = document.createElement('div');
      text.className = 'dl-job-text';
      const small = document.createElement('small');

      if (job.state === 'named') {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'dl-name';
        input.value = job.name;
        input.maxLength = 120;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('data-job-id', job.id);
        input.setAttribute('aria-label', 'Song name');
        small.textContent = nameHint(job.name);
        input.addEventListener('input', () => { queue.rename(job.id, input.value); small.textContent = nameHint(input.value); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        text.appendChild(input);
      } else {
        const title = document.createElement('b');
        // After the look-up the song's name is known; before it, only the link is.
        title.textContent = job.phase === 'download' && (job.name || job.title) ? (job.name || job.title) : shortLink(job.url);
        text.appendChild(title);
        small.textContent = job.state === 'waiting' ? 'Waiting'
          : job.state === 'running' ? (job.message || (job.phase === 'title' ? 'Finding the name…' : 'Downloading…'))
          : job.message || (job.state === 'done' ? 'Done' : 'Failed');
      }
      text.appendChild(small);
      li.appendChild(text);

      if (job.state === 'failed' || job.state === 'stopped') {
        li.appendChild(button('Retry', 'dl-retry', () => queue.retry(job.id)));
      }
      el.jobs.appendChild(li);
    });

    if (typingId) {
      const again = el.jobs.querySelector('input[data-job-id="' + typingId + '"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(selStart, selEnd); } catch (e) { /* not essential */ }
      }
    }

    const s = queue.summary();
    const busy = s.waiting + s.running > 0;
    const ready = !busy && s.named > 0;
    el.stop.hidden = !(busy || ready);
    el.stop.textContent = busy ? 'Stop' : 'Discard';
    el.start.hidden = !ready;
    el.start.textContent = 'Save ' + s.named + (s.named === 1 ? ' song' : ' songs');
    el.summary.hidden = s.total === 0;
    if (busy) {
      // Count within the kind of job that is running now: names being found, or songs being saved.
      const running = lastJobs.find((j) => j.state === 'running');
      const phase = running ? running.phase : 'download';
      const group = lastJobs.filter((j) => j.phase === phase);
      const over = group.filter((j) => j.state !== 'waiting' && j.state !== 'running').length;
      el.summary.textContent = (phase === 'title' ? 'Finding names ' : 'Downloading ') +
        Math.min(group.length, over + 1) + ' of ' + group.length;
    } else if (ready) {
      el.summary.textContent = 'Check the names below, then save';
    } else if (s.total) {
      const parts = [];
      if (s.done) parts.push(s.done + ' done');
      if (s.failed) parts.push(s.failed + ' failed');
      if (s.stopped) parts.push(s.stopped + ' stopped');
      el.summary.textContent = parts.join(' · ');
    }
  }

  // Everything on the tab is re-read each time it is shown (the playlists may have changed).
  function refresh() {
    renderFolders();
    updateLinks();
    renderJobs();
  }

  const isOpen = () => !!panel && panel.getAttribute('data-view') === 'download';
  const openTab = () => {
    if (root.SpotifyUI && root.SpotifyUI.setView) root.SpotifyUI.setView('download');
    else refresh();
  };
  const closeTab = () => {
    if (isOpen() && root.SpotifyUI && root.SpotifyUI.setView) root.SpotifyUI.setView('library');
  };

  // The bottom bar switches tabs on its own, so watch for this one coming into view.
  if (panel && typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (isOpen()) refresh(); })
      .observe(panel, { attributes: true, attributeFilter: ['data-view'] });
  }
  refresh();

  el.links.addEventListener('input', updateLinks);
  el.newName.addEventListener('input', () => { updateFolderNote(); updateGo(); });
  el.clear.addEventListener('click', () => { el.links.value = ''; updateLinks(); });

  el.paste.addEventListener('click', () => {
    const fallback = () => { el.links.focus(); el.note.textContent = 'Long-press the box and choose Paste.'; };
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) return fallback();
      navigator.clipboard.readText().then((text) => {
        if (!text) return fallback();
        el.links.value = el.links.value ? el.links.value.replace(/\s*$/, '\n') + text : text;
        updateLinks();
      }, fallback);
    } catch (e) { fallback(); }
  });

  el.go.addEventListener('click', () => {
    const parsed = parseLinks(el.links.value);
    if (!parsed.links.length) return;
    const folder = targetFolder();
    queue.add(parsed.links, folder, !!(el.review && el.review.checked));
    el.links.value = '';
    updateLinks();
  });

  el.start.addEventListener('click', () => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); queue.confirm(); });
  el.stop.addEventListener('click', () => { if (queue.busy()) queue.stop(); else queue.discard(); });

  root.SongDownload = Object.assign({}, api, {
    open: openTab,
    close: closeTab,
    isOpen,
  });
})(typeof window !== 'undefined' ? window : this);
