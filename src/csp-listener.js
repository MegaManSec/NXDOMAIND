
// Catch CSP violations that don't reach webRequest; report to background.
(function(){
  window.addEventListener('securitypolicyviolation', (e) => {
    try {
      const blocked = e.blockedURI || '';
      if (!/^https?:\/\//i.test(blocked)) return;
      chrome.runtime.sendMessage({
        type: 'cspViolation',
        blockedURL: blocked,
        documentURL: e.documentURI || location.href
      });
    } catch {}
  }, true);
})();
