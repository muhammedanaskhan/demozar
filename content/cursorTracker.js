// Cursor Tracker - Injected into recorded tab to track mouse position
(function() {
  console.log('[DaddyRecorder] Cursor tracker script loaded');

  // Avoid re-injection
  if (window.__daddyRecorderCursorTracker) {
    console.log('[DaddyRecorder] Cursor tracker already exists');
    return;
  }
  window.__daddyRecorderCursorTracker = true;

  let isTracking = false;
  let startTime = 0;
  let messageCount = 0;

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[DaddyRecorder] Received message:', message.type);
    if (message.type === 'START_CURSOR_TRACKING') {
      startTracking();
      sendResponse({ success: true, status: 'tracking_started' });
    } else if (message.type === 'RESET_CURSOR_TIME') {
      // Reset start time to sync with actual recording start
      startTime = Date.now();
      messageCount = 0;
      console.log('[DaddyRecorder] Timer reset to sync with recording');
      sendResponse({ success: true });
    } else if (message.type === 'STOP_CURSOR_TRACKING') {
      stopTracking();
      sendResponse({ success: true, status: 'tracking_stopped', messagesSent: messageCount });
    } else if (message.type === 'SHOW_COUNTDOWN') {
      showCountdown(typeof message.from === 'number' ? message.from : 3).then(() => {
        sendResponse({ success: true });
      }).catch(() => sendResponse({ success: false }));
      return true; // async
    }
    return false;
  });

  // Full-page countdown overlay injected into the recorded tab. Drawn on
  // top of page content via a fixed-position div at a very high z-index.
  // Resolves when the countdown reaches zero and the overlay has been removed.
  function showCountdown(from) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = '__daddy-countdown';
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:rgba(10,10,11,0.55)',
        'font:700 min(36vmin,360px)/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        'color:#17FEA0', 'text-shadow:0 0 60px rgba(23,254,160,0.6)',
        'pointer-events:none',
        'font-variant-numeric:tabular-nums'
      ].join(';');
      document.documentElement.appendChild(overlay);

      let n = from;
      overlay.textContent = String(n);
      const tick = () => {
        n -= 1;
        if (n <= 0) {
          overlay.style.transition = 'opacity 120ms ease';
          overlay.style.opacity = '0';
          setTimeout(() => {
            try { overlay.remove(); } catch (_) {}
            resolve();
          }, 150);
          return;
        }
        overlay.textContent = String(n);
        setTimeout(tick, 1000);
      };
      setTimeout(tick, 1000);
    });
  }

  function startTracking() {
    if (isTracking) {
      console.log('[DaddyRecorder] Already tracking');
      return;
    }
    isTracking = true;
    startTime = Date.now();
    messageCount = 0;

    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    console.log('[DaddyRecorder] ✓ Cursor tracking STARTED at', new Date().toISOString());
  }

  function stopTracking() {
    isTracking = false;
    document.removeEventListener('mousemove', handleMouseMove);
    console.log('[DaddyRecorder] Cursor tracking STOPPED. Total messages sent:', messageCount);
  }

  // Throttle to ~30fps to avoid too much data
  let lastSent = 0;
  const throttleMs = 33; // ~30fps

  function handleMouseMove(e) {
    if (!isTracking) return;

    const now = Date.now();
    if (now - lastSent < throttleMs) return;
    lastSent = now;

    // Calculate normalized position (0-1)
    const x = e.clientX / window.innerWidth;
    const y = e.clientY / window.innerHeight;
    const time = (now - startTime) / 1000; // Time in seconds

    // Send to background
    chrome.runtime.sendMessage({
      type: 'CURSOR_POSITION',
      data: { time, x, y }
    }).then(() => {
      messageCount++;
      if (messageCount % 30 === 0) {
        console.log('[DaddyRecorder] Sent', messageCount, 'cursor positions');
      }
    }).catch((err) => {
      console.log('[DaddyRecorder] Failed to send cursor position:', err);
      // Extension might have been unloaded
      stopTracking();
    });
  }

  // Auto-start if already recording (in case message was missed)
  // This helps if the script loads after START_CURSOR_TRACKING was sent
  console.log('[DaddyRecorder] Cursor tracker ready and waiting for START_CURSOR_TRACKING message');
})();
