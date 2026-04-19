// Editor State
const state = {
  videoBlob: null,
  videoUrl: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  // Clips array - each clip has { id, start, end, speed }
  clips: [],
  selectedClipId: null,
  aspectRatio: 'native',
  background: '../assets/abstract.webp',
  backgroundType: 'image',
  backgroundImage: '../assets/abstract.webp',
  imageBlur: 'moderate',
  hideMenuBar: false,
  hideDock: false,
  frameStyle: 'default',
  frameShadow: true,
  frameBorder: false,
  cursorSize: 'medium',
  smoothMovement: true,
  cursorShadow: true,
  clickStyle: 'orb',
  clickForce: 'moderate'
};

// Generate unique ID for clips
function generateClipId() {
  return 'clip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// DOM Elements
const elements = {
  videoPlayer: document.getElementById('videoPlayer'),
  previewWrapper: document.getElementById('previewWrapper'),
  previewBackground: document.getElementById('previewBackground'),
  previewFrame: document.getElementById('previewFrame'),
  minimalFrame: document.getElementById('minimalFrame'),
  playBtn: document.getElementById('playBtn'),
  currentTime: document.getElementById('currentTime'),
  durationEl: document.getElementById('duration'),
  progressBar: document.getElementById('progressBar'),
  progressFilled: document.getElementById('progressFilled'),
  progressHandle: document.getElementById('progressHandle'),
  timelineRuler: document.getElementById('timelineRuler'),
  timelinePlayhead: document.getElementById('timelinePlayhead'),
  timelineClips: document.getElementById('timelineClips'),
  timelineTrack: document.getElementById('timelineTrack'),
  splitBtn: document.getElementById('splitBtn'),
  trimStartBtn: document.getElementById('trimStartBtn'),
  trimEndBtn: document.getElementById('trimEndBtn'),
  deleteClipBtn: document.getElementById('deleteClipBtn'),
  clipSpeed: document.getElementById('clipSpeed'),
  resetTimelineBtn: document.getElementById('resetTimelineBtn'),
  exportBtn: document.getElementById('exportBtn'),
  exportModal: document.getElementById('exportModal'),
  closeModal: document.getElementById('closeModal'),
  exportFinalBtn: document.getElementById('exportFinalBtn'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingProgressBar: document.getElementById('loadingProgressBar'),
  aspectRatio: document.getElementById('aspectRatio'),
  imageBlur: document.getElementById('imageBlur'),
  hideMenuBar: document.getElementById('hideMenuBar'),
  hideDock: document.getElementById('hideDock'),
  frameShadow: document.getElementById('frameShadow'),
  frameBorder: document.getElementById('frameBorder'),
  cursorSize: document.getElementById('cursorSize'),
  smoothMovement: document.getElementById('smoothMovement'),
  cursorShadow: document.getElementById('cursorShadow'),
  clickStyle: document.getElementById('clickStyle'),
  clickForce: document.getElementById('clickForce'),
  exportResolution: document.getElementById('exportResolution'),
  exportQuality: document.getElementById('exportQuality'),
  exportFormat: document.getElementById('exportFormat')
};

// Initialize
async function init() {
  await loadVideo();
  bindEvents();
  updatePreview();
}

// Load video from IndexedDB
async function loadVideo() {
  try {
    const db = await openDB();
    const transaction = db.transaction(['recordings'], 'readonly');
    const store = transaction.objectStore('recordings');
    const request = store.get('latest');

    request.onsuccess = () => {
      const data = request.result;
      console.log('[Editor] IndexedDB data:', data);
      if (data && data.blob) {
        console.log('[Editor] Blob from DB:', data.blob, 'size:', data.blob.size, 'type:', data.blob.type);
        state.videoBlob = data.blob;
        state.videoUrl = URL.createObjectURL(data.blob);
        console.log('[Editor] Created blob URL:', state.videoUrl);
        elements.videoPlayer.src = state.videoUrl;

        elements.videoPlayer.onerror = (e) => {
          const err = elements.videoPlayer.error;
          console.error('[Editor] Video error code:', err?.code, 'message:', err?.message, 'full:', err);
        };

        elements.videoPlayer.onloadedmetadata = () => {
          // WebM from MediaRecorder often has Infinity duration initially
          // We need to seek briefly to get the actual duration
          if (!isFinite(elements.videoPlayer.duration)) {
            // Seek to a large value to force duration calculation
            elements.videoPlayer.currentTime = 1e10;
            elements.videoPlayer.onseeked = function onSeek() {
              elements.videoPlayer.onseeked = null;
              state.duration = elements.videoPlayer.duration;
              elements.videoPlayer.currentTime = 0;
              updateDurationDisplay();
            };
          } else {
            state.duration = elements.videoPlayer.duration;
            updateDurationDisplay();
          }
        };
      } else {
        showError('No recording found. Please record a video first.');
      }
    };

    request.onerror = () => {
      showError('Failed to load recording.');
    };
  } catch (error) {
    console.error('Error loading video:', error);
    showError('Failed to load recording.');
  }
}

// Update duration display
function updateDurationDisplay() {
  if (isFinite(state.duration) && !isNaN(state.duration)) {
    // Show effective duration (after speed changes)
    const effectiveDuration = getEditedDuration();
    elements.durationEl.textContent = formatTime(effectiveDuration);

    // Initialize clips if not already done
    if (state.clips.length === 0) {
      initializeClips();
    }

    // Render time markers after a short delay to ensure layout is ready
    setTimeout(renderTimeMarkers, 100);
  } else {
    elements.durationEl.textContent = '00:00';
  }
  updateProgress();
}

// Initialize clips with full video as single clip
function initializeClips() {
  state.clips = [{
    id: generateClipId(),
    start: 0,
    end: state.duration,
    speed: 1,
    deleted: false
  }];
  state.selectedClipId = state.clips[0].id;
  renderClips();
}

// Render clips in timeline
function renderClips() {
  const container = elements.timelineClips;
  container.innerHTML = '';

  const activeClips = state.clips.filter(c => !c.deleted);
  const totalDuration = activeClips.reduce((sum, c) => sum + (c.end - c.start) / c.speed, 0);

  // Scissor SVG icon for handles
  const scissorIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
    <circle cx="6" cy="6" r="3"/>
    <circle cx="6" cy="18" r="3"/>
    <line x1="20" y1="4" x2="8.12" y2="15.88"/>
    <line x1="14.47" y1="14.48" x2="20" y2="20"/>
    <line x1="8.12" y1="8.12" x2="12" y2="12"/>
  </svg>`;

  state.clips.forEach(clip => {
    if (clip.deleted) return;

    const clipEl = document.createElement('div');
    clipEl.className = 'timeline-clip' + (clip.id === state.selectedClipId ? ' selected' : '');
    clipEl.dataset.clipId = clip.id;

    // Calculate width based on clip duration relative to total
    const clipDuration = (clip.end - clip.start) / clip.speed;
    const widthPercent = (clipDuration / totalDuration) * 100;
    clipEl.style.width = `${widthPercent}%`;

    // Format duration for display (effective duration after speed)
    const effectiveDuration = (clip.end - clip.start) / clip.speed;

    // Add handles with scissor icons and content
    clipEl.innerHTML = `
      <div class="clip-handle left">${scissorIcon}</div>
      <div class="clip-content">
        <span>${formatTime(effectiveDuration)}</span>
        ${clip.speed !== 1 ? `<span class="clip-speed">${clip.speed}x</span>` : ''}
      </div>
      <div class="clip-handle right">${scissorIcon}</div>
    `;

    // Click to select
    clipEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('clip-handle')) return;
      selectClip(clip.id);
    });

    container.appendChild(clipEl);
  });

  updateDeleteButton();
  updateSpeedControl();
  renderTimeMarkers();

  // Update duration display to reflect speed changes
  const effectiveDuration = getEditedDuration();
  elements.durationEl.textContent = formatTime(effectiveDuration);
}

// Render time markers on ruler
function renderTimeMarkers() {
  const ruler = document.getElementById('timelineRuler');
  if (!ruler || !isFinite(state.duration)) return;

  ruler.innerHTML = '';

  // Use effective duration (after speed changes)
  const duration = getEditedDuration();
  if (duration <= 0) return;

  let interval = 1; // Default 1 second

  if (duration > 60) interval = 10;
  else if (duration > 30) interval = 5;
  else if (duration > 10) interval = 2;
  else if (duration < 3) interval = 0.5;

  const numMarkers = Math.ceil(duration / interval) + 1;

  for (let i = 0; i < numMarkers; i++) {
    const time = i * interval;
    if (time > duration) break;

    const marker = document.createElement('span');
    marker.className = 'time-marker';
    marker.textContent = formatTime(time);
    marker.style.left = `${16 + (time / duration) * (ruler.offsetWidth - 32)}px`;
    ruler.appendChild(marker);
  }
}

// Select a clip
function selectClip(clipId) {
  state.selectedClipId = clipId;
  document.querySelectorAll('.timeline-clip').forEach(el => {
    el.classList.toggle('selected', el.dataset.clipId === clipId);
  });
  updateDeleteButton();
  updateSpeedControl();
}

// Update delete button state
function updateDeleteButton() {
  const activeClips = state.clips.filter(c => !c.deleted);
  const deleteBtn = document.getElementById('deleteClipBtn');
  // Can only delete if there's more than one clip and one is selected
  deleteBtn.disabled = activeClips.length <= 1 || !state.selectedClipId;
}

// Update speed control to show selected clip's speed
function updateSpeedControl() {
  const speedSelect = document.getElementById('clipSpeed');
  const customSpeedInput = document.getElementById('customSpeed');
  const customSpeedWrapper = document.getElementById('customSpeedWrapper');
  const selectedClip = state.clips.find(c => c.id === state.selectedClipId);

  if (selectedClip) {
    const speed = selectedClip.speed;
    const speedStr = speed.toString();

    // Check if speed matches a preset option
    const presetOption = Array.from(speedSelect.options).find(opt => opt.value === speedStr && opt.value !== 'custom');

    if (presetOption) {
      speedSelect.value = speedStr;
      customSpeedWrapper.classList.add('hidden');
    } else {
      // It's a custom speed
      speedSelect.value = 'custom';
      customSpeedInput.value = speed;
      customSpeedWrapper.classList.remove('hidden');
    }
  }
}

// Split clip at current playhead position
function splitAtPlayhead() {
  const currentTime = elements.videoPlayer.currentTime;

  // Find which clip contains the current time
  let accumulatedTime = 0;
  let clipToSplit = null;
  let splitPoint = 0;

  for (const clip of state.clips) {
    if (clip.deleted) continue;

    const clipDuration = (clip.end - clip.start) / clip.speed;
    if (accumulatedTime + clipDuration > currentTime) {
      clipToSplit = clip;
      // Calculate the actual video time within this clip
      const timeIntoClip = (currentTime - accumulatedTime) * clip.speed;
      splitPoint = clip.start + timeIntoClip;
      break;
    }
    accumulatedTime += clipDuration;
  }

  if (!clipToSplit || splitPoint <= clipToSplit.start || splitPoint >= clipToSplit.end) {
    return; // Can't split at this point
  }

  // Create two new clips
  const clipIndex = state.clips.indexOf(clipToSplit);
  const newClip1 = {
    id: generateClipId(),
    start: clipToSplit.start,
    end: splitPoint,
    speed: clipToSplit.speed,
    deleted: false
  };
  const newClip2 = {
    id: generateClipId(),
    start: splitPoint,
    end: clipToSplit.end,
    speed: clipToSplit.speed,
    deleted: false
  };

  // Replace the original clip with two new ones
  state.clips.splice(clipIndex, 1, newClip1, newClip2);
  state.selectedClipId = newClip2.id;

  renderClips();
}

// Trim from start (remove everything before playhead in current clip)
function trimToStart() {
  const currentTime = elements.videoPlayer.currentTime;

  let accumulatedTime = 0;
  for (const clip of state.clips) {
    if (clip.deleted) continue;

    const clipDuration = (clip.end - clip.start) / clip.speed;
    if (accumulatedTime + clipDuration > currentTime) {
      const timeIntoClip = (currentTime - accumulatedTime) * clip.speed;
      const newStart = clip.start + timeIntoClip;

      if (newStart < clip.end) {
        clip.start = newStart;
        renderClips();
      }
      break;
    }
    accumulatedTime += clipDuration;
  }
}

// Trim to end (remove everything after playhead in current clip)
function trimToEnd() {
  const currentTime = elements.videoPlayer.currentTime;

  let accumulatedTime = 0;
  for (const clip of state.clips) {
    if (clip.deleted) continue;

    const clipDuration = (clip.end - clip.start) / clip.speed;
    if (accumulatedTime + clipDuration > currentTime) {
      const timeIntoClip = (currentTime - accumulatedTime) * clip.speed;
      const newEnd = clip.start + timeIntoClip;

      if (newEnd > clip.start) {
        clip.end = newEnd;
        renderClips();
      }
      break;
    }
    accumulatedTime += clipDuration;
  }
}

// Delete selected clip
function deleteSelectedClip() {
  if (!state.selectedClipId) return;

  const activeClips = state.clips.filter(c => !c.deleted);
  if (activeClips.length <= 1) return; // Can't delete last clip

  const clip = state.clips.find(c => c.id === state.selectedClipId);
  if (clip) {
    clip.deleted = true;

    // Select next available clip
    const remainingClips = state.clips.filter(c => !c.deleted);
    state.selectedClipId = remainingClips.length > 0 ? remainingClips[0].id : null;

    renderClips();
  }
}

// Change speed of selected clip
function changeClipSpeed(speed) {
  const clip = state.clips.find(c => c.id === state.selectedClipId);
  if (clip) {
    clip.speed = parseFloat(speed);
    renderClips();
  }
}

// Reset timeline to original state
function resetTimeline() {
  state.clips = [{
    id: generateClipId(),
    start: 0,
    end: state.duration,
    speed: 1,
    deleted: false
  }];
  state.selectedClipId = state.clips[0].id;
  elements.videoPlayer.currentTime = 0;
  renderClips();
}

// Get total edited duration
function getEditedDuration() {
  return state.clips
    .filter(c => !c.deleted)
    .reduce((sum, c) => sum + (c.end - c.start) / c.speed, 0);
}

// Open IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('DemozarRecorder', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings');
      }
    };
  });
}

// Show error message
function showError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    padding: 40px;
    border-radius: 16px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    text-align: center;
    z-index: 1000;
  `;
  errorDiv.innerHTML = `
    <h2 style="margin-bottom: 16px; color: #ef4444;">Error</h2>
    <p style="color: #64748b; margin-bottom: 24px;">${message}</p>
    <button id="errorCloseBtn" style="
      padding: 12px 24px;
      background: #6366f1;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
    ">Close</button>
  `;
  document.body.appendChild(errorDiv);

  // Add event listener (CSP compliant)
  document.getElementById('errorCloseBtn').addEventListener('click', () => {
    window.close();
  });
}

// Bind events
function bindEvents() {
  // Play/Pause
  elements.playBtn.addEventListener('click', togglePlay);
  elements.videoPlayer.addEventListener('click', togglePlay);

  // Video events
  elements.videoPlayer.addEventListener('timeupdate', () => {
    updateProgress();
    updatePlaybackRate();
  });
  elements.videoPlayer.addEventListener('ended', () => {
    state.isPlaying = false;
    if (playheadAnimationId) {
      cancelAnimationFrame(playheadAnimationId);
      playheadAnimationId = null;
    }
    updatePlayButton();
  });

  // Progress bar
  elements.progressBar.addEventListener('click', seekVideo);
  elements.progressBar.addEventListener('mousedown', startDrag);

  // Timeline clips wrapper - make it clickable for seeking
  const clipsWrapper = document.querySelector('.timeline-clips-wrapper');
  if (clipsWrapper) {
    clipsWrapper.addEventListener('click', seekFromTimeline);
    clipsWrapper.addEventListener('mousedown', startTimelineDrag);
    clipsWrapper.style.cursor = 'pointer';
  }

  // Image background presets
  document.querySelectorAll('#bgImages .bg-preset').forEach(preset => {
    preset.addEventListener('click', () => {
      document.querySelectorAll('#bgImages .bg-preset').forEach(p => p.classList.remove('active'));
      preset.classList.add('active');
      state.backgroundImage = preset.dataset.bgImage;
      state.background = preset.dataset.bgImage;
      updatePreview();
    });
  });

  // Gradient background presets
  document.querySelectorAll('#bgGradients .bg-preset').forEach(preset => {
    preset.addEventListener('click', () => {
      document.querySelectorAll('#bgGradients .bg-preset').forEach(p => p.classList.remove('active'));
      preset.classList.add('active');
      state.background = preset.dataset.bg;
      updatePreview();
    });
  });

  // Solid color background presets
  document.querySelectorAll('#bgColors .bg-preset').forEach(preset => {
    preset.addEventListener('click', () => {
      document.querySelectorAll('#bgColors .bg-preset').forEach(p => p.classList.remove('active'));
      preset.classList.add('active');
      state.background = preset.dataset.bg;
      updatePreview();
    });
  });

  // Background type tabs
  document.querySelectorAll('.bg-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.bg-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.backgroundType = tab.dataset.type;

      // Show/hide appropriate preset panels
      document.getElementById('bgImages').classList.toggle('hidden', tab.dataset.type !== 'image');
      document.getElementById('bgGradients').classList.toggle('hidden', tab.dataset.type !== 'gradient');
      document.getElementById('bgColors').classList.toggle('hidden', tab.dataset.type !== 'color');

      // Show/hide blur setting (only for images)
      document.getElementById('imageBlurRow').classList.toggle('hidden', tab.dataset.type !== 'image');

      updatePreview();
    });
  });

  // Frame style tabs
  document.querySelectorAll('.frame-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.frame-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.frameStyle = tab.dataset.frame;
      updatePreview();
    });
  });

  // Settings
  elements.aspectRatio.addEventListener('change', (e) => {
    state.aspectRatio = e.target.value;
    updatePreview();
  });

  elements.imageBlur.addEventListener('change', (e) => {
    state.imageBlur = e.target.value;
    updatePreview();
  });

  // Crop toggles
  elements.hideMenuBar.addEventListener('change', (e) => {
    state.hideMenuBar = e.target.checked;
    updatePreview();
  });

  elements.hideDock.addEventListener('change', (e) => {
    state.hideDock = e.target.checked;
    updatePreview();
  });

  elements.frameShadow.addEventListener('change', (e) => {
    state.frameShadow = e.target.checked;
    updatePreview();
  });

  elements.frameBorder.addEventListener('change', (e) => {
    state.frameBorder = e.target.checked;
    updatePreview();
  });

  elements.cursorSize.addEventListener('change', (e) => {
    state.cursorSize = e.target.value;
  });

  elements.smoothMovement.addEventListener('change', (e) => {
    state.smoothMovement = e.target.checked;
  });

  elements.cursorShadow.addEventListener('change', (e) => {
    state.cursorShadow = e.target.checked;
  });

  elements.clickStyle.addEventListener('change', (e) => {
    state.clickStyle = e.target.value;
  });

  elements.clickForce.addEventListener('change', (e) => {
    state.clickForce = e.target.value;
  });

  // Export modal
  elements.exportBtn.addEventListener('click', () => {
    elements.exportModal.classList.remove('hidden');
  });

  elements.closeModal.addEventListener('click', () => {
    elements.exportModal.classList.add('hidden');
  });

  elements.exportModal.addEventListener('click', (e) => {
    if (e.target === elements.exportModal) {
      elements.exportModal.classList.add('hidden');
    }
  });

  elements.exportFinalBtn.addEventListener('click', exportVideo);

  // Timeline tools
  elements.splitBtn.addEventListener('click', splitAtPlayhead);
  elements.trimStartBtn.addEventListener('click', trimToStart);
  elements.trimEndBtn.addEventListener('click', trimToEnd);
  elements.deleteClipBtn.addEventListener('click', deleteSelectedClip);
  elements.resetTimelineBtn.addEventListener('click', resetTimeline);

  const customSpeedInput = document.getElementById('customSpeed');
  const customSpeedWrapper = document.getElementById('customSpeedWrapper');

  elements.clipSpeed.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      customSpeedWrapper.classList.remove('hidden');
      customSpeedInput.focus();
    } else {
      customSpeedWrapper.classList.add('hidden');
      changeClipSpeed(e.target.value);
    }
  });

  customSpeedInput.addEventListener('change', (e) => {
    const speed = parseFloat(e.target.value);
    if (speed && speed >= 0.1 && speed <= 100) {
      changeClipSpeed(speed);
    }
  });

  customSpeedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const speed = parseFloat(customSpeedInput.value);
      if (speed && speed >= 0.1 && speed <= 100) {
        changeClipSpeed(speed);
        customSpeedInput.blur();
      }
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ignore if typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'KeyS') {
      e.preventDefault();
      splitAtPlayhead();
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault();
      deleteSelectedClip();
    }
  });

}

// Animation frame ID for smooth playhead
let playheadAnimationId = null;

// Smooth playhead animation loop
function animatePlayhead() {
  if (state.isPlaying) {
    updateProgress();
    playheadAnimationId = requestAnimationFrame(animatePlayhead);
  }
}

// Toggle play/pause
function togglePlay() {
  if (state.isPlaying) {
    elements.videoPlayer.pause();
    if (playheadAnimationId) {
      cancelAnimationFrame(playheadAnimationId);
      playheadAnimationId = null;
    }
  } else {
    elements.videoPlayer.play();
    playheadAnimationId = requestAnimationFrame(animatePlayhead);
  }
  state.isPlaying = !state.isPlaying;
  updatePlayButton();
}

// Update play button icon
function updatePlayButton() {
  const playIcon = elements.playBtn.querySelector('.play-icon');
  const pauseIcon = elements.playBtn.querySelector('.pause-icon');

  if (state.isPlaying) {
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
  } else {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
  }
}

// Update progress bar
function updateProgress() {
  const currentTime = elements.videoPlayer.currentTime || 0;
  const duration = isFinite(state.duration) && state.duration > 0 ? state.duration : 1;
  const percent = Math.min(100, Math.max(0, (currentTime / duration) * 100));

  elements.progressFilled.style.width = `${percent}%`;
  elements.progressHandle.style.left = `${percent}%`;
  elements.currentTime.textContent = formatTime(currentTime);

  // Update timeline playhead - now inside clips wrapper
  const clipsWrapper = document.querySelector('.timeline-clips-wrapper');
  if (clipsWrapper && elements.timelinePlayhead) {
    const padding = 0; // No padding inside wrapper
    const wrapperWidth = clipsWrapper.offsetWidth - 32; // Account for wrapper padding
    elements.timelinePlayhead.style.left = `${16 + (percent / 100) * wrapperWidth}px`;
  }
}

// Seek video
function seekVideo(e) {
  if (!elements.videoPlayer.duration || isNaN(elements.videoPlayer.duration)) {
    return;
  }
  const rect = elements.progressBar.getBoundingClientRect();
  let percent = (e.clientX - rect.left) / rect.width;
  percent = Math.max(0, Math.min(1, percent)); // Clamp between 0 and 1
  const newTime = percent * elements.videoPlayer.duration;
  if (!isNaN(newTime)) {
    elements.videoPlayer.currentTime = newTime;
    updateProgress();
    updatePlaybackRate();
  }
}

// Drag handling
let isDragging = false;

function startDrag(e) {
  e.preventDefault(); // Prevent text selection
  isDragging = true;
  seekVideo(e);

  const handleDrag = (e) => {
    e.preventDefault();
    if (isDragging) {
      seekVideo(e);
    }
  };

  const stopDrag = () => {
    isDragging = false;
    document.removeEventListener('mousemove', handleDrag);
    document.removeEventListener('mouseup', stopDrag);
  };

  document.addEventListener('mousemove', handleDrag);
  document.addEventListener('mouseup', stopDrag);
}

// Timeline seeking
function seekFromTimeline(e) {
  const clipsWrapper = document.querySelector('.timeline-clips-wrapper');
  if (!clipsWrapper || !isFinite(state.duration) || state.duration <= 0) {
    return;
  }

  const rect = clipsWrapper.getBoundingClientRect();
  const padding = 16; // Account for wrapper padding
  const effectiveWidth = rect.width - (padding * 2);
  let clickX = e.clientX - rect.left - padding;
  let percent = clickX / effectiveWidth;
  percent = Math.max(0, Math.min(1, percent));

  const newTime = percent * state.duration;
  if (!isNaN(newTime) && isFinite(newTime)) {
    elements.videoPlayer.currentTime = newTime;
    updateProgress();
    updatePlaybackRate();
  }
}

function startTimelineDrag(e) {
  // Don't start drag if clicking on a clip
  if (e.target.closest('.timeline-clip')) return;

  e.preventDefault(); // Prevent text selection
  isDragging = true;
  seekFromTimeline(e);

  const handleDrag = (e) => {
    e.preventDefault();
    if (isDragging) {
      seekFromTimeline(e);
    }
  };

  const stopDrag = () => {
    isDragging = false;
    document.removeEventListener('mousemove', handleDrag);
    document.removeEventListener('mouseup', stopDrag);
  };

  document.addEventListener('mousemove', handleDrag);
  document.addEventListener('mouseup', stopDrag);
}

// Format time
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Update playback rate based on current clip
function updatePlaybackRate() {
  const currentTime = elements.videoPlayer.currentTime;
  const clip = getClipAtTime(currentTime);

  if (clip && elements.videoPlayer.playbackRate !== clip.speed) {
    // Clamp to browser's supported range (0.0625 to 16)
    const rate = Math.max(0.0625, Math.min(16, clip.speed));
    elements.videoPlayer.playbackRate = rate;
  }
}

// Get the clip at a specific video time
function getClipAtTime(videoTime) {
  for (const clip of state.clips) {
    if (clip.deleted) continue;
    if (videoTime >= clip.start && videoTime < clip.end) {
      return clip;
    }
  }
  // Return first non-deleted clip if not found
  return state.clips.find(c => !c.deleted);
}

// Update preview
function updatePreview() {
  // Aspect ratio
  elements.previewWrapper.setAttribute('data-aspect', state.aspectRatio);

  // Reset background styles
  elements.previewBackground.style.background = '';
  elements.previewBackground.style.backgroundImage = '';
  elements.previewBackground.style.backgroundSize = '';
  elements.previewBackground.style.backgroundPosition = '';

  // Background based on type
  if (state.backgroundType === 'hidden') {
    elements.previewBackground.style.background = 'transparent';
    elements.previewWrapper.style.background = 'var(--bg-tertiary)';
    elements.previewBackground.style.filter = 'none';
    elements.previewBackground.style.transform = 'none';
  } else if (state.backgroundType === 'image') {
    elements.previewBackground.style.backgroundImage = `url('${state.backgroundImage}')`;
    elements.previewBackground.style.backgroundSize = 'cover';
    elements.previewBackground.style.backgroundPosition = 'center';
    elements.previewWrapper.style.background = '';

    // Apply blur for images
    const blurValues = { none: '0px', light: '8px', moderate: '16px', heavy: '32px' };
    const blur = blurValues[state.imageBlur];
    elements.previewBackground.style.filter = blur === '0px' ? 'none' : `blur(${blur})`;
    elements.previewBackground.style.transform = blur === '0px' ? 'none' : 'scale(1.1)';
  } else if (state.backgroundType === 'gradient') {
    elements.previewBackground.style.background = state.background;
    elements.previewWrapper.style.background = '';
    elements.previewBackground.style.filter = 'none';
    elements.previewBackground.style.transform = 'none';
  } else if (state.backgroundType === 'color') {
    elements.previewBackground.style.background = state.background;
    elements.previewWrapper.style.background = '';
    elements.previewBackground.style.filter = 'none';
    elements.previewBackground.style.transform = 'none';
  }

  // Crop - hide menu bar and/or dock
  // Menu bar ~3% from top, dock ~6% from bottom
  const cropTop = state.hideMenuBar ? 3.5 : 0;
  const cropBottom = state.hideDock ? 6 : 0;

  if (cropTop > 0 || cropBottom > 0) {
    // Calculate how much of video we're keeping
    const keepPercent = 100 - cropTop - cropBottom;
    // Scale factor to fill the original space
    const scale = 100 / keepPercent;
    // Translate to shift cropped area out of view
    // Positive = move down, Negative = move up
    const shiftPercent = (cropTop - cropBottom) / 2;

    elements.videoPlayer.style.clipPath = `inset(${cropTop}% 0 ${cropBottom}% 0)`;
    elements.videoPlayer.style.transform = `scale(${scale.toFixed(3)}) translateY(${shiftPercent.toFixed(2)}%)`;
    elements.videoPlayer.style.transformOrigin = 'center center';
  } else {
    elements.videoPlayer.style.clipPath = 'none';
    elements.videoPlayer.style.transform = 'none';
  }

  // Frame style
  // Default: No custom frame, video shows its own browser chrome
  // Minimal: Show custom Demozar frame
  // Hidden: No frame at all
  if (state.frameStyle === 'minimal') {
    elements.minimalFrame.classList.remove('hidden');
    elements.videoPlayer.classList.add('has-frame');
  } else {
    elements.minimalFrame.classList.add('hidden');
    elements.videoPlayer.classList.remove('has-frame');
  }

  // Shadow & border
  elements.previewFrame.classList.toggle('has-shadow', state.frameShadow);
  elements.previewFrame.classList.toggle('has-border', state.frameBorder);
}

// Export video
async function exportVideo() {
  elements.exportModal.classList.add('hidden');
  elements.loadingOverlay.classList.remove('hidden');

  const resolution = elements.exportResolution.value;
  const quality = elements.exportQuality.value / 100;
  const format = elements.exportFormat.value;

  // Get active clips (not deleted)
  const activeClips = state.clips.filter(c => !c.deleted);

  if (activeClips.length === 0) {
    elements.loadingOverlay.classList.add('hidden');
    alert('No clips to export');
    return;
  }

  try {
    // Get resolution dimensions
    const resolutions = {
      '1080p': { width: 1920, height: 1080 },
      '720p': { width: 1280, height: 720 },
      '480p': { width: 854, height: 480 }
    };
    const { width, height } = resolutions[resolution];

    // Create canvas for rendering
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Create offscreen video for reading frames
    const video = document.createElement('video');
    video.src = state.videoUrl;
    video.muted = true;

    await new Promise(resolve => {
      video.onloadedmetadata = resolve;
    });

    // Apply crop if enabled
    const cropTop = state.hideMenuBar ? 0.035 : 0;
    const cropBottom = state.hideDock ? 0.06 : 0;
    const srcY = video.videoHeight * cropTop;
    const srcHeight = video.videoHeight * (1 - cropTop - cropBottom);
    const effectiveAspect = video.videoWidth / srcHeight;

    // Calculate video dimensions to fit in frame
    const canvasAspect = width / height;
    let videoWidth, videoHeight, videoX, videoY;
    const padding = 60; // Padding for background visibility

    if (effectiveAspect > canvasAspect) {
      videoWidth = width - padding * 2;
      videoHeight = videoWidth / effectiveAspect;
    } else {
      videoHeight = height - padding * 2;
      videoWidth = videoHeight * effectiveAspect;
    }

    videoX = (width - videoWidth) / 2;
    videoY = (height - videoHeight) / 2;

    // Account for frame header if not hidden
    const frameHeight = state.frameStyle === 'hidden' ? 0 : (state.frameStyle === 'minimal' ? 28 : 40);
    if (frameHeight > 0) {
      // Shift video down to make room for frame
      const totalHeight = videoHeight + frameHeight;
      if (totalHeight > height - padding * 2) {
        const scale = (height - padding * 2) / totalHeight;
        videoHeight *= scale;
        videoWidth *= scale;
      }
      videoX = (width - videoWidth) / 2;
      videoY = (height - videoHeight - frameHeight) / 2 + frameHeight;
    }

    // Set up MediaRecorder for canvas
    const stream = canvas.captureStream(30);

    const mimeType = format === 'mp4' && MediaRecorder.isTypeSupported('video/mp4')
      ? 'video/mp4'
      : 'video/webm;codecs=vp9';

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: quality * 10000000
    });

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const exportPromise = new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `demozar-export-${Date.now()}.${format}`;
        a.click();

        elements.loadingOverlay.classList.add('hidden');
        URL.revokeObjectURL(url);
        resolve();
      };
    });

    // Calculate total edited duration for progress
    const totalEditedDuration = getEditedDuration();
    let processedDuration = 0;

    // Helper to draw a frame
    function drawFrame() {
      // Clear canvas
      ctx.clearRect(0, 0, width, height);

      // Draw background
      if (state.backgroundType === 'hidden') {
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, width, height);
      } else if (state.backgroundType === 'color') {
        ctx.fillStyle = state.background;
        ctx.fillRect(0, 0, width, height);
      } else if (state.backgroundType === 'gradient') {
        // Parse gradient - try to extract colors
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        // Default gradient if parsing fails
        gradient.addColorStop(0, '#667eea');
        gradient.addColorStop(1, '#764ba2');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      } else {
        // Image background - fallback to gradient since we can't easily load images here
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#667eea');
        gradient.addColorStop(1, '#764ba2');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      }

      // Draw shadow behind frame if enabled
      if (state.frameShadow) {
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
        ctx.shadowBlur = 40;
        ctx.shadowOffsetY = 15;
        ctx.fillStyle = '#1a1a1d';

        const frameY = videoY - frameHeight;
        const radius = 12;

        ctx.beginPath();
        ctx.roundRect(videoX, frameY, videoWidth, videoHeight + frameHeight, radius);
        ctx.fill();
        ctx.restore();
      }

      // Draw browser frame if not hidden
      if (state.frameStyle !== 'hidden') {
        const frameY = videoY - frameHeight;
        const radius = 12;

        // Frame background (dark for minimal, light for default)
        ctx.fillStyle = state.frameStyle === 'minimal' ? '#28282a' : '#f5f5f7';

        ctx.beginPath();
        ctx.roundRect(videoX, frameY, videoWidth, frameHeight, [radius, radius, 0, 0]);
        ctx.fill();

        // Traffic light dots
        const dotY = frameY + frameHeight / 2;
        const dotRadius = state.frameStyle === 'minimal' ? 4.5 : 6;
        const dotSpacing = state.frameStyle === 'minimal' ? 16 : 20;
        const dotStartX = videoX + 16;

        ctx.fillStyle = '#ff5f57';
        ctx.beginPath();
        ctx.arc(dotStartX, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#febc2e';
        ctx.beginPath();
        ctx.arc(dotStartX + dotSpacing, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#28c840';
        ctx.beginPath();
        ctx.arc(dotStartX + dotSpacing * 2, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fill();

        // URL bar for minimal frame
        if (state.frameStyle === 'minimal') {
          const urlBarWidth = Math.min(180, videoWidth * 0.3);
          const urlBarHeight = 16;
          const urlBarX = videoX + (videoWidth - urlBarWidth) / 2;
          const urlBarY = frameY + (frameHeight - urlBarHeight) / 2;

          ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
          ctx.beginPath();
          ctx.roundRect(urlBarX, urlBarY, urlBarWidth, urlBarHeight, 4);
          ctx.fill();

          ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('demozar.com', urlBarX + urlBarWidth / 2, urlBarY + urlBarHeight / 2);
        }
      }

      // Draw video frame with crop
      ctx.drawImage(
        video,
        0, srcY, video.videoWidth, srcHeight,  // Source: cropped area
        videoX, videoY, videoWidth, videoHeight // Destination
      );

      // Draw border if enabled
      if (state.frameBorder) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        const frameY = videoY - frameHeight;
        ctx.beginPath();
        ctx.roundRect(videoX, frameY, videoWidth, videoHeight + frameHeight, 12);
        ctx.stroke();
      }
    }

    // Process each clip sequentially
    recorder.start();

    for (let clipIndex = 0; clipIndex < activeClips.length; clipIndex++) {
      const clip = activeClips[clipIndex];
      const clipDuration = (clip.end - clip.start) / clip.speed;

      // Seek to clip start
      video.currentTime = clip.start;
      await new Promise(resolve => {
        video.onseeked = resolve;
      });

      // Play this clip at its speed
      video.playbackRate = clip.speed;

      // Process this clip's frames
      await new Promise((resolveClip) => {
        let lastFrameTime = performance.now();
        const targetFrameInterval = 1000 / 30; // 30fps

        const processClipFrames = () => {
          // Check if we've reached the end of this clip
          if (video.currentTime >= clip.end || video.ended) {
            video.pause();
            processedDuration += clipDuration;
            resolveClip();
            return;
          }

          const now = performance.now();
          const elapsed = now - lastFrameTime;

          if (elapsed >= targetFrameInterval) {
            lastFrameTime = now - (elapsed % targetFrameInterval);
            drawFrame();

            // Update progress
            const clipProgress = (video.currentTime - clip.start) / (clip.end - clip.start);
            const overallProgress = (processedDuration + clipProgress * clipDuration) / totalEditedDuration;
            elements.loadingProgressBar.style.width = `${Math.min(100, overallProgress * 100)}%`;
          }

          requestAnimationFrame(processClipFrames);
        };

        video.play().then(() => {
          processClipFrames();
        });
      });
    }

    // All clips processed, stop recording
    recorder.stop();
    await exportPromise;

  } catch (error) {
    console.error('Export error:', error);
    elements.loadingOverlay.classList.add('hidden');
    alert('Export failed: ' + error.message);
  }
}

// Handle window resize for time markers
window.addEventListener('resize', () => {
  if (isFinite(state.duration)) {
    renderTimeMarkers();
  }
});

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
