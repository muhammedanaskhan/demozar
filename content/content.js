// Demozar Content Script
// Minimal content script - spotlight feature removed
(function() {
  'use strict';

  // Prevent duplicate initialization
  if (window.__demozarLoaded) {
    return;
  }
  window.__demozarLoaded = true;

  // Listen for messages from background (for future features)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Handle any future messages here
    sendResponse({ success: true });
    return true;
  });
})();
