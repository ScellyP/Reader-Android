/* =========================================================================
   Download songs sheet (music panel -> Library -> "Download songs")
   -------------------------------------------------------------------------
   The page half only. Paste links, pick a playlist (folder) chip or
   "+ New playlist", press Download. Jobs run one at a time; each shows
   Waiting / Downloading / Done / Failed (Retry), with a Stop button.

   The download itself runs natively: MainActivity's AndroidBridge hands each
   job to Termux, which runs song_dl.py (yt-dlp). The contract:

     page   -> AndroidBridge.downloadSong(jobId, url, folder)   folder "" = none
               AndroidBridge.cancelSongDownload()               (optional)
     native -> window.onSongDownloadStatus(jobId, "running"|"done"|"failed", message)
               exactly one done/failed per job

   Without the native hook a job fails at once with "Not connected to Termux
   yet". After a batch with at least one finished song, NovelAudio.rescan()
   refreshes the library.

   Playlist names are cleaned here (cleanFolderName) and are always passed on
   as a separate argument, never joined into a shell string.

   The pure helpers (parseLinks, cleanFolderName, createQueue) are exported
   for tests/song-download.test.js.
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
  // A job is { id, url, folder, state, message } with state
  // waiting | running | done | failed | stopped.
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
        if (batchOpen) {
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
      if (!started) { finish(job, 'failed', why || 'Could not start the download'); return; }
      emit();
    }

    function finish(job, state, message) {
      // Exactly one result per job: a late or repeated report changes nothing.
      if (job.state !== 'running') return;
      job.state = job.stopRequested && state === 'failed' ? 'stopped' : state;
      job.message = job.state === 'stopped' ? 'Stopped' : (message || '');
      if (current === job) current = null;
      emit();
      pump();
    }

    return {
      jobs,
      add(urls, folder) {
        if (!batchOpen && !current) {
          // A fresh batch: forget the old finished rows so the list stays about this one.
          for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].state !== 'waiting') jobs.splice(i, 1);
        }
        urls.forEach((url) => {
          jobs.push({ id: 'j' + nextId++, url, folder: folder || '', state: 'waiting', message: '' });
        });
        batchOpen = true;
        emit();
        pump();
      },
      // The native side answers here.
      report(id, status, message) {
        const job = jobs.find((j) => String(j.id) === String(id));
        if (!job) return;
        if (status === 'running') { if (job.state === 'running') { job.message = message || ''; emit(); } return; }
        if (status === 'done') finish(job, 'done', message);
        else if (status === 'failed') finish(job, 'failed', message);
      },
      retry(id) {
        const job = jobs.find((j) => j.id === id);
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
        jobs.forEach((j) => { if (j.state === 'waiting') { j.state = 'stopped'; j.message = 'Stopped'; } });
        if (current) {
          current.stopRequested = true;
          try { if (cancel) cancel(); } catch (e) { /* the job still ends by itself */ }
        }
        emit();
        if (!current) pump();
      },
      busy() { return jobs.some((j) => j.state === 'waiting' || j.state === 'running'); },
      summary() {
        return { total: jobs.length, waiting: count('waiting'), running: count('running'),
                 done: count('done'), failed: count('failed'), stopped: count('stopped') };
      },
    };
  }

  // A short title for a link: host + path, without the scheme or tracking query.
  function shortLink(url) {
    const bare = String(url).replace(/^https?:\/\/(www\.)?/i, '').split(/[?#]/)[0].replace(/\/$/, '');
    return bare.length > 48 ? bare.slice(0, 47) + '…' : bare;
  }

  const api = { parseLinks, cleanFolderName, createQueue, shortLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !document.getElementById) return;

  /* =======================================================================
     The sheet
     ======================================================================= */

  const $ = (id) => document.getElementById(id);
  const sheet = $('dl-sheet');
  if (!sheet) return;

  const el = {
    open: $('dl-open-btn'), close: $('dl-close'), scrim: $('dl-scrim'),
    links: $('dl-links'), note: $('dl-links-note'), clear: $('dl-clear'), paste: $('dl-paste'),
    folders: $('dl-folders'), newName: $('dl-new-name'), folderNote: $('dl-folder-note'),
    go: $('dl-go'), summary: $('dl-summary'), stop: $('dl-stop'), jobs: $('dl-jobs'),
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
      if (!bridge || typeof bridge.downloadSong !== 'function') throw new Error('Not connected to Termux yet');
      return bridge.downloadSong(job.id, job.url, job.folder);
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

  function renderJobs() {
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
      const title = document.createElement('b');
      title.textContent = shortLink(job.url);
      const small = document.createElement('small');
      small.textContent = job.state === 'waiting' ? 'Waiting'
        : job.state === 'running' ? (job.message || 'Downloading…')
        : job.message || (job.state === 'done' ? 'Done' : 'Failed');
      text.appendChild(title);
      text.appendChild(small);
      li.appendChild(text);

      if (job.state === 'failed' || job.state === 'stopped') {
        li.appendChild(button('Retry', 'dl-retry', () => queue.retry(job.id)));
      }
      el.jobs.appendChild(li);
    });

    const s = queue.summary();
    const busy = s.waiting + s.running > 0;
    el.stop.hidden = !busy;
    el.summary.hidden = s.total === 0;
    if (busy) {
      el.summary.textContent = 'Downloading ' + Math.min(s.total, s.done + s.failed + s.stopped + 1) + ' of ' + s.total;
    } else if (s.total) {
      const parts = [];
      if (s.done) parts.push(s.done + ' done');
      if (s.failed) parts.push(s.failed + ' failed');
      if (s.stopped) parts.push(s.stopped + ' stopped');
      el.summary.textContent = parts.join(' · ');
    }
  }

  function openSheet() {
    renderFolders();
    updateLinks();
    renderJobs();
    sheet.classList.remove('hidden');
  }

  function closeSheet() { sheet.classList.add('hidden'); }

  el.open.addEventListener('click', openSheet);
  el.close.addEventListener('click', closeSheet);
  el.scrim.addEventListener('click', closeSheet);
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
    queue.add(parsed.links, folder);
    el.links.value = '';
    updateLinks();
  });

  el.stop.addEventListener('click', () => queue.stop());

  root.SongDownload = Object.assign({}, api, {
    open: openSheet,
    close: closeSheet,
    isOpen() { return !sheet.classList.contains('hidden'); },
  });
})(typeof window !== 'undefined' ? window : this);
