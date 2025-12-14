// Listens for preview payloads from the extension and stores them
// in localStorage for the share page to consume, then reloads.
(function () {
  // On share page load, pull preview payload from extension storage
  chrome.storage?.local.get('mnemolog_preview', (res) => {
    const data = res?.mnemolog_preview;
    if (!data) return;
    try {
      localStorage.setItem('mnemolog_preview', data);
      chrome.storage.local.remove('mnemolog_preview', () => {});
      // Reload so the share page's loader picks it up on initial load
      window.location.reload();
    } catch (e) {
      console.warn('Failed to set preview data', e);
    }
  });
})();
