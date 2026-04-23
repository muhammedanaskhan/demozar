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
    }
    return false;
  });

  function startTracking() {
    if (isTracking) {
      console.log('[DaddyRecorder] Already tracking');
      return;
    }
    isTracking = true;
    startTime = Date.now();
    messageCount = 0;

    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    // Capture-phase so we still see clicks on elements that stopPropagation.
    document.addEventListener('mousedown', handleClick, { passive: true, capture: true });
    console.log('[DaddyRecorder] ✓ Cursor tracking STARTED at', new Date().toISOString());
  }

  function stopTracking() {
    isTracking = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mousedown', handleClick, { capture: true });
    console.log('[DaddyRecorder] Cursor tracking STOPPED. Total messages sent:', messageCount);
  }

  // Debounce rapid-fire clicks (accidental double-trigger). 100ms is
  // comfortably below an intentional double-click (~250ms) but kills
  // the spurious duplicate when a UI component fires mousedown twice.
  let lastClickSent = 0;
  const CLICK_DEBOUNCE_MS = 100;

  let clickCount = 0;

  function handleClick(e) {
    if (!isTracking) {
      console.log('[DaddyRecorder] Click ignored - not tracking');
      return;
    }
    if (e.button !== 0) {
      console.log('[DaddyRecorder] Click ignored - not primary button:', e.button);
      return;
    }
    const now = Date.now();
    if (now - lastClickSent < CLICK_DEBOUNCE_MS) {
      console.log('[DaddyRecorder] Click ignored - debounce');
      return;
    }
    lastClickSent = now;
    const time = (now - startTime) / 1000;
    const x = e.clientX / window.innerWidth;
    const y = e.clientY / window.innerHeight;
    clickCount++;
    console.log(`[DaddyRecorder] 🖱️ CLICK #${clickCount} captured at time=${time.toFixed(2)}s, pos=(${x.toFixed(3)}, ${y.toFixed(3)})`);
    chrome.runtime.sendMessage({
      type: 'CLICK_POSITION',
      data: { time, x, y }
    }).then(() => {
      console.log(`[DaddyRecorder] ✓ Click #${clickCount} sent to background`);
    }).catch((err) => {
      console.error(`[DaddyRecorder] ✗ Click #${clickCount} FAILED to send:`, err);
    });
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
  console.log('[DaddyRecorder] Cursor tracker ready, checking if recording is active...');

  // Query background to check if recording is in progress
  chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((state) => {
    if (state && state.isRecording && !state.isPaused && !isTracking) {
      console.log('[DaddyRecorder] Recording already active — auto-starting tracker');
      startTracking();
    } else {
      console.log('[DaddyRecorder] Recording state:', state);
    }
  }).catch((err) => {
    console.log('[DaddyRecorder] Could not check recording state:', err);
  });
})();
