// State
let state = {
  source: 'tab',
  spotlightEnabled: true,
  spotlightSize: 80,
  spotlightColor: '#6366f1',
  spotlightStyle: 'glow',
  countdownEnabled: true,
  audioEnabled: true,
  format: 'webm',
  quality: 'high',
  watermarkEnabled: false,
  isRecording: false,
  isPaused: false,
  recordingTime: 0
};

// DOM Elements
const elements = {
  mainView: document.getElementById('mainView'),
  recordingView: document.getElementById('recordingView'),
  settingsView: document.getElementById('settingsView'),
  exportView: document.getElementById('exportView'),
  countdownOverlay: document.getElementById('countdownOverlay'),
  countdownNumber: document.getElementById('countdownNumber'),
  recordBtn: document.getElementById('recordBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  backBtn: document.getElementById('backBtn'),
  newRecordingBtn: document.getElementById('newRecordingBtn'),
  recTime: document.getElementById('recTime'),
  status: document.getElementById('status'),
  spotlightEnabled: document.getElementById('spotlightEnabled'),
  spotlightSettings: document.getElementById('spotlightSettings'),
  spotlightSize: document.getElementById('spotlightSize'),
  sizeValue: document.getElementById('sizeValue'),
  countdownEnabled: document.getElementById('countdownEnabled'),
  audioEnabled: document.getElementById('audioEnabled'),
  formatSelect: document.getElementById('formatSelect'),
  qualitySelect: document.getElementById('qualitySelect'),
  watermarkEnabled: document.getElementById('watermarkEnabled')
};

// Timer
let timerInterval = null;

// Initialize
async function init() {
  await loadSettings();
  bindEvents();
  updateUI();
}

// Load settings from storage
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get('settings');
    if (stored.settings) {
      state = { ...state, ...stored.settings };
    }
  } catch (e) {
    console.log('Could not load settings:', e);
  }
}

// Save settings to storage
async function saveSettings() {
  try {
    await chrome.storage.local.set({ settings: state });
  } catch (e) {
    console.log('Could not save settings:', e);
  }
}

// Bind event listeners
function bindEvents() {
  // Source buttons
  document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.source = btn.dataset.source;
      saveSettings();
    });
  });

  // Spotlight toggle
  elements.spotlightEnabled.addEventListener('change', (e) => {
    state.spotlightEnabled = e.target.checked;
    updateSpotlightSettingsVisibility();
    saveSettings();
  });

  // Spotlight size
  elements.spotlightSize.addEventListener('input', (e) => {
    state.spotlightSize = parseInt(e.target.value);
    elements.sizeValue.textContent = `${state.spotlightSize}px`;
    saveSettings();
  });

  // Color buttons
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.spotlightColor = btn.dataset.color;
      saveSettings();
    });
  });

  // Style buttons
  document.querySelectorAll('.style-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.spotlightStyle = btn.dataset.style;
      saveSettings();
    });
  });

  // Record button
  elements.recordBtn.addEventListener('click', startRecording);

  // Pause button
  elements.pauseBtn.addEventListener('click', togglePause);

  // Stop button
  elements.stopBtn.addEventListener('click', stopRecording);

  // Settings button
  elements.settingsBtn.addEventListener('click', () => {
    elements.settingsView.classList.remove('hidden');
  });

  // Back button
  elements.backBtn.addEventListener('click', () => {
    elements.settingsView.classList.add('hidden');
  });

  // New recording button
  elements.newRecordingBtn.addEventListener('click', () => {
    elements.exportView.classList.add('hidden');
    showMainView();
  });

  // Settings toggles
  elements.countdownEnabled.addEventListener('change', (e) => {
    state.countdownEnabled = e.target.checked;
    saveSettings();
  });

  elements.audioEnabled.addEventListener('change', (e) => {
    state.audioEnabled = e.target.checked;
    saveSettings();
  });

  elements.formatSelect.addEventListener('change', (e) => {
    state.format = e.target.value;
    saveSettings();
  });

  elements.qualitySelect.addEventListener('change', (e) => {
    state.quality = e.target.value;
    saveSettings();
  });

  elements.watermarkEnabled.addEventListener('change', (e) => {
    state.watermarkEnabled = e.target.checked;
    saveSettings();
  });

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RECORDING_STOPPED') {
      handleRecordingStopped(message.success);
    } else if (message.type === 'RECORDING_ERROR') {
      showError(message.error);
      showMainView();
    } else if (message.type === 'TIME_UPDATE') {
      state.recordingTime = message.time;
      updateTimerDisplay();
    }
  });
}

// Update UI based on state
function updateUI() {
  // Source buttons
  document.querySelectorAll('.source-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.source === state.source);
  });

  // Spotlight toggle
  elements.spotlightEnabled.checked = state.spotlightEnabled;
  updateSpotlightSettingsVisibility();

  // Spotlight size
  elements.spotlightSize.value = state.spotlightSize;
  elements.sizeValue.textContent = `${state.spotlightSize}px`;

  // Color buttons
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === state.spotlightColor);
  });

  // Style buttons
  document.querySelectorAll('.style-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.style === state.spotlightStyle);
  });

  // Settings
  elements.countdownEnabled.checked = state.countdownEnabled;
  elements.audioEnabled.checked = state.audioEnabled;
  elements.formatSelect.value = state.format;
  elements.qualitySelect.value = state.quality;
  elements.watermarkEnabled.checked = state.watermarkEnabled;
}

function updateSpotlightSettingsVisibility() {
  if (state.spotlightEnabled) {
    elements.spotlightSettings.classList.remove('hidden');
  } else {
    elements.spotlightSettings.classList.add('hidden');
  }
}

// Start recording
async function startRecording() {
  try {
    setStatus('Preparing...');

    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (state.countdownEnabled) {
      await showCountdown();
    }

    // Send message to background to start recording
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      settings: {
        source: state.source,
        spotlightEnabled: state.spotlightEnabled,
        spotlightSize: state.spotlightSize,
        spotlightColor: state.spotlightColor,
        spotlightStyle: state.spotlightStyle,
        audioEnabled: state.audioEnabled,
        format: state.format,
        quality: state.quality,
        watermarkEnabled: state.watermarkEnabled,
        tabId: tab.id
      }
    });

    // Close popup after starting - user will click icon to stop
    // Small delay to ensure message is sent
    setTimeout(() => {
      window.close();
    }, 300);

  } catch (error) {
    console.error('Error starting recording:', error);
    showError('Failed to start recording');
  }
}

// Show countdown
function showCountdown() {
  return new Promise((resolve) => {
    elements.countdownOverlay.classList.remove('hidden');
    let count = 3;
    elements.countdownNumber.textContent = count;

    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        elements.countdownNumber.textContent = count;
      } else {
        clearInterval(interval);
        elements.countdownOverlay.classList.add('hidden');
        resolve();
      }
    }, 1000);
  });
}

// Toggle pause
function togglePause() {
  state.isPaused = !state.isPaused;

  chrome.runtime.sendMessage({
    type: state.isPaused ? 'PAUSE_RECORDING' : 'RESUME_RECORDING'
  });

  // Update pause button
  if (state.isPaused) {
    elements.pauseBtn.classList.add('paused');
    elements.pauseBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
    `;
    elements.pauseBtn.title = 'Resume';
    stopTimer();
  } else {
    elements.pauseBtn.classList.remove('paused');
    elements.pauseBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16" rx="1"/>
        <rect x="14" y="4" width="4" height="16" rx="1"/>
      </svg>
    `;
    elements.pauseBtn.title = 'Pause';
    startTimer();
  }
}

// Stop recording
function stopRecording() {
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  stopTimer();
}

// Handle recording stopped
function handleRecordingStopped(success) {
  state.isRecording = false;
  state.isPaused = false;
  stopTimer();

  if (success) {
    showExportView();
  } else {
    showMainView();
    showError('Recording failed');
  }
}

// Timer functions
function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    state.recordingTime++;
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay() {
  const minutes = Math.floor(state.recordingTime / 60);
  const seconds = state.recordingTime % 60;
  elements.recTime.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// View management
function showMainView() {
  elements.mainView.classList.remove('hidden');
  elements.recordingView.classList.add('hidden');
  elements.exportView.classList.add('hidden');
}

function showRecordingView() {
  elements.mainView.classList.add('hidden');
  elements.recordingView.classList.remove('hidden');
  elements.exportView.classList.add('hidden');

  // Reset pause button
  elements.pauseBtn.classList.remove('paused');
  elements.pauseBtn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1"/>
      <rect x="14" y="4" width="4" height="16" rx="1"/>
    </svg>
  `;
  elements.pauseBtn.title = 'Pause';
}

function showExportView() {
  elements.mainView.classList.add('hidden');
  elements.recordingView.classList.add('hidden');
  elements.exportView.classList.remove('hidden');
}

// Status messages
function setStatus(message) {
  elements.status.textContent = message;
  elements.status.classList.remove('error');
}

function showError(message) {
  elements.status.textContent = message;
  elements.status.classList.add('error');
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);

// Check if already recording when popup opens
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (response && response.isRecording) {
    state.isRecording = true;
    state.isPaused = response.isPaused;
    state.recordingTime = response.recordingTime || 0;
    showRecordingView();
    updateTimerDisplay();
    if (!state.isPaused) {
      startTimer();
    }
    if (state.isPaused) {
      elements.pauseBtn.classList.add('paused');
      elements.pauseBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      `;
    }
  }
});
