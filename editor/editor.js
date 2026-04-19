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
  // Zoom segments - each has { id, start, end, position, fixedX, fixedY, depth }
  zoomSegments: [],
  selectedZoomId: null,
  // Recorded cursor data from recording session - array of {time, x, y}
  cursorData: [],
  // Current cursor position for zoom (from recorded data or manual)
  cursorX: 0.5,
  cursorY: 0.5,
  // Smoothed cursor position (for smooth following)
  smoothCursorX: 0.5,
  smoothCursorY: 0.5,
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

// Generate unique ID for zoom segments
function generateZoomId() {
  return 'zoom_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Create a new zoom segment at current playhead position
function createZoomSegment() {
  const currentTime = elements.videoPlayer.currentTime;
  const duration = state.duration;

  // Default zoom duration: 2 seconds or remaining time
  const zoomDuration = Math.min(2, duration - currentTime);

  if (zoomDuration <= 0) return null;

  const zoom = {
    id: generateZoomId(),
    start: currentTime,
    end: currentTime + zoomDuration,
    position: 'follow', // 'follow' or 'fixed'
    fixedX: 0.5, // Center X (0-1) for fixed position
    fixedY: 0.5, // Center Y (0-1) for fixed position
    depth: 1.5,  // Zoom level (1.5 = 150%)
    easing: 'smooth' // 'smooth' or 'instant'
  };

  state.zoomSegments.push(zoom);
  state.selectedZoomId = zoom.id;
  state.selectedClipId = null; // Deselect any clip

  renderZoomSegments();
  updateZoomControls();

  return zoom;
}

// Get zoom segment by ID
function getZoomById(id) {
  return state.zoomSegments.find(z => z.id === id);
}

// Get active zoom at a given time
function getZoomAtTime(time) {
  return state.zoomSegments.find(z => time >= z.start && time < z.end);
}

// Get recorded cursor position at a given time (interpolated)
function getCursorAtTime(time) {
  const data = state.cursorData;
  if (!data || data.length === 0) {
    return { x: 0.5, y: 0.5 }; // Default to center if no data
  }

  // Find the two data points surrounding the requested time
  let before = null;
  let after = null;

  for (let i = 0; i < data.length; i++) {
    if (data[i].time <= time) {
      before = data[i];
    }
    if (data[i].time >= time && !after) {
      after = data[i];
      break;
    }
  }

  // Edge cases
  if (!before && !after) return { x: 0.5, y: 0.5 };
  if (!before) return { x: after.x, y: after.y };
  if (!after) return { x: before.x, y: before.y };
  if (before.time === after.time) return { x: before.x, y: before.y };

  // Linear interpolation between the two points
  const t = (time - before.time) / (after.time - before.time);
  return {
    x: before.x + (after.x - before.x) * t,
    y: before.y + (after.y - before.y) * t
  };
}

// Render zoom segments on timeline
function renderZoomSegments() {
  const container = elements.timelineZooms;
  if (!container) return;

  container.innerHTML = '';

  if (!isFinite(state.duration) || state.duration <= 0) return;

  const zoomIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>`;

  state.zoomSegments.forEach(zoom => {
    const zoomEl = document.createElement('div');
    zoomEl.className = 'zoom-segment' + (zoom.id === state.selectedZoomId ? ' selected' : '');
    zoomEl.dataset.zoomId = zoom.id;

    // Calculate position and width based on video duration
    const leftPercent = (zoom.start / state.duration) * 100;
    const widthPercent = ((zoom.end - zoom.start) / state.duration) * 100;

    zoomEl.style.left = `${leftPercent}%`;
    zoomEl.style.width = `${widthPercent}%`;

    // Content shows depth
    zoomEl.innerHTML = `
      <div class="zoom-handle left"></div>
      <div class="zoom-segment-content">
        ${zoomIcon}
        <span>${zoom.depth}x</span>
      </div>
      <div class="zoom-handle right"></div>
    `;

    // Click to select
    zoomEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('zoom-handle')) return;
      selectZoom(zoom.id);
    });

    // Drag handles for resizing
    const leftHandle = zoomEl.querySelector('.zoom-handle.left');
    const rightHandle = zoomEl.querySelector('.zoom-handle.right');

    leftHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startZoomResize(zoom.id, 'left', e);
    });

    rightHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startZoomResize(zoom.id, 'right', e);
    });

    // Drag segment to move
    zoomEl.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('zoom-handle')) return;
      startZoomDrag(zoom.id, e);
    });

    container.appendChild(zoomEl);
  });
}

// Select a zoom segment
function selectZoom(zoomId) {
  state.selectedZoomId = zoomId;
  state.selectedClipId = null; // Deselect any clip

  // Update visual selection
  document.querySelectorAll('.zoom-segment').forEach(el => {
    el.classList.toggle('selected', el.dataset.zoomId === zoomId);
  });
  document.querySelectorAll('.timeline-clip').forEach(el => {
    el.classList.remove('selected');
  });

  updateZoomControls();
  switchToZoomPanel();
}

// Update zoom controls panel based on selected zoom
function updateZoomControls() {
  const zoom = getZoomById(state.selectedZoomId);

  if (!zoom) {
    elements.zoomEmptyState.classList.remove('hidden');
    elements.zoomControls.classList.add('hidden');
    return;
  }

  elements.zoomEmptyState.classList.add('hidden');
  elements.zoomControls.classList.remove('hidden');

  // Update position toggle
  elements.positionFollow.classList.toggle('active', zoom.position === 'follow');
  elements.positionFixed.classList.toggle('active', zoom.position === 'fixed');

  // Show/hide fixed position picker
  elements.fixedPositionPicker.classList.toggle('active', zoom.position === 'fixed');

  // Update position grid selection
  document.querySelectorAll('.position-cell').forEach(cell => {
    const x = parseFloat(cell.dataset.x);
    const y = parseFloat(cell.dataset.y);
    cell.classList.toggle('active', x === zoom.fixedX && y === zoom.fixedY);
  });

  // Update depth slider
  elements.zoomDepth.value = zoom.depth;
  elements.depthValue.textContent = `${zoom.depth}x`;
}

// Switch sidebar to zoom panel
function switchToZoomPanel() {
  // Activate zoom tab
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === 'zoom');
  });

  // Show zoom panel, hide settings
  elements.zoomPanel.classList.add('active');
  elements.settingsPanel.style.display = 'none';
}

// Switch sidebar to settings panel
function switchToSettingsPanel() {
  // Activate settings tab
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === 'settings');
  });

  // Show settings panel, hide zoom
  elements.zoomPanel.classList.remove('active');
  elements.settingsPanel.style.display = '';
}

// Delete selected zoom segment
function deleteSelectedZoom() {
  if (!state.selectedZoomId) return;

  state.zoomSegments = state.zoomSegments.filter(z => z.id !== state.selectedZoomId);
  state.selectedZoomId = null;

  renderZoomSegments();
  updateZoomControls();
}

// Start dragging a zoom segment
function startZoomDrag(zoomId, e) {
  const zoom = getZoomById(zoomId);
  if (!zoom) return;

  selectZoom(zoomId);

  const container = elements.timelineZooms;
  const rect = container.getBoundingClientRect();
  const startX = e.clientX;
  const startLeft = zoom.start;
  const zoomDuration = zoom.end - zoom.start;

  const handleDrag = (e) => {
    const deltaX = e.clientX - startX;
    const deltaTime = (deltaX / rect.width) * state.duration;

    let newStart = startLeft + deltaTime;
    let newEnd = newStart + zoomDuration;

    // Clamp to video bounds
    if (newStart < 0) {
      newStart = 0;
      newEnd = zoomDuration;
    }
    if (newEnd > state.duration) {
      newEnd = state.duration;
      newStart = newEnd - zoomDuration;
    }

    zoom.start = newStart;
    zoom.end = newEnd;

    renderZoomSegments();
  };

  const stopDrag = () => {
    document.removeEventListener('mousemove', handleDrag);
    document.removeEventListener('mouseup', stopDrag);
  };

  document.addEventListener('mousemove', handleDrag);
  document.addEventListener('mouseup', stopDrag);
}

// Start resizing a zoom segment
function startZoomResize(zoomId, handle, e) {
  const zoom = getZoomById(zoomId);
  if (!zoom) return;

  selectZoom(zoomId);

  const container = elements.timelineZooms;
  const rect = container.getBoundingClientRect();
  const startX = e.clientX;
  const startValue = handle === 'left' ? zoom.start : zoom.end;

  const handleResize = (e) => {
    const deltaX = e.clientX - startX;
    const deltaTime = (deltaX / rect.width) * state.duration;
    const minDuration = 0.2; // Minimum 0.2 seconds

    if (handle === 'left') {
      let newStart = startValue + deltaTime;
      newStart = Math.max(0, Math.min(zoom.end - minDuration, newStart));
      zoom.start = newStart;
    } else {
      let newEnd = startValue + deltaTime;
      newEnd = Math.min(state.duration, Math.max(zoom.start + minDuration, newEnd));
      zoom.end = newEnd;
    }

    renderZoomSegments();
  };

  const stopResize = () => {
    document.removeEventListener('mousemove', handleResize);
    document.removeEventListener('mouseup', stopResize);
  };

  document.addEventListener('mousemove', handleResize);
  document.addEventListener('mouseup', stopResize);
}

// DOM Elements
const elements = {
  videoPlayer: document.getElementById('videoPlayer'),
  videoContainer: document.getElementById('videoContainer'),
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
  timelineZooms: document.getElementById('timelineZooms'),
  addZoomBtn: document.getElementById('addZoomBtn'),
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
  exportFormat: document.getElementById('exportFormat'),
  // Zoom controls
  zoomPanel: document.getElementById('zoomPanel'),
  zoomEmptyState: document.getElementById('zoomEmptyState'),
  zoomControls: document.getElementById('zoomControls'),
  positionFollow: document.getElementById('positionFollow'),
  positionFixed: document.getElementById('positionFixed'),
  fixedPositionPicker: document.getElementById('fixedPositionPicker'),
  zoomDepth: document.getElementById('zoomDepth'),
  depthValue: document.getElementById('depthValue'),
  deleteZoomBtn: document.getElementById('deleteZoomBtn'),
  settingsPanel: document.getElementById('settingsPanel')
};

// Initialize
async function init() {
  await loadVideo();
  bindEvents();
  updatePreview();
  startZoomAnimation(); // Start zoom follow animation
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

        // Load cursor data if available
        if (data.cursorData && data.cursorData.length > 0) {
          state.cursorData = data.cursorData;
          console.log('[Editor] Loaded', state.cursorData.length, 'cursor positions');
        } else {
          console.log('[Editor] No cursor data available for this recording');
        }

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
  const clipsWrapper = document.querySelector('.timeline-clips-wrapper');
  const trackLabel = document.querySelector('.timeline-track-row .track-label');
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

  // Account for track label width and wrapper padding
  const trackLabelWidth = trackLabel ? trackLabel.offsetWidth : 0;
  const wrapperPadding = 16;
  const effectiveWidth = clipsWrapper ? (clipsWrapper.offsetWidth - wrapperPadding * 2) : (ruler.offsetWidth - 32);
  const startOffset = trackLabelWidth + wrapperPadding;

  for (let i = 0; i < numMarkers; i++) {
    const time = i * interval;
    if (time > duration) break;

    const marker = document.createElement('span');
    marker.className = 'time-marker';
    marker.textContent = formatTime(time);
    marker.style.left = `${startOffset + (time / duration) * effectiveWidth}px`;
    ruler.appendChild(marker);
  }
}

// Select a clip
function selectClip(clipId) {
  state.selectedClipId = clipId;
  state.selectedZoomId = null; // Deselect any zoom

  document.querySelectorAll('.timeline-clip').forEach(el => {
    el.classList.toggle('selected', el.dataset.clipId === clipId);
  });
  document.querySelectorAll('.zoom-segment').forEach(el => {
    el.classList.remove('selected');
  });

  updateDeleteButton();
  updateSpeedControl();
  updateZoomControls();
  switchToSettingsPanel();
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

  // Clear zoom segments
  state.zoomSegments = [];
  state.selectedZoomId = null;

  elements.videoPlayer.currentTime = 0;
  renderClips();
  renderZoomSegments();
  updateZoomControls();
  applyZoomEffect();
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
    const request = indexedDB.open('DaddyRecorder', 1);

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
    applyZoomEffect();
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
  }

  // Zoom track wrapper - make it clickable for seeking
  const zoomWrapper = document.querySelector('.timeline-zoom-wrapper');
  if (zoomWrapper) {
    zoomWrapper.addEventListener('click', (e) => {
      if (e.target.closest('.zoom-segment')) return;
      seekFromZoomTrack(e);
    });
    zoomWrapper.addEventListener('mousedown', (e) => {
      if (e.target.closest('.zoom-segment')) return;
      startZoomTrackDrag(e);
    });
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

  // Zoom controls
  elements.addZoomBtn.addEventListener('click', () => {
    const zoom = createZoomSegment();
    if (zoom) {
      renderZoomSegments();
      switchToZoomPanel();
    }
  });

  elements.positionFollow.addEventListener('click', () => {
    const zoom = getZoomById(state.selectedZoomId);
    if (zoom) {
      zoom.position = 'follow';
      updateZoomControls();
      renderZoomSegments();
    }
  });

  elements.positionFixed.addEventListener('click', () => {
    const zoom = getZoomById(state.selectedZoomId);
    if (zoom) {
      zoom.position = 'fixed';
      updateZoomControls();
      renderZoomSegments();
    }
  });

  // Fixed position grid
  document.querySelectorAll('.position-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const zoom = getZoomById(state.selectedZoomId);
      if (zoom) {
        zoom.fixedX = parseFloat(cell.dataset.x);
        zoom.fixedY = parseFloat(cell.dataset.y);
        updateZoomControls();
      }
    });
  });

  // Depth slider
  elements.zoomDepth.addEventListener('input', (e) => {
    const zoom = getZoomById(state.selectedZoomId);
    if (zoom) {
      zoom.depth = parseFloat(e.target.value);
      elements.depthValue.textContent = `${zoom.depth}x`;
      renderZoomSegments();
    }
  });

  // Delete zoom
  elements.deleteZoomBtn.addEventListener('click', deleteSelectedZoom);

  // Sidebar tabs
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabType = tab.dataset.tab;
      if (tabType === 'settings') {
        switchToSettingsPanel();
      } else if (tabType === 'zoom') {
        switchToZoomPanel();
      }
      // Other tabs can be added later
    });
  });

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
    applyZoomEffect();
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

  // Update timeline playhead - positioned within timeline track
  const clipsWrapper = document.querySelector('.timeline-clips-wrapper');
  const trackLabel = document.querySelector('.timeline-track-row .track-label');
  if (clipsWrapper && elements.timelinePlayhead) {
    const trackLabelWidth = trackLabel ? trackLabel.offsetWidth : 0;
    const wrapperPadding = 16; // padding inside clips wrapper
    const wrapperWidth = clipsWrapper.offsetWidth - (wrapperPadding * 2);
    const playheadLeft = trackLabelWidth + wrapperPadding + (percent / 100) * wrapperWidth;
    elements.timelinePlayhead.style.left = `${playheadLeft}px`;
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
    applyZoomEffect();
  }
}

// Timeline seeking from zoom track
function seekFromZoomTrack(e) {
  const zoomWrapper = document.querySelector('.timeline-zoom-wrapper');
  if (!zoomWrapper || !isFinite(state.duration) || state.duration <= 0) {
    return;
  }

  const rect = zoomWrapper.getBoundingClientRect();
  const padding = 16;
  const effectiveWidth = rect.width - (padding * 2);
  let clickX = e.clientX - rect.left - padding;
  let percent = clickX / effectiveWidth;
  percent = Math.max(0, Math.min(1, percent));

  const newTime = percent * state.duration;
  if (!isNaN(newTime) && isFinite(newTime)) {
    elements.videoPlayer.currentTime = newTime;
    updateProgress();
    updatePlaybackRate();
    applyZoomEffect();
  }
}

function startTimelineDrag(e) {
  // Don't start drag if clicking on a clip
  if (e.target.closest('.timeline-clip')) return;

  e.preventDefault();
  isDragging = true;

  // Immediately update playhead position visually
  updatePlayheadFromMouse(e);
  seekFromTimeline(e);

  const handleDrag = (e) => {
    e.preventDefault();
    if (isDragging) {
      // Update playhead visually first (instant feedback)
      updatePlayheadFromMouse(e);
      // Then seek video (may have slight delay)
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

function startZoomTrackDrag(e) {
  e.preventDefault();
  isDragging = true;

  updatePlayheadFromMouseZoomTrack(e);
  seekFromZoomTrack(e);

  const handleDrag = (e) => {
    e.preventDefault();
    if (isDragging) {
      updatePlayheadFromMouseZoomTrack(e);
      seekFromZoomTrack(e);
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

// Instantly update playhead visual position from mouse (no waiting for video seek)
function updatePlayheadFromMouse(e) {
  const clipsWrapper = document.querySelector('.timeline-clips-wrapper');
  const trackLabel = document.querySelector('.timeline-track-row .track-label');
  if (!clipsWrapper || !elements.timelinePlayhead) return;

  const rect = clipsWrapper.getBoundingClientRect();
  const padding = 16;
  const effectiveWidth = rect.width - (padding * 2);
  let clickX = e.clientX - rect.left - padding;
  let percent = Math.max(0, Math.min(1, clickX / effectiveWidth));

  const trackLabelWidth = trackLabel ? trackLabel.offsetWidth : 0;
  const playheadLeft = trackLabelWidth + padding + percent * effectiveWidth;
  elements.timelinePlayhead.style.left = `${playheadLeft}px`;
}

function updatePlayheadFromMouseZoomTrack(e) {
  const zoomWrapper = document.querySelector('.timeline-zoom-wrapper');
  const trackLabel = document.querySelector('.timeline-track-row .track-label');
  if (!zoomWrapper || !elements.timelinePlayhead) return;

  const rect = zoomWrapper.getBoundingClientRect();
  const padding = 16;
  const effectiveWidth = rect.width - (padding * 2);
  let clickX = e.clientX - rect.left - padding;
  let percent = Math.max(0, Math.min(1, clickX / effectiveWidth));

  const trackLabelWidth = trackLabel ? trackLabel.offsetWidth : 0;
  const playheadLeft = trackLabelWidth + padding + percent * effectiveWidth;
  elements.timelinePlayhead.style.left = `${playheadLeft}px`;
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

// Apply zoom effect during playback (called from animation loop)
// This function is now a no-op - zoom is handled by the animation loop
function applyZoomEffect() {
  // Zoom is handled by startZoomAnimation/applyZoomEffectSmooth
  // This function is kept for compatibility but does nothing
  // The animation loop provides smoother cursor following
}

// Cubic ease in/out function
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Animation loop for smooth zoom following
let zoomAnimationId = null;

function startZoomAnimation() {
  if (zoomAnimationId) return;

  function animate() {
    const currentTime = elements.videoPlayer?.currentTime || 0;

    // Get cursor position from recorded data at current video time
    const cursorPos = getCursorAtTime(currentTime);
    state.cursorX = cursorPos.x;
    state.cursorY = cursorPos.y;

    // Smooth interpolation for fluid camera movement
    const smoothingFactor = 0.15;
    state.smoothCursorX += (state.cursorX - state.smoothCursorX) * smoothingFactor;
    state.smoothCursorY += (state.cursorY - state.smoothCursorY) * smoothingFactor;

    // Apply zoom if there's an active zoom segment
    const zoom = getZoomAtTime(currentTime);

    if (zoom) {
      applyZoomEffectSmooth(zoom);
      elements.previewFrame.classList.add('zoom-active');
    } else {
      // Reset transform when no zoom
      elements.videoPlayer.style.transform = 'none';
      elements.videoPlayer.style.transformOrigin = '0 0';
      elements.previewFrame.classList.remove('zoom-active');
    }

    zoomAnimationId = requestAnimationFrame(animate);
  }

  zoomAnimationId = requestAnimationFrame(animate);
}

function stopZoomAnimation() {
  if (zoomAnimationId) {
    cancelAnimationFrame(zoomAnimationId);
    zoomAnimationId = null;
  }
}

// Smooth version of applyZoomEffect for animation loop
function applyZoomEffectSmooth(zoom) {
  const currentTime = elements.videoPlayer.currentTime;
  const zoomDuration = zoom.end - zoom.start;
  const progress = Math.max(0, Math.min(1, (currentTime - zoom.start) / zoomDuration));

  // Ease in and out
  const easeDuration = 0.15;
  let scale = zoom.depth;

  if (progress < easeDuration) {
    const easeProgress = progress / easeDuration;
    scale = 1 + (zoom.depth - 1) * easeInOutCubic(easeProgress);
  } else if (progress > (1 - easeDuration)) {
    const easeProgress = (1 - progress) / easeDuration;
    scale = 1 + (zoom.depth - 1) * easeInOutCubic(easeProgress);
  }

  let cursorX, cursorY;

  if (zoom.position === 'fixed') {
    cursorX = zoom.fixedX;
    cursorY = zoom.fixedY;
  } else {
    // Follow cursor: use smoothed recorded cursor position
    cursorX = state.smoothCursorX;
    cursorY = state.smoothCursorY;
  }

  // SMART ZOOM: Keep cursor centered in the viewport
  //
  // The approach:
  // 1. Set transform-origin to top-left (0, 0)
  // 2. Scale the video by S
  // 3. Translate so the cursor position ends up at viewport center
  //
  // After scale(S) with origin at (0,0):
  // - Video spans from (0,0) to (S*100%, S*100%)
  // - Cursor at (cx, cy) moves to (cx*S*100%, cy*S*100%)
  //
  // To center cursor at (50%, 50%):
  // translateX = 50% - cx*S*100% = (0.5 - cx*S) * 100%
  // translateY = 50% - cy*S*100% = (0.5 - cy*S) * 100%
  //
  // Clamping to prevent showing outside video:
  // - Left edge: translateX + 0 >= 0 is always true for our range
  // - Right edge: translateX + S*100% >= 100% → translateX >= (1-S)*100%
  // - So translateX must be >= (1-S)*100% and <= 0

  let translateX = (0.5 - cursorX * scale) * 100;
  let translateY = (0.5 - cursorY * scale) * 100;

  // Clamp to keep video filling the viewport
  const minTranslate = (1 - scale) * 100; // e.g., -50% for scale 1.5
  const maxTranslate = 0;

  translateX = Math.max(minTranslate, Math.min(maxTranslate, translateX));
  translateY = Math.max(minTranslate, Math.min(maxTranslate, translateY));

  // Apply transform: scale from top-left, then translate
  elements.videoPlayer.style.transformOrigin = '0 0';
  elements.videoPlayer.style.transform = `translate(${translateX.toFixed(2)}%, ${translateY.toFixed(2)}%) scale(${scale.toFixed(3)})`;
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
  // macOS menu bar + tab bar is ~4.5% from top
  // macOS dock is ~7% from bottom
  const menuBarPercent = 4.5;
  const dockPercent = 7;

  const cropTop = state.hideMenuBar ? menuBarPercent : 0;
  const cropBottom = state.hideDock ? dockPercent : 0;

  if (cropTop > 0 || cropBottom > 0) {
    // Use clipPath with rounded corners for clean look
    elements.videoPlayer.style.clipPath = `inset(${cropTop}% 0 ${cropBottom}% 0 round 12px)`;
  } else {
    elements.videoPlayer.style.clipPath = 'none';
  }

  // Apply any active zoom effect (don't reset transform here, let applyZoomEffect handle it)
  applyZoomEffect();

  // Frame style
  // Default: No custom frame, video shows its own browser chrome
  // Minimal: Show custom DaddyRecorder frame
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

    // Apply crop if enabled (matching preview values)
    // macOS menu bar + tab bar ~4.5% from top, dock ~7% from bottom
    const cropTop = state.hideMenuBar ? 0.045 : 0;
    const cropBottom = state.hideDock ? 0.07 : 0;
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
        a.download = `daddyrecorder-export-${Date.now()}.${format}`;
        a.click();

        elements.loadingOverlay.classList.add('hidden');
        URL.revokeObjectURL(url);
        resolve();
      };
    });

    // Calculate total edited duration for progress
    const totalEditedDuration = getEditedDuration();
    let processedDuration = 0;

    // Helper to draw a frame with zoom effect
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
          ctx.fillText('daddyrecorder.com', urlBarX + urlBarWidth / 2, urlBarY + urlBarHeight / 2);
        }
      }

      // Calculate zoom parameters for current frame
      const currentVideoTime = video.currentTime;
      const activeZoom = getZoomAtTime(currentVideoTime);

      let zoomScale = 1;
      let zoomOriginX = 0.5;
      let zoomOriginY = 0.5;

      if (activeZoom) {
        const zoomDuration = activeZoom.end - activeZoom.start;
        const progress = (currentVideoTime - activeZoom.start) / zoomDuration;

        // Ease in and out
        const easeDuration = 0.15;
        if (progress < easeDuration) {
          const easeProgress = progress / easeDuration;
          zoomScale = 1 + (activeZoom.depth - 1) * easeInOutCubic(easeProgress);
        } else if (progress > (1 - easeDuration)) {
          const easeProgress = (1 - progress) / easeDuration;
          zoomScale = 1 + (activeZoom.depth - 1) * easeInOutCubic(easeProgress);
        } else {
          zoomScale = activeZoom.depth;
        }

        if (activeZoom.position === 'fixed') {
          zoomOriginX = activeZoom.fixedX;
          zoomOriginY = activeZoom.fixedY;
        } else {
          // Follow mode: use recorded cursor position at current video time
          const cursorPos = getCursorAtTime(currentVideoTime);
          zoomOriginX = cursorPos.x;
          zoomOriginY = cursorPos.y;
        }
      }

      // Draw video frame with crop, zoom, and rounded corners
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(videoX, videoY, videoWidth, videoHeight, 12);
      ctx.clip();

      if (zoomScale !== 1) {
        // Apply zoom: calculate zoomed source rectangle
        const zoomedSrcWidth = video.videoWidth / zoomScale;
        const zoomedSrcHeight = srcHeight / zoomScale;

        // Center the cursor in the visible area (cursor always at center of zoom)
        // Calculate offset to center the cursor position
        let offsetX = zoomOriginX * video.videoWidth - zoomedSrcWidth / 2;
        let offsetY = zoomOriginY * srcHeight - zoomedSrcHeight / 2;

        // Clamp to video bounds so we don't show outside the video
        const maxOffsetX = video.videoWidth - zoomedSrcWidth;
        const maxOffsetY = srcHeight - zoomedSrcHeight;
        offsetX = Math.max(0, Math.min(maxOffsetX, offsetX));
        offsetY = Math.max(0, Math.min(maxOffsetY, offsetY));

        ctx.drawImage(
          video,
          offsetX, srcY + offsetY, zoomedSrcWidth, zoomedSrcHeight,  // Source: zoomed area
          videoX, videoY, videoWidth, videoHeight // Destination
        );
      } else {
        // No zoom, draw normally
        ctx.drawImage(
          video,
          0, srcY, video.videoWidth, srcHeight,  // Source: cropped area
          videoX, videoY, videoWidth, videoHeight // Destination
        );
      }
      ctx.restore();

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
