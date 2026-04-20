// Editor State
const state = {
  videoBlob: null,
  videoUrl: null,
  // Webcam bubble overlay (null when the recording had no camera stream)
  webcamBlob: null,
  webcamUrl: null,
  cameraSettings: null,  // { enabled, anchor, sizePct, opacity, mirror, shape }
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  // Clips array - each clip has { id, start, end, speed }
  clips: [],
  selectedClipId: null,
  // Zoom segments - each has { id, start, end, position, fixedX, fixedY, depth }
  zoomSegments: [],
  selectedZoomId: null,
  // Camera hide segments — intervals where the webcam bubble is HIDDEN.
  // Bubble is visible by default; adding a segment hides it for that range.
  cameraHideSegments: [],
  selectedCameraHideId: null,
  // Recorded cursor data from recording session - array of {time, x, y}
  cursorData: [],
  // Recorded click events - array of {time, x, y}. Used by Auto-zoom on
  // clicks to generate a zoom segment at each click moment.
  clickData: [],
  // Current cursor position for zoom (from recorded data or manual)
  cursorX: 0.5,
  cursorY: 0.5,
  // Smoothed cursor position (for smooth following)
  smoothCursorX: 0.5,
  smoothCursorY: 0.5,
  // Cursor follow velocity — needed by SmoothDamp to maintain momentum
  // between frames. Stored as objects because smoothDamp mutates .v.
  smoothCursorVX: { v: 0 },
  smoothCursorVY: { v: 0 },
  // Zoom motion controls (apply to every zoom segment). The presets
  // below are just quick-picks that set these values — the user can
  // fine-tune either slider to override a preset.
  zoomRampSec: 0.55,          // 0.2–1.5 s — how long the in/out ramp takes
  zoomSmoothTime: 0.10,       // 0.03–0.30 s — SmoothDamp follow responsiveness
  zoomCurve: 'easeInOutCubic',// 'easeInOutCubic' | 'easeOutBack' (bounce)
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

// Auto-generate zoom segments from recorded click events.
//
// Approach: each "burst" of clicks becomes ONE follow-mode zoom segment.
// The camera zooms in at the first click of a burst and follows the
// recorded cursor for the rest — so when the user clicks 10 times across
// the screen in 2 seconds, the camera smoothly tracks between them
// instead of popping to the arithmetic mean. Consecutive bursts within
// `bridgeGap` seconds are merged into a single long zoom so the camera
// doesn't ramp out and back in between click sequences.
function generateZoomsFromClicks({
  trailSec = 2.2,       // how long the zoom stays in after the last click in a burst
  leadIn = 0.35,        // how long before the first click the zoom starts ramping in
  burstGap = 2.5,       // clicks more than this apart start a new burst
  bridgeGap = 1.4,      // adjacent bursts closer than this merge into one zoom
  depth = 1.35,         // slightly gentler than manual zooms so auto feels natural
  minDuration = 0.8,    // skip degenerate segments
  minClicksPerBurst = 2 // Cursorful's rule — single isolated clicks don't zoom
} = {}) {
  const clicks = (state.clickData || []).slice().sort((a, b) => a.time - b.time);
  if (clicks.length === 0) return 0;

  // Pass 1: group clicks into bursts. Track click count so we can filter
  // out lone clicks — those are the main driver of motion sickness in
  // auto-zoom UX (Cursorful suppresses them explicitly).
  const bursts = [];
  let cur = { first: clicks[0].time, last: clicks[0].time, count: 1 };
  for (let i = 1; i < clicks.length; i++) {
    if (clicks[i].time - cur.last <= burstGap) {
      cur.last = clicks[i].time;
      cur.count++;
    } else {
      bursts.push(cur);
      cur = { first: clicks[i].time, last: clicks[i].time, count: 1 };
    }
  }
  bursts.push(cur);

  // Drop bursts that don't meet the multi-click threshold. A single
  // stray click isn't a "demo moment" worth zooming on.
  const zoomableBursts = bursts.filter(b => b.count >= minClicksPerBurst);
  if (zoomableBursts.length === 0) return 0;

  // Pass 2: expand each burst into a tentative zoom window
  // [first - leadIn, last + trailSec], then merge adjacent windows whose
  // gap is within bridgeGap so the camera doesn't bounce.
  const duration = state.duration || (clicks[clicks.length - 1].time + trailSec);
  const windows = zoomableBursts.map(b => ({
    start: Math.max(0, b.first - leadIn),
    end:   Math.min(duration, b.last + trailSec)
  }));
  const merged = [];
  for (const w of windows) {
    if (merged.length && w.start - merged[merged.length - 1].end <= bridgeGap) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, w.end);
    } else {
      merged.push({ ...w });
    }
  }

  // Pass 3: emit zoom segments in FOLLOW mode so the camera tracks the
  // recorded cursor across rapid clicks.
  const segments = merged
    .filter(w => w.end - w.start >= minDuration)
    .map(w => ({
      id: generateZoomId(),
      start: w.start,
      end: w.end,
      position: 'follow',
      fixedX: 0.5,
      fixedY: 0.5,
      depth,
      easing: 'smooth',
      source: 'click'
    }));

  // Replace any prior click-auto zooms; leave manual zooms alone.
  state.zoomSegments = state.zoomSegments.filter(z => z.source !== 'click');
  state.zoomSegments.push(...segments);
  state.zoomSegments.sort((a, b) => a.start - b.start);
  renderZoomSegments();
  return segments.length;
}

// Camera hide segment helpers
function generateCameraHideId() {
  return 'camhide_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

function isCameraHiddenAt(time) {
  return state.cameraHideSegments.some(seg => time >= seg.start && time < seg.end);
}

function createCameraHideSegment() {
  const t = elements.videoPlayer.currentTime;
  const remaining = state.duration - t;
  if (!isFinite(remaining) || remaining <= 0.1) return null;
  const seg = {
    id: generateCameraHideId(),
    start: t,
    end: t + Math.min(2, remaining)
  };
  state.cameraHideSegments.push(seg);
  state.selectedCameraHideId = seg.id;
  renderCameraHideSegments();
  saveCameraSettings(); // persists the list too
  return seg;
}

function deleteSelectedCameraHide() {
  if (!state.selectedCameraHideId) return;
  state.cameraHideSegments = state.cameraHideSegments.filter(s => s.id !== state.selectedCameraHideId);
  state.selectedCameraHideId = null;
  renderCameraHideSegments();
  saveCameraSettings();
}

function renderCameraHideSegments() {
  const container = document.getElementById('timelineCameraHides');
  if (!container) return;
  container.innerHTML = '';
  if (!isFinite(state.duration) || state.duration <= 0) return;

  state.cameraHideSegments.forEach(seg => {
    const el = document.createElement('div');
    el.className = 'camera-hide-segment' + (seg.id === state.selectedCameraHideId ? ' selected' : '');
    const leftPct = (seg.start / state.duration) * 100;
    const widthPct = ((seg.end - seg.start) / state.duration) * 100;
    el.style.left = leftPct + '%';
    el.style.width = widthPct + '%';
    el.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
        <line x1="2" y1="2" x2="22" y2="22" stroke-width="2.5"/>
      </svg>
      <span>Camera hidden</span>
    `;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selectedCameraHideId = seg.id;
      state.selectedZoomId = null;
      state.selectedClipId = null;
      renderCameraHideSegments();
      updateDeleteButton();
    });
    container.appendChild(el);
  });
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
  state.selectedCameraHideId = null; // Deselect camera hide too

  // Update visual selection
  document.querySelectorAll('.zoom-segment').forEach(el => {
    el.classList.toggle('selected', el.dataset.zoomId === zoomId);
  });
  document.querySelectorAll('.timeline-clip').forEach(el => {
    el.classList.remove('selected');
  });

  updateZoomControls();
  updateDeleteButton();
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

  // Snapshot the current frame into the picker + position the marker.
  if (zoom.position === 'fixed') {
    renderFocusPickerFrame();
    updateFocusPickerMarker(zoom);
  }

  // Update depth slider
  elements.zoomDepth.value = zoom.depth;
  elements.depthValue.textContent = `${zoom.depth}x`;
}

// Draw the current video frame into the focus picker so the user sees
// what they're pointing at while placing the marker.
function renderFocusPickerFrame() {
  const canvas = document.getElementById('focusCanvas');
  const video = elements.videoPlayer;
  if (!canvas || !video || !video.videoWidth) return;
  const wrapper = canvas.parentElement;
  const w = Math.max(1, wrapper.clientWidth);
  const h = Math.max(1, wrapper.clientHeight);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // Cover-fit the video frame into the picker
  const videoAspect = video.videoWidth / video.videoHeight;
  const pickerAspect = w / h;
  let dx, dy, dw, dh;
  if (videoAspect > pickerAspect) {
    dh = h;
    dw = h * videoAspect;
    dx = (w - dw) / 2;
    dy = 0;
  } else {
    dw = w;
    dh = w / videoAspect;
    dx = 0;
    dy = (h - dh) / 2;
  }
  try { ctx.drawImage(video, dx, dy, dw, dh); } catch (_) {}
}

function updateFocusPickerMarker(zoom) {
  const wrapper = document.getElementById('focusCanvasWrapper');
  const marker = document.getElementById('focusMarker');
  const rect = document.getElementById('focusRect');
  if (!wrapper || !marker || !rect) return;
  const w = wrapper.clientWidth;
  const h = wrapper.clientHeight;
  const cx = zoom.fixedX * w;
  const cy = zoom.fixedY * h;
  marker.style.left = cx + 'px';
  marker.style.top = cy + 'px';
  // Zoom visible-area rectangle — width/height shrink with depth.
  const rw = w / (zoom.depth || 1);
  const rh = h / (zoom.depth || 1);
  let rx = cx - rw / 2;
  let ry = cy - rh / 2;
  // Keep rectangle inside picker (same clamping the export/preview do)
  rx = Math.max(0, Math.min(w - rw, rx));
  ry = Math.max(0, Math.min(h - rh, ry));
  rect.style.left = rx + 'px';
  rect.style.top = ry + 'px';
  rect.style.width = rw + 'px';
  rect.style.height = rh + 'px';
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

  // Show settings panel, hide zoom + camera
  elements.zoomPanel.classList.remove('active');
  if (elements.cameraPanel) elements.cameraPanel.classList.remove('active');
  elements.settingsPanel.style.display = '';
}

// Switch sidebar to camera panel
function switchToCameraPanel() {
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === 'camera');
  });
  elements.zoomPanel.classList.remove('active');
  if (elements.cameraPanel) elements.cameraPanel.classList.add('active');
  elements.settingsPanel.style.display = 'none';
  updateCameraPanel();
}

// Reflect state.cameraSettings into the panel's controls; also toggle
// empty-state when there is no webcam on this recording.
function updateCameraPanel() {
  if (!elements.cameraPanel) return;
  const hasCam = !!state.webcamUrl;
  if (elements.cameraEmptyState) {
    elements.cameraEmptyState.classList.toggle('hidden', hasCam);
  }
  if (elements.cameraControls) {
    elements.cameraControls.classList.toggle('hidden', !hasCam);
  }
  if (!hasCam || !state.cameraSettings) return;

  const s = state.cameraSettings;
  if (elements.cameraShow) elements.cameraShow.checked = !!s.enabled;
  if (elements.cameraSize) elements.cameraSize.value = String(s.sizePct ?? 22);
  if (elements.cameraSizeValue) elements.cameraSizeValue.textContent = (s.sizePct ?? 22) + '%';
  if (elements.cameraOpacity) elements.cameraOpacity.value = String(Math.round((s.opacity ?? 1) * 100));
  if (elements.cameraOpacityValue) elements.cameraOpacityValue.textContent = Math.round((s.opacity ?? 1) * 100) + '%';
  if (elements.cameraMirror) elements.cameraMirror.checked = !!s.mirror;

  document.querySelectorAll('#cameraAnchorGrid .position-cell').forEach(cell => {
    cell.classList.toggle('active', cell.dataset.anchor === s.anchor);
  });

  const r = getCornerRadiusPct(s);
  if (elements.cameraRadius) elements.cameraRadius.value = String(r);
  if (elements.cameraRadiusValue) elements.cameraRadiusValue.textContent = r + '%';
  syncRadiusPresetButtons(r);
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
  settingsPanel: document.getElementById('settingsPanel'),
  // Webcam bubble
  webcamBubble: document.getElementById('webcamBubble'),
  webcamPlayer: document.getElementById('webcamPlayer'),
  // Camera panel
  cameraPanel: document.getElementById('cameraPanel'),
  cameraEmptyState: document.getElementById('cameraEmptyState'),
  cameraControls: document.getElementById('cameraControls'),
  cameraShow: document.getElementById('cameraShow'),
  cameraAnchorGrid: document.getElementById('cameraAnchorGrid'),
  cameraSize: document.getElementById('cameraSize'),
  cameraSizeValue: document.getElementById('cameraSizeValue'),
  cameraOpacity: document.getElementById('cameraOpacity'),
  cameraOpacityValue: document.getElementById('cameraOpacityValue'),
  cameraMirror: document.getElementById('cameraMirror'),
  cameraRadius: document.getElementById('cameraRadius'),
  cameraRadiusValue: document.getElementById('cameraRadiusValue')
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

        // Click events (for Auto-zoom on clicks)
        if (Array.isArray(data.clickData)) {
          state.clickData = data.clickData;
          console.log('[Editor] Loaded', state.clickData.length, 'click events');
        }

        // Restore zoom motion config (legacy preset values migrate to
        // the new sliders).
        if (typeof data.zoomRampSec === 'number') state.zoomRampSec = data.zoomRampSec;
        if (typeof data.zoomSmoothTime === 'number') state.zoomSmoothTime = data.zoomSmoothTime;
        if (data.zoomCurve) state.zoomCurve = data.zoomCurve;
        if (data.zoomPreset && ZOOM_PRESETS[data.zoomPreset] &&
            typeof data.zoomRampSec !== 'number') {
          // Old recording with just a preset name — expand to explicit values.
          const p = ZOOM_PRESETS[data.zoomPreset];
          state.zoomRampSec = p.rampSec;
          state.zoomSmoothTime = p.smoothTime;
          state.zoomCurve = p.curve;
        }
        reflectZoomMotionUI();

        // Load webcam bubble if the recording captured one. We always
        // composite at export time — the live overlay (via Document
        // Picture-in-Picture) is in its own browser window that tab /
        // window captures don't include, so there's no double-up.
        if (data.webcamBlob) {
          state.webcamBlob = data.webcamBlob;
          state.webcamUrl = URL.createObjectURL(data.webcamBlob);
          state.cameraSettings = data.cameraSettings || {
            enabled: true,
            anchor: 'bottom-right',
            sizePct: 22,
            opacity: 1,
            mirror: true,
            cornerRadiusPct: 50
          };
          if (Array.isArray(data.cameraHideSegments)) {
            state.cameraHideSegments = data.cameraHideSegments;
          }
          console.log('[Editor] Webcam bubble loaded,', data.webcamBlob.size, 'bytes');
          attachWebcamBubble();
          renderCameraHideSegments();
        } else {
          state.cameraSettings = null;
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
  // Enabled if anything deletable is selected — a zoom segment, a
  // camera-hide segment, or (for clips) a non-last clip.
  const canDeleteClip = activeClips.length > 1 && !!state.selectedClipId;
  const canDeleteZoom = !!state.selectedZoomId;
  const canDeleteCamHide = !!state.selectedCameraHideId;
  deleteBtn.disabled = !(canDeleteClip || canDeleteZoom || canDeleteCamHide);
}

// Top-bar Delete dispatches to whatever is currently selected. Zoom and
// camera-hide segments take priority over clips — picking them is a more
// explicit intent than the default clip that's always selected.
function handleTopBarDelete() {
  if (state.selectedZoomId) {
    deleteSelectedZoom();
  } else if (state.selectedCameraHideId) {
    deleteSelectedCameraHide();
  } else {
    deleteSelectedClip();
  }
  updateDeleteButton();
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

// Corner radius as a percentage of the bubble's half-width. 0 = square,
// 50 = circle. Migrates legacy `shape` values to a radius if needed.
function getCornerRadiusPct(settings) {
  if (!settings) return 50;
  if (typeof settings.cornerRadiusPct === 'number') return settings.cornerRadiusPct;
  // Legacy migration
  switch (settings.shape) {
    case 'square':  return 0;
    case 'rounded': return 18;
    default:        return 50; // circle
  }
}

// Push current state values into the sliders + numeric readouts + the
// preset button highlight. Called on load and after a preset click.
function reflectZoomMotionUI() {
  const rampSlider = document.getElementById('zoomRampSlider');
  const smoothSlider = document.getElementById('zoomSmoothSlider');
  if (rampSlider) rampSlider.value = String(state.zoomRampSec);
  if (smoothSlider) smoothSlider.value = String(state.zoomSmoothTime);
  const rv = document.getElementById('zoomRampValue');
  const sv = document.getElementById('zoomSmoothValue');
  if (rv) rv.textContent = state.zoomRampSec.toFixed(2) + 's';
  if (sv) sv.textContent = state.zoomSmoothTime.toFixed(2) + 's';
  highlightMatchingPreset();
}

// Light up a preset button if the current values exactly match it,
// otherwise clear them (user tuned a custom value).
function highlightMatchingPreset() {
  document.querySelectorAll('[data-zoom-preset]').forEach(btn => {
    const preset = ZOOM_PRESETS[btn.dataset.zoomPreset];
    const match = preset
      && Math.abs(preset.rampSec - state.zoomRampSec) < 0.005
      && Math.abs(preset.smoothTime - state.zoomSmoothTime) < 0.005
      && preset.curve === state.zoomCurve;
    btn.classList.toggle('active', !!match);
  });
}

// Persist zoom motion config on the current 'latest' recording — lives
// alongside other edit state so the choice survives reloading the editor.
async function saveZoomMotion() {
  try {
    const db = await openDB();
    const tx = db.transaction(['recordings'], 'readwrite');
    const store = tx.objectStore('recordings');
    const getReq = store.get('latest');
    getReq.onsuccess = () => {
      const data = getReq.result;
      if (!data) return;
      data.zoomRampSec = state.zoomRampSec;
      data.zoomSmoothTime = state.zoomSmoothTime;
      data.zoomCurve = state.zoomCurve;
      store.put(data, 'latest');
    };
  } catch (e) {
    console.warn('[Editor] Could not persist zoom motion:', e);
  }
}

// Highlight the preset button whose radius matches the current value
// (or clear them all if the value is in between presets).
function syncRadiusPresetButtons(pct) {
  document.querySelectorAll('[data-radius-preset]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.radiusPreset, 10) === pct);
  });
}

// Wire up the webcam bubble overlay once a recording with webcam is loaded.
// Keeps webcamPlayer.currentTime locked to videoPlayer, mirrors play/pause,
// and paints a visual bubble whose position/size/shape tracks cameraSettings.
function attachWebcamBubble() {
  if (!state.webcamUrl || !elements.webcamPlayer || !elements.webcamBubble) return;

  const main = elements.videoPlayer;
  const cam = elements.webcamPlayer;
  cam.src = state.webcamUrl;

  // Sync time on every main-video tick + explicit events. Webcam frame drift
  // beyond ~0.15 s gets snapped rather than drifted.
  const resync = () => {
    if (!main || !cam) return;
    if (!isFinite(main.currentTime) || !isFinite(cam.duration)) return;
    const target = Math.min(main.currentTime, cam.duration || main.currentTime);
    if (Math.abs((cam.currentTime || 0) - target) > 0.15) {
      try { cam.currentTime = target; } catch (_) {}
    }
  };

  main.addEventListener('timeupdate', resync);
  main.addEventListener('seeked', resync);
  main.addEventListener('play', () => {
    resync();
    cam.play().catch(() => {});
  });
  main.addEventListener('pause', () => {
    cam.pause();
  });
  main.addEventListener('ratechange', () => {
    cam.playbackRate = main.playbackRate;
  });

  attachBubbleDragHandlers();

  updateCameraBubble();
}

// Mouse drag on the bubble body → reposition (updates customX/customY).
// Mouse drag on the resize handle → scales sizePct.
function attachBubbleDragHandlers() {
  const bubble = elements.webcamBubble;
  if (!bubble) return;
  const handle = document.getElementById('webcamResizeHandle');

  bubble.addEventListener('pointerdown', (e) => {
    if (e.target === handle || handle?.contains(e.target)) return; // resize handled below
    if (!state.cameraSettings) return;
    e.preventDefault();
    // Clicking the bubble opens its panel, matching direct-manipulation UX
    // in design tools — select an object, see its properties.
    switchToCameraPanel();
    bubble.setPointerCapture(e.pointerId);
    bubble.classList.add('dragging');

    const container = elements.videoContainer;
    const rect = container.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const offsetX = e.clientX - bubbleRect.left;
    const offsetY = e.clientY - bubbleRect.top;

    const onMove = (ev) => {
      const rawX = ev.clientX - rect.left - offsetX;
      const rawY = ev.clientY - rect.top - offsetY;
      const cw = rect.width, ch = rect.height;
      // Normalize to 0..1 (top-left corner of bubble)
      state.cameraSettings.customX = Math.max(0, Math.min(1, rawX / cw));
      state.cameraSettings.customY = Math.max(0, Math.min(1, rawY / ch));
      state.cameraSettings.anchor = null; // custom position takes over
      updateCameraBubble();
    };
    const onUp = () => {
      bubble.releasePointerCapture(e.pointerId);
      bubble.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      // Clear the 9-point picker's "active" cell since we're free-form now
      document.querySelectorAll('#cameraAnchorGrid .position-cell').forEach(c => c.classList.remove('active'));
      saveCameraSettings();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (!state.cameraSettings) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    bubble.classList.add('resizing');

    const container = elements.videoContainer;
    const cw = container.clientWidth || 1;
    const startSize = bubble.clientWidth;
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;

    const onMove = (ev) => {
      const dx = ev.clientX - startMouseX;
      const dy = ev.clientY - startMouseY;
      // Use the larger of the two diffs for proportional resize
      const delta = Math.max(dx, dy);
      const newSize = Math.max(60, Math.min(cw * 0.6, startSize + delta));
      state.cameraSettings.sizePct = Math.round((newSize / cw) * 100);
      // Keep the sidebar slider in sync
      if (elements.cameraSize) elements.cameraSize.value = String(state.cameraSettings.sizePct);
      if (elements.cameraSizeValue) elements.cameraSizeValue.textContent = state.cameraSettings.sizePct + '%';
      updateCameraBubble();
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      bubble.classList.remove('resizing');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      saveCameraSettings();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// Paint the bubble based on current state.cameraSettings. Called on load and
// whenever a sidebar control changes.
function updateCameraBubble() {
  const bubble = elements.webcamBubble;
  if (!bubble) return;

  const s = state.cameraSettings;
  if (!s || !state.webcamUrl) {
    bubble.classList.add('hidden');
    return;
  }

  if (!s.enabled) {
    bubble.classList.add('hidden');
    return;
  }

  // A "hide" segment covering the current time overrides visibility
  if (isCameraHiddenAt(elements.videoPlayer.currentTime || 0)) {
    bubble.classList.add('hidden');
    return;
  }

  bubble.classList.remove('hidden');

  // Position is normalized to the preview (.video-container). Bubble is
  // always square; the visual shape is driven by border-radius.
  const container = elements.videoContainer;
  const cw = container?.clientWidth || 0;
  const ch = container?.clientHeight || 0;
  const size = Math.round((s.sizePct / 100) * (cw || 800));

  bubble.style.width = size + 'px';
  bubble.style.height = size + 'px';
  bubble.style.opacity = String(s.opacity ?? 1);
  bubble.style.borderRadius = getCornerRadiusPct(s) + '%';

  let left, top;
  if (s.customX != null && s.customY != null) {
    // Dragged free-form: normalized 0..1 relative to container
    left = Math.round(s.customX * cw);
    top = Math.round(s.customY * ch);
  } else {
    // 9-point anchor: {top|middle|bottom}-{left|center|right}
    const margin = 16;
    left = margin; top = margin;
    const [vAnchor, hAnchor] = (s.anchor || 'bottom-right').split('-');
    if (hAnchor === 'center') left = Math.round((cw - size) / 2);
    else if (hAnchor === 'right') left = Math.max(0, cw - size - margin);
    if (vAnchor === 'middle') top = Math.round((ch - size) / 2);
    else if (vAnchor === 'bottom') top = Math.max(0, ch - size - margin);
  }

  // Clamp so the bubble stays inside the preview
  left = Math.max(0, Math.min(cw - size, left));
  top = Math.max(0, Math.min(ch - size, top));

  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';

  bubble.classList.toggle('mirror', !!s.mirror);
}

// Persist cameraSettings + cameraHideSegments on the current 'latest' recording.
async function saveCameraSettings() {
  if (!state.cameraSettings && !state.cameraHideSegments?.length) return;
  try {
    const db = await openDB();
    const tx = db.transaction(['recordings'], 'readwrite');
    const store = tx.objectStore('recordings');
    const getReq = store.get('latest');
    getReq.onsuccess = () => {
      const data = getReq.result;
      if (!data) return;
      if (state.cameraSettings) data.cameraSettings = { ...state.cameraSettings };
      data.cameraHideSegments = [...state.cameraHideSegments];
      store.put(data, 'latest');
    };
  } catch (e) {
    console.warn('[Editor] Could not persist camera settings:', e);
  }
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
  // Reposition the webcam bubble on viewport resize — it's laid out in pixels.
  window.addEventListener('resize', updateCameraBubble);

  // Play/Pause
  elements.playBtn.addEventListener('click', togglePlay);
  elements.videoPlayer.addEventListener('click', togglePlay);

  // Video events
  elements.videoPlayer.addEventListener('timeupdate', () => {
    handleClipBoundaries(); // Skip deleted sections during playback
    updateProgress();
    updatePlaybackRate();
    applyZoomEffect();
    updateCameraBubble(); // respect camera-hide segments
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

  // Playhead itself - make it directly draggable
  if (elements.timelinePlayhead) {
    elements.timelinePlayhead.addEventListener('mousedown', startPlayheadDrag);
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
  elements.deleteClipBtn.addEventListener('click', handleTopBarDelete);
  elements.resetTimelineBtn.addEventListener('click', resetTimeline);

  // Zoom controls
  elements.addZoomBtn.addEventListener('click', () => {
    const zoom = createZoomSegment();
    if (zoom) {
      renderZoomSegments();
      switchToZoomPanel();
    }
  });

  const autoZoomBtn = document.getElementById('autoZoomClicksBtn');
  if (autoZoomBtn) {
    autoZoomBtn.addEventListener('click', () => {
      const n = generateZoomsFromClicks();
      if (n === 0) {
        alert('No recorded clicks found in this recording.');
      }
    });
  }

  // Zoom feel preset buttons — shortcuts that set both sliders at once.
  document.querySelectorAll('[data-zoom-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = ZOOM_PRESETS[btn.dataset.zoomPreset];
      if (!preset) return;
      state.zoomRampSec = preset.rampSec;
      state.zoomSmoothTime = preset.smoothTime;
      state.zoomCurve = preset.curve;
      reflectZoomMotionUI();
      saveZoomMotion();
    });
  });

  const rampSlider = document.getElementById('zoomRampSlider');
  if (rampSlider) {
    rampSlider.addEventListener('input', (e) => {
      state.zoomRampSec = parseFloat(e.target.value);
      document.getElementById('zoomRampValue').textContent = state.zoomRampSec.toFixed(2) + 's';
      highlightMatchingPreset();
      saveZoomMotion();
    });
  }
  const smoothSlider = document.getElementById('zoomSmoothSlider');
  if (smoothSlider) {
    smoothSlider.addEventListener('input', (e) => {
      state.zoomSmoothTime = parseFloat(e.target.value);
      document.getElementById('zoomSmoothValue').textContent = state.zoomSmoothTime.toFixed(2) + 's';
      highlightMatchingPreset();
      saveZoomMotion();
    });
  }

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

  // Free-placement focus-point picker — click or drag anywhere inside
  // the mini preview to set exactly where the zoom is centered.
  const picker = document.getElementById('focusCanvasWrapper');
  if (picker) {
    const commitFromEvent = (ev) => {
      const zoom = getZoomById(state.selectedZoomId);
      if (!zoom) return;
      const rect = picker.getBoundingClientRect();
      let x = (ev.clientX - rect.left) / rect.width;
      let y = (ev.clientY - rect.top) / rect.height;
      x = Math.max(0, Math.min(1, x));
      y = Math.max(0, Math.min(1, y));
      zoom.fixedX = x;
      zoom.fixedY = y;
      updateFocusPickerMarker(zoom);
    };
    picker.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      picker.setPointerCapture(e.pointerId);
      commitFromEvent(e);
      const onMove = (ev) => commitFromEvent(ev);
      const onUp = () => {
        picker.releasePointerCapture(e.pointerId);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  // Depth slider
  elements.zoomDepth.addEventListener('input', (e) => {
    const zoom = getZoomById(state.selectedZoomId);
    if (zoom) {
      zoom.depth = parseFloat(e.target.value);
      elements.depthValue.textContent = `${zoom.depth}x`;
      renderZoomSegments();
      if (zoom.position === 'fixed') updateFocusPickerMarker(zoom);
    }
  });

  // Keep focus picker in sync when the viewport resizes
  window.addEventListener('resize', () => {
    const zoom = getZoomById(state.selectedZoomId);
    if (zoom && zoom.position === 'fixed') {
      renderFocusPickerFrame();
      updateFocusPickerMarker(zoom);
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
      } else if (tabType === 'camera') {
        switchToCameraPanel();
      }
      // Other tabs can be added later
    });
  });

  // Camera panel controls
  if (elements.cameraShow) {
    elements.cameraShow.addEventListener('change', (e) => {
      if (!state.cameraSettings) return;
      state.cameraSettings.enabled = !!e.target.checked;
      updateCameraBubble();
      saveCameraSettings();
    });
  }
  if (elements.cameraAnchorGrid) {
    elements.cameraAnchorGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.position-cell');
      if (!cell || !state.cameraSettings) return;
      state.cameraSettings.anchor = cell.dataset.anchor;
      // Snapping back to a named anchor discards any prior drag position.
      state.cameraSettings.customX = null;
      state.cameraSettings.customY = null;
      document.querySelectorAll('#cameraAnchorGrid .position-cell')
        .forEach(c => c.classList.toggle('active', c === cell));
      updateCameraBubble();
      saveCameraSettings();
    });
  }
  if (elements.cameraSize) {
    elements.cameraSize.addEventListener('input', (e) => {
      if (!state.cameraSettings) return;
      state.cameraSettings.sizePct = parseInt(e.target.value, 10);
      if (elements.cameraSizeValue) elements.cameraSizeValue.textContent = e.target.value + '%';
      updateCameraBubble();
      saveCameraSettings();
    });
  }
  if (elements.cameraOpacity) {
    elements.cameraOpacity.addEventListener('input', (e) => {
      if (!state.cameraSettings) return;
      state.cameraSettings.opacity = parseInt(e.target.value, 10) / 100;
      if (elements.cameraOpacityValue) elements.cameraOpacityValue.textContent = e.target.value + '%';
      updateCameraBubble();
      saveCameraSettings();
    });
  }
  if (elements.cameraMirror) {
    elements.cameraMirror.addEventListener('change', (e) => {
      if (!state.cameraSettings) return;
      state.cameraSettings.mirror = !!e.target.checked;
      updateCameraBubble();
      saveCameraSettings();
    });
  }
  if (elements.cameraRadius) {
    elements.cameraRadius.addEventListener('input', (e) => {
      if (!state.cameraSettings) return;
      const pct = parseInt(e.target.value, 10);
      state.cameraSettings.cornerRadiusPct = pct;
      state.cameraSettings.shape = null;
      if (elements.cameraRadiusValue) elements.cameraRadiusValue.textContent = pct + '%';
      syncRadiusPresetButtons(pct);
      updateCameraBubble();
      saveCameraSettings();
    });
  }

  document.querySelectorAll('[data-radius-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.cameraSettings) return;
      const pct = parseInt(btn.dataset.radiusPreset, 10);
      state.cameraSettings.cornerRadiusPct = pct;
      state.cameraSettings.shape = null;
      if (elements.cameraRadius) elements.cameraRadius.value = String(pct);
      if (elements.cameraRadiusValue) elements.cameraRadiusValue.textContent = pct + '%';
      syncRadiusPresetButtons(pct);
      updateCameraBubble();
      saveCameraSettings();
    });
  });

  const addHide = document.getElementById('cameraAddHide');
  if (addHide) addHide.addEventListener('click', createCameraHideSegment);
  const delHide = document.getElementById('cameraDeleteHide');
  if (delHide) delHide.addEventListener('click', deleteSelectedCameraHide);

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
      handleTopBarDelete();
    }
  });

}

// Animation frame ID for smooth playhead
let playheadAnimationId = null;

// Smooth playhead animation loop
function animatePlayhead() {
  if (state.isPlaying) {
    handleClipBoundaries(); // Check and skip deleted sections
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
    // Before playing, ensure we're in an active clip
    const activeClips = state.clips.filter(c => !c.deleted);
    if (activeClips.length === 0) return; // No clips to play

    const currentTime = elements.videoPlayer.currentTime;
    const inActiveClip = activeClips.some(clip =>
      currentTime >= clip.start && currentTime < clip.end
    );

    if (!inActiveClip) {
      // Find the appropriate clip to start from
      const nextClip = activeClips.find(clip => clip.start > currentTime);
      if (nextClip) {
        elements.videoPlayer.currentTime = nextClip.start;
      } else {
        // Start from first clip
        elements.videoPlayer.currentTime = activeClips[0].start;
      }
    }

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

// Update progress bar - uses edited time (accounts for deleted clips)
function updateProgress() {
  const videoTime = elements.videoPlayer.currentTime || 0;
  const editedDuration = getEditedDuration();
  const duration = isFinite(editedDuration) && editedDuration > 0 ? editedDuration : 1;

  // Convert video time to edited timeline position
  const editedTime = videoTimeToEditedTime(videoTime);
  const percent = Math.min(100, Math.max(0, (editedTime / duration) * 100));

  elements.progressFilled.style.width = `${percent}%`;
  elements.progressHandle.style.left = `${percent}%`;
  elements.currentTime.textContent = formatTime(editedTime);

  // Update timeline playhead - but NOT while dragging (let mouse control it for instant feedback)
  if (!isDragging) {
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
}

// Seek video from progress bar - uses edited time
function seekVideo(e) {
  const editedDuration = getEditedDuration();
  if (!isFinite(editedDuration) || editedDuration <= 0) {
    return;
  }
  const rect = elements.progressBar.getBoundingClientRect();
  let percent = (e.clientX - rect.left) / rect.width;
  percent = Math.max(0, Math.min(1, percent)); // Clamp between 0 and 1

  // Convert edited timeline position to actual video time
  const editedTime = percent * editedDuration;
  const videoTime = editedTimeToVideoTime(editedTime);

  if (!isNaN(videoTime) && isFinite(videoTime)) {
    elements.videoPlayer.currentTime = videoTime;
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

// Timeline seeking - uses edited time (accounts for deleted clips)
function seekFromTimeline(e) {
  const clipsWrapper = document.querySelector('.timeline-clips-wrapper');
  const editedDuration = getEditedDuration();
  if (!clipsWrapper || !isFinite(editedDuration) || editedDuration <= 0) {
    return;
  }

  const rect = clipsWrapper.getBoundingClientRect();
  const padding = 16; // Account for wrapper padding
  const effectiveWidth = rect.width - (padding * 2);
  let clickX = e.clientX - rect.left - padding;
  let percent = clickX / effectiveWidth;
  percent = Math.max(0, Math.min(1, percent));

  // Convert edited timeline position to actual video time
  const editedTime = percent * editedDuration;
  const videoTime = editedTimeToVideoTime(editedTime);

  if (!isNaN(videoTime) && isFinite(videoTime)) {
    elements.videoPlayer.currentTime = videoTime;
    updateProgress();
    updatePlaybackRate();
    applyZoomEffect();
  }
}

// Timeline seeking from zoom track - uses edited time
function seekFromZoomTrack(e) {
  const zoomWrapper = document.querySelector('.timeline-zoom-wrapper');
  const editedDuration = getEditedDuration();
  if (!zoomWrapper || !isFinite(editedDuration) || editedDuration <= 0) {
    return;
  }

  const rect = zoomWrapper.getBoundingClientRect();
  const padding = 16;
  const effectiveWidth = rect.width - (padding * 2);
  let clickX = e.clientX - rect.left - padding;
  let percent = clickX / effectiveWidth;
  percent = Math.max(0, Math.min(1, percent));

  // Convert edited timeline position to actual video time
  const editedTime = percent * editedDuration;
  const videoTime = editedTimeToVideoTime(editedTime);

  if (!isNaN(videoTime) && isFinite(videoTime)) {
    elements.videoPlayer.currentTime = videoTime;
    updateProgress();
    updatePlaybackRate();
    applyZoomEffect();
  }
}

function startTimelineDrag(e) {
  // Don't start drag if clicking on a clip or playhead
  if (e.target.closest('.timeline-clip') || e.target.closest('.timeline-playhead')) return;

  e.preventDefault();
  isDragging = true;

  // Add dragging class to playhead for visual feedback
  elements.timelinePlayhead.classList.add('dragging');

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
    elements.timelinePlayhead.classList.remove('dragging');
    document.removeEventListener('mousemove', handleDrag);
    document.removeEventListener('mouseup', stopDrag);
  };

  document.addEventListener('mousemove', handleDrag);
  document.addEventListener('mouseup', stopDrag);
}

// Start dragging from the playhead itself
function startPlayheadDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  isDragging = true;

  // Add dragging class for visual feedback
  elements.timelinePlayhead.classList.add('dragging');

  const handleDrag = (e) => {
    e.preventDefault();
    if (isDragging) {
      // Update playhead visually first (instant feedback)
      updatePlayheadFromMouse(e);
      // Then seek video
      seekFromTimeline(e);
    }
  };

  const stopDrag = () => {
    isDragging = false;
    elements.timelinePlayhead.classList.remove('dragging');
    document.removeEventListener('mousemove', handleDrag);
    document.removeEventListener('mouseup', stopDrag);
  };

  document.addEventListener('mousemove', handleDrag);
  document.addEventListener('mouseup', stopDrag);
}

function startZoomTrackDrag(e) {
  e.preventDefault();
  isDragging = true;

  // Add dragging class to playhead for visual feedback
  elements.timelinePlayhead.classList.add('dragging');

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
    elements.timelinePlayhead.classList.remove('dragging');
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

// Back-out (overshoot past 1 then settle) — gives the "Bounce" preset
// its slight kick when zooming in.
function easeOutBack(t, overshoot = 1.70158) {
  const c1 = overshoot;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// Zoom feel presets. Borrows OBS-Smooth-Zoom's tuples (see research
// notes): Snappy / Smooth / Bounce. `smoothTime` maps to Unity's
// SmoothDamp "approximately how long to reach target" parameter — lower
// = snappier cursor follow, higher = looser / more cinematic.
const ZOOM_PRESETS = {
  snappy: { rampSec: 0.30, smoothTime: 0.05, curve: 'easeInOutCubic' },
  smooth: { rampSec: 0.55, smoothTime: 0.10, curve: 'easeInOutCubic' },
  bounce: { rampSec: 0.60, smoothTime: 0.12, curve: 'easeOutBack'    },
};

// Returns the live motion config — either the user's custom tuned values
// or the defaults from whichever preset they last clicked.
function getZoomPreset() {
  return {
    rampSec: state.zoomRampSec,
    smoothTime: state.zoomSmoothTime,
    curve: state.zoomCurve,
  };
}

function applyEase(t, curveName) {
  if (curveName === 'easeOutBack') {
    // Only overshoot on the way IN. The way OUT uses the symmetric cubic
    // so we don't fling the camera on the way out too.
    return easeOutBack(t);
  }
  return easeInOutCubic(t);
}

// Fixed-duration ramp into / out of a zoom segment. Returns a 0..1
// rampProgress representing how "zoomed-in" we should be. Decoupling ramp
// time from segment length fixes the old behavior where short zooms
// popped abruptly and long zooms ramped forever.
function computeZoomRamp(time, zoom) {
  const { rampSec, curve } = getZoomPreset();
  const segLen = zoom.end - zoom.start;
  // Cap each ramp at a third of the segment so short zooms still get
  // symmetric in/out.
  const ramp = Math.min(rampSec, segLen / 3);
  const elapsed = time - zoom.start;
  const remaining = zoom.end - time;
  let t = 1;
  let isRampingOut = false;
  if (elapsed < ramp) {
    t = elapsed / ramp;
  } else if (remaining < ramp) {
    t = remaining / ramp;
    isRampingOut = true;
  }
  t = Math.max(0, Math.min(1, t));
  // "Bounce" preset: overshoot only on ramp-in (otherwise we'd fling the
  // camera at the end of the zoom, which looks cheap).
  return applyEase(t, isRampingOut ? 'easeInOutCubic' : curve);
}

// Unity-style SmoothDamp — critically damped spring via exponential
// decay approximation. velocityRef is an object { v: number } we mutate
// in place so we can track velocity across rAF frames per axis.
//
// Gives us a spring that settles without overshoot, in roughly
// `smoothTime` seconds. This is what Screen Studio and every serious
// auto-zoom tool uses for cursor follow — the old linear lerp produced
// velocity discontinuities that read as "jittery" to the eye.
function smoothDamp(current, target, velocityRef, smoothTime, deltaTime, maxSpeed = Infinity) {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * deltaTime;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const originalTo = target;

  // Clamp change to maxSpeed * smoothTime
  const maxChange = maxSpeed * smoothTime;
  change = Math.max(-maxChange, Math.min(maxChange, change));
  const adjustedTarget = current - change;

  let temp = (velocityRef.v + omega * change) * deltaTime;
  velocityRef.v = (velocityRef.v - omega * temp) * exp;

  let output = adjustedTarget + (change + temp) * exp;

  // If we overshot the original target (e.g. target moving away from us),
  // snap to it to avoid oscillation.
  if ((originalTo - current > 0) === (output > originalTo)) {
    output = originalTo;
    velocityRef.v = (output - originalTo) / deltaTime;
  }
  return output;
}

// Animation loop for smooth zoom following
let zoomAnimationId = null;

let lastAnimateTs = 0;

function startZoomAnimation() {
  if (zoomAnimationId) return;

  function animate(now) {
    const currentTime = elements.videoPlayer?.currentTime || 0;

    // Time elapsed since the last rAF tick — feeds SmoothDamp.
    let dt = lastAnimateTs ? (now - lastAnimateTs) / 1000 : 1 / 60;
    if (dt > 0.1) dt = 0.1;  // cap to avoid a huge step after a tab resume
    lastAnimateTs = now;

    // Target cursor position from recorded data at current video time
    const cursorPos = getCursorAtTime(currentTime);
    state.cursorX = cursorPos.x;
    state.cursorY = cursorPos.y;

    // Critically-damped spring (Unity SmoothDamp) — produces the same
    // "cinema operator following a subject" feel as Screen Studio /
    // Screenize, and settles without overshoot.
    const { smoothTime } = getZoomPreset();
    state.smoothCursorX = smoothDamp(state.smoothCursorX, state.cursorX, state.smoothCursorVX, smoothTime, dt);
    state.smoothCursorY = smoothDamp(state.smoothCursorY, state.cursorY, state.smoothCursorVY, smoothTime, dt);

    // Apply zoom if there's an active zoom segment
    const zoom = getZoomAtTime(currentTime);

    if (zoom) {
      applyZoomEffectSmooth(zoom);
      elements.previewFrame.classList.add('zoom-active');
    } else {
      // Reset transform + blur when no zoom
      elements.videoPlayer.style.transform = 'none';
      elements.videoPlayer.style.transformOrigin = '0 0';
      elements.videoPlayer.style.filter = '';
      elements.previewFrame.classList.remove('zoom-active');
    }

    zoomAnimationId = requestAnimationFrame(animate);
  }

  lastAnimateTs = 0;
  zoomAnimationId = requestAnimationFrame(animate);
}

function stopZoomAnimation() {
  if (zoomAnimationId) {
    cancelAnimationFrame(zoomAnimationId);
    zoomAnimationId = null;
  }
}

// Motion-blur amount (in px) for a given ramp value. Peaks in the middle
// of the ramp and vanishes at rest (ramp = 0 or 1). Screen Studio ships
// motion blur on zoom by default — it's half of why their zooms feel
// cinematic instead of lurching.
const ZOOM_BLUR_PEAK_PX = 2.5;
function zoomMotionBlurPx(ramp) {
  // Parabola: 0 at endpoints, peak at 0.5. Multiplied to hit PEAK at 0.5.
  const t = Math.max(0, Math.min(1, ramp));
  return (t * (1 - t)) * 4 * ZOOM_BLUR_PEAK_PX;
}

// Smooth version of applyZoomEffect for animation loop
function applyZoomEffectSmooth(zoom) {
  const currentTime = elements.videoPlayer.currentTime;
  // Fixed-time ramp (see computeZoomRamp) so both 1.5 s and 10 s zooms
  // feel equally cinematic instead of popping or dragging.
  const ramp = computeZoomRamp(currentTime, zoom);
  const scale = 1 + (zoom.depth - 1) * ramp;

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

  // Motion blur during the in/out ramp — vanishes at steady zoom.
  const blurPx = zoomMotionBlurPx(ramp);
  elements.videoPlayer.style.filter = blurPx > 0.05 ? `blur(${blurPx.toFixed(2)}px)` : '';
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

// Convert edited timeline position to raw video time
// editedTime is the position on the timeline (0 to getEditedDuration())
// Returns the actual video time to seek to
function editedTimeToVideoTime(editedTime) {
  const activeClips = state.clips.filter(c => !c.deleted);
  let accumulatedEditedTime = 0;

  for (const clip of activeClips) {
    const clipEditedDuration = (clip.end - clip.start) / clip.speed;

    if (accumulatedEditedTime + clipEditedDuration > editedTime) {
      // The target time is within this clip
      const timeIntoClip = (editedTime - accumulatedEditedTime) * clip.speed;
      return clip.start + timeIntoClip;
    }

    accumulatedEditedTime += clipEditedDuration;
  }

  // If we're past all clips, return end of last clip
  const lastClip = activeClips[activeClips.length - 1];
  return lastClip ? lastClip.end : 0;
}

// Convert raw video time to edited timeline position
// videoTime is the actual video playback time
// Returns the position on the edited timeline
function videoTimeToEditedTime(videoTime) {
  const activeClips = state.clips.filter(c => !c.deleted);
  let editedTime = 0;

  for (const clip of activeClips) {
    if (videoTime < clip.start) {
      // Video time is before this clip - return current edited time
      return editedTime;
    }

    if (videoTime >= clip.start && videoTime < clip.end) {
      // Video time is within this clip
      const timeIntoClip = videoTime - clip.start;
      return editedTime + (timeIntoClip / clip.speed);
    }

    // Video time is past this clip, add its full edited duration
    editedTime += (clip.end - clip.start) / clip.speed;
  }

  // If past all clips, return total edited duration
  return editedTime;
}

// Check if video time is within any active clip
function isTimeInActiveClip(videoTime) {
  const activeClips = state.clips.filter(c => !c.deleted);
  return activeClips.some(clip => videoTime >= clip.start && videoTime < clip.end);
}

// Get the next active clip after a given video time
function getNextActiveClip(videoTime) {
  const activeClips = state.clips.filter(c => !c.deleted);
  return activeClips.find(clip => clip.start > videoTime);
}

// Handle clip boundaries during playback - skip deleted sections
function handleClipBoundaries() {
  if (!state.isPlaying) return;

  const currentVideoTime = elements.videoPlayer.currentTime;
  const activeClips = state.clips.filter(c => !c.deleted);

  if (activeClips.length === 0) {
    // No active clips, stop playback
    elements.videoPlayer.pause();
    state.isPlaying = false;
    updatePlayButton();
    return;
  }

  // Check if current time is within an active clip
  const currentClip = activeClips.find(clip =>
    currentVideoTime >= clip.start && currentVideoTime < clip.end
  );

  if (currentClip) {
    // We're in an active clip - check if we've reached its end
    if (currentVideoTime >= currentClip.end - 0.05) {
      // Find next active clip
      const currentIndex = activeClips.indexOf(currentClip);
      const nextClip = activeClips[currentIndex + 1];

      if (nextClip) {
        // Jump to next clip
        elements.videoPlayer.currentTime = nextClip.start;
      } else {
        // No more clips, stop at end
        elements.videoPlayer.pause();
        state.isPlaying = false;
        updatePlayButton();
        elements.videoPlayer.currentTime = currentClip.end;
      }
    }
  } else {
    // We're NOT in an active clip - find where to jump
    const nextClip = activeClips.find(clip => clip.start > currentVideoTime);

    if (nextClip) {
      // Jump to next clip
      elements.videoPlayer.currentTime = nextClip.start;
    } else {
      // Check if we're before the first clip
      const firstClip = activeClips[0];
      if (currentVideoTime < firstClip.start) {
        elements.videoPlayer.currentTime = firstClip.start;
      } else {
        // We're past all clips, stop
        elements.videoPlayer.pause();
        state.isPlaying = false;
        updatePlayButton();
      }
    }
  }
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
    // No colored wrapper — the recorded surface sits on the editor's own
    // page background. Matches what exports produce (transparent canvas).
    elements.previewBackground.style.background = 'transparent';
    elements.previewWrapper.style.background = 'transparent';
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

  // Webcam bubble overlay tracks whatever the preview is doing.
  updateCameraBubble();
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
    const target = resolutions[resolution];

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

    // Hidden background implies a truly bare export — strip the browser
    // frame header too so the file is just the video pixels.
    const hiddenExport = state.backgroundType === 'hidden';
    const frameHeight = (hiddenExport || state.frameStyle === 'hidden')
      ? 0
      : (state.frameStyle === 'minimal' ? 28 : 40);

    // Canvas size + video placement depend on whether we're showing a
    // background or cropping tight to the video.
    let width, height, videoWidth, videoHeight, videoX, videoY;

    if (state.backgroundType === 'hidden') {
      // Tight crop: canvas = video region (+ frame header if present).
      // No padding; videoX = 0, videoY = frameHeight.
      if (effectiveAspect >= 1) {
        videoWidth = Math.min(target.width, video.videoWidth);
        videoHeight = videoWidth / effectiveAspect;
      } else {
        videoHeight = Math.min(target.height, srcHeight);
        videoWidth = videoHeight * effectiveAspect;
      }
      // Round to even numbers — some encoders require it
      videoWidth = Math.round(videoWidth / 2) * 2;
      videoHeight = Math.round(videoHeight / 2) * 2;
      width = videoWidth;
      height = videoHeight + frameHeight;
      videoX = 0;
      videoY = frameHeight;
    } else {
      // Backgrounded export: pad around the video so the background shows.
      width = target.width;
      height = target.height;
      const canvasAspect = width / height;
      const padding = 60;

      if (effectiveAspect > canvasAspect) {
        videoWidth = width - padding * 2;
        videoHeight = videoWidth / effectiveAspect;
      } else {
        videoHeight = height - padding * 2;
        videoWidth = videoHeight * effectiveAspect;
      }

      videoX = (width - videoWidth) / 2;
      videoY = (height - videoHeight) / 2;

      if (frameHeight > 0) {
        const totalHeight = videoHeight + frameHeight;
        if (totalHeight > height - padding * 2) {
          const scale = (height - padding * 2) / totalHeight;
          videoHeight *= scale;
          videoWidth *= scale;
        }
        videoX = (width - videoWidth) / 2;
        videoY = (height - videoHeight - frameHeight) / 2 + frameHeight;
      }
    }

    // Create canvas now that final dimensions are known
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Set up MediaRecorder for canvas
    const stream = canvas.captureStream(30);

    // Carry the original recording's audio track(s) into the exported file so
    // mic / system audio don't get lost. captureStream() on the <video> element
    // shares its live media tracks with us.
    try {
      if (typeof video.captureStream === 'function') {
        const srcStream = video.captureStream();
        srcStream.getAudioTracks().forEach(t => stream.addTrack(t));
      }
    } catch (e) {
      console.warn('[Editor] Could not attach source audio to export stream:', e);
    }

    const mimeType = format === 'mp4' && MediaRecorder.isTypeSupported('video/mp4')
      ? 'video/mp4'
      : 'video/webm;codecs=vp9,opus';

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

    // SmoothDamp cursor state for the export — mirrors the preview so
    // the exported video's zoom follow motion matches what the user saw.
    // Step size is 1/30s since the export loop runs at 30 fps.
    const exportSmoothCursor = {
      x: 0.5, y: 0.5,
      vx: { v: 0 }, vy: { v: 0 },
      initialized: false,
    };

    // Helper to draw a frame with zoom effect
    function drawFrame() {
      // Clear canvas
      ctx.clearRect(0, 0, width, height);

      // Draw background
      if (state.backgroundType === 'hidden') {
        // Leave canvas transparent. webm output doesn't carry alpha, so
        // the exported file will render as black around the video — that's
        // the intended "no background" look.
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
      // Frame shadow is drawn behind the video/frame box. Tight-crop ("hidden"
      // background) leaves no room for a shadow and the dark fill behind the
      // video would bleed into the edges, so skip it in that mode.
      if (state.frameShadow && !hiddenExport) {
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
      if (state.frameStyle !== 'hidden' && !hiddenExport) {
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
      let zoomRamp = 0; // 0 = no zoom, 1 = fully zoomed

      if (activeZoom) {
        // Same fixed-time ramp as the preview — keeps export in sync.
        const ramp = computeZoomRamp(currentVideoTime, activeZoom);
        zoomRamp = ramp;
        zoomScale = 1 + (activeZoom.depth - 1) * ramp;

        if (activeZoom.position === 'fixed') {
          zoomOriginX = activeZoom.fixedX;
          zoomOriginY = activeZoom.fixedY;
        } else {
          // Follow mode: SmoothDamp with the same smoothTime as the
          // preview so the exported motion matches what the user saw.
          const target = getCursorAtTime(currentVideoTime);
          const { smoothTime } = getZoomPreset();
          const dt = 1 / 30;
          if (exportSmoothCursor.initialized) {
            exportSmoothCursor.x = smoothDamp(exportSmoothCursor.x, target.x, exportSmoothCursor.vx, smoothTime, dt);
            exportSmoothCursor.y = smoothDamp(exportSmoothCursor.y, target.y, exportSmoothCursor.vy, smoothTime, dt);
          } else {
            exportSmoothCursor.x = target.x;
            exportSmoothCursor.y = target.y;
            exportSmoothCursor.vx.v = 0;
            exportSmoothCursor.vy.v = 0;
            exportSmoothCursor.initialized = true;
          }
          zoomOriginX = exportSmoothCursor.x;
          zoomOriginY = exportSmoothCursor.y;
        }
      } else {
        // Reset smoothing between zoom segments so a new zoom starts
        // from the cursor's actual position, not the leftover smoothed
        // value from the previous segment.
        exportSmoothCursor.initialized = false;
      }

      // Draw video frame with crop, zoom, and rounded corners
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(videoX, videoY, videoWidth, videoHeight, 12);
      ctx.clip();

      // Motion blur during the zoom in/out ramps (matches preview).
      const exportBlurPx = zoomMotionBlurPx(zoomRamp);
      if (exportBlurPx > 0.05) {
        ctx.filter = `blur(${exportBlurPx.toFixed(2)}px)`;
      }

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

      // Webcam bubble overlay — drawn AFTER the video so it sits on top,
      // but BEFORE the border so the bubble doesn't clip the corner stroke.
      drawWebcamBubble(videoX, videoY, videoWidth, videoHeight);

      // Draw border if enabled (but not in tight-crop mode — border would
      // hug the canvas edges and get clipped).
      if (state.frameBorder && !hiddenExport) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        const frameY = videoY - frameHeight;
        ctx.beginPath();
        ctx.roundRect(videoX, frameY, videoWidth, videoHeight + frameHeight, 12);
        ctx.stroke();
      }
    }

    // Composite the webcam bubble into the export canvas.
    function drawWebcamBubble(vx, vy, vw, vh) {
      const s = state.cameraSettings;
      if (!s || !s.enabled) return;
      if (isCameraHiddenAt(video.currentTime || 0)) return;
      const cam = elements.webcamPlayer;
      // HAVE_METADATA (1) + video w/h tells us a frame is paintable. Without
      // this softer check, any mid-seek dip of readyState caused the bubble
      // to blink out for a frame.
      if (!cam || !cam.videoWidth || !cam.videoHeight) return;

      // Bubble is a square whose visual shape is driven by corner radius.
      const bubbleW = Math.round((s.sizePct / 100) * vw);
      const bubbleH = bubbleW;
      const margin = Math.round(vw * 0.02); // 2% inset

      let x, y;
      if (s.customX != null && s.customY != null) {
        // Custom drag position — normalized to the preview container in the
        // editor, applied 1:1 to the video region at export time.
        x = vx + s.customX * vw;
        y = vy + s.customY * vh;
      } else {
        // 9-point anchor
        x = vx + margin;
        y = vy + margin;
        const [vAnc, hAnc] = (s.anchor || 'bottom-right').split('-');
        if (hAnc === 'center') x = vx + (vw - bubbleW) / 2;
        else if (hAnc === 'right') x = vx + vw - bubbleW - margin;
        if (vAnc === 'middle') y = vy + (vh - bubbleH) / 2;
        else if (vAnc === 'bottom') y = vy + vh - bubbleH - margin;
      }
      // Clamp so the bubble stays inside the video region in export too
      x = Math.max(vx, Math.min(vx + vw - bubbleW, x));
      y = Math.max(vy, Math.min(vy + vh - bubbleH, y));
      // Alias for the rest of the function — mask + draw below use a
      // single "size" when the shape is square-ish (circle/rounded/square)
      // but need separate w/h for portrait/landscape.
      const size = bubbleW; // legacy reference for circle path math

      // Mask / stroke path derived from corner-radius %. A radius of 50
      // equals half the bubble width, i.e. a full circle.
      const radius = (getCornerRadiusPct(s) / 100) * bubbleW;
      const tracePath = () => {
        ctx.beginPath();
        ctx.roundRect(x, y, bubbleW, bubbleH, radius);
      };

      ctx.save();
      ctx.globalAlpha = s.opacity ?? 1;
      tracePath();
      ctx.clip();

      // Cover-fit the webcam video frame into the bubble rectangle.
      const cw = cam.videoWidth || 640;
      const ch = cam.videoHeight || 480;
      const scale = Math.max(bubbleW / cw, bubbleH / ch);
      const dw = cw * scale;
      const dh = ch * scale;
      const dx = x + (bubbleW - dw) / 2;
      const dy = y + (bubbleH - dh) / 2;

      if (s.mirror) {
        ctx.translate(x + bubbleW, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(cam, x + bubbleW - dx - dw, dy, dw, dh);
      } else {
        ctx.drawImage(cam, dx, dy, dw, dh);
      }

      ctx.restore();

      // Subtle ring around the bubble, matching the preview shadow.
      ctx.save();
      ctx.globalAlpha = (s.opacity ?? 1) * 0.7;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      tracePath();
      ctx.stroke();
      ctx.restore();
    }

    // Process each clip sequentially
    recorder.start();

    // Webcam player — the editor's preview element. During export we drive
    // it alongside the screen video so the bubble isn't stuck on a frozen
    // frame in the output.
    const webcam = elements.webcamPlayer;
    const hasWebcam = !!(webcam && webcam.src && state.cameraSettings?.enabled);
    if (hasWebcam) {
      webcam.muted = true;
      webcam.pause();
    }

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

      // Seek webcam to the same position + play at the same speed
      if (hasWebcam) {
        webcam.playbackRate = clip.speed;
        try {
          webcam.currentTime = Math.min(clip.start, (webcam.duration || clip.start));
          await new Promise((resolve) => {
            const done = () => { webcam.onseeked = null; resolve(); };
            webcam.onseeked = done;
            setTimeout(done, 500); // safety: don't block if seeked never fires
          });
        } catch (_) {}
        webcam.play().catch(() => {});
      }

      // Process this clip's frames
      await new Promise((resolveClip) => {
        let lastFrameTime = performance.now();
        const targetFrameInterval = 1000 / 30; // 30fps

        const processClipFrames = () => {
          // Check if we've reached the end of this clip
          if (video.currentTime >= clip.end || video.ended) {
            video.pause();
            if (hasWebcam) webcam.pause();
            processedDuration += clipDuration;
            resolveClip();
            return;
          }

          const now = performance.now();
          const elapsed = now - lastFrameTime;

          if (elapsed >= targetFrameInterval) {
            lastFrameTime = now - (elapsed % targetFrameInterval);

            // No mid-clip drift correction — each currentTime= assignment
            // triggers a seek, which briefly drops readyState and made the
            // bubble blink. Webcam + screen both run at clip.speed, so
            // they stay aligned for the life of the clip. We re-sync
            // between clips at each clip's start seek below.

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
