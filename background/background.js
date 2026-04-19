// Recording state
let recordingState = {
  isRecording: false,
  isPaused: false,
  recordingTime: 0,
  settings: null,
  tabId: null
};

// Timer interval
let timerInterval = null;

// Icon paths (relative paths from extension root)
const ICONS_NORMAL = {
  '16': 'icons/icon16.png',
  '32': 'icons/icon32.png',
  '48': 'icons/icon48.png',
  '128': 'icons/icon128.png'
};

const ICONS_RECORDING = {
  '16': 'icons/icon16-recording.png',
  '32': 'icons/icon32-recording.png',
  '48': 'icons/icon48-recording.png',
  '128': 'icons/icon128-recording.png'
};

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
      startTimer();
      setRecordingUI(true);
      return false; // No response needed

    case 'RECORDING_DATA':
      handleRecordingData(message.data, message.format);
      return false; // No response needed

    case 'RECORDING_ERROR':
      handleRecordingError(message.error);
      return false; // No response needed

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
      await chrome.action.setTitle({ title: 'Spotlight Recorder' });
    }
  } catch (e) {
    console.error('Error setting UI:', e);
  }
}

// Start recording
async function startRecording(settings) {
  try {
    recordingState.settings = settings;
    recordingState.tabId = settings.tabId;

    // Enable spotlight overlay if enabled
    if (settings.spotlightEnabled) {
      try {
        await chrome.tabs.sendMessage(settings.tabId, {
          type: 'START_SPOTLIGHT',
          settings: {
            size: settings.spotlightSize,
            color: settings.spotlightColor,
            style: settings.spotlightStyle
          }
        });
      } catch (e) {
        console.log('Could not start spotlight (content script may not be loaded):', e);
      }
    }

    // Create offscreen document
    await setupOffscreenDocument();

    // Small delay to ensure offscreen document is ready
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send recording request to offscreen document
    await sendToOffscreen({
      type: 'START_RECORDING',
      settings: settings
    });

  } catch (error) {
    console.error('Error starting recording:', error);
    throw error;
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

    if (existingContexts.length > 0) {
      return;
    }

    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['DISPLAY_MEDIA'],
      justification: 'Recording screen content with getDisplayMedia'
    });
  } catch (e) {
    console.log('Offscreen setup error:', e);
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

  // Stop spotlight in content script
  if (recordingState.settings?.spotlightEnabled && recordingState.tabId) {
    try {
      await chrome.tabs.sendMessage(recordingState.tabId, {
        type: 'STOP_SPOTLIGHT'
      });
    } catch (e) {
      // Tab might be closed
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
  try {
    // Convert data URL to Blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    // Store in IndexedDB
    await storeRecording(blob, format);

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
    const request = indexedDB.open('SpotlightRecorder', 1);

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

      const data = {
        blob: blob,
        format: format,
        timestamp: Date.now()
      };

      const putRequest = store.put(data, 'latest');
      putRequest.onsuccess = () => resolve();
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
