import { parse } from 'tldts';
import { Profiler } from './shared/profiler';

type Method = 'rdap' | 'dns' | null;
type StatusPublic = 'registered' | 'unregistered' | 'unknown';
type StatusInternal = StatusPublic | 'pending' | 'error';
type Status = StatusInternal;

interface PageRef {
  url: string;
  ts: number;
}

interface DomainInfo {
  status: Status;
  method: Method;
  http: number;
  url: string;
  ts: number;
  pages?: PageRef[];
  requests?: PageRef[];
  softUntil?: number;
}

const HOST_SEEN_BUMP_MS = 5_000;
const DNS_REGISTERED_SOFT_TTL_MS = 15 * 60_000;

const MAX_DOMAINS = 1_000_000; // Total maximum *domains* (eTLD+1, domain.com) kept in the cache.
const MAX_HOSTS = 1_000_000; // Total maximum *hosts* (subdomain.domain.com) kept in the cache.
const MAX_PAGES_PER_DOMAIN = 200; // Total maximum "Pages observed on:" (https://html-viewer.com/)
const MAX_REQS_PER_DOMAIN = 200; // Total maximum "Requests made to this domain:" (https://example.com/page1, https://example.com/page2)

const REQ_GC_WINDOW_MS = 30_000; // GC seen requestIds
const REQ_TTL_MS = 1_500; // suppress duplicate events for same requestId
const MAX_CONCURRENCY = 10;

// Throttle re-enqueues per registrable domain
const ENQUEUE_TTL_MS = 10_000;

// Tab history: how long to keep past URLs (ms) and how many per tab
const TAB_HISTORY_TTL_MS = 10 * 60_000; // 10 minutes ; kind of a hack so we can guess the right page, because some events have no navigation commits
const TAB_HISTORY_MAX = 10;

// Logs
const MAX_LOGS = 400; // How many lines of logs to keep
const LOG_TTL_MS = 15 * 60_000; // How long to keep logs; 15 minutes

const inflightByDomain = new Map<string, Promise<void>>();

const active = new Set<string>();
const seenRequestIds: Record<string, number> = {};
const lastQueued: Record<string, number> = {};

// MV3 (chrome.action) vs MV2 (browserAction) wrapper
const act = chrome.action || (chrome as any).browserAction;

const itemToHost = new Map<string, string>();

let hostSeen: Record<string, number> = {};
let domainStatus: Record<string, DomainInfo> = {};
let availableList: {
  domain: string;
  method: Method;
  ts: number;
  pages?: PageRef[];
  requests?: PageRef[];
}[] = [];
let queue: string[] = [];
const queued = new Set<string>();
let inflight = 0;
let hasNew = false;
let tabTopUrl: Record<number, string> = {};
let debugEnabled = false;

const ICONS = {
  blue: {
    '16': 'icons/icon16-blue.png',
    '32': 'icons/icon32-blue.png',
    '128': 'icons/icon128-blue.png',
  },
  yellow: {
    '16': 'icons/icon16-yellow.png',
    '32': 'icons/icon32-yellow.png',
    '128': 'icons/icon128-yellow.png',
  },
};

// --- Keepalive for Chrome MV3 service worker only; noop on Firefox MV2 ---
// Rationale: Firefox uses persistent background scripts; Chrome MV3 uses
// ephemeral service workers that may suspend with queued work (#5).
// We gate the alarm on MV3 to avoid unnecessary wakeups on Firefox.
// Requires "alarms" permission in manifest (both MV2/MV3).
const isMV3 = (() => {
  try {
    return (chrome?.runtime?.getManifest?.().manifest_version ?? 2) === 3;
  } catch {
    return false;
  }
})();

// Cross-browser alarms handle (Chrome or Firefox)
const alarmsApi = (chrome as any)?.alarms ?? (globalThis as any).browser?.alarms;

const QUEUE_ALARM_NAME = 'queueTick';
const QUEUE_ALARM_PERIOD_MIN = 1;

let lastBadgeAt = 0;
let lastBadgeState = {
  count: -1,
  working: undefined as boolean | undefined,
  hasNew: undefined as boolean | undefined,
};
let badgeTimer: number | null = null;

interface TabHistoryItem {
  url: string;
  ts: number;
}
const tabHistory: Record<number, TabHistoryItem[]> = {};
const frameHistory: Record<string, TabHistoryItem[]> = {};

let logs: { ts: number; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }[] = [];

type PageSource =
  | 'documentUrl'
  | 'originUrl'
  | 'initiator'
  | 'tabTopUrl'
  | 'tabHistory'
  | 'frameHistory'
  | 'none';

const dirty = {
  hostSeen: false,
  domainStatus: false,
  availableList: false,
  tabTopUrl: false,
  logs: false,
};

let persistTimer: number | null = null;
let persistScheduled = false;
let persistInFlight = false;
let persistPending = false;
let lastPersistRequestedAt = 0;

type StopFn = () => void;
const NOOP_STOP: StopFn = () => undefined;
function profTic(label: string): StopFn {
  if (debugEnabled) {
    const stop = (Profiler.tic as unknown as (l: string) => StopFn)(label);
    return typeof stop === 'function' ? stop : NOOP_STOP;
  }
  return NOOP_STOP;
}

async function persistSelective() {
  const stop = profTic('persistSelective');
  try {
    const payload: Record<string, unknown> = {};
    if (dirty.hostSeen) {
      payload.hostSeen = hostSeen;
    }
    if (dirty.domainStatus) {
      payload.domainStatus = domainStatus;
    }
    if (dirty.availableList) {
      payload.availableList = availableList;
    }
    if (dirty.tabTopUrl) {
      payload.tabTopUrl = tabTopUrl;
    }
    if (dirty.logs) {
      pruneLogsTTL();
      payload.logs = logs;
      payload.debugEnabled = debugEnabled;
    }
    if (Object.keys(payload).length === 0) {
      return;
    } // nothing to write
    await storage.set(payload);
    dirty.hostSeen =
      dirty.domainStatus =
      dirty.availableList =
      dirty.tabTopUrl =
      dirty.logs =
        false;
  } finally {
    stop();
  }
}

const storage = {
  get: (keys: string[]) =>
    new Promise<any>((res, rej) =>
      chrome.storage.local.get(keys, (val) => {
        const err = chrome.runtime.lastError;
        return err ? rej(err) : res(val);
      }),
    ),
  set: (obj: any) =>
    new Promise<void>((res, rej) =>
      chrome.storage.local.set(obj, () => {
        const err = chrome.runtime.lastError;
        return err ? rej(err) : res();
      }),
    ),
};

function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string) {
  const stop = profTic('log');
  try {
    if (level === 'debug' && !debugEnabled) {
      return;
    }
    try {
      const entry = { ts: Date.now(), level, msg: String(msg) };
      logs.push(entry);
      pruneLogsTTL();
      (console[level] || console.log)(
        `[${new Date(entry.ts).toISOString()}] [${entry.level}] ${entry.msg}`,
      );
    } catch (e) {
      try {
        console.error('log() failure:', e);
      } catch {}
    }
  } finally {
    stop();
  }
}

function pruneLogsTTL(nowTs = Date.now()) {
  const stop = profTic('pruneLogsTTL');

  try {
    const cutoff = nowTs - LOG_TTL_MS;
    // keep only recent logs
    logs = logs.filter((l) => l && typeof l.ts === 'number' && l.ts >= cutoff);
    // and still respect MAX_LOGS (most recent)
    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }
  } finally {
    stop();
  }
}

function errToStr(e: any) {
  try {
    if (!e) {
      return 'unknown error';
    }
    if (e instanceof Error) {
      return `${e.name}: ${e.message}\n${e.stack || ''}`;
    }
    if (typeof e === 'object') {
      return JSON.stringify(e);
    }
    return String(e);
  } catch (e2) {
    try {
      console.error('errToStr failure:', e2);
    } catch {}
  }
  return 'unserializable error';
}

function persistLogsSoon() {
  const stop = profTic('persistLogsSoon');
  try {
    dirty.logs = true;
    persistSoon();
  } finally {
    stop();
  }
}

function now() {
  return Date.now();
}

function normalizeHost(h?: string | null) {
  if (!h) {
    return null;
  }
  const x = h.trim().toLowerCase().replace(/\.+$/, '');
  return x || null;
}

function isWorking() {
  return inflight > 0 || queue.length > 0 || active.size > 0;
}

/** Keep a small, fresh history of top-level URLs per tab, and mirror to tabTopUrl. */
function recordTabTop(tabId: number, url: string) {
  const stop = profTic('recordTabTop');
  try {
    if (typeof tabId !== 'number' || tabId < 0) {
      return;
    }
    tabTopUrl[tabId] = url;
    dirty.tabTopUrl = true;
    const arr = (tabHistory[tabId] ??= []);
    const t = now();
    arr.push({ url, ts: t });
    // prune by size and TTL
    while (arr.length > TAB_HISTORY_MAX) {
      arr.shift();
    }
    const cutoff = t - TAB_HISTORY_TTL_MS;
    while (arr.length && arr[0] && arr[0].ts < cutoff) {
      arr.shift();
    }
  } finally {
    stop();
  }
}

/** Keep a small, fresh history of URLs per (tab, frame). */
function recordFrameUrl(tabId: number, frameId: number, url: string) {
  const stop = profTic('recordFrameUrl');
  try {
    if (typeof tabId !== 'number' || tabId < 0) {
      return;
    }
    if (typeof frameId !== 'number' || frameId < 0) {
      return;
    }
    const key = `${tabId}:${frameId}`;
    const arr = (frameHistory[key] ??= []);
    const t = now();
    arr.push({ url, ts: t });
    // prune by size and TTL
    while (arr.length > TAB_HISTORY_MAX) {
      arr.shift();
    }
    const cutoff = t - TAB_HISTORY_TTL_MS;
    while (arr.length && arr[0] && arr[0].ts < cutoff) {
      arr.shift();
    }
  } finally {
    stop();
  }
}

/** Find most recent full URL for a tab (optionally same-origin with the given origin). */
function lookupTabHistory(tabId: number, origin?: string): string | undefined {
  const stop = profTic('lookupTabHistory');
  try {
    const arr = tabHistory[tabId];
    if (!arr?.length) {
      return undefined;
    }
    if (origin) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const it = arr[i];
        if (!it) {
          continue;
        }
        try {
          if (new URL(it.url).origin === origin) {
            return it.url;
          }
        } catch {}
      }
    }
    // else or if none matched, return the latest
    return arr[arr.length - 1]?.url;
  } finally {
    stop();
  }
}

/** Find most recent full URL for a frame (optionally same-origin). */
function lookupFrameHistory(tabId: number, frameId: number, origin?: string): string | undefined {
  const stop = profTic('lookupFrameHistory');
  try {
    const key = `${tabId}:${frameId}`;
    const arr = frameHistory[key];
    if (!arr?.length) {
      return undefined;
    }
    if (origin) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const it = arr[i];
        if (!it) {
          continue;
        }
        try {
          if (new URL(it.url).origin === origin) {
            return it.url;
          }
        } catch {}
      }
    }
    return arr[arr.length - 1]?.url;
  } finally {
    stop();
  }
}

/** Prefer full path; upgrade origin-only or missing pages via frame & tab history for robustness. */
function pageFromVerbose(details: any, tabId?: number, frameId?: number) {
  const stop = profTic('pageFromVerbose');
  try {
    let url: string | undefined;
    let source: PageSource = 'none';
    try {
      // Prefer frame history *first*
      if (typeof tabId === 'number' && typeof frameId === 'number') {
        const fh = lookupFrameHistory(tabId, frameId);
        if (fh) {
          url = fh;
          source = 'frameHistory';
        }
      }
      // Only set these if we *still* don't have a URL
      if (!url && details?.documentUrl) {
        url = String(details.documentUrl);
        source = 'documentUrl';
      } else if (!url && details?.originUrl) {
        url = String(details.originUrl);
        source = 'originUrl';
      } else if (!url && details?.initiator) {
        url = String(details.initiator);
        source = 'initiator';
      } else if (!url && typeof tabId === 'number' && tabTopUrl[tabId]) {
        url = tabTopUrl[tabId];
        source = 'tabTopUrl';
      }

      const onlyOrigin = (() => {
        if (!url) {
          return false;
        }
        try {
          const u = new URL(url);
          return u.pathname === '/' && !u.search && !u.hash;
        } catch {
          return false;
        }
      })();

      if (typeof tabId === 'number') {
        // If we only have an origin or nothing, try recent history for this tab
        if (!url) {
          const hist = lookupTabHistory(tabId);
          if (hist) {
            url = hist;
            source = 'tabHistory';
          }
        } else if (onlyOrigin) {
          try {
            const origin = new URL(url).origin;
            // Prefer a frame-scoped upgrade when possible
            if (typeof frameId === 'number') {
              const fh2 = lookupFrameHistory(tabId, frameId, origin);
              if (fh2) {
                url = fh2;
                source = 'frameHistory';
              } else {
                const hist = lookupTabHistory(tabId, origin);
                if (hist) {
                  url = hist;
                  source = 'tabHistory';
                }
              }
            } else {
              const hist = lookupTabHistory(tabId, origin);
              if (hist) {
                url = hist;
                source = 'tabHistory';
              }
            }
          } catch {}
        }
      }
    } catch (e) {
      log('error', 'pageFromVerbose error: ' + errToStr(e));
      persistLogsSoon();
    }
    return { url, source };
  } finally {
    stop();
  }
}

function updateBadgeSoon() {
  // at-most-once per 1000ms
  if (badgeTimer) {
    return;
  }
  const delay = Math.max(0, 1000 - (performance.now() - lastBadgeAt));
  badgeTimer = setTimeout(() => {
    badgeTimer = null as any;
    void updateBadge();
  }, delay) as any;
}

function updateBadge() {
  const stop = profTic('updateBadge');
  try {
    const count = availableList.length;
    const workingNow = isWorking();
    // Skip if nothing changed
    if (
      lastBadgeState.count === count &&
      lastBadgeState.working === workingNow &&
      lastBadgeState.hasNew === hasNew
    ) {
      return;
    }
    const prev = lastBadgeState;
    lastBadgeState = { count, working: workingNow, hasNew };
    lastBadgeAt = performance.now();
    // Only update the pieces that actually changed; fire-and-forget to avoid blocking
    if (prev.count !== count) {
      try {
        void act.setBadgeText({ text: count ? String(count) : '' });
      } catch {}
    }
    if (prev.hasNew !== hasNew) {
      try {
        void act.setBadgeBackgroundColor({ color: hasNew ? '#d93025' : '#1a73e8' });
      } catch {}
    }
    if (prev.working !== workingNow) {
      try {
        void act.setIcon({ path: workingNow ? ICONS.yellow : ICONS.blue });
      } catch {}
    }
  } finally {
    stop();
  }
}

function prune() {
  const stop = profTic('prune');
  try {
    const nowTs = now();
    // Enforce log TTL during general housekeeping
    pruneLogsTTL(nowTs);

    let modifiedDomainStatus = false,
      modifiedHostSeen = false,
      modifiedAvailable = false;
    // GC request ids
    for (const k of Object.keys(seenRequestIds)) {
      const v = seenRequestIds[k];
      if (v != null && nowTs - v > REQ_GC_WINDOW_MS) {
        delete seenRequestIds[k];
      }
    }
    // GC lastQueued throttle map
    for (const k of Object.keys(lastQueued)) {
      const v = lastQueued[k];
      if (v != null && nowTs - v > REQ_GC_WINDOW_MS) {
        delete lastQueued[k];
      }
    }

    // Bound domainStatus size
    const dk = Object.keys(domainStatus);
    if (dk.length > MAX_DOMAINS) {
      const del = dk.length - MAX_DOMAINS;
      dk.sort((a, b) => (domainStatus[a]?.ts ?? 0) - (domainStatus[b]?.ts ?? 0));
      for (let i = 0; i < del; i++) {
        delete domainStatus[dk[i]!];
        modifiedDomainStatus = true;
      }
    }

    // Bound hostSeen size
    const hk = Object.keys(hostSeen);
    if (hk.length > MAX_HOSTS) {
      const delH = hk.length - MAX_HOSTS;
      hk.sort((a, b) => (hostSeen[a] ?? 0) - (hostSeen[b] ?? 0));
      for (let i = 0; i < delH; i++) {
        delete hostSeen[hk[i]!];
        modifiedHostSeen = true;
      }
    }

    // Clamp pages/requests per domain
    for (const d of Object.keys(domainStatus)) {
      const ds = domainStatus[d];
      if (!ds) {
        continue;
      } // for noUncheckedIndexedAccess
      if (ds.pages && ds.pages.length > MAX_PAGES_PER_DOMAIN) {
        ds.pages.sort((a, b) => b.ts - a.ts);
        ds.pages = ds.pages.slice(0, MAX_PAGES_PER_DOMAIN);
        modifiedDomainStatus = true;
      }
      if (ds.requests && ds.requests.length > MAX_REQS_PER_DOMAIN) {
        ds.requests.sort((a, b) => b.ts - a.ts);
        ds.requests = ds.requests.slice(0, MAX_REQS_PER_DOMAIN);
        modifiedDomainStatus = true;
      }
    }
    // Clamp in availableList too
    availableList.forEach((item) => {
      let changed = false;
      if (item.pages && item.pages.length > MAX_PAGES_PER_DOMAIN) {
        item.pages.sort((a, b) => b.ts - a.ts);
        item.pages = item.pages.slice(0, MAX_PAGES_PER_DOMAIN);
        changed = true;
      }
      if (item.requests && item.requests.length > MAX_REQS_PER_DOMAIN) {
        item.requests.sort((a, b) => b.ts - a.ts);
        item.requests = item.requests.slice(0, MAX_REQS_PER_DOMAIN);
        changed = true;
      }
      if (changed) {
        modifiedAvailable = true;
      }
    });

    // Prune tab histories by TTL
    const cutoff = nowTs - TAB_HISTORY_TTL_MS;
    for (const k of Object.keys(tabHistory)) {
      const arr = tabHistory[+k];
      if (!arr) {
        continue;
      }
      while (arr.length && arr[0] && arr[0].ts < cutoff) {
        arr.shift();
      }
      if (!arr.length) {
        delete tabHistory[+k];
      }
    }
    // Prune frame histories by TTL
    for (const k of Object.keys(frameHistory)) {
      const arr = frameHistory[k];
      if (!arr) {
        delete frameHistory[k];
        continue;
      }
      while (arr.length && (arr[0]?.ts ?? Infinity) < cutoff) {
        arr.shift();
      }
      if (!arr.length) {
        delete frameHistory[k];
      }
    }
    if (modifiedDomainStatus) {
      dirty.domainStatus = true;
    }
    if (modifiedHostSeen) {
      dirty.hostSeen = true;
    }
    if (modifiedAvailable) {
      dirty.availableList = true;
    }
  } finally {
    stop();
  }
}

async function persist() {
  const stop = profTic('persist');
  try {
    prune();
    await persistSelective();
    updateBadgeSoon();
  } finally {
    stop();
  }
}

function persistSoon() {
  const stop = profTic('persistSoon');
  try {
    // debounce: 1500ms (tune 1000–2000) + min-spacing 500ms between requests
    const now = performance.now();
    if (now - lastPersistRequestedAt < 500 && persistScheduled) {
      return;
    }
    lastPersistRequestedAt = now;
    if (persistTimer) {
      clearTimeout(persistTimer as any);
    }
    persistTimer = setTimeout(triggerPersist, 1500) as any;
    persistScheduled = true;
  } finally {
    stop();
  }
}

async function triggerPersist() {
  persistTimer = null;
  if (persistInFlight) {
    // coalesce while a write is happening; run once after it finishes
    persistPending = true;
    return;
  }
  persistScheduled = false;
  persistInFlight = true;
  try {
    await persist();
  } finally {
    persistInFlight = false;
    if (persistPending) {
      persistPending = false;
      // schedule a single trailing write
      persistTimer = setTimeout(triggerPersist, 200) as any;
      persistScheduled = true;
    }
  }
}

// Track top-level page URLs (prefer webNavigation if available)
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.tabId >= 0 && details.url && details.url.startsWith('http')) {
      // Record for the specific frame
      recordFrameUrl(details.tabId, details.frameId, details.url);
      // Also mirror to tab-top history if main frame
      if (details.frameId === 0) {
        recordTabTop(details.tabId, details.url);
      }
      log(
        'debug',
        `[signal:webNavigation.onCommitted] tab=${details.tabId} frame=${details.frameId} url=${details.url}`,
      );
      persistSoon();
    }
  });
}

// Track SPA route changes and hash changes for all frames
if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.tabId >= 0 && details.url && details.url.startsWith('http')) {
      recordFrameUrl(details.tabId, details.frameId, details.url);
      if (details.frameId === 0) {
        recordTabTop(details.tabId, details.url);
      }
      log(
        'debug',
        `[signal:webNavigation.onHistoryStateUpdated] tab=${details.tabId} frame=${details.frameId} url=${details.url}`,
      );
      persistSoon();
    }
  });
}

if (chrome.webNavigation && chrome.webNavigation.onReferenceFragmentUpdated) {
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.tabId >= 0 && details.url && details.url.startsWith('http')) {
      recordFrameUrl(details.tabId, details.frameId, details.url);
      if (details.frameId === 0) {
        recordTabTop(details.tabId, details.url);
      }
      log(
        'debug',
        `[signal:webNavigation.onReferenceFragmentUpdated] tab=${details.tabId} frame=${details.frameId} url=${details.url}`,
      );
      persistSoon();
    }
  });
}

// Fallback: tabs.onUpdated always exists
chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: { url?: string }) => {
  if (changeInfo.url && /^https?:\/\//.test(changeInfo.url)) {
    recordTabTop(tabId, changeInfo.url);
    log('debug', `[signal:tabs.onUpdated] tab=${tabId} url=${changeInfo.url}`);
    persistSoon();
  }
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  delete tabTopUrl[tabId];
  // Clear all frame histories for this tab
  Object.keys(frameHistory).forEach((k) => {
    if (k.startsWith(`${tabId}:`)) {
      delete frameHistory[k];
    }
  });
  delete tabHistory[tabId];
  dirty.tabTopUrl = true;
  log('debug', `[signal:tabs.onRemoved] tab=${tabId}`);
  persistSoon();
});

// RDAP
async function rdapFetch(domain: string) {
  const stop = profTic('rdapFetch');
  try {
    const makeUrl = (d: string) => `https://rdap.org/domain/${encodeURIComponent(d)}`;

    const attempt = async (url: string, ms: number) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), ms);
      try {
        log('debug', `[rdap] GET ${url}`);
        const r = await fetch(url, {
          cache: 'no-store',
          headers: { accept: 'application/rdap+json, application/json;q=0.9, */*;q=0.1' },
          redirect: 'follow',
          signal: ctl.signal,
        });
        log('debug', `[rdap] ${domain} -> ok=${r.ok} status=${r.status} final=${r.url}`);
        return { ok: r.ok, status: r.status, finalUrl: r.url };
      } finally {
        clearTimeout(t);
      }
    };

    const url = makeUrl(domain);

    try {
      // Primary attempt
      return await attempt(url, 5000);
    } catch (e1) {
      log('warn', `[rdap] primary failed -> ${errToStr(e1)}; trying secondary`);
      persistLogsSoon();
      try {
        // Single retry with a slightly longer budget
        return await attempt(url, 7000);
      } catch (e2) {
        // Transport failure; not a domain verdict
        log('warn', `[rdap] ${domain} transient failure: ${errToStr(e2)}; will try doh`);
        persistLogsSoon();
        return { ok: false, status: 0, finalUrl: url };
      }
    }
  } finally {
    stop();
  }
}

// DNS via dns.google
async function doh(name: string, type: string) {
  const stop = profTic('doh');
  try {
    const q = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const urls = [
      `https://dns.google/resolve?${q}`, // primary
      `https://cloudflare-dns.com/dns-query?${q}`, // secondary (JSON mode via Accept)
    ];

    const attempt = async (url: string, ms: number) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), ms);
      try {
        const init: RequestInit = { cache: 'no-store', signal: ctl.signal };
        if (url.includes('cloudflare')) {
          init.headers = { accept: 'application/dns-json' };
        }
        const r = await fetch(url, init);
        if (!r.ok) {
          throw new Error(`DoH HTTP ${r.status}`);
        }
        return await r.json();
      } finally {
        clearTimeout(t);
      }
    };

    try {
      return await attempt(urls[0]!, 5000);
    } catch (e1) {
      log('warn', `[doh] primary failed -> ${errToStr(e1)}; trying secondary`);
      persistLogsSoon();
      return await attempt(urls[1]!, 5000);
    }
  } finally {
    stop();
  }
}

async function dnsCheckOne(name: string) {
  const stop = profTic('dnsCheckOne');
  try {
    try {
      log('debug', `[doh] check ${name} (NS only)`);
      const ns = await doh(name, 'NS');
      const code = (j: any) => (j && typeof j.Status === 'number' ? j.Status : -1);
      const rcode = code(ns);
      const hasNS = ns && ns.Status === 0 && Array.isArray(ns.Answer) && ns.Answer.length > 0;
      const hasSOA = Array.isArray(ns?.Authority) && ns.Authority.some((rr: any) => rr.type === 6);

      if (rcode === 3) {
        // NXDOMAIN
        log('debug', `[doh] ${name} -> unregistered (NXDOMAIN)`);
        return { status: 'unregistered' as Status, method: 'dns' as Method };
      }

      if (rcode === 0) {
        // NOERROR
        if (hasNS || hasSOA) {
          log('debug', `[doh] ${name} -> registered (NS/SOA present)`);
          return { status: 'registered' as Status, method: 'dns' as Method };
        }
      }

      // Unknown/transient rcode: treat as soft "registered" with a short TTL cache
      log('debug', `[doh] ${name} -> unknown (rcode=${rcode} transient)`);
      return {
        status: 'registered' as Status,
        method: 'dns' as Method,
        softUntil: now() + DNS_REGISTERED_SOFT_TTL_MS,
      };
    } catch (e) {
      // Network/timeout/etc
      log('warn', `[doh] ${name} transient failure: ${errToStr(e)}; soft-fail as 'unknown'`);
      persistLogsSoon();
      return { status: 'unknown' as Status, method: 'dns' as Method };
    }
  } finally {
    stop();
  }
}

async function dnsFallback(registrable: string) {
  const stop = profTic('dnsFallback');
  try {
    log('debug', `[doh] fallback registrable=${registrable}`);
    const cands = [registrable]; // no subdomain looping

    // Cache check
    const cs = domainStatus[registrable];
    if (cs && (cs.status === 'registered' || cs.status === 'unregistered')) {
      log('debug', `[doh] cache-hit ${registrable} -> ${cs.status}`);
      return {
        result: { status: cs.status, method: cs.method, http: cs.http ?? 0, url: cs.url ?? '' },
        cands,
      };
    }

    // Single DNS check at registrable
    const res = await dnsCheckOne(registrable);
    log('debug', `[doh] checked ${registrable} -> ${res.status}`);
    return {
      result: {
        status: res.status,
        method: res.method,
        http: 0,
        url: '',
        ...((res as any).softUntil ? { softUntil: (res as any).softUntil } : {}),
      },
      cands,
    };
  } finally {
    stop();
  }
}

function addPageContext(domain: string, pageUrl?: string | null) {
  const stop = profTic('addPageContext');
  try {
    if (!pageUrl) {
      return;
    }
    const item: DomainInfo = domainStatus[domain] ?? {
      status: 'pending',
      method: null,
      http: 0,
      url: '',
      ts: now(),
      pages: [],
      requests: [],
    };

    item.pages = item.pages ?? [];
    const idx = item.pages.findIndex((p) => p.url === pageUrl);
    if (idx >= 0 && item.pages[idx]) {
      item.pages[idx].ts = now();
    } else {
      item.pages.push({ url: pageUrl, ts: now() });
      if (item.pages.length > MAX_PAGES_PER_DOMAIN) {
        item.pages.sort((a, b) => b.ts - a.ts);
        item.pages = item.pages.slice(0, MAX_PAGES_PER_DOMAIN);
      }
    }
    item.ts = now();
    domainStatus[domain] = item;
    dirty.domainStatus = true;
    log('debug', `[context] page + ${pageUrl} -> ${domain} (pages=${item.pages?.length ?? 0})`);
  } finally {
    stop();
  }
}

function addRequestContext(domain: string, reqUrl?: string | null) {
  const stop = profTic('addRequestContext');
  try {
    if (!reqUrl) {
      return;
    }
    const item: DomainInfo = domainStatus[domain] ?? {
      status: 'pending',
      method: null,
      http: 0,
      url: '',
      ts: now(),
      pages: [],
      requests: [],
    };
    item.requests = item.requests ?? [];
    const idx = item.requests.findIndex((p) => p.url === reqUrl);
    if (idx >= 0 && item.requests[idx]) {
      item.requests[idx].ts = now();
    } else {
      item.requests.push({ url: reqUrl, ts: now() });
      if (item.requests.length > MAX_REQS_PER_DOMAIN) {
        item.requests.sort((a, b) => b.ts - a.ts);
        item.requests = item.requests.slice(0, MAX_REQS_PER_DOMAIN);
      }
    }
    item.ts = now();
    domainStatus[domain] = item;
    dirty.domainStatus = true;
    log('debug', `[context] request + ${reqUrl} -> ${domain} (reqs=${item.requests?.length ?? 0})`);
  } finally {
    stop();
  }
}

function mergeContextsInto(cands: string[], into: DomainInfo) {
  const stop = profTic('mergeContextsInto');
  try {
    const pages = new Map<string, number>();
    const reqs = new Map<string, number>();
    for (const cand of cands) {
      const ds = domainStatus[cand];
      if (!ds) {
        continue;
      }
      (ds.pages ?? []).forEach((p) =>
        pages.set(p.url, Math.max(pages.get(p.url) || 0, Number(p.ts) || 0)),
      );
      (ds.requests ?? []).forEach((r) =>
        reqs.set(r.url, Math.max(reqs.get(r.url) || 0, Number(r.ts) || 0)),
      );
    }
    const mergedPages = Array.from(pages.entries())
      .map(([url, ts]) => ({ url, ts }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_PAGES_PER_DOMAIN);
    const mergedReqs = Array.from(reqs.entries())
      .map(([url, ts]) => ({ url, ts }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_REQS_PER_DOMAIN);
    into.pages = mergedPages;
    into.requests = mergedReqs;
  } finally {
    stop();
  }
}

function propagateStatus(cands: string[], result: DomainInfo) {
  const stop = profTic('propagateStatus');

  try {
    const ts = now();
    mergeContextsInto(cands, result);

    for (const cand of cands) {
      domainStatus[cand] = {
        ...result,
        ts,
        ...(result.pages ? { pages: result.pages } : {}),
        ...(result.requests ? { requests: result.requests } : {}),
      };
    }
    dirty.domainStatus = true;

    const shortest = cands[0]!; // registrable
    if (result.status === 'unregistered') {
      const existing = availableList.find((x) => x.domain === shortest);
      if (existing) {
        const pm = new Map<string, number>((existing.pages ?? []).map((p) => [p.url, p.ts]));
        (result.pages ?? []).forEach((p) => pm.set(p.url, Math.max(pm.get(p.url) || 0, p.ts)));
        existing.pages = Array.from(pm.entries())
          .map(([url, ts]) => ({ url, ts }))
          .sort((a, b) => b.ts - a.ts)
          .slice(0, MAX_PAGES_PER_DOMAIN);

        const rm = new Map<string, number>((existing.requests ?? []).map((r) => [r.url, r.ts]));
        (result.requests ?? []).forEach((r) => rm.set(r.url, Math.max(rm.get(r.url) || 0, r.ts)));
        existing.requests = Array.from(rm.entries())
          .map(([url, ts]) => ({ url, ts }))
          .sort((a, b) => b.ts - a.ts)
          .slice(0, MAX_REQS_PER_DOMAIN);

        existing.method = result.method ?? existing.method ?? null;
        existing.ts = ts;
        dirty.availableList = true;

        log(
          'debug',
          `[availableList] updated ${shortest} pages=${existing.pages?.length ?? 0} reqs=${existing.requests?.length ?? 0}`,
        );
        persistSoon();
      } else {
        availableList.push({
          domain: shortest,
          method: result.method ?? null,
          ts,
          ...(result.pages ? { pages: result.pages } : {}),
          ...(result.requests ? { requests: result.requests } : {}),
        });
        dirty.availableList = true;
        hasNew = true;
        log(
          'debug',
          `[availableList] added ${shortest} pages=${result.pages?.length ?? 0} reqs=${result.requests?.length ?? 0}`,
        );
        persistSoon();
      }
    }
  } finally {
    stop();
  }
}

function ensureEnqueued(regDomain: string, origHost: string, source: string) {
  const stop = profTic('ensureEnqueued');
  try {
    const t = now();

    // throttle: if we queued this recently, skip
    if (lastQueued[regDomain] && t - lastQueued[regDomain] < ENQUEUE_TTL_MS) {
      log('debug', `[queue] skip-throttle ${regDomain} (src=${source})`);
      return;
    }

    // If already RESOLVED (not pending), skip — unless a soft TTL has expired (#5 + perf cache refresh)
    if (domainStatus[regDomain]) {
      const ds = domainStatus[regDomain];
      if (ds.status !== 'pending' && ds.status !== 'error') {
        const expiredSoft =
          ds.method === 'dns' && typeof ds.softUntil === 'number' && now() > ds.softUntil;
        if (!expiredSoft) {
          log(
            'debug',
            `[queue] skip-resolved ${regDomain} status=${ds.status} softUntil=${
              ds.softUntil ? new Date(ds.softUntil).toISOString() : '-'
            }`,
          );
          return;
        }
        // allow re-enqueue to refresh soft-cached DNS verdict
        log('debug', `[queue] re-enqueue after soft TTL ${regDomain}`);
      }
    }

    if (active.has(regDomain)) {
      log('debug', `[queue] skip-active ${regDomain}`);
      return;
    }
    if (inflightByDomain.has(regDomain) || queued.has(regDomain)) {
      log('debug', `[queue] skip-inqueue ${regDomain}`);
      return;
    }

    itemToHost.set(regDomain, origHost);
    queue.push(regDomain);
    queued.add(regDomain);
    lastQueued[regDomain] = t;
    log(
      'debug',
      `[queue] + ${regDomain} (src=${source}) size=${queue.length} inflight=${inflight}`,
    );
    updateBadgeSoon();
    void processQueue();
  } finally {
    stop();
  }
}

async function checkRegistrable(registrable: string) {
  const stop = profTic('checkRegistrable');
  try {
    if (inflightByDomain.has(registrable)) {
      await inflightByDomain.get(registrable);
      return;
    }
    const p = (async () => {
      log('debug', `[check] registrable=${registrable}`);
      const resp = await rdapFetch(registrable);

      if (resp.ok && resp.status === 200) {
        const cands = [registrable];
        const result: DomainInfo = {
          status: 'registered',
          method: 'rdap',
          http: 200,
          url: resp.finalUrl,
          ts: now(),
        };
        propagateStatus(cands, result);
        log('debug', `[check] ${registrable} -> registered (rdap 200)`);
        return;
      }

      if (!resp.ok && resp.status === 404) {
        const cands = [registrable];
        // If rdap.org redirected us to an authoritative RDAP endpoint,
        // a 404 there is strong evidence of "unregistered".
        const redirectedOffAggregator = !resp.finalUrl.startsWith('https://rdap.org/');
        if (redirectedOffAggregator) {
          const result: DomainInfo = {
            status: 'unregistered',
            method: 'rdap',
            http: 404,
            url: resp.finalUrl,
            ts: now(),
          };
          propagateStatus(cands, result);
          log('debug', `[check] ${registrable} -> unregistered (rdap 404 via redirect)`);
          return;
        }
        // Otherwise confirm with DNS before committing.
        try {
          const { result } = await dnsFallback(registrable);
          if (result.status === 'registered' || result.status === 'unregistered') {
            propagateStatus(cands, {
              ...result,
              http: result.http ?? 0,
              url: result.url ?? '',
              ts: now(),
            });
            log(
              'debug',
              `[check] ${registrable} -> ${result.status} (dns fallback after rdap 404 on aggregator)`,
            );
            return;
          }
        } catch {}
        log(
          'warn',
          `[check] ${registrable} rdap 404 on aggregator; DNS inconclusive -> keeping 'pending'`,
        );
        delete lastQueued[registrable];
        return;
      }

      if (!resp.ok && resp.status === 0) {
        const cands = [registrable];

        // Try DNS as a best-effort fallback first
        try {
          const { result } = await dnsFallback(registrable);
          if (result.status === 'registered' || result.status === 'unregistered') {
            // We got a definitive answer from DNS - commit it.
            propagateStatus(cands, {
              ...result,
              http: result.http ?? 0,
              url: result.url ?? '',
              ts: now(),
            });
            log(
              'debug',
              `[check] ${registrable} -> ${result.status} (dns fallback after rdap network failure)`,
            );
          } else {
            // SOFT FAIL: keep pending (no propagateStatus), so it retries on next signal.
            log(
              'warn',
              `[check] ${registrable} rdap network failure; dns fallback inconclusive -> keeping 'pending' so it will retry`,
            );
            delete lastQueued[registrable]; // lift throttle so a new signal can re-enqueue immediately
          }
        } catch (e) {
          // SOFT FAIL: keep pending
          log(
            'warn',
            `[check] ${registrable} rdap network failure and dns fallback failed: ${errToStr(e)} -> keeping 'pending'`,
          );
          delete lastQueued[registrable];
        }
        return;
      }

      const cands = [registrable];
      const result: DomainInfo = {
        status: 'error',
        method: 'rdap',
        http: resp.status,
        url: resp.finalUrl,
        ts: now(),
      };
      propagateStatus(cands, result);
      log('debug', `[check] ${registrable} -> error http=${resp.status}`);
    })().finally(() => inflightByDomain.delete(registrable));
    inflightByDomain.set(registrable, p);
    await p;
  } finally {
    stop();
  }
}

async function processQueue() {
  const stop = profTic('processQueue');
  try {
    while (inflight < MAX_CONCURRENCY && queue.length) {
      const item = queue.shift()!;
      active.add(item);
      queued.delete(item);
      inflight++;
      updateBadgeSoon();
      log('debug', `[process] start ${item} inflight=${inflight} remaining=${queue.length}`);
      try {
        await checkRegistrable(item);
        log('debug', `[process] done  ${item}`);
      } catch (e) {
        log('error', `[process] ${item} failed: ${errToStr(e)}`);
        persistLogsSoon();
      } finally {
        active.delete(item);
        itemToHost.delete(item);
        inflight = Math.max(0, inflight - 1);
        if (queue.length) {
          setTimeout(() => {
            void processQueue();
          }, 0);
        }
        persistSoon(); // batch writes under load
        updateBadgeSoon();
        log('debug', `[process] finalize ${item} inflight=${inflight} remaining=${queue.length}`);
      }
    }
  } finally {
    stop();
  }
}

// onBeforeRequest: see URLs even if blocked by extensions
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url: requestUrl, tabId, requestId, frameId } = details as any;

    if (requestId) {
      const t = now();
      if (seenRequestIds[requestId] && t - seenRequestIds[requestId] < REQ_TTL_MS) {
        log('debug', `[signal:beforeRequest] skip-dup rid=${requestId} url=${requestUrl}`);
        return;
      }
      seenRequestIds[requestId] = t;
    }

    if (
      typeof requestUrl !== 'string' ||
      (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://'))
    ) {
      log('debug', `[signal:beforeRequest] skip-nonhttp url=${requestUrl}`);
      return;
    }

    try {
      log(
        'debug',
        `[signal:beforeRequest] rid=${requestId ?? '-'} tab=${tabId ?? '-'} frame=${frameId ?? '-'} type=${(details as any).type ?? '-'} url=${requestUrl}`,
      );

      const urlObj = new URL(requestUrl);
      const host = normalizeHost(urlObj.hostname);
      if (!host) {
        log('debug', `[signal:beforeRequest] skip-host host=${host}`);
        return;
      }

      const t = now();
      const prev = hostSeen[host] || 0;
      hostSeen[host] = t;
      if (t - prev >= HOST_SEEN_BUMP_MS) {
        dirty.hostSeen = true;
        persistSoon();
      }

      const info = parse(host); // ICANN-only by default
      if (!info.domain || info.isIp || !info.isIcann) {
        log(
          'debug',
          `[signal:beforeRequest] skip-tldts host=${host} isIp=${info.isIp} isIcann=${info.isIcann}`,
        );
        return;
      }

      const registrable = info.domain;
      let { url: pageUrl, source: pageSrc } = pageFromVerbose(details, tabId, frameId);
      // Special-case main frame: if no page context, the page *is* the request URL
      const isMainFrame = (details as any).type === 'main_frame' || frameId === 0;
      if (!pageUrl && isMainFrame) {
        pageUrl = requestUrl;
        pageSrc = 'documentUrl';
      }
      log('debug', `[signal:beforeRequest] pageSrc=${pageSrc} pageUrl=${pageUrl ?? '-'}`);

      if (pageUrl) {
        addPageContext(registrable, pageUrl);
      }
      addRequestContext(registrable, requestUrl);

      if (!domainStatus[registrable]) {
        domainStatus[registrable] = {
          status: 'pending',
          method: null,
          http: 0,
          url: '',
          ts: now(),
          pages: [],
          requests: [],
        };
        log('debug', `[state] set pending ${registrable}`);
      }

      ensureEnqueued(registrable, host, 'beforeRequest');
    } catch (e) {
      log('error', 'onBeforeRequest handler failed: ' + errToStr(e));
      persistLogsSoon();
    }
    return undefined;
  },
  { urls: ['http://*/*', 'https://*/*'] },
);

// onErrorOccurred: log canceled/blocked (privacy/CSP/etc.), enqueue
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const { tabId, requestId, frameId } = details as any;

    if (requestId) {
      const t = now();
      if (seenRequestIds[requestId] && t - seenRequestIds[requestId] < REQ_TTL_MS) {
        log('debug', `[signal:errorOccurred] skip-dup rid=${requestId} url=${details.url}`);
        return;
      }
      seenRequestIds[requestId] = t;
    }

    if (!details?.url) {
      return;
    }
    const requestUrl = details.url;

    if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) {
      log('debug', `[signal:errorOccurred] skip-nonhttp url=${requestUrl}`);
      return;
    }

    try {
      log(
        'debug',
        `[signal:errorOccurred] rid=${requestId ?? '-'} tab=${tabId ?? '-'} frame=${frameId ?? '-'} type=${(details as any).type ?? '-'} url=${requestUrl} err=${(details as any).error ?? '-'}`,
      );

      const host = normalizeHost(new URL(requestUrl).hostname);
      if (!host) {
        log('debug', `[signal:errorOccurred] skip-host host=${host}`);
        return;
      }

      const info = parse(host);
      if (!info.domain || info.isIp || !info.isIcann) {
        log(
          'debug',
          `[signal:errorOccurred] skip-tldts host=${host} isIp=${info.isIp} isIcann=${info.isIcann}`,
        );
        return;
      }

      const registrable = info.domain;
      let { url: pageUrl, source: pageSrc } = pageFromVerbose(details, tabId, frameId);
      // Special-case main frame failures: use the failing request as the page URL
      const isMainFrame = (details as any).type === 'main_frame' || frameId === 0;
      if (!pageUrl && isMainFrame) {
        pageUrl = requestUrl;
        pageSrc = 'documentUrl';
      }
      log('debug', `[signal:errorOccurred] pageSrc=${pageSrc} pageUrl=${pageUrl ?? '-'}`);

      if (pageUrl) {
        addPageContext(registrable, pageUrl);
      }
      addRequestContext(registrable, requestUrl);

      if (!domainStatus[registrable]) {
        domainStatus[registrable] = {
          status: 'pending',
          method: null,
          http: 0,
          url: '',
          ts: now(),
          pages: [],
          requests: [],
        };
        log('debug', `[state] set pending ${registrable}`);
      }
      ensureEnqueued(registrable, host, 'errorOccurred');
    } catch (e) {
      log('error', 'onErrorOccurred handler failed: ' + errToStr(e));
      persistLogsSoon();
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
);

// Messages
chrome.runtime.onMessage.addListener(
  (
    msg: { type?: string; [k: string]: any },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ) => {
    if (msg?.type === 'ackNew') {
      hasNew = false;
      updateBadgeSoon();
      sendResponse({ ok: true });
      return true;
    }

    if (msg?.type === 'getLogs') {
      pruneLogsTTL();
      sendResponse({ logs, debugEnabled });
      return true;
    }

    if (msg?.type === 'setDebug') {
      debugEnabled = !!msg.enabled;
      void storage
        .set({ debugEnabled })
        .catch((e) => log('error', 'setDebug storage.set failed: ' + errToStr(e)));
      sendResponse({ ok: true, debugEnabled });
      return true;
    }

    if (msg?.type === 'clearLogs') {
      logs = [];
      void storage
        .set({ logs })
        .catch((e) => log('error', 'clearLogs storage.set failed: ' + errToStr(e)));
      sendResponse({ ok: true });
      return true;
    }

    if (msg?.type === 'getState') {
      // Return authoritative in-memory state; don't overwrite it from storage here.
      let cacheSize = 0;
      for (const dkey of Object.keys(domainStatus)) {
        const d = domainStatus[dkey];
        if (!d) {
          continue;
        }
        if (d.status !== 'pending' && d.status !== 'unknown') {
          cacheSize += 1;
        }
      }
      sendResponse({
        availableList,
        cacheSize: cacheSize,
        hostsSeen: Object.keys(hostSeen).length,
      });
      return true;
    }

    if (msg?.type === 'clearCache') {
      hostSeen = {};
      domainStatus = {};
      queue = [];
      hasNew = false;
      updateBadgeSoon();
      try {
        (active as any).clear?.();
      } catch (e) {
        log('error', 'clearCache active.clear failed: ' + errToStr(e));
        persistLogsSoon();
      }
      for (const k of Object.keys(lastQueued)) {
        delete lastQueued[k];
      }
      queued.clear();
      try {
        (itemToHost as any).clear?.();
      } catch (e) {
        log('error', 'clearCache itemToHost.clear failed: ' + errToStr(e));
        persistLogsSoon();
      }
      void storage
        .set({ hostSeen, domainStatus })
        .catch((e) => log('error', 'clearCache storage.set failed: ' + errToStr(e)));
      void persist()
        .then(() => {
          sendResponse({ ok: true });
        })
        .catch((e) => {
          log('error', 'persist failed: ' + errToStr(e));
          sendResponse({ ok: false });
        });
      return true;
    }

    if (msg?.type === 'clearAvailable') {
      availableList = [];
      hasNew = false;
      updateBadgeSoon();
      void storage
        .set({ availableList })
        .then(() => {
          updateBadgeSoon();
        })
        .catch((e) => log('error', 'clearAvailable storage.set failed: ' + errToStr(e)));
      sendResponse({ ok: true });
      return true;
    }

    if (msg?.type === 'cspViolation') {
      try {
        const raw = typeof msg.blockedURL === 'string' ? msg.blockedURL : '';
        const tabUrl = sender?.tab?.url || '-';
        log(
          'debug',
          `[signal:cspViolation] blocked=${raw || '-'} document=${msg.documentURL ?? '-'} tabUrl=${tabUrl}`,
        );

        // Page URL (document), upgraded via tab history if only-origin.
        const rawPage =
          (typeof msg.documentURL === 'string' ? msg.documentURL : undefined) ||
          (typeof tabUrl === 'string' && tabUrl !== '-' ? tabUrl : undefined);
        let pageUrl: string | undefined = rawPage;
        try {
          if (rawPage && sender?.tab?.id != null) {
            const ru = new URL(rawPage);
            const onlyOrigin = ru.pathname === '/' && !ru.search && !ru.hash;
            if (onlyOrigin) {
              const hist = lookupTabHistory(sender.tab.id, ru.origin);
              if (hist) {
                pageUrl = hist;
              }
            }
          }
        } catch {}
        if (!pageUrl && sender?.tab?.id != null) {
          const hist = lookupTabHistory(sender.tab.id);
          if (hist) {
            pageUrl = hist;
          }
        }

        // Derive blocked host when possible (http/https or blob:https://...).
        let blockedHost: string | null = null;
        if (/^https?:/i.test(raw)) {
          try {
            blockedHost = normalizeHost(new URL(raw).hostname);
          } catch {}
        } else if (raw.startsWith('blob:')) {
          const inner = raw.slice(5);
          try {
            blockedHost = normalizeHost(new URL(inner).hostname);
          } catch {}
        }

        // Prefer attributing to the page's registrable; fall back to blocked host.
        let registrable: string | null = null;
        try {
          if (pageUrl) {
            const ph = normalizeHost(new URL(pageUrl).hostname);
            const info = ph ? parse(ph) : ({} as any);
            if (info.domain && info.isIcann && !info.isIp) {
              registrable = info.domain;
            }
          }
        } catch {}
        if (!registrable && blockedHost) {
          const info = parse(blockedHost);
          if (info.domain && info.isIcann && !info.isIp) {
            registrable = info.domain;
          }
        }

        if (registrable) {
          // Context: record page; only record request if it's a real http(s) URL.
          if (pageUrl) {
            addPageContext(registrable, pageUrl);
          }
          if (blockedHost && /^https?:/i.test(raw)) {
            addRequestContext(registrable, raw);
          }

          if (!domainStatus[registrable]) {
            domainStatus[registrable] = {
              status: 'pending',
              method: null,
              http: 0,
              url: '',
              ts: now(),
              pages: [],
              requests: [],
            };
            log('debug', `[state] set pending ${registrable}`);
          }
          // Keep queue/active semantics consistent with other signals.
          ensureEnqueued(registrable, blockedHost || registrable, 'cspViolation');
        } else {
          log(
            'debug',
            `[signal:cspViolation] skip (no registrable) blockedHost=${blockedHost ?? '-'} pageUrl=${pageUrl ?? '-'}`,
          );
        }
      } catch (e) {
        log('error', 'cspViolation handler failed: ' + errToStr(e));
        persistLogsSoon();
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg?.type === 'recheckDomain' && typeof msg.domain === 'string') {
      const host = normalizeHost(msg.domain);
      const info = host ? parse(host) : null;
      const registrable = info && info.domain && info.isIcann && !info.isIp ? info.domain : null;
      if (registrable) {
        delete domainStatus[registrable];
        delete lastQueued[registrable];
        const hostHint = itemToHost.get(registrable) || host || registrable;
        ensureEnqueued(registrable, hostHint, 'recheck');
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      return true;
    }
    return false;
  },
);

async function init() {
  const s = await storage.get([
    'hostSeen',
    'domainStatus',
    'availableList',
    'tabTopUrl',
    'logs',
    'debugEnabled',
  ]);
  hostSeen = s.hostSeen || {};
  domainStatus = s.domainStatus || {};
  availableList = s.availableList || [];
  tabTopUrl = s.tabTopUrl || {};
  logs = Array.isArray(s.logs) ? s.logs : [];
  pruneLogsTTL();
  debugEnabled = !!s.debugEnabled;
  updateBadge();
  void processQueue();
}

function ensureQueueAlarm() {
  if (!alarmsApi) {
    return;
  }
  try {
    // Re-creating with the same name overwrites the old one; idempotent.
    alarmsApi.create?.(QUEUE_ALARM_NAME, { periodInMinutes: QUEUE_ALARM_PERIOD_MIN });
  } catch (e) {
    try {
      log('warn', `[alarms] failed to create ${QUEUE_ALARM_NAME}: ${errToStr(e)}`);
    } catch {}
    try {
      persistLogsSoon();
    } catch {}
  }
}

if (isMV3 && alarmsApi) {
  try {
    alarmsApi.onAlarm?.addListener?.((alarm: any) => {
      if (alarm?.name === QUEUE_ALARM_NAME) {
        void processQueue();
      }
    });
    ensureQueueAlarm();
  } catch (e) {
    try {
      log('warn', `[alarms] setup failed: ${errToStr(e)}`);
    } catch {}
  }
}

void init();
