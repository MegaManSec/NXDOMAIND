# NXDOMAIN'd: Discover dangling unregistered domains

One codebase → two builds:

- **Chrome (MV3)**: service worker (ESM)
- **Firefox (MV2)**: background script (IIFE)

## Build
```bash
pnpm prepare
pnpm run build:chrome
pnpm run build:firefox
# or
pnpm prepare
pnpm run build
```

- Chrome output: `dist/chrome`
- Firefox output: `dist/firefox`

## Load
- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
- **Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on → `dist/firefox/manifest.json`

## What it actually does
- Extracts **registrable domain** with **tldts** (ICANN-only; ignores private suffixes)
- **RDAP-first**; if the TLD has no RDAP (404 at rdap.org with no redirect), **DNS fallback** using decreasing candidates and **A/AAAA/TXT/NS** via dns.google
- Records **page URL** (where seen) and **full request URL** (what was fetched or blocked)
- Badge turns **red** on new finding; turns **blue** when popup opens

# Tuning
Edit `src/background.ts`:

- `MAX_DOMAINS` – max registrable domains (eTLD+1) cached.
- `MAX_HOSTS` – max full hosts (e.g., `a.cdn.example.com`) cached.
- `MAX_PAGES_PER_DOMAIN` – cap for "Pages observed on” per domain (most recent kept).
- `MAX_REQS_PER_DOMAIN` – cap for "Requests made to this domain” (most recent kept).
- `REQ_GC_WINDOW_MS` – GC horizon for `seenRequestIds`/`lastQueued`.
- `REQ_TTL_MS` – de-dupe window for identical `requestId` events.
- `MAX_CONCURRENCY` – parallel RDAP/DNS checks.
- `ENQUEUE_TTL_MS` – per-domain re-enqueue throttle.
- `TAB_HISTORY_TTL_MS` – keep per-tab full-URL history this long (to recover paths when only origin is provided).
- `TAB_HISTORY_MAX` – max history entries per tab.
- `MAX_LOGS` – max in-memory log lines (with recent-first trimming).
- `LOG_TTL_MS` – drop logs older than this duration.
