(function () {
  document.addEventListener(
    'securitypolicyviolation',
    (e) => {
      try {
        const blocked = e.blockedURI || '';
        chrome.runtime.sendMessage({
          type: 'cspViolation',
          blockedURL: blocked,
          documentURL: e.documentURI || location.href,
        });
      } catch {}
    },
    true,
  );
})();
