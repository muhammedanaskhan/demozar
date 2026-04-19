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
