// Recording state
let recordingState = {
  isRecording: false,
  isPaused: false,
  recordingTime: 0,
  settings: null,
  recordingTabId: null
};

// Cursor tracking data - array of {time, x, y}
let cursorData = [];

// Timer interval
let timerInterval = null;

// Handle extension icon click (for one-click stop)
chrome.action.onClicked.addListener((tab) => {
  // This only fires when popup is disabled (during recording)
  if (recordingState.isRecording) {
    stopRecording();
  }
});

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages meant for offscreen
  if (message.target === 'offscreen') {
    return false;
  }

  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.settings).then(() => {
        sendResponse({ success: true });
      }).catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
      return true; // Async response

    case 'STOP_RECORDING':
      stopRecording();
      sendResponse({ success: true });
      return false;

    case 'PAUSE_RECORDING':
      pauseRecording();
      sendResponse({ success: true });
      return false;

    case 'RESUME_RECORDING':
      resumeRecording();
      sendResponse({ success: true });
      return false;

    case 'LOG':
      console.log('[Offscreen Log]', message.message);
      return false;

    case 'GET_STATE':
      sendResponse({
        isRecording: recordingState.isRecording,
        isPaused: recordingState.isPaused,
        recordingTime: recordingState.recordingTime
      });
      return false;

    case 'RECORDING_STARTED':
      recordingState.isRecording = true;
      recordingState.isPaused = false;
      recordingState.recordingTime = 0;
      cursorData = []; // Reset cursor data to sync with recording start
      startTimer();
      setRecordingUI(true);
      // Reset cursor tracker timer to sync with actual recording start
      if (recordingState.recordingTabId) {
        chrome.tabs.sendMessage(recordingState.recordingTabId, { type: 'RESET_CURSOR_TIME' }).catch(() => {});
      }
      console.log('[Background] Recording started, cursor timer synced');
      return false;

    case 'RECORDING_DATA':
      console.log('[Background] Got RECORDING_DATA message');
      handleRecordingData(message.data, message.format);
      return false;

    case 'RECORDING_ERROR':
      handleRecordingError(message.error);
      return false;

    case 'CURSOR_POSITION':
      // Collect cursor position data from content script
      if (recordingState.isRecording && !recordingState.isPaused) {
        cursorData.push(message.data);
        if (cursorData.length % 30 === 0) {
          console.log('[Background] Received', cursorData.length, 'cursor positions. Latest:', message.data);
        }
      }
      return false;

    default:
      return false;
  }
});

// Set UI for recording state
async function setRecordingUI(isRecording) {
  try {
    if (isRecording) {
      // Set red badge to indicate recording
      await chrome.action.setBadgeText({ text: 'REC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      // Disable popup so clicking icon stops recording
      await chrome.action.setPopup({ popup: '' });
      // Update tooltip
      await chrome.action.setTitle({ title: 'Click to stop recording' });
    } else {
      // Clear badge
      await chrome.action.setBadgeText({ text: '' });
      // Re-enable popup
      await chrome.action.setPopup({ popup: 'popup/popup.html' });
      // Restore tooltip
      await chrome.action.setTitle({ title: 'DaddyRecorder' });
    }
  } catch (e) {
    console.error('Error setting UI:', e);
  }
}

// Start recording
async function startRecording(settings) {
  try {
    recordingState.settings = settings;

    // Reset cursor data
    cursorData = [];

    console.log('[Background] Starting recording with settings:', {
      quality: settings.quality,
      format: settings.format
    });

    // IMPORTANT: Inject cursor tracker FIRST, before media picker appears
    // This ensures we capture the correct tab while it's still active
    await injectCursorTracker();

    await setupOffscreenDocument();

    // Small wait so the offscreen doc's message listener is registered.
    await new Promise(resolve => setTimeout(resolve, 150));

    const response = await sendToOffscreen({
      type: 'START_RECORDING',
      settings: settings
    });
    console.log('[Background] Offscreen response:', response);
    if (response && !response.success) {
      throw new Error(response.error || 'Recording failed in offscreen');
    }

  } catch (error) {
    console.error('Error starting recording:', error);
    throw error;
  }
}

// Inject cursor tracker into active tab
async function injectCursorTracker() {
  try {
    // Get the active tab in the current window
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    let tab = tabs[0];

    // Fallback: try current window
    if (!tab) {
      const fallbackTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = fallbackTabs[0];
    }

    if (!tab || !tab.id) {
      console.log('[Background] No active tab found for cursor tracking');
      return;
    }

    // Skip chrome:// and other restricted URLs
    const url = tab.url || '';
    if (url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://') ||
        url.startsWith('about:') ||
        url.startsWith('edge://') ||
        url === '') {
      console.log('[Background] Cannot inject into restricted URL:', url);
      return;
    }

    recordingState.recordingTabId = tab.id;
    console.log('[Background] Injecting cursor tracker into tab:', tab.id, 'URL:', url);

    // Inject the cursor tracker script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/cursorTracker.js']
    });
    console.log('[Background] Script injected successfully');

    // Small delay to ensure script is ready
    await new Promise(resolve => setTimeout(resolve, 50));

    // Start tracking
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_CURSOR_TRACKING' });
    console.log('[Background] Cursor tracking started, response:', response);

  } catch (error) {
    console.error('[Background] Cursor tracker injection failed:', error);
    // Non-fatal - recording continues without cursor tracking
  }
}

// Send message to offscreen document
async function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      ...message,
      target: 'offscreen'
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Could not send to offscreen:', chrome.runtime.lastError);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Setup offscreen document
async function setupOffscreenDocument() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    // Close existing offscreen document to ensure fresh state
    if (existingContexts.length > 0) {
      console.log('[Background] Closing existing offscreen document');
      await chrome.offscreen.closeDocument();
    }

    console.log('[Background] Creating offscreen document');
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['DISPLAY_MEDIA', 'USER_MEDIA'],
      justification: 'Recording screen/tab content with getDisplayMedia or getUserMedia'
    });
    console.log('[Background] Offscreen document created');
  } catch (e) {
    console.error('[Background] Offscreen setup error:', e);
    throw e;
  }
}

// Close offscreen document
async function closeOffscreenDocument() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {
    console.log('Could not close offscreen:', e);
  }
}

// Stop recording
async function stopRecording() {
  stopTimer();

  // Stop cursor tracking
  if (recordingState.recordingTabId) {
    try {
      await chrome.tabs.sendMessage(recordingState.recordingTabId, { type: 'STOP_CURSOR_TRACKING' });
    } catch (e) {
      // Tab might be closed or navigated away
    }
  }

  // Tell offscreen to stop
  try {
    await sendToOffscreen({ type: 'STOP_RECORDING' });
  } catch (e) {
    console.log('Could not send stop to offscreen:', e);
  }
}

// Pause recording
function pauseRecording() {
  recordingState.isPaused = true;
  stopTimer();
  sendToOffscreen({ type: 'PAUSE_RECORDING' }).catch(() => {});
}

// Resume recording
function resumeRecording() {
  recordingState.isPaused = false;
  startTimer();
  sendToOffscreen({ type: 'RESUME_RECORDING' }).catch(() => {});
}

// Handle recording data from offscreen
async function handleRecordingData(dataUrl, format) {
  console.log('[Background] Received RECORDING_DATA, format:', format, 'dataUrl length:', dataUrl?.length);

  try {
    // Convert data URL to Blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    console.log('[Background] Blob created from dataUrl, size:', blob.size, 'type:', blob.type);

    // Store in IndexedDB
    await storeRecording(blob, format);
    console.log('[Background] Recording stored in IndexedDB');

    recordingState.isRecording = false;
    recordingState.isPaused = false;
    recordingState.recordingTime = 0;

    // Restore normal UI
    await setRecordingUI(false);

    await closeOffscreenDocument();

    // Open editor page
    await chrome.tabs.create({
      url: chrome.runtime.getURL('editor/editor.html')
    });

    // Notify popup (if open)
    try {
      await chrome.runtime.sendMessage({
        type: 'RECORDING_STOPPED',
        success: true
      });
    } catch (e) {
      // Popup might be closed
    }

  } catch (error) {
    console.error('Error saving recording:', error);
    handleRecordingError('Failed to save recording');
  }
}

// Store recording in IndexedDB
async function storeRecording(blob, format) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('DaddyRecorder', 1);

    request.onerror = () => reject(request.error);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings');
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(['recordings'], 'readwrite');
      const store = transaction.objectStore('recordings');

      console.log('[Background] Storing recording with', cursorData.length, 'cursor positions');
      if (cursorData.length > 0) {
        console.log('[Background] First cursor point:', cursorData[0]);
        console.log('[Background] Last cursor point:', cursorData[cursorData.length - 1]);
      }

      const data = {
        blob: blob,
        format: format,
        timestamp: Date.now(),
        cursorData: [...cursorData] // Copy the array to ensure it's stored
      };

      const putRequest = store.put(data, 'latest');
      putRequest.onsuccess = () => {
        // Clear cursor data after storing
        cursorData = [];
        recordingState.recordingTabId = null;
        resolve();
      };
      putRequest.onerror = () => reject(putRequest.error);
    };
  });
}

// Handle recording error
async function handleRecordingError(error) {
  recordingState.isRecording = false;
  recordingState.isPaused = false;
  stopTimer();

  // Restore normal UI
  await setRecordingUI(false);

  await closeOffscreenDocument();

  try {
    await chrome.runtime.sendMessage({
      type: 'RECORDING_ERROR',
      error: error
    });
  } catch (e) {
    // Popup might be closed
  }
}

// Timer functions
function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    recordingState.recordingTime++;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Clean up on extension unload
chrome.runtime.onSuspend.addListener(() => {
  stopTimer();
  closeOffscreenDocument();
});

// Initialize - ensure UI is in correct state on startup
chrome.runtime.onStartup.addListener(() => {
  setRecordingUI(false);
});

chrome.runtime.onInstalled.addListener(() => {
  setRecordingUI(false);
});
