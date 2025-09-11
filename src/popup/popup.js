function mkli(text){ const e=document.createElement('li'); e.textContent=text; return e; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function withTimeout(p, ms=500){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); },
           e => { clearTimeout(t); reject(e); });
  });
}
function fmt(ts){
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function fmtNum(n){
  try {
    return new Intl.NumberFormat(undefined, { notation: 'compact' }).format(n);
  } catch {
    return String(n);
  }
}

function sendMessageP(message) {
  return new Promise((resolve, reject) => {
    let maybePromise;
    try {
      maybePromise = chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err);
        else resolve(response);
      });
    } catch (e) {
      reject(e);
      return;
    }
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(resolve, reject);
    }
  });
}

async function getSafeState(){
  // Try background first (worker may be cold). A couple quick retries.
  for (let i = 0; i < 2; i++){
    try {
      const state = await withTimeout(sendMessageP({ type: "getState" }), 1200);
      if (state && typeof state === 'object') return state;
    } catch {}
    await sleep(150);
  }

  // Fallback: storage snapshot
  try {
    const s = await new Promise(res =>
      chrome.storage.local.get(["availableList","hostSeen","domainStatus"], res)
    );
    return {
      availableList: Array.isArray(s.availableList) ? s.availableList : [],
      cacheSize: s.domainStatus ? Object.keys(s.domainStatus).length : 0,
      hostsSeen: s.hostSeen ? Object.keys(s.hostSeen).length : 0
    };
  } catch {
    return { availableList: [], cacheSize: 0, hostsSeen: 0 };
  }
}

async function refresh(){
  const state = await getSafeState();
  const availableList = Array.isArray(state.availableList) ? state.availableList : [];
  const cacheSize = typeof state.cacheSize === 'number' ? state.cacheSize : 0;
  const hostsSeen = typeof state.hostsSeen === 'number' ? state.hostsSeen : 0;

  const ac = document.getElementById("avail-count");
  const cc = document.getElementById("cache-count");
  const hc = document.getElementById("hosts-count");
  if (ac) ac.textContent = String(availableList.length);
  if (cc) cc.textContent = String(cacheSize);
  if (hc) hc.textContent = fmtNum(hostsSeen);

  const ul = document.getElementById("list");
  if (!ul) return;
  ul.innerHTML = "";
  availableList
    .slice()
    .sort((a,b)=> (b.ts||0)-(a.ts||0))
    .forEach(item => {
      const li = document.createElement("li");
      li.className = "item";

      const row = document.createElement("div");
      row.className = "row";

      const left = document.createElement("div");
      const title = document.createElement("span");
      title.className = "domain";
      title.textContent = item.domain || "";
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `method: ${item.method || 'rdap'}`;
      left.appendChild(title);
      left.appendChild(document.createTextNode(" "));
      left.appendChild(meta);

      const when = document.createElement("div");
      when.className = "time";
      when.textContent = item.ts ? fmt(item.ts) : "";

      row.appendChild(left);
      row.appendChild(when);

      const pages = Array.isArray(item.pages) ? item.pages : [];
      const reqs  = Array.isArray(item.requests) ? item.requests : [];

      li.appendChild(row);

      if (pages.length){
        const pagesTitle = document.createElement("div");
        pagesTitle.className = "section-title";
        pagesTitle.textContent = "Pages observed on:";
        const pagesUl = document.createElement("ul");
        pagesUl.className = "pages";
        pages.slice(0, 20).forEach(p => pagesUl.appendChild(mkli(`${p.url} - ${fmt(p.ts)}`)));
        li.appendChild(pagesTitle);
        li.appendChild(pagesUl);
      }

      if (reqs.length){
        const reqsTitle = document.createElement("div");
        reqsTitle.className = "section-title";
        reqsTitle.textContent = "Requests made to this domain:";
        const reqsUl = document.createElement("ul");
        reqsUl.className = "reqs";
        reqs.slice(0, 30).forEach(r => reqsUl.appendChild(mkli(`${r.url} - ${fmt(r.ts)}`)));
        li.appendChild(reqsTitle);
        li.appendChild(reqsUl);
      }

      const actions = document.createElement("div");
      actions.className = "item-actions";
      const recheck = document.createElement("button");
      recheck.textContent = "Recheck";
      recheck.addEventListener("click", async () => {
        try { await chrome.runtime.sendMessage({ type: "recheckDomain", domain: item.domain }); } catch {}
        setTimeout(refresh, 600);
      });
      actions.appendChild(recheck);

      li.appendChild(actions);
      ul.appendChild(li);
    });
}

// React to background messages telling us state changed
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === "stateUpdated" || msg.type === "availableListUpdated")) {
      refresh();
    }
  });
} catch {}

// React to storage updates (works even if you never send messages)
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.availableList || changes.hostSeen || changes.domainStatus)) {
      refresh();
    }
  });
} catch {}

document.addEventListener("DOMContentLoaded", async () => {
  try { await chrome.runtime.sendMessage({ type: 'ackNew' }); } catch {}
  refresh();
  // Stagger a couple of follow-ups in case the worker was cold
  setTimeout(refresh, 300);
  setTimeout(refresh, 1200);
});

document.getElementById("copy")?.addEventListener("click", async () => {
  const state = await getSafeState();
  const list = Array.isArray(state.availableList) ? state.availableList : [];
  const text = list.map(x => x.domain).join("\n");
  try { await navigator.clipboard.writeText(text); alert(`Copied ${list.length} domain(s).`); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    try {
      ta.select();
      document.execCommand("copy");
      alert(`Copied ${list.length} domain(s).`);
    } finally {
      try { document.body.removeChild(ta); } catch {}
    }
  }
});

document.getElementById("copy2")?.addEventListener("click", async () => {
  const state = await getSafeState();
  const list = Array.isArray(state.availableList) ? state.availableList : [];
  const lines = [];
  list.forEach(item => {
    const baseLine = `${item.domain}\t${item.method||'rdap'}\t${new Date(item.ts||Date.now()).toISOString()}`;
    const pages = Array.isArray(item.pages) ? item.pages : [];
    const reqs  = Array.isArray(item.requests) ? item.requests : [];
    if (pages.length){
      pages.forEach(p => lines.push(`${baseLine}\tpage\t${p.url}\t${new Date(p.ts||Date.now()).toISOString()}`));
    } else {
      lines.push(`${baseLine}\tpage\t\t`);
    }
    if (reqs.length){
      reqs.forEach(r => lines.push(`${baseLine}\trequest\t${r.url}\t${new Date(r.ts||Date.now()).toISOString()}`));
    }
  });
  const text = lines.join("\n");
  try { await navigator.clipboard.writeText(text); alert(`Copied ${lines.length} line(s).`); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    try {
      ta.select();
      document.execCommand("copy");
      alert(`Copied ${list.length} domain(s).`);
    } finally {
      try { document.body.removeChild(ta); } catch {}
    }
  }
});

document.getElementById("clear")?.addEventListener("click", async () => {
  try { await chrome.runtime.sendMessage({ type: "clearAvailable" }); } catch {}
  await refresh();
});

document.getElementById("clear-cache")?.addEventListener("click", async () => {
  if (!confirm("Clear cached domains/hosts? This will force re-checking.")) return;
  try { await chrome.runtime.sendMessage({ type: "clearCache" }); } catch {}
  await refresh();
});

async function loadLogs() {
  try {
    const resp = await sendMessageP({ type: "getLogs" });
    const { logs = [], debugEnabled = false } = resp || {};

    const box = document.getElementById("debug-logs");
    const chk = document.getElementById("debug-toggle");
    if (chk) chk.checked = !!debugEnabled;
    if (Array.isArray(logs) && box) {
      const lines = logs.slice(-300).map(e => {
        const ts = new Date(e.ts || Date.now()).toISOString();
        return `${ts} [${e.level}] ${e.msg}`;
      }).join("\n");
      box.textContent = lines || "(no logs yet)";
    }
  } catch (e) {
    const box = document.getElementById("debug-logs");
    if (box) box.textContent = "Failed to load logs: " + (e?.message || e);
  }
}

document.getElementById("debug-refresh")?.addEventListener("click", loadLogs);
document.getElementById("debug-clear")?.addEventListener("click", async () => {
  try { await chrome.runtime.sendMessage({ type: "clearLogs" }); } catch {}
  loadLogs();
});
document.getElementById("debug-toggle")?.addEventListener("change", async (e) => {
  const en = !!e.target.checked;
  try { await chrome.runtime.sendMessage({ type: "setDebug", enabled: en }); } catch {}
});

// Load logs when debug section is opened
const dbg = document.getElementById("debug");
if (dbg) dbg.addEventListener("toggle", () => { if (dbg.open) loadLogs(); });
