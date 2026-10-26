#!/usr/bin/env python3
"""
WORKS ON TERMUX (Android) -- pure Python, only needs two pip packages.
On desktop, an optional third package (SeleniumBase) unlocks a
browser-based fallback for pages that block plain HTTP requests:

    requests (IPv6-preferred)
      -> SeleniumBase (UC Mode / CDP Mode, drives Chrome or Brave)

SeleniumBase is fully optional. If it isn't installed, the fallback is
skipped and the script behaves exactly as it did with plain requests
alone (e.g. on Termux).

------------------------------------------------------------
SETUP (run once in Termux):
------------------------------------------------------------
    pkg update -y
    pkg install python -y
    pip install requests beautifulsoup4
    termux-setup-storage
        (grants Termux access to shared/internal storage -- required
         once so this script can write to /storage/emulated/0/...,
         which is where it saves chapters by default)

------------------------------------------------------------
SETUP (optional, desktop only -- SeleniumBase fallback):
------------------------------------------------------------
    pip install seleniumbase
    (drives Brave if found in a common install location -- or pass
     --browser-path -- otherwise falls back to a default Chrome
     install. SeleniumBase manages its own driver automatically.)

    Not required on Termux -- if seleniumbase isn't installed, or no
    suitable browser is found, this layer is skipped and the original
    error is raised instead.

------------------------------------------------------------
USAGE:
------------------------------------------------------------
    python chapter_downloader.py "https://example.com/novel/chapter-13"

    Continue where you left off (what the Novel Reader app's \"Fetch new
    chapters\" button runs): no link needed -- the newest chapter already in
    the folder remembers where it came from (its \"Source:\" line), so the
    script opens that page ONLY to find its \"next chapter\" link (it is not
    saved again) and downloads everything after it, up to the latest:
      python chapter_downloader.py --resume -o /storage/emulated/0/Novel/Shadow-Slave -n 100000

    Optional flags:
      --resume             continue after the newest chapter in the output folder
                           (see above). Give -o or --novel to say which folder;
                           don't give a link. Exit codes: 0 finished (or already
                           up to date), 2 nothing to continue from, 3 stopped
                           because a page could not be fetched
      -o, --output DIR     folder to save chapters into
                           (default: /storage/emulated/0/Novel/Chapters, or
                            /storage/emulated/0/Novel/<name>/ if --novel is
                            given instead -- overrides --novel if both given)
      --novel NAME         name of the novel being downloaded -- chapters
                           are saved into /storage/emulated/0/Novel/<name>/
                           so the Novel Reader app's novel switcher picks
                           it up as its own separate novel with its own
                           chapter list and reading progress
      -n, --max N          max number of chapters to download (default: 50)
      -d, --delay SECONDS  pause between requests, be polite (default: 2)
      --no-follow          only download the one page you gave it, don't
                            chase "next chapter" links
      --no-browser-fallback
                           disable the SeleniumBase fallback on 403s, even
                           if seleniumbase is installed
      --force-browser      skip the plain-requests attempt entirely and
                           fetch every page with SeleniumBase directly --
                           use this once you already know a site always
                           blocks plain requests (no wasted request, no
                           "still blocked" message, no per-page delay
                           while requests fails first)
      --browser-path PATH  path to Brave (or another browser) executable,
                           if it's not in one of the common install locations
      --prefer-ipv4        use IPv4 for plain requests instead of the
                           IPv6-preferred default (the browser fallback
                           always picks automatically regardless of this flag)
      --debug-fallback     save the raw HTML the fallback captures to
                           ./debug_html/ when it doesn't look like real
                           content, for troubleshooting

    Example (novel #1, saved to /storage/emulated/0/Novel/Shadow-Slave/):
      python chapter_downloader.py "https://site.com/novel/ch-13" --novel "Shadow Slave" -n 20

    Example (novel #2, saved to /storage/emulated/0/Novel/Iron-Prince/):
      python chapter_downloader.py "https://site.com/novel2/ch-1" --novel "Iron Prince" -n 20

    Example (no --novel, saves into the app's default folder):
      python chapter_downloader.py "https://site.com/novel/ch-13" -n 20

    Example (fully custom folder instead):
      python chapter_downloader.py "https://site.com/novel/ch-13" -o MyNovel -n 20
------------------------------------------------------------
"""

import argparse
import os
import re
import socket
import sys
import time
from urllib.parse import urljoin

try:
    import requests
    from bs4 import BeautifulSoup
    from bs4.element import Tag
except ImportError:
    print("Missing packages. In Termux run:\n"
          "    pip install requests beautifulsoup4")
    sys.exit(1)

# seleniumbase is optional and desktop-only (needs a real browser
# install). Import it lazily inside its fallback function instead of
# here, so Termux users without it installed never hit an ImportError
# just for having this script around.
_SELENIUMBASE_CHECKED, _SELENIUMBASE_AVAILABLE = False, False

# When True (via --debug-fallback), each browser fallback layer saves the
# raw HTML it captured to ./debug_html/ so it can actually be inspected,
# instead of guessing at content-detection thresholds blind.
DEBUG_FALLBACK = False


class _IPv6HTTPSConnection(requests.packages.urllib3.connection.HTTPSConnection):
    """HTTPS connection that resolves and connects via IPv6 specifically,
    without touching any process-global urllib3 state."""
    def _new_conn(self):
        try:
            infos = socket.getaddrinfo(
                self.host, self.port, socket.AF_INET6, socket.SOCK_STREAM
            )
        except socket.gaierror:
            # host genuinely has no IPv6 address on record -- let the
            # normal (IPv4) connection logic handle it
            return super()._new_conn()

        last_err = None
        for family, socktype, proto, _, sockaddr in infos:
            try:
                sock = socket.socket(family, socktype, proto)
                if self.socket_options:
                    for opt in self.socket_options:
                        sock.setsockopt(*opt)
                sock.settimeout(self.timeout)
                sock.connect(sockaddr)
                return sock
            except OSError as e:
                # covers both "no IPv6 route on this network" (errno 97,
                # EAFNOSUPPORT/ENETUNREACH) and per-address connect
                # failures -- either way, try the next address, then
                # fall back to normal IPv4 behavior if none work
                last_err = e
                continue

        return super()._new_conn()


class _IPv6HTTPSConnectionPool(requests.packages.urllib3.connectionpool.HTTPSConnectionPool):
    ConnectionCls = _IPv6HTTPSConnection


class IPv6PreferredAdapter(requests.adapters.HTTPAdapter):
    """
    Requests transport adapter that prefers IPv6 for HTTPS connections.
    Scoped to this adapter's own connection pools only -- no global
    urllib3/socket state is modified, so it can't affect anything else
    in the process (including the browser-based fallbacks below).

    If a host has no IPv6 address, or the network has no real IPv6
    route, connections silently fall back to normal (IPv4) behavior
    per-host rather than hard-failing.
    """
    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = dict(
            self.poolmanager.pool_classes_by_scheme or {}
        )
        self.poolmanager.pool_classes_by_scheme["https"] = _IPv6HTTPSConnectionPool


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.google.com/",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

# Words/phrases that typically mark a "next chapter" link.
NEXT_PATTERNS = [
    "next chapter", "next chap", "next episode", "next part",
    "chapter next", "read next", "next »", "next>>", "next »",
    "next", "berikutnya", "siguiente", "próximo",
]

# Tags whose text is just noise, strip these before extracting text.
STRIP_TAGS = [
    "script", "style", "noscript", "header", "footer", "nav",
    "aside", "form", "iframe", "svg", "button",
]

# class/id name fragments that usually mean "this is an ad/comment/junk block"
JUNK_HINTS = [
    "comment", "sidebar", "advert", "advertisement", "ads", "banner",
    "share", "social", "related", "recommend", "newsletter", "popup",
    "cookie", "subscribe", "menu", "breadcrumb", "pagination", "tag",
]

# class/id name fragments that usually mean "this IS the chapter content"
CONTENT_HINTS = [
    "chapter-content", "chapter_content", "chapterContent",
    "reading-content", "reader-content", "entry-content", "post-content",
    "article-content", "story", "content-area", "text-content",
    "novel-content", "articlebody", "article-body", "main-content",
]


SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def configure_session_ip_preference(prefer_ipv4=False):
    """
    By default, the requests layer prefers IPv6 for HTTPS connections
    (falling back to IPv4 automatically per-host if a host has no IPv6
    address, or the network has no real IPv6 route). Pass
    prefer_ipv4=True to skip this and use requests' normal behavior
    instead. This only affects the plain-requests layer -- the browser
    fallback (SeleniumBase) always picks IPv4/IPv6 automatically via
    the OS, since it doesn't expose a real setting to control it.
    """
    if not prefer_ipv4:
        SESSION.mount("https://", IPv6PreferredAdapter())


def fetch(url, timeout=20, retries=2, browser_fallback=True, browser_path=None,
          force_browser=False):
    if force_browser:
        # Skip the plain-requests attempt entirely and go straight to the
        # browser. Use this once you already know a site always 403s plain
        # requests -- no point wasting a request (and printing a "blocked"
        # message) on an attempt you know will fail.
        if not browser_fallback:
            raise RuntimeError(
                "--force-browser and --no-browser-fallback can't be used together."
            )
        soup = _fetch_with_seleniumbase(url, timeout=timeout, browser_path=browser_path)
        if soup is not None:
            return soup
        raise RuntimeError(f"SeleniumBase fallback failed to fetch {url}")

    try:
        resp = SESSION.get(url, timeout=timeout)
        resp.raise_for_status()
        resp.encoding = resp.apparent_encoding or resp.encoding
        return BeautifulSoup(resp.text, "html.parser")
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        if status == 403 and browser_fallback:
            # sites that 403 plain requests are almost always doing bot
            # detection, not a transient block -- retrying with the same
            # requests session won't help, so go straight to the browser
            # fallback instead of wasting time on retries.
            soup = _fetch_with_seleniumbase(url, timeout=timeout, browser_path=browser_path)
            if soup is not None:
                return soup
        raise


def _looks_like_real_content(html):
    """Shared check used by every browser fallback: does this HTML look
    like an actual chapter page (real paragraph content), or still an
    interstitial/challenge page? Reuses the same heuristics as the
    normal parsing pipeline instead of guessing at challenge wording."""
    soup_check = BeautifulSoup(html, "html.parser")
    container = find_content_container(soup_check)
    text_len = len(container.get_text(strip=True)) if container is not None else 0
    p_count = len(container.find_all("p")) if container is not None else 0
    return text_len > 400 or p_count >= 3


def _dump_debug_html(html, label):
    """
    When --debug-fallback is passed, save whatever HTML a fallback layer
    captured to disk so we can actually see what happened, instead of
    guessing at content-detection thresholds blind.
    """
    if not DEBUG_FALLBACK:
        return
    os.makedirs("debug_html", exist_ok=True)
    safe_label = re.sub(r"[^a-zA-Z0-9_-]", "_", label)
    path = os.path.join("debug_html", f"{safe_label}_{int(time.time())}.html")
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"    [debug] saved raw HTML from {label} -> {path}")
    except Exception as e:
        print(f"    [debug] failed to save debug HTML: {e}")


# Common Brave install locations by OS. If none of these exist, we fall
# Common Brave install locations by OS. If none of these exist,
# SeleniumBase falls back to using a default Chrome install instead.
_BRAVE_PATHS = [
    # Windows
    r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
    # macOS
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    # Linux
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
    "/snap/bin/brave",
]


def _find_brave_path():
    for path in _BRAVE_PATHS:
        if os.path.isfile(path):
            return path
    return None


def _check_seleniumbase_available():
    """Import seleniumbase lazily and cache whether it's usable at all."""
    global _SELENIUMBASE_CHECKED, _SELENIUMBASE_AVAILABLE
    if _SELENIUMBASE_CHECKED:
        return _SELENIUMBASE_AVAILABLE
    _SELENIUMBASE_CHECKED = True
    try:
        import seleniumbase  # noqa: F401
        _SELENIUMBASE_AVAILABLE = True
    except ImportError:
        _SELENIUMBASE_AVAILABLE = False
    return _SELENIUMBASE_AVAILABLE


def _fetch_with_seleniumbase(url, timeout=20, browser_path=None):
    """
    Fallback layer: SeleniumBase in UC Mode with CDP Mode activated,
    which drives Chrome (or a Chrome-based browser, e.g. Brave, via
    binary_location) directly via the DevTools Protocol. Returns a
    BeautifulSoup soup, or None if seleniumbase isn't installed/usable.
    """
    if not _check_seleniumbase_available():
        print("    [!] seleniumbase isn't installed -- skipping this fallback layer.\n"
              "        (optional: pip install seleniumbase -- desktop only)")
        return None

    resolved_path = browser_path or _find_brave_path()

    try:
        from seleniumbase import SB

        sb_kwargs = dict(
            uc=True,
            headless=True,
            test=True,
            # "mlatest" tells SeleniumBase to fetch the chromedriver build
            # that matches the *installed* Chrome/Brave's major version
            # (milestone) at launch time, instead of whatever build
            # happens to already be sitting in site-packages/.../drivers.
            # This is what avoids the classic
            #   "chromedriver X might not be incompatible with Chrome Y"
            # warning (and the connection failures that come with it)
            # after either the browser or seleniumbase gets updated.
            driver_version="mlatest",
        )
        if resolved_path:
            sb_kwargs["binary_location"] = resolved_path

        deadline = time.monotonic() + max(timeout, 25)
        html = ""
        with SB(**sb_kwargs) as sb:
            sb.activate_cdp_mode(url)
            sb.sleep(1)
            html = sb.get_page_source()
            while time.monotonic() < deadline and not _looks_like_real_content(html):
                sb.sleep(1)
                html = sb.get_page_source()

        if not _looks_like_real_content(html):
            print("    [!] SeleniumBase ran, but the page still doesn't look "
                  "like real content -- treating as failed.")
            _dump_debug_html(html, "seleniumbase")
            return None
        print("    [i] SeleniumBase fetch succeeded.")
        return BeautifulSoup(html, "html.parser")
    except Exception as e:
        print(f"    [!] SeleniumBase fallback failed: {e}")
        return None


def is_junk(tag):
    if not isinstance(tag, Tag):
        return False
    # A tag can show up here after an earlier iteration already decomposed
    # one of its ancestors (decompose() cascades to all descendants and
    # clears their .attrs to None) -- treat those as already-gone rather
    # than crashing on tag.get(...).
    if getattr(tag, "decomposed", False) or tag.attrs is None:
        return False
    ident = " ".join([
        " ".join(tag.get("class", [])) if tag.get("class") else "",
        tag.get("id", "") or "",
    ]).lower()
    return any(h in ident for h in JUNK_HINTS)


def find_content_container(soup):
    """Try to find the element that holds the actual chapter text."""
    # 1) Look for a container whose class/id matches known content hints
    for hint in CONTENT_HINTS:
        el = soup.find(attrs={"class": re.compile(hint, re.I)})
        if el:
            return el
        el = soup.find(attrs={"id": re.compile(hint, re.I)})
        if el:
            return el

    # 2) Fall back: pick the <div>/<article>/<section> with the most
    #    paragraph text, ignoring obvious junk blocks.
    candidates = soup.find_all(["article", "div", "section", "main"])
    best, best_len = None, 0
    for c in candidates:
        if is_junk(c):
            continue
        text_len = len(c.get_text(strip=True))
        # prefer blocks that actually contain <p> tags
        p_count = len(c.find_all("p"))
        score = text_len + p_count * 50
        if score > best_len:
            best, best_len = c, score

    return best if best is not None else soup.body


def clean_text(container):
    """Turn the HTML content block into clean, readable paragraph text."""
    if container is None:
        return ""

    container = container.__copy__() if hasattr(container, "__copy__") else container
    for tag in container.find_all(STRIP_TAGS):
        tag.decompose()
    for tag in container.find_all(True):
        if is_junk(tag):
            tag.decompose()

    # Convert <br> to newlines so paragraphs don't run together
    for br in container.find_all("br"):
        br.replace_with("\n")

    lines = []
    block_tags = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "div"]
    seen_texts = set()

    for el in container.find_all(block_tags):
        # skip if this element's parent is also one of block_tags we'll visit
        # (avoids duplicating nested divs); simplest fix: only take leaf-ish blocks
        if el.find(block_tags):
            continue
        txt = el.get_text(separator=" ", strip=True)
        txt = re.sub(r"\s+", " ", txt).strip()
        if not txt:
            continue
        if txt in seen_texts:
            continue
        seen_texts.add(txt)
        lines.append(txt)

    if not lines:
        # last resort: just grab all text
        txt = container.get_text(separator="\n", strip=True)
        lines = [l.strip() for l in txt.splitlines() if l.strip()]

    return "\n\n".join(lines)


def _title_from_url(url):
    """Derive a human-readable chapter title from the URL slug, e.g.
    '.../chapter-1663-domain-war.html' -> 'Chapter 1663 Domain War'.
    Used when the page's own h1/h2/title tag turns out to just be the
    series name repeated on every chapter (common on novel sites)."""
    slug = url.rstrip("/").split("/")[-1]
    slug = re.sub(r"\.\w+$", "", slug)  # drop .html/.htm etc.
    slug = slug.replace("-", " ").replace("_", " ").strip()
    slug = re.sub(r"\s+", " ", slug)
    return slug.title() if slug else None


def find_title(soup, fallback, url=None):
    candidates = []
    for sel in ["h1", "h2", "title"]:
        el = soup.find(sel)
        if el:
            t = el.get_text(strip=True)
            if t:
                candidates.append(t)

    # Prefer a candidate that actually looks chapter-specific (mentions
    # "chapter" plus a number) over one that's likely just the series
    # name repeated on every page.
    for t in candidates:
        if re.search(r"chapter\s*\d+", t, re.I):
            return t

    # None of the page's own titles look chapter-specific -- the URL
    # slug is usually more reliable on sites like this.
    if url:
        url_title = _title_from_url(url)
        if url_title and re.search(r"\d", url_title):
            return url_title

    if candidates:
        return candidates[0]
    return fallback


def find_next_link(soup, base_url):
    """Look for a 'next chapter' style link on the page."""
    # 1) <link rel="next" href="...">
    rel_next = soup.find("a", attrs={"rel": re.compile("next", re.I)})
    if rel_next and rel_next.get("href"):
        return urljoin(base_url, rel_next["href"])
    link_next = soup.find("link", attrs={"rel": re.compile("next", re.I)})
    if link_next and link_next.get("href"):
        return urljoin(base_url, link_next["href"])

    # 2) anchor whose visible text/aria-label/title/class/id hints "next"
    best = None
    for a in soup.find_all("a", href=True):
        text = a.get_text(strip=True).lower()
        attrs_blob = " ".join([
            text,
            (a.get("title") or "").lower(),
            (a.get("aria-label") or "").lower(),
            " ".join(a.get("class", [])).lower(),
            (a.get("id") or "").lower(),
        ])
        for pat in NEXT_PATTERNS:
            if pat in attrs_blob:
                # avoid matching "next page" pagination that isn't a chapter
                href = urljoin(base_url, a["href"])
                if href.rstrip("/") == base_url.rstrip("/"):
                    continue
                best = href
                break
        if best:
            break

    return best


def safe_filename(name, maxlen=120):
    name = re.sub(r'[\\/*?:"<>|]', "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:maxlen] if name else "chapter"


def save_chapter(title, url, text, out_dir, index):
    os.makedirs(out_dir, exist_ok=True)
    fname = f"{safe_filename(title)}.txt"
    path = os.path.join(out_dir, fname)
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"{title}\n")
        f.write(f"Source: {url}\n")
        f.write("=" * 60 + "\n\n")
        f.write(text)
        f.write("\n")
    return path


def save_next_link(next_url, out_dir):
    """Write just the next unfetched chapter's URL to a small text file
    in out_dir, so a later run can pick up where this one left off."""
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "next_chapter.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(next_url + "\n")
    return path


def _chapter_number(text):
    """The chapter number in a title or file name, the same way the Novel
    Reader app reads it: a number right after the word "chapter" wins,
    otherwise the first number anywhere. None when there is no number."""
    if not text:
        return None
    m = re.search(r"chapter\s*#?\s*(\d+(?:\.\d+)?)", text, re.I)
    if not m:
        m = re.search(r"(\d+(?:\.\d+)?)", text)
    return float(m.group(1)) if m else None


def find_resume_point(out_dir):
    """
    Look through the saved chapters in out_dir and return (url, title) of the
    newest one: the highest chapter number (read from each file's first line,
    like the app does; the file name is the fallback), ties broken by the most
    recently written file. url is the page that chapter was downloaded from
    (the "Source:" line near the top of the file), or None when that newest
    chapter has no Source line -- then there is nothing reliable to continue
    from. Returns (None, None) when the folder has no numbered chapters.
    """
    best = None  # (number, mtime, title, url)
    try:
        names = os.listdir(out_dir)
    except OSError:
        return None, None
    for name in names:
        low = name.lower()
        if not low.endswith(".txt") or low == "next_chapter.txt":
            continue
        path = os.path.join(out_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                head = [f.readline() for _ in range(6)]
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        title = head[0].strip() or os.path.splitext(name)[0]
        number = _chapter_number(title)
        if number is None:
            number = _chapter_number(name)
        if number is None:
            continue
        url = None
        for line in head[1:]:
            m = re.match(r"\s*Source:\s*(\S+)", line)
            if m:
                url = m.group(1)
                break
        if best is None or (number, mtime) > (best[0], best[1]):
            best = (number, mtime, title, url)
    if best is None:
        return None, None
    return best[3], best[2]


def run(start_url, out_dir, max_chapters, delay, follow_next, browser_fallback=True,
        browser_path=None, force_browser=False, skip_first=False):
    """
    skip_first=True is the --resume mode: start_url is a chapter that is
    already saved. It is fetched only to find its "next chapter" link, is not
    saved again and does not count towards max_chapters.

    Returns 0 when the run ended normally (no more chapters, or max reached)
    and 3 when it had to stop because a page could not be fetched.
    """
    url = start_url
    visited = set()
    index = 1
    saved = 0
    anchor = skip_first  # the first page is only a signpost, not a download
    exit_code = 0
    # Tracks the URL of a next chapter we know about but haven't
    # successfully downloaded yet (because we hit --max, hit an error,
    # or found a duplicate) -- written out at the end so a later run can
    # resume from it.
    pending_next_url = None

    while url and index <= max_chapters:
        if url in visited:
            print(f"[!] Already visited {url}, stopping to avoid a loop.")
            break
        visited.add(url)

        if anchor:
            print(f"[=] Opening the newest saved chapter to find what comes next: {url}")
        else:
            print(f"[{index}] Fetching: {url}")
        try:
            soup = fetch(url, browser_fallback=browser_fallback, browser_path=browser_path,
                         force_browser=force_browser)
        except Exception as e:
            print(f"[!] Failed to fetch {url}: {e}")
            exit_code = 3
            if not anchor:
                pending_next_url = url  # never actually downloaded -- still pending
            break

        if anchor:
            anchor = False
            next_url = find_next_link(soup, url)
            if not next_url:
                print("[i] No 'next chapter' link found on the newest chapter -- you're up to date.")
                break
            url = next_url
            time.sleep(delay)
            continue

        container = find_content_container(soup)
        text = clean_text(container)
        title = find_title(soup, fallback=f"Chapter {index}", url=url)

        if len(text.strip()) < 30:
            print("[!] Very little text found on this page -- "
                  "the site's layout may not be recognized. Saving anyway.")

        path = save_chapter(title, url, text, out_dir, index)
        saved += 1
        print(f"    -> saved: {path} ({len(text)} chars)")

        if not follow_next:
            break

        next_url = find_next_link(soup, url)
        if not next_url:
            print("[i] No 'next chapter' link found. Done.")
            break

        if index + 1 > max_chapters:
            # We know where to continue, but we've hit the --max limit --
            # stop here instead of fetching it.
            pending_next_url = next_url
            break

        url = next_url
        index += 1
        time.sleep(delay)

    if follow_next and pending_next_url:
        link_path = save_next_link(pending_next_url, out_dir)
        print(f"[i] More chapters remain -- next chapter link saved to: {link_path}")

    print(f"\nFinished. {saved} chapter(s) saved in: {out_dir}")
    return exit_code


def main():
    parser = argparse.ArgumentParser(
        description="Download a webpage's chapter text and auto-follow 'next chapter' links."
    )
    parser.add_argument("url", nargs="?", default=None,
                         help="URL of the starting chapter page (not used with --resume)")
    parser.add_argument("--resume", action="store_true",
                         help="continue after the newest chapter already in the output folder: "
                              "its Source link is opened only to find the next chapter link, then "
                              "everything after it is downloaded. Use with -o or --novel, no URL.")
    parser.add_argument("-o", "--output", default=None,
                         help="output folder (default: /storage/emulated/0/Novel/<name>/ "
                              "if --novel is given, otherwise /storage/emulated/0/Novel/Chapters -- "
                              "the base folder the Novel Reader Android app reads from)")
    parser.add_argument("--novel", default=None,
                         help="name of the novel -- chapters are saved into "
                              "/storage/emulated/0/Novel/<name>/ so the app's novel "
                              "switcher picks it up as its own separate novel. "
                              "Ignored if -o/--output is also given.")
    parser.add_argument("-n", "--max", type=int, default=50, help="max chapters to download (default: 50)")
    parser.add_argument("-d", "--delay", type=float, default=2.0, help="seconds to wait between requests (default: 2)")
    parser.add_argument("--no-follow", action="store_true", help="only download this one page, don't chase 'next chapter'")
    parser.add_argument("--no-browser-fallback", action="store_true",
                         help="disable the SeleniumBase fallback on 403s, even if seleniumbase is installed")
    parser.add_argument("--force-browser", action="store_true",
                         help="skip the plain-requests attempt entirely and fetch every page "
                              "with SeleniumBase directly -- use this once you already know a "
                              "site always blocks plain requests")
    parser.add_argument("--browser-path", default=None,
                         help="path to Brave (or another browser) executable, "
                              "if it's not in one of the common install locations")
    parser.add_argument("--prefer-ipv4", action="store_true",
                         help="use IPv4 for plain requests instead of the IPv6-preferred default "
                              "(the browser fallback always picks automatically regardless of this flag)")
    parser.add_argument("--debug-fallback", action="store_true",
                         help="save the raw HTML each browser fallback captures to ./debug_html/ "
                              "when it doesn't look like real content, for troubleshooting")
    args = parser.parse_args()

    global DEBUG_FALLBACK
    DEBUG_FALLBACK = args.debug_fallback

    configure_session_ip_preference(prefer_ipv4=args.prefer_ipv4)

    if args.output:
        out_dir = args.output
    elif args.novel:
        out_dir = os.path.join("/storage/emulated/0/Novel", safe_filename(args.novel, maxlen=80))
    else:
        out_dir = "/storage/emulated/0/Novel/Chapters"

    start_url = args.url
    if args.resume:
        if args.url:
            parser.error("--resume finds the link by itself; don't give a URL with it")
        if args.no_follow:
            parser.error("--resume and --no-follow can't be used together")
        start_url, last_title = find_resume_point(out_dir)
        if last_title is None:
            print(f"[!] Nothing to continue from: no numbered chapters in {out_dir}.\n"
                  "    Download one chapter with its link first.")
            sys.exit(2)
        if not start_url:
            print(f"[!] The newest chapter ({last_title}) has no 'Source:' line, so the script "
                  "can't tell where it came from.\n    Run it once with that chapter's link.")
            sys.exit(2)
        print(f"[i] Newest saved chapter: {last_title}")
    elif not args.url:
        parser.error("a URL is required (or use --resume)")

    code = run(
        start_url=start_url,
        out_dir=out_dir,
        max_chapters=args.max,
        delay=args.delay,
        follow_next=not args.no_follow,
        browser_fallback=not args.no_browser_fallback,
        browser_path=args.browser_path,
        force_browser=args.force_browser,
        skip_first=args.resume,
    )
    sys.exit(code)


if __name__ == "__main__":
    main()
