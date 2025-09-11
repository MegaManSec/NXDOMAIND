import { parse } from 'tldts';

type Method = 'rdap' | 'dns' | null;
type Status = 'registered' | 'unregistered' | 'unknown' | 'error' | 'cors_error' | 'pending';

interface PageRef { url: string; ts: number; }

interface DomainInfo {
  status: Status;
  method: Method;
  http: number;
  url: string;
  ts: number;
  pages?: PageRef[];
  requests?: PageRef[];
}

const MAX_DOMAINS = 1_000_000_000; // Total maximum *domains* (eTLD+1, domain.com) kept in the cache.
const MAX_HOSTS = 1_000_000_000; // Total maximum *hosts* (subdomain.domain.com) kept in the cache.
const MAX_PAGES_PER_DOMAIN = 200; // Total maximum "Pages observed on:" (https://html-viewer.com/)
const MAX_REQS_PER_DOMAIN  = 200; // Total maximum "Requests made to this domain:" (https://example.com/page1, https://example.com/page2)

const REQ_GC_WINDOW_MS = 60_000; // GC seen requestIds
const REQ_TTL_MS = 5_000;        // suppress duplicate events for same requestId
const MAX_CONCURRENCY = 3;

// Throttle re-enqueues per registrable domain
const ENQUEUE_TTL_MS = 30_000;

// Tab history: how long to keep past URLs (ms) and how many per tab
const TAB_HISTORY_TTL_MS = 10 * 60_000; // 10 minutes ; kind of a hack so we can guess the right page, because some events have no navigation commits
const TAB_HISTORY_MAX = 10;

// Logs
const MAX_LOGS = 400; // How many lines of logs to keep
const LOG_TTL_MS = 15 * 60_000; // How long to keep logs; 15 minutes

const storage = {
  get: (keys: string[]) => new Promise<any>((res, rej) =>
    chrome.storage.local.get(keys, (val) => {
      const err = chrome.runtime.lastError;
      return err ? rej(err) : res(val);
    })
  ),
  set: (obj: any) => new Promise<void>((res, rej) =>
    chrome.storage.local.set(obj, () => {
      const err = chrome.runtime.lastError;
      return err ? rej(err) : res();
    })
  ),
};

// MV3 (chrome.action) vs MV2 (browserAction) wrapper
const act = (chrome.action || (chrome as any).browserAction);

let hostSeen: Record<string, number> = {};
let domainStatus: Record<string, DomainInfo> = {};
let availableList: Array<{ domain: string; method: Method; ts: number; pages?: PageRef[]; requests?: PageRef[] }> = [];
let queue: string[] = [];
let inflight = 0;
let hasNew = false;
let tabTopUrl: Record<number, string> = {};
let debugEnabled = false;

type TabHistoryItem = { url: string; ts: number };
const tabHistory: Record<number, TabHistoryItem[]> = {};
const frameHistory: Record<string, TabHistoryItem[]> = {};

let logs: Array<{ts:number, level:'debug'|'info'|'warn'|'error', msg:string}> = [];

function log(level:'debug'|'info'|'warn'|'error', msg:string){
  if (level==='debug' && !debugEnabled) return;
  try {
    const entry = { ts: Date.now(), level, msg: String(msg) };
    logs.push(entry);
    pruneLogsTTL();
    (console[level] || console.log)(`[${new Date(entry.ts).toISOString()}] [${entry.level}] ${entry.msg}`);
  } catch (e) {
    try { console.error('log() failure:', e); } catch {}
  }
}

function pruneLogsTTL(nowTs = Date.now()){
  const cutoff = nowTs - LOG_TTL_MS;
  // keep only recent logs
  logs = logs.filter(l => l && typeof l.ts === 'number' && l.ts >= cutoff);
  // and still respect MAX_LOGS (most recent)
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

function errToStr(e:any){
  try {
    if (!e) return 'unknown error';
    if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack||''}`;
    if (typeof e === 'object') return JSON.stringify(e);
    return String(e);
  } catch (e2) {
    try { console.error('errToStr failure:', e2); } catch {}
  }
  return 'unserializable error';
}

let persistTimer: number | null = null;
let persistLogsTimer: number | null = null;

function persistLogsSoon(){
  try { if (persistLogsTimer) clearTimeout(persistLogsTimer as any); } catch {}
  persistLogsTimer = setTimeout(() => {
    pruneLogsTTL();
    storage.set({ logs, debugEnabled });
    persistLogsTimer = null as any;
  }, 150) as any;
}

const active = new Set<string>();
const seenRequestIds: Record<string, number> = {};
const lastQueued: Record<string, number> = {};

function now(){ return Date.now(); }

function normalizeHost(h?: string | null){
  if (!h) return null;
  const x = h.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return x || null;
}

function isWorking() {
  return inflight > 0 || queue.length > 0 || active.size > 0;
}

/** Keep a small, fresh history of top-level URLs per tab, and mirror to tabTopUrl. */
function recordTabTop(tabId: number, url: string) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  tabTopUrl[tabId] = url;
  const arr = (tabHistory[tabId] ??= []);
  const t = now();
  arr.push({ url, ts: t });
  // prune by size and TTL
  while (arr.length > TAB_HISTORY_MAX) arr.shift();
  const cutoff = t - TAB_HISTORY_TTL_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
}

/** Keep a small, fresh history of URLs per (tab, frame). */
function recordFrameUrl(tabId: number, frameId: number, url: string) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  if (typeof frameId !== 'number' || frameId < 0) return;
  const key = `${tabId}:${frameId}`;
  const arr = (frameHistory[key] ??= []);
  const t = now();
  arr.push({ url, ts: t });
  // prune by size and TTL
  while (arr.length > TAB_HISTORY_MAX) arr.shift();
  const cutoff = t - TAB_HISTORY_TTL_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
}



/** Find most recent full URL for a tab (optionally same-origin with the given origin). */
function lookupTabHistory(tabId: number, origin?: string): string | undefined {
  const arr = tabHistory[tabId];
  if (!arr || !arr.length) return undefined;
  if (origin) {
    for (let i = arr.length - 1; i >= 0; i--) {
      try {
        if (new URL(arr[i].url).origin === origin) return arr[i].url;
      } catch {}
    }
  }
  // else or if none matched, return the latest
  return arr[arr.length - 1]?.url;
}

/** Find most recent full URL for a frame (optionally same-origin). */
function lookupFrameHistory(tabId: number, frameId: number, origin?: string): string | undefined {
  const key = `${tabId}:${frameId}`;
  const arr = frameHistory[key];
  if (!arr || !arr.length) return undefined;
  if (origin) {
    for (let i = arr.length - 1; i >= 0; i--) {
      try {
        if (new URL(arr[i].url).origin === origin) return arr[i].url;
      } catch {}
    }
  }
  return arr[arr.length - 1]?.url;
}

type PageSource = 'documentUrl'|'originUrl'|'initiator'|'tabTopUrl'|'tabHistory'|'frameHistory'|'none';

/** Prefer full path; upgrade origin-only or missing pages via frame & tab history for robustness. */
function pageFromVerbose(details:any, tabId?:number, frameId?:number){
  let url: string | undefined;
  let source: PageSource = 'none';
  try {
    // Prefer frame history *first*
    if (typeof tabId === 'number' && typeof frameId === 'number') {
      const fh = lookupFrameHistory(tabId, frameId);
      if (fh) { url = fh; source = 'frameHistory'; }
    }
    // Only set these if we *still* don't have a URL
    if (!url && details?.documentUrl) { url = String(details.documentUrl); source = 'documentUrl'; }
    else if (!url && details?.originUrl) { url = String(details.originUrl); source = 'originUrl'; }
    else if (!url && details?.initiator) { url = String(details.initiator); source = 'initiator'; }
    else if (!url && typeof tabId === 'number' && tabTopUrl[tabId]) { url = tabTopUrl[tabId]; source = 'tabTopUrl'; }

    const onlyOrigin = (() => {
      if (!url) return false;
      try { const u = new URL(url); return u.pathname === '/' && !u.search && !u.hash; } catch { return false; }
    })();

    if (typeof tabId === 'number') {
      // If we only have an origin or nothing, try recent history for this tab
      if (!url) {
        const hist = lookupTabHistory(tabId);
        if (hist) { url = hist; source = 'tabHistory'; }
      } else if (onlyOrigin) {
        try {
          const origin = new URL(url).origin;
          // Prefer a frame-scoped upgrade when possible
          if (typeof frameId === 'number') {
            const fh2 = lookupFrameHistory(tabId, frameId, origin);
            if (fh2) { url = fh2; source = 'frameHistory'; }
            else {
              const hist = lookupTabHistory(tabId, origin);
              if (hist) { url = hist; source = 'tabHistory'; }
            }
          } else {
            const hist = lookupTabHistory(tabId, origin);
            if (hist) { url = hist; source = 'tabHistory'; }
          }
        } catch {}
      }
    }
  } catch (e) {
    log('error', 'pageFromVerbose error: ' + errToStr(e));
    persistLogsSoon();
  }
  return { url, source };
}

function candidatesFrom(originalHost: string, registrable: string | null): string[] {
  if (!registrable) return [];
  const labels = originalHost.split('.').filter(Boolean);
  const regLabels = registrable.split('.');
  // If host doesn't end with registrable (edge), just return registrable
  if (labels.slice(-regLabels.length).join('.') !== registrable) return [registrable];
  const out: string[] = [registrable];
  // Add longer host suffixes above registrable (shortest -> longest)
  for (let i = labels.length - regLabels.length - 1; i >= 0; i--) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

const ICONS = {
  blue: {
    "16": "icons/icon16-blue.png",
    "32": "icons/icon32-blue.png",
    "128": "icons/icon128-blue.png",
  },
  yellow: {
    "16": "icons/icon16-yellow.png",
    "32": "icons/icon32-yellow.png",
    "128": "icons/icon128-yellow.png",
  },
};

async function updateBadge(){
  const count = availableList.length;
  try { await act.setBadgeText({ text: count ? String(count) : "" }); } catch {}
  try { await act.setBadgeBackgroundColor({ color: hasNew ? "#d93025" : "#1a73e8" }); } catch {}
  const working = isWorking();
  try { await act.setIcon({ path: working ? ICONS.yellow : ICONS.blue }); } catch {}
}

function prune(){
  const nowTs = now();
  // Enforce log TTL during general housekeeping
  pruneLogsTTL(nowTs);

  // GC request ids
  for (const k of Object.keys(seenRequestIds)){
    if (nowTs - seenRequestIds[k] > REQ_GC_WINDOW_MS) delete seenRequestIds[k];
  }

  // GC lastQueued throttle map
  for (const k of Object.keys(lastQueued)){
    if (nowTs - lastQueued[k] > REQ_GC_WINDOW_MS) delete lastQueued[k];
  }

  // Bound domainStatus size
  const dk = Object.keys(domainStatus);
  if (dk.length > MAX_DOMAINS){
    dk.sort((a,b) => (domainStatus[a].ts - domainStatus[b].ts));
    const del = dk.length - MAX_DOMAINS;
    for (let i=0;i<del;i++) delete domainStatus[dk[i]];
  }

  // Bound hostSeen size
  const hk = Object.keys(hostSeen);
  if (hk.length > MAX_HOSTS){
    hk.sort((a,b) => (hostSeen[a] - hostSeen[b]));
    const del = hk.length - MAX_HOSTS;
    for (let i=0;i<del;i++) delete hostSeen[hk[i]];
  }

  // Clamp pages/requests per domain
  for (const d of Object.keys(domainStatus)){
    const ds = domainStatus[d];
    if (ds.pages && ds.pages.length > MAX_PAGES_PER_DOMAIN){
      ds.pages.sort((a,b)=>b.ts - a.ts);
      ds.pages = ds.pages.slice(0, MAX_PAGES_PER_DOMAIN);
    }
    if (ds.requests && ds.requests.length > MAX_REQS_PER_DOMAIN){
      ds.requests.sort((a,b)=>b.ts - a.ts);
      ds.requests = ds.requests.slice(0, MAX_REQS_PER_DOMAIN);
    }
  }

  // Clamp in availableList too
  availableList.forEach(item => {
    if (item.pages && item.pages.length > MAX_PAGES_PER_DOMAIN){
      item.pages.sort((a,b)=>b.ts - a.ts);
      item.pages = item.pages.slice(0, MAX_PAGES_PER_DOMAIN);
    }
    if (item.requests && item.requests.length > MAX_REQS_PER_DOMAIN){
      item.requests.sort((a,b)=>b.ts - a.ts);
      item.requests = item.requests.slice(0, MAX_REQS_PER_DOMAIN);
    }
  });

  // Prune tab histories by TTL
  const cutoff = nowTs - TAB_HISTORY_TTL_MS;
  for (const k of Object.keys(tabHistory)) {
    const arr = tabHistory[+k];
    if (!arr) continue;
    while (arr.length && arr[0].ts < cutoff) arr.shift();
    if (!arr.length) delete tabHistory[+k];
  }
  // Prune frame histories by TTL
  for (const k of Object.keys(frameHistory)) {
    const arr = frameHistory[k];
    if (!arr) { delete frameHistory[k]; continue; }
    while (arr.length && arr[0].ts < cutoff) arr.shift();
    if (!arr.length) delete frameHistory[k];
  }
}

async function persist(){
  prune();
  await storage.set({ hostSeen, domainStatus, availableList, tabTopUrl, logs, debugEnabled });
  await updateBadge();
}

function persistSoon(){
  try { if (persistTimer) clearTimeout(persistTimer as any); } catch {}
  // write after a short delay to collapse bursts
  persistTimer = setTimeout(() => { void persist(); persistTimer = null as any; }, 150) as any;
}

// Track top-level page URLs (prefer webNavigation if available)
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.tabId >= 0 && details.url && details.url.startsWith("http")) {
      // Record for the specific frame
      recordFrameUrl(details.tabId, details.frameId, details.url);
      // Also mirror to tab-top history if main frame
      if (details.frameId === 0) {
        recordTabTop(details.tabId, details.url);
      }
      log('debug', `[signal:webNavigation.onCommitted] tab=${details.tabId} frame=${details.frameId} url=${details.url}`);
      void persist();
    }
  });
}

// Track SPA route changes and hash changes for all frames
if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.tabId >= 0 && details.url && details.url.startsWith("http")) {
      recordFrameUrl(details.tabId, details.frameId, details.url);
      if (details.frameId === 0) recordTabTop(details.tabId, details.url);
      log('debug', `[signal:webNavigation.onHistoryStateUpdated] tab=${details.tabId} frame=${details.frameId} url=${details.url}`);
      void persist();
    }
  });
}

if (chrome.webNavigation && chrome.webNavigation.onReferenceFragmentUpdated) {
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.tabId >= 0 && details.url && details.url.startsWith("http")) {
      recordFrameUrl(details.tabId, details.frameId, details.url);
      if (details.frameId === 0) recordTabTop(details.tabId, details.url);
      log('debug', `[signal:webNavigation.onReferenceFragmentUpdated] tab=${details.tabId} frame=${details.frameId} url=${details.url}`);
      void persist();
    }
  });
}


// Fallback: tabs.onUpdated always exists
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && /^https?:\/\//.test(changeInfo.url)) {
    recordTabTop(tabId, changeInfo.url);
    log('debug', `[signal:tabs.onUpdated] tab=${tabId} url=${changeInfo.url}`);
    void persist();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabTopUrl[tabId];
  // Clear all frame histories for this tab
  Object.keys(frameHistory).forEach(k => {
    if (k.startsWith(`${tabId}:`)) delete frameHistory[k];
  });
  delete tabHistory[tabId];
  log('debug', `[signal:tabs.onRemoved] tab=${tabId}`);
  void persist();
});

// RDAP
async function rdapFetch(domain: string){
  const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
  try {
    log('debug', `[rdap] GET ${url}`);
    const r = await fetch(url, {
      cache: "no-store",
      headers: { "accept": "application/rdap+json, application/json;q=0.9, */*;q=0.1" },
      redirect: "follow"
    });
    log('debug', `[rdap] ${domain} -> ok=${r.ok} status=${r.status} final=${r.url}`);
    return { ok: r.ok, status: r.status, finalUrl: r.url };
  } catch (e){
    // Clearer label: this is a transport failure, not a domain result.
    log('warn', `[rdap] network/timeout fetching ${url}: ${errToStr(e)}`);
    persistLogsSoon();
    return { ok: false, status: 0, finalUrl: url };
  }
}

// DNS via dns.google
async function doh(name: string, type: string){
  const q = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  const urls = [
    `https://dns.google/resolve?${q}`,                 // primary
    `https://cloudflare-dns.com/dns-query?${q}`        // secondary (JSON mode via Accept)
  ];

  const attempt = async (url: string, ms: number) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, {
        cache: "no-store",
        headers: url.includes("cloudflare") ? { accept: "application/dns-json" } : undefined,
        signal: ctl.signal
      });
      if (!r.ok) throw new Error(`DoH HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  };

  try {
    return await attempt(urls[0], 5000);
  } catch (e1) {
    log('warn', `[doh] primary failed -> ${errToStr(e1)}; trying secondary`);
    persistLogsSoon();
    return await attempt(urls[1], 7000);
  }
}

async function dnsCheckOne(name: string){
  try {
    log('debug', `[doh] check ${name}`);
    const [a, aaaa, txt, ns] = await Promise.all([
      doh(name, "A"),
      doh(name, "AAAA"),
      doh(name, "TXT"),
      doh(name, "NS")
    ]);

    const hasAnswer = (j: any) => j && j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0;
    const isNx      = (j: any) => j && j.Status === 3;
    const code      = (j: any) => (j && typeof j.Status === 'number' ? j.Status : -1);
    const isSoft    = (j: any) => [2,5].includes(code(j)); // SERVFAIL, REFUSED

    // If any resolver came back with a transient condition, soft-fail.
    if ([a, aaaa, txt, ns].some(isSoft)) {
      log('warn', `[doh] ${name} -> SERVFAIL/REFUSED; soft-fail as 'unknown'`);
      return { status: 'unknown' as Status, method: 'dns' as Method };
    }

    const anyAns = hasAnswer(a) || hasAnswer(aaaa) || hasAnswer(txt) || hasAnswer(ns);
    const nxAll  = isNx(a) && isNx(aaaa) && isNx(txt) && isNx(ns);

    const res = anyAns ? 'registered' : nxAll ? 'unregistered' : 'unknown';
    log('debug', `[doh] ${name} -> ${res}`);
    return { status: res as Status, method: 'dns' as Method };
  } catch (e) {
    // Network/timeout/etc → SOFT FAIL
    log('warn', `[doh] ${name} transient failure: ${errToStr(e)}; soft-fail as 'unknown'`);
    persistLogsSoon();
    return { status: 'unknown' as Status, method: 'dns' as Method };
  }
}

async function dnsFallback(originalHost: string, registrable: string){
  log('debug', `[doh] fallback for host=${originalHost} registrable=${registrable}`);
  const cands = candidatesFrom(originalHost, registrable);
  let last = { status: 'unknown' as Status, method: 'dns' as Method };
  for (const cand of cands){
    const cs = domainStatus[cand];
    if (cs && (cs.status === 'registered' || cs.status === 'unregistered')){
      log('debug', `[doh] cache-hit ${cand} -> ${cs.status}`);
      return { result: { status: cs.status, method: cs.method, http: cs.http ?? 0, url: cs.url ?? "" }, cands };
    }
    const res = await dnsCheckOne(cand);
    log('debug', `[doh] checked ${cand} -> ${res.status}`);
    if (res.status === 'registered'){
      return { result: { status: res.status, method: res.method, http: 0, url: "" }, cands };
    }
    last = res;
  }
  return { result: { status: last.status, method: last.method, http: 0, url: "" }, cands };
}

function addPageContext(domain: string, pageUrl?: string | null){
  if (!pageUrl) return;
  const item: DomainInfo = domainStatus[domain] ?? { status: 'pending', method: null, http: 0, url: '', ts: now(), pages: [], requests: [] };
  item.pages = item.pages ?? [];
  const idx = item.pages.findIndex(p => p.url === pageUrl);
  if (idx >= 0) item.pages[idx].ts = now();
  else {
    item.pages.push({ url: pageUrl, ts: now() });
    if (item.pages.length > MAX_PAGES_PER_DOMAIN){
      item.pages.sort((a,b)=>b.ts-a.ts);
      item.pages = item.pages.slice(0, MAX_PAGES_PER_DOMAIN);
    }
  }
  item.ts = now();
  domainStatus[domain] = item;
  log('debug', `[context] page + ${pageUrl} -> ${domain} (pages=${item.pages?.length ?? 0})`);
  persistSoon();
}

function addRequestContext(domain: string, reqUrl?: string | null){
  if (!reqUrl) return;
  const item: DomainInfo = domainStatus[domain] ?? { status: 'pending', method: null, http: 0, url: '', ts: now(), pages: [], requests: [] };
  item.requests = item.requests ?? [];
  const idx = item.requests.findIndex(p => p.url === reqUrl);
  if (idx >= 0) item.requests[idx].ts = now();
  else {
    item.requests.push({ url: reqUrl, ts: now() });
    if (item.requests.length > MAX_REQS_PER_DOMAIN){
      item.requests.sort((a,b)=>b.ts-a.ts);
      item.requests = item.requests.slice(0, MAX_REQS_PER_DOMAIN);
    }
  }
  item.ts = now();
  domainStatus[domain] = item;
  log('debug', `[context] request + ${reqUrl} -> ${domain} (reqs=${item.requests?.length ?? 0})`);
  persistSoon();
}

function mergeContextsInto(cands: string[], into: DomainInfo){
  const pages = new Map<string, number>();
  const reqs  = new Map<string, number>();
  for (const cand of cands){
    const ds = domainStatus[cand];
    if (!ds) continue;
    (ds.pages ?? []).forEach(p => pages.set(p.url, Math.max(pages.get(p.url) || 0, Number(p.ts) || 0)));
    (ds.requests ?? []).forEach(r => reqs.set(r.url, Math.max(reqs.get(r.url) || 0, Number(r.ts) || 0)));
  }
  const mergedPages = Array.from(pages.entries()).map(([url, ts])=>({url, ts})).sort((a,b)=>b.ts-a.ts).slice(0, MAX_PAGES_PER_DOMAIN);
  const mergedReqs  = Array.from(reqs.entries()).map(([url, ts])=>({url, ts})).sort((a,b)=>b.ts-a.ts).slice(0, MAX_REQS_PER_DOMAIN);
  into.pages = mergedPages;
  into.requests = mergedReqs;
}

function propagateStatus(cands: string[], result: DomainInfo){
  const ts = now();
  mergeContextsInto(cands, result);

  for (const cand of cands){
    const cur = domainStatus[cand] ?? {};
    domainStatus[cand] = { ...result, ts, pages: result.pages ?? (cur as DomainInfo).pages, requests: result.requests ?? (cur as DomainInfo).requests };
  }

  const shortest = cands[0]; // registrable
  if (result.status === 'unregistered'){
    const existing = availableList.find(x => x.domain === shortest);
    if (existing){
      const pm = new Map<string, number>((existing.pages ?? []).map(p => [p.url, p.ts]));
      (result.pages ?? []).forEach(p => pm.set(p.url, Math.max(pm.get(p.url) || 0, p.ts)));
      existing.pages = Array.from(pm.entries())
        .map(([url, ts])=>({url, ts}))
        .sort((a,b)=>b.ts-a.ts)
        .slice(0, MAX_PAGES_PER_DOMAIN);

      const rm = new Map<string, number>((existing.requests ?? []).map(r => [r.url, r.ts]));
      (result.requests ?? []).forEach(r => rm.set(r.url, Math.max(rm.get(r.url) || 0, r.ts)));
      existing.requests = Array.from(rm.entries())
        .map(([url, ts])=>({url, ts}))
        .sort((a,b)=>b.ts-a.ts)
        .slice(0, MAX_REQS_PER_DOMAIN);

      existing.method = result.method ?? existing.method ?? null;
      existing.ts = ts;

      log('debug', `[availableList] updated ${shortest} pages=${existing.pages?.length ?? 0} reqs=${existing.requests?.length ?? 0}`);
      persistSoon();
    } else {
      availableList.push({ domain: shortest, method: result.method ?? null, ts, pages: result.pages, requests: result.requests });
      hasNew = true;
      log('debug', `[availableList] added ${shortest} pages=${result.pages?.length ?? 0} reqs=${result.requests?.length ?? 0}`);
      persistSoon();
    }
  }
}

function ensureEnqueued(regDomain: string, origHost: string, source: string){
  const t = now();

  // throttle: if we queued this recently, skip
  if (lastQueued[regDomain] && (t - lastQueued[regDomain] < ENQUEUE_TTL_MS)) {
    log('debug', `[queue] skip-throttle ${regDomain} (src=${source})`);
    return;
  }

  // If already RESOLVED (not pending), skip; allow pending to enqueue
  if (domainStatus[regDomain] && domainStatus[regDomain].status !== 'pending') {
    log('debug', `[queue] skip-resolved ${regDomain} status=${domainStatus[regDomain].status}`);
    return;
  }

  if (active.has(regDomain)) { log('debug', `[queue] skip-active ${regDomain}`); return; }
  if (queue.includes(regDomain)) { log('debug', `[queue] skip-inqueue ${regDomain}`); return; }

  itemToHost.set(regDomain, origHost);
  active.add(regDomain);
  lastQueued[regDomain] = t;
  queue.push(regDomain);
  log('debug', `[queue] + ${regDomain} (src=${source}) size=${queue.length} inflight=${inflight}`);
  void updateBadge();
  void processQueue();
}

function enqueue(regDomain: string){
  if (domainStatus[regDomain] && domainStatus[regDomain].status !== 'pending') return;
  if (!queue.includes(regDomain)) queue.push(regDomain);
  void processQueue();
}

async function checkRegistrable(registrable: string, originalHost: string){
  log('debug', `[check] registrable=${registrable} fromHost=${originalHost}`);
  const resp = await rdapFetch(registrable);

  if (resp.ok && resp.status === 200){
    const cands = candidatesFrom(originalHost, registrable);
    const result: DomainInfo = { status: 'registered', method: 'rdap', http: 200, url: resp.finalUrl, ts: now() };
    propagateStatus(cands, result);
    log('debug', `[check] ${registrable} -> registered (rdap 200)`);
    return;
  }

  if (!resp.ok && resp.status === 404){
    const noRedirect = resp.finalUrl.startsWith("https://rdap.org/");
    const cands = candidatesFrom(originalHost, registrable);
    if (!noRedirect){
      const result: DomainInfo = { status: 'unregistered', method: 'rdap', http: 404, url: resp.finalUrl, ts: now() };
      propagateStatus(cands, result);
      log('debug', `[check] ${registrable} -> unregistered (rdap 404 via redirect)`);
      return;
    }
    const { result } = await dnsFallback(originalHost, registrable);
    if (result.status === 'registered' || result.status === 'unregistered') {
      propagateStatus(cands, { ...result, http: result.http ?? 0, url: result.url ?? '', ts: now() });
      log('debug', `[check] ${registrable} -> ${result.status} (dns fallback)`);
    } else {
      // SOFT FAIL: keep pending so it retries on the next signal
      log('warn', `[check] ${registrable} dns fallback inconclusive (${result.status}); keeping 'pending'`);
      delete lastQueued[registrable]; // remove 30s throttle for quick retry
    }
    return;
  }

  if (!resp.ok && resp.status === 0){
    const cands = candidatesFrom(originalHost, registrable);

    // Try DNS as a best-effort fallback first
    try {
      const { result } = await dnsFallback(originalHost, registrable);
      if (result.status === 'registered' || result.status === 'unregistered') {
        // We got a definitive answer from DNS - commit it.
        propagateStatus(cands, { ...result, http: result.http ?? 0, url: result.url ?? '', ts: now() });
        log('debug', `[check] ${registrable} -> ${result.status} (dns fallback after rdap network failure)`);
      } else {
        // SOFT FAIL: keep pending (no propagateStatus), so it retries on next signal.
        log('warn', `[check] ${registrable} rdap network failure; dns fallback inconclusive -> keeping 'pending' so it will retry`);
        delete lastQueued[registrable]; // lift throttle so a new signal can re-enqueue immediately
      }
    } catch (e) {
      // SOFT FAIL: keep pending
      log('warn', `[check] ${registrable} rdap network failure and dns fallback failed: ${errToStr(e)} -> keeping 'pending'`);
      delete lastQueued[registrable];
    }
    return;
  }

  const cands = candidatesFrom(originalHost, registrable);
  const result: DomainInfo = { status: 'error', method: 'rdap', http: resp.status, url: resp.finalUrl, ts: now() };
  propagateStatus(cands, result);
  log('debug', `[check] ${registrable} -> error http=${resp.status}`);
}

async function processQueue(){
  while (inflight < MAX_CONCURRENCY && queue.length){
    const item = queue.shift()!;
    inflight++;
    void updateBadge();
    log('debug', `[process] start ${item} inflight=${inflight} remaining=${queue.length}`);
    try {
      const originalHost = itemToHost.get(item) || item;
      await checkRegistrable(item, originalHost);
      log('debug', `[process] done  ${item}`);
    } catch (e) {
      log('error', `[process] ${item} failed: ${errToStr(e)}`);
      persistLogsSoon();
    } finally {
      active.delete(item);
      inflight--;
      if (queue.length) setTimeout(() => { void processQueue(); }, 0);
      persistSoon(); // batch writes under load
      void updateBadge();
      log('debug', `[process] finalize ${item} inflight=${inflight} remaining=${queue.length}`);
    }
  }
}

const itemToHost = new Map<string, string>();

// onBeforeRequest: see URLs even if blocked by extensions
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url: requestUrl, tabId, requestId, frameId } = details as any;

    if (requestId) {
      const t = now();
      if (seenRequestIds[requestId] && (t - seenRequestIds[requestId] < REQ_TTL_MS)) {
        log('debug', `[signal:beforeRequest] skip-dup rid=${requestId} url=${requestUrl}`);
        return;
      }
      seenRequestIds[requestId] = t;
    }

    if (typeof requestUrl !== 'string' || (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://"))) {
      log('debug', `[signal:beforeRequest] skip-nonhttp url=${requestUrl}`);
      return;
    }

    try {
      log('debug', `[signal:beforeRequest] rid=${requestId ?? '-'} tab=${tabId ?? '-'} frame=${frameId ?? '-'} type=${(details as any).type ?? '-'} url=${requestUrl}`);

      const urlObj = new URL(requestUrl);
      const host = normalizeHost(urlObj.hostname);
      if (!host) { log('debug', `[signal:beforeRequest] skip-host host=${host}`); return; }

      hostSeen[host] = now();

      const info = parse(host); // ICANN-only by default
      if (!info.domain || info.isIp || !info.isIcann) { log('debug', `[signal:beforeRequest] skip-tldts host=${host} isIp=${info.isIp} isIcann=${info.isIcann}`); return; }

      const registrable = info.domain;
      let { url: pageUrl, source: pageSrc } = pageFromVerbose(details, tabId, frameId);
      // Special-case main frame: if no page context, the page *is* the request URL
      const isMainFrame = ((details as any).type === 'main_frame') || (frameId === 0);
      if (!pageUrl && isMainFrame) { pageUrl = requestUrl; pageSrc = 'documentUrl'; }
      log('debug', `[signal:beforeRequest] pageSrc=${pageSrc} pageUrl=${pageUrl ?? '-'}`);

      if (pageUrl) addPageContext(registrable, pageUrl);
      addRequestContext(registrable, requestUrl);

      if (!domainStatus[registrable]) {
        domainStatus[registrable] = { status: 'pending', method: null, http: 0, url: '', ts: now(), pages: [], requests: [] };
        log('debug', `[state] set pending ${registrable}`);
      }

      ensureEnqueued(registrable, host, 'beforeRequest');
    } catch (e) {
      log('error', 'onBeforeRequest handler failed: ' + errToStr(e));
      persistLogsSoon();
    }
  },
  { urls: ["http://*/*", "https://*/*"] }
);

// onErrorOccurred: log canceled/blocked (privacy/CSP/etc.), enqueue
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const { tabId, requestId, frameId } = details as any;

    if (requestId) {
      const t = now();
      if (seenRequestIds[requestId] && (t - seenRequestIds[requestId] < REQ_TTL_MS)) {
        log('debug', `[signal:errorOccurred] skip-dup rid=${requestId} url=${details.url}`);
        return;
      }
      seenRequestIds[requestId] = t;
    }

    if (!details || !details.url) return;
    const requestUrl = details.url;

    if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
      log('debug', `[signal:errorOccurred] skip-nonhttp url=${requestUrl}`);
      return;
    }

    try {
      log('debug', `[signal:errorOccurred] rid=${requestId ?? '-'} tab=${tabId ?? '-'} frame=${frameId ?? '-'} type=${(details as any).type ?? '-'} url=${requestUrl} err=${(details as any).error ?? '-'}`);

      const host = normalizeHost(new URL(requestUrl).hostname);
      if (!host) { log('debug', `[signal:errorOccurred] skip-host host=${host}`); return; }

      const info = parse(host);
      if (!info.domain || info.isIp || !info.isIcann) { log('debug', `[signal:errorOccurred] skip-tldts host=${host} isIp=${info.isIp} isIcann=${info.isIcann}`); return; }

      const registrable = info.domain;
      let { url: pageUrl, source: pageSrc } = pageFromVerbose(details, tabId, frameId);
      // Special-case main frame failures: use the failing request as the page URL
      const isMainFrame = ((details as any).type === 'main_frame') || (frameId === 0);
      if (!pageUrl && isMainFrame) { pageUrl = requestUrl; pageSrc = 'documentUrl'; }
      log('debug', `[signal:errorOccurred] pageSrc=${pageSrc} pageUrl=${pageUrl ?? '-'}`);

      if (pageUrl) addPageContext(registrable, pageUrl);
      addRequestContext(registrable, requestUrl);

      if (!domainStatus[registrable]) {
        domainStatus[registrable] = { status: 'pending', method: null, http: 0, url: '', ts: now(), pages: [], requests: [] };
        log('debug', `[state] set pending ${registrable}`);
      }
      ensureEnqueued(registrable, host, 'errorOccurred');
    } catch (e) {
      log('error', 'onErrorOccurred handler failed: ' + errToStr(e));
      persistLogsSoon();
    }
  },
  { urls: ["http://*/*", "https://*/*"] }
);

// Messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ackNew"){
    hasNew = false;
    void updateBadge();
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "getLogs"){
    pruneLogsTTL();
    sendResponse({ logs, debugEnabled });
    return true;
  }

  if (msg?.type === "setDebug"){
    debugEnabled = !!msg.enabled;
    storage.set({ debugEnabled }).then(()=>{});
    sendResponse({ ok:true, debugEnabled });
    return true;
  }

  if (msg?.type === "clearLogs"){
    logs = [];
    storage.set({ logs }).then(()=>{});
    sendResponse({ ok:true });
    return true;
  }

  if (msg?.type === "getState"){
    // Return authoritative in-memory state; don't overwrite it from storage here.
    sendResponse({
      availableList,
      cacheSize: Object.keys(domainStatus).length,
      hostsSeen: Object.keys(hostSeen).length
    });
    return true;
  }

  if (msg?.type === "clearCache"){
    hostSeen = {};
    domainStatus = {};
    queue = [];
    inflight = 0;
    try { (active as any).clear?.(); } catch (e) { log('error', 'clearCache active.clear failed: ' + errToStr(e)); persistLogsSoon(); }
    for (const k of Object.keys(lastQueued)) delete lastQueued[k];
    try { (itemToHost as any).clear?.(); } catch (e) { log('error', 'clearCache itemToHost.clear failed: ' + errToStr(e)); persistLogsSoon(); }
    storage.set({ hostSeen, domainStatus }).then(()=>{});
    (async () => { await persist(); sendResponse({ ok: true }); })();
    return true;
  }

  if (msg?.type === "clearAvailable"){
    availableList = [];
    storage.set({ availableList }).then(() => { void updateBadge(); });
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "cspViolation"){
    try {
      const raw = typeof msg.blockedURL === "string" ? msg.blockedURL : "";
      const tabUrl = (sender?.tab && (sender.tab as any).url) || "-";
      log('debug', `[signal:cspViolation] blocked=${raw || '-'} document=${msg.documentURL ?? '-'} tabUrl=${tabUrl}`);

      // Page URL (document), upgraded via tab history if only-origin.
      const rawPage = (typeof msg.documentURL === 'string' ? msg.documentURL : undefined) ||
                      (typeof tabUrl === 'string' && tabUrl !== "-" ? tabUrl : undefined);
      let pageUrl: string | undefined = rawPage;
      try {
        if (rawPage && sender?.tab?.id != null) {
          const ru = new URL(rawPage);
          const onlyOrigin = (ru.pathname === '/' && !ru.search && !ru.hash);
          if (onlyOrigin) {
            const hist = lookupTabHistory(sender.tab.id, ru.origin);
            if (hist) pageUrl = hist;
          }
        }
      } catch {}
      if (!pageUrl && sender?.tab?.id != null) {
        const hist = lookupTabHistory(sender.tab.id);
        if (hist) pageUrl = hist;
      }

      // Derive blocked host when possible (http/https or blob:https://...).
      let blockedHost: string | null = null;
      if (/^https?:/i.test(raw)) {
        try { blockedHost = normalizeHost(new URL(raw).hostname); } catch {}
      } else if (raw.startsWith('blob:')) {
        const inner = raw.slice(5);
        try { blockedHost = normalizeHost(new URL(inner).hostname); } catch {}
      }

      // Prefer attributing to the page's registrable; fall back to blocked host.
      let registrable: string | null = null;
      try {
        if (pageUrl) {
          const ph = normalizeHost(new URL(pageUrl).hostname);
          const info = ph ? parse(ph) : ({} as any);
          if (info.domain && info.isIcann && !info.isIp) registrable = info.domain;
        }
      } catch {}
      if (!registrable && blockedHost) {
        const info = parse(blockedHost);
        if (info.domain && info.isIcann && !info.isIp) registrable = info.domain;
      }

      if (registrable) {
        // Context: record page; only record request if it's a real http(s) URL.
        if (pageUrl) addPageContext(registrable, pageUrl);
        if (blockedHost && /^https?:/i.test(raw)) addRequestContext(registrable, raw);

        if (!domainStatus[registrable]) {
          domainStatus[registrable] = { status: 'pending', method: null, http: 0, url: '', ts: now(), pages: [], requests: [] };
          log('debug', `[state] set pending ${registrable}`);
        }
        // Keep queue/active semantics consistent with other signals.
        ensureEnqueued(registrable, blockedHost || registrable, 'cspViolation');
      } else {
        log('debug', `[signal:cspViolation] skip (no registrable) blockedHost=${blockedHost ?? '-'} pageUrl=${pageUrl ?? '-'}`);
      }
    } catch (e) {
      log('error', 'cspViolation handler failed: ' + errToStr(e));
      persistLogsSoon();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "recheckDomain" && typeof msg.domain === "string"){
    const d = normalizeHost(msg.domain);
    if (d){
      delete domainStatus[d];
      delete lastQueued[d];
      const host = itemToHost.get(d) || d;
      ensureEnqueued(d, host, 'recheck');
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  return false;
});

async function init(){
  const s = await storage.get(["hostSeen", "domainStatus", "availableList", "tabTopUrl", "logs", "debugEnabled"]);
  hostSeen = s.hostSeen || {};
  domainStatus = s.domainStatus || {};
  availableList = s.availableList || [];
  tabTopUrl = s.tabTopUrl || {};
  logs = Array.isArray(s.logs) ? s.logs : [];
  pruneLogsTTL();
  debugEnabled = !!s.debugEnabled;
  await updateBadge();
  void processQueue();
}

void init();
