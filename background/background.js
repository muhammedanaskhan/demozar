// ========== State ==========
let recordingState = {
  isRecording: false,
  isPaused: false,
  recordingTime: 0,
  settings: null,
  recorderTabId: null,       // pinned recorder tab
  sourceTabId: null          // the tab that was active when the user launched
};

// Cursor tracking data - array of {time, x, y}
let cursorData = [];
// Click events from the recorded tab — consumed by the editor to auto-
// generate zoom segments at each click moment.
let clickData = [];

// Timer
let timerInterval = null;

function defaultCameraSettings() {
  return {
    enabled: true,
    anchor: 'bottom-right',
    sizePct: 22,
    opacity: 1,
    mirror: true,
    cornerRadiusPct: 50  // 50 = full circle, 0 = square
  };
}

// ========== Action icon: click-to-stop ==========

chrome.action.onClicked.addListener(() => {
  // Only fires when popup is disabled, which we do during recording.
  if (recordingState.isRecording && recordingState.recorderTabId != null) {
    chrome.tabs.sendMessage(recordingState.recorderTabId, { type: 'STOP_RECORDING_FROM_BG' }).catch(() => {});
  }
});

// ========== Messages ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  switch (message.type) {
    case 'OPEN_RECORDER':
      openRecorderTab().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'GET_STATE':
      sendResponse({
        isRecording: recordingState.isRecording,
        isPaused: recordingState.isPaused,
        recordingTime: recordingState.recordingTime
      });
      return false;

    case 'RECORDING_STARTED':
      onRecordingStarted(sender.tab ? sender.tab.id : null);
      return false;

    case 'FOCUS_SOURCE_TAB':
      if (recordingState.sourceTabId != null) {
        chrome.tabs.update(recordingState.sourceTabId, { active: true }).catch(() => {});
      }
      return false;

    case 'FOCUS_RECORDER_TAB':
      if (recordingState.recorderTabId != null) {
        chrome.tabs.update(recordingState.recorderTabId, { active: true }).catch(() => {});
      }
      return false;

    case 'UPDATE_SOURCE_TAB':
      updateSourceTabFromActive().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;

    case 'RECORDING_DATA':
      handleRecordingData(message.screen, message.webcam);
      return false;

    case 'RECORDING_ERROR':
      handleRecordingError(message.error);
      return false;

    case 'CURSOR_POSITION':
      if (recordingState.isRecording && !recordingState.isPaused) {
        cursorData.push(message.data);
      }
      return false;

    case 'CLICK_POSITION':
      if (recordingState.isRecording && !recordingState.isPaused) {
        clickData.push(message.data);
      }
      return false;

    default:
      return false;
  }
});

// ========== Recorder tab lifecycle ==========

async function openRecorderTab() {
  // Remember which tab the user was on so we can inject cursor tracking there.
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab) recordingState.sourceTabId = activeTab.id;
  } catch (_) {}

  // Avoid duplicates if the user double-clicks.
  if (recordingState.recorderTabId != null) {
    try {
      await chrome.tabs.update(recordingState.recorderTabId, { active: true });
      return;
    } catch (_) {
      recordingState.recorderTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL('recorder/recorder.html'),
    pinned: true,
    active: true
  });
  recordingState.recorderTabId = tab.id;
}

async function closeRecorderTab() {
  const id = recordingState.recorderTabId;
  recordingState.recorderTabId = null;
  if (id == null) return;
  try { await chrome.tabs.remove(id); } catch (_) {}
}

function onRecordingStarted(senderTabId) {
  recordingState.isRecording = true;
  recordingState.isPaused = false;
  recordingState.recordingTime = 0;
  if (senderTabId) recordingState.recorderTabId = senderTabId;
  cursorData = [];
  clickData = [];
  startTimer();
  setRecordingUI(true);
  injectCursorTracker();  // non-blocking; best-effort
  console.log('[Background] Recording started');
}

// Handle extension tab close: if the recorder tab itself is closed while we
// think we're recording, treat it as a stop (no data).
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recordingState.recorderTabId && recordingState.isRecording) {
    console.log('[Background] Recorder tab closed mid-recording — aborting');
    recordingState.recorderTabId = null;
    handleRecordingError('Recorder tab was closed before recording finished');
  }
});

// Re-identify the source tab from whichever tab is currently active in
// the last-focused window. Called after getDisplayMedia resolves for
// tab-surface captures — Chrome auto-focuses the picked tab, so the
// active tab at that moment IS the tab being recorded.
async function updateSourceTabFromActive() {
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id && active.id !== recordingState.recorderTabId) {
      recordingState.sourceTabId = active.id;
      console.log('[Background] sourceTabId updated to picked tab:', active.id, active.url);
    }
  } catch (e) {
    console.warn('[Background] Could not update source tab:', e);
  }
}

// ========== Cursor tracking ==========

async function injectCursorTracker() {
  const tabId = recordingState.sourceTabId;
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url || '';
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
        url.startsWith('about:') || url.startsWith('edge://')) {
      console.log('[Background] Skipping cursor tracker for restricted URL:', url);
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/cursorTracker.js']
    });
    await new Promise(r => setTimeout(r, 50));
    await chrome.tabs.sendMessage(tabId, { type: 'START_CURSOR_TRACKING' });
    await chrome.tabs.sendMessage(tabId, { type: 'RESET_CURSOR_TIME' });
  } catch (e) {
    console.warn('[Background] Cursor tracker injection failed:', e);
  }
}

async function stopCursorTracker() {
  const tabId = recordingState.sourceTabId;
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'STOP_CURSOR_TRACKING' });
  } catch (_) {}
}

// Live webcam overlay is now handled in the recorder tab itself via the
// Document Picture-in-Picture API (see recorder.js::openLiveOverlayPip).
// A PiP window is a separate browser window that tab/window captures
// don't include, so we can show the user a live webcam bubble without
// burning it into the recording.

// ========== Data handling ==========

async function handleRecordingData(screen, webcam) {
  if (!screen || !screen.dataUrl) {
    handleRecordingError('Missing screen recording payload');
    return;
  }
  console.log('[Background] RECORDING_DATA — screen:', screen.format, 'webcam:', webcam ? webcam.format : 'none');

  try {
    const screenBlob = await (await fetch(screen.dataUrl)).blob();
    let webcamBlob = null;
    if (webcam && webcam.dataUrl) {
      webcamBlob = await (await fetch(webcam.dataUrl)).blob();
    }

    await stopCursorTracker();
    await storeRecording(screenBlob, screen.format, webcamBlob, webcam ? webcam.format : null);

    recordingState.isRecording = false;
    recordingState.isPaused = false;
    recordingState.recordingTime = 0;
    await setRecordingUI(false);
    await closeRecorderTab();

    await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
  } catch (e) {
    console.error('[Background] Save error:', e);
    handleRecordingError('Failed to save recording');
  }
}

async function handleRecordingError(error) {
  console.warn('[Background] Recording error:', error);
  recordingState.isRecording = false;
  recordingState.isPaused = false;
  stopTimer();
  await setRecordingUI(false);
  await stopCursorTracker();
  await closeRecorderTab();
}

async function storeRecording(blob, format, webcamBlob, webcamFormat) {
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
      const tx = db.transaction(['recordings'], 'readwrite');
      const store = tx.objectStore('recordings');
      const data = {
        blob,
        format,
        timestamp: Date.now(),
        cursorData: [...cursorData],
        clickData: [...clickData],
        webcamBlob: webcamBlob || null,
        webcamFormat: webcamFormat || null,
        cameraSettings: webcamBlob ? defaultCameraSettings() : null
      };
      const put = store.put(data, 'latest');
      put.onsuccess = () => {
        cursorData = [];
        clickData = [];
        recordingState.sourceTabId = null;
        resolve();
      };
      put.onerror = () => reject(put.error);
    };
  });
}

// ========== Icon / badge ==========

async function setRecordingUI(isRecording) {
  try {
    if (isRecording) {
      await chrome.action.setBadgeText({ text: 'REC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      await chrome.action.setPopup({ popup: '' });
      await chrome.action.setTitle({ title: 'Click to stop recording' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setPopup({ popup: 'popup/popup.html' });
      await chrome.action.setTitle({ title: 'DaddyRecorder' });
    }
  } catch (e) {
    console.error('[Background] UI error:', e);
  }
}

// ========== Timer ==========

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => { recordingState.recordingTime++; }, 1000);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ========== Boot / lifecycle ==========

chrome.runtime.onStartup.addListener(() => setRecordingUI(false));
chrome.runtime.onInstalled.addListener(() => setRecordingUI(false));
chrome.runtime.onSuspend.addListener(() => {
  stopTimer();
  closeRecorderTab();
});
