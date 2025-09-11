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

## What it actually does

- Monitors all network requests, and extracts all connected-to ICANN-only **domain** (using the [PSL](https://publicsuffix.org/) with [tldts](https://www.npmjs.com/package/tldts)).
- Uses either **RDAP** or **DNS-over-HTTPS** to check if the domain is actually registered, or it's an unregistered, dangling domain.
- Records the **page URL** (where the request was initiated from) and the **full request URL** (where the request was supposed to be made to).
- The extension badge turns **red** on new finding; **blue** when idle; and **yellow** while checking new domains.

The idea is that there some websites attempting to load resources from external domains which no longer exist. You can register them, and take advantage of how the external resource is being loaded.

## Download

Packed Chrome and Firefox extensions can be downloaded from the [releases](https://github.com/MegaManSec/NXDOMAIND/releases) page.

- Firefox: download the file, and enable it.
- Chrome: open [chrome://extensions/](chrome://extensions/), and drag the `.zip` file into your browser to import it.

## Build

```bash
pnpm install
pnpm run build:chrome
pnpm run build:firefox
# or
pnpm install
pnpm run build
```

- Chrome output: `dist/chrome`
- Firefox output: `dist/firefox`

There's also

```bash
pnpm run typecheck
pnpm run lint
pnpm run fix
```

### Load

- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
- **Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on → `dist/firefox/manifest.json`

## Tuning

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
