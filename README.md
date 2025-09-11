# NXDOMAIN'd: Discover dangling unregistered domains while browsing the web

Looking to perform a supply-chain attack? Look no further! This extension allows you to automatically discover websites which are loading resources from domains which you can register today!

Do you want to do any of the following?

- Show your own ads,
- Rewrite links for your affiliate programs,
- DDoS,
- Access user data,
- Show FAKE NEWS,
- Mine crypto in the browser
- ... and more?

Well, then this script may be for you!

Note: don't do any of the above things if you care about the law, of course!

The best part? One codebase, two builds!

- **Chrome (MV3)**: service worker (ESM)
- **Firefox (MV2)**: background script (IIFE)

## Download

Packed Chrome and Firefox extensions can be downloaded from the [releases](https://github.com/MegaManSec/NXDOMAIND/releases) page.

- Firefox: download the file, and enable it.
- Chrome: open [chrome://extensions/](chrome://extensions/), and drag the `.zip` file into your browser to import it.

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

### Load
- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
- **Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on → `dist/firefox/manifest.json`

## What it actually does
- Monitors all network requests, and extracts ICANN-only **domain** (using the [PSL](https://publicsuffix.org/) with [tldts](https://www.npmjs.com/package/tldts)).
- Uses **RDAP** to check if the domain is registered, or falls back to a DNS-only check for TLDs with no RDAP, decreasing candidates (a.b.example.com -> b.example.com -> example.com), checking for **A/AAAA/TXT/NS** via dns.google.
- Records **page URL** (where seen) and **full request URL** (what was fetched or blocked).
- Badge turns **red** on new finding; turns **blue** when popup opens; turns **yellow** while checking new domains.

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
