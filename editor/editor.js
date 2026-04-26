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
  // Output frame — global. Fixed pixel dims (e.g. 1920×1080). Aspect drives
  // the canvas backing buffer + the aspect-lock for every crop segment.
  output: {
    aspect: '16:9',
    height: 1080,  // 480/720/1080/1440/2160
  },
  // Crop segments — timeline-driven. Each segment overrides the camera for
  // its [start, end] time range. Outside any segment, the effective camera
  // is the default (max-fit aspect-locked rectangle, centered in source).
  // Like zoom segments: ramp-in / ramp-out via computeZoomRamp.
  // Each segment: { id, start, end, camera: {x,y,w,h}, easing? }
  cropSegments: [],
  selectedCropId: null,
  background: '../assets/abstract.webp',
  backgroundType: 'image',
  backgroundImage: '../assets/abstract.webp',
  imageBlur: 'moderate',
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
  burstGap = 5.0,       // clicks more than this apart start a new burst (was 2.5)
  bridgeGap = 2.0,      // adjacent bursts closer than this merge into one zoom
  depth = 1.35,         // slightly gentler than manual zooms so auto feels natural
  minDuration = 0.8,    // skip degenerate segments
  minClicksPerBurst = 1 // create zoom on any click (was 2)
} = {}) {
  console.log('[Editor] generateZoomsFromClicks called, clickData:', state.clickData?.length || 0);
  const clicks = (state.clickData || []).slice().sort((a, b) => a.time - b.time);
  if (clicks.length === 0) {
    console.log('[Editor] No clicks found in clickData');
    return 0;
  }
  console.log('[Editor] Processing', clicks.length, 'clicks:', clicks);

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
  console.log('[Editor] Detected bursts:', bursts);

  // Drop bursts that don't meet the multi-click threshold. A single
  // stray click isn't a "demo moment" worth zooming on.
  const zoomableBursts = bursts.filter(b => b.count >= minClicksPerBurst);
  console.log('[Editor] Zoomable bursts (>=' + minClicksPerBurst + ' clicks):', zoomableBursts);
  if (zoomableBursts.length === 0) {
    console.log('[Editor] No valid bursts — all clicks were isolated (single clicks with >' + burstGap + 's gap)');
    return 0;
  }

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

  // Show zoom panel, hide settings + camera + crop
  elements.zoomPanel.classList.add('active');
  if (elements.cameraPanel) elements.cameraPanel.classList.remove('active');
  if (elements.cropPanel) elements.cropPanel.classList.remove('active');
  elements.settingsPanel.style.display = 'none';
}

// Switch sidebar to settings panel
function switchToSettingsPanel() {
  // Activate settings tab
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === 'settings');
  });

  // Show settings panel, hide zoom + camera + crop
  elements.zoomPanel.classList.remove('active');
  if (elements.cameraPanel) elements.cameraPanel.classList.remove('active');
  if (elements.cropPanel) elements.cropPanel.classList.remove('active');
  elements.settingsPanel.style.display = '';
}

// Switch sidebar to camera panel
function switchToCameraPanel() {
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === 'camera');
  });
  elements.zoomPanel.classList.remove('active');
  if (elements.cameraPanel) elements.cameraPanel.classList.add('active');
  if (elements.cropPanel) elements.cropPanel.classList.remove('active');
  elements.settingsPanel.style.display = 'none';
  updateCameraPanel();
}

// Switch sidebar to crop panel
function switchToCropPanel() {
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === 'crop');
  });
  elements.zoomPanel.classList.remove('active');
  if (elements.cameraPanel) elements.cameraPanel.classList.remove('active');
  if (elements.cropPanel) elements.cropPanel.classList.add('active');
  elements.settingsPanel.style.display = 'none';
  // Editing mode is driven by selectedCropId — opening the panel doesn't
  // force a selection. If no segment is selected, the empty state shows.
  updateCropPanel();
}

// ========================================================================
// VIRTUAL CAMERA MODEL
// ========================================================================
//
// Output frame (state.output): a fixed canvas, e.g. 1920×1080. The exporter
// always produces video at exactly these pixels. Aspect = output.aspect.
//
// Camera (state.camera): a rectangle inside the recorded source video, in
// normalized coords [0..1]. The camera is ALWAYS aspect-locked to the output:
//   (camera.w * sourceWidth) / (camera.h * sourceHeight) === outputAspect
//
// Render: drawImage(source, camera.x*sw, camera.y*sh, camera.w*sw, camera.h*sh,
//                    0, 0, outputW, outputH).
//
// Zoom: a sub-rect inside the camera. computeSourceRect blends camera + zoom
// into one final source rectangle to draw.
// ========================================================================

const ASPECT_RATIOS = {
  '21:9': 21 / 9,
  '16:9': 16 / 9,
  '16:10': 16 / 10,
  '3:2': 3 / 2,
  '4:3': 4 / 3,
  '1:1': 1,
  '3:4': 3 / 4,
  '2:3': 2 / 3,
  '10:16': 10 / 16,
  '9:16': 9 / 16,
};

function aspectValue(name) {
  return ASPECT_RATIOS[name] || 16 / 9;
}

// Output frame dimensions (px). Width derived from aspect × height; rounded
// to even numbers (some encoders require it).
function outputDimensions() {
  const ratio = aspectValue(state.output.aspect);
  const h = state.output.height;
  const w = Math.round((h * ratio) / 2) * 2;
  return { width: w, height: Math.round(h / 2) * 2 };
}

// Largest aspect-locked rectangle that fits inside the source.
//   Returns { w, h } in normalized [0..1] source coords.
//   Reason: when output aspect differs from source aspect, the camera can't
//   fill the source — it sits as a centered strip.
function aspectFitWithin(sourceW, sourceH, outAspectRatio) {
  if (!sourceW || !sourceH) return { w: 1, h: 1 };
  const sourceAspect = sourceW / sourceH;
  if (outAspectRatio >= sourceAspect) {
    // Output is wider than source — limited by source width
    return { w: 1, h: sourceAspect / outAspectRatio };
  }
  // Output is taller — limited by source height
  return { w: outAspectRatio / sourceAspect, h: 1 };
}

// Default camera: max-fit aspect-locked rectangle, centered in source.
function defaultCamera(sourceW, sourceH, outAspectRatio) {
  const { w, h } = aspectFitWithin(sourceW, sourceH, outAspectRatio);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// Clamp + aspect-lock a candidate camera rect.
//   `dim` selects which dimension to honor when correcting aspect:
//     'w' → derive h from w, then clamp w if h overflowed
//     'h' → derive w from h, then clamp h if w overflowed
//     'either' → derive whichever yields the larger valid rect
//   Position is clamped to keep the rect fully inside [0,1].
function clampCamera(cam, sourceW, sourceH, outAspectRatio, dim = 'either') {
  if (!sourceW || !sourceH) return cam;
  const sourceAspect = sourceW / sourceH;
  // In normalized source coords, the locked ratio is (outAspect / sourceAspect).
  const ratio = outAspectRatio / sourceAspect;  // cam.w / cam.h
  const minSize = 0.05;  // min camera size (normalized) — 5% of source

  // Step 1: derive a valid (w, h) pair.
  let w = Math.max(0, Math.min(1, cam.w));
  let h = Math.max(0, Math.min(1, cam.h));

  if (dim === 'w') {
    h = w / ratio;
    if (h > 1) { h = 1; w = h * ratio; }
  } else if (dim === 'h') {
    w = h * ratio;
    if (w > 1) { w = 1; h = w / ratio; }
  } else {
    // 'either': pick the pair with the larger area that fits
    const fromW = (() => { const wh = w; const hh = wh / ratio; return hh <= 1 ? { w: wh, h: hh, area: wh * hh } : null; })();
    const fromH = (() => { const hh = h; const ww = hh * ratio; return ww <= 1 ? { w: ww, h: hh, area: ww * hh } : null; })();
    const pick = [fromW, fromH].filter(Boolean).sort((a, b) => b.area - a.area)[0];
    if (pick) { w = pick.w; h = pick.h; } else { ({ w, h } = aspectFitWithin(sourceW, sourceH, outAspectRatio)); }
  }

  // Step 2: enforce min size
  if (w < minSize || h < minSize) {
    const scale = Math.max(minSize / Math.max(w, 1e-6), minSize / Math.max(h, 1e-6));
    w *= scale;
    h *= scale;
    if (w > 1) { w = 1; h = w / ratio; }
    if (h > 1) { h = 1; w = h * ratio; }
  }

  // Step 3: clamp position so the rect is fully inside [0, 1].
  const x = Math.max(0, Math.min(1 - w, cam.x));
  const y = Math.max(0, Math.min(1 - h, cam.y));
  return { x, y, w, h };
}

// Source-frame dimensions, read from the loaded <video>. Returns {w, h} or
// {w: 1, h: 1} if metadata isn't available yet.
function sourceDimensions() {
  const v = elements.videoPlayer;
  if (v && v.videoWidth && v.videoHeight) return { w: v.videoWidth, h: v.videoHeight };
  return { w: 1, h: 1 };
}

// =====================================================================
// CROP SEGMENTS — timeline-based cameras.
// =====================================================================
//
// Crop is timeline data, not UI state. Each segment owns a camera that's
// active for [segment.start, segment.end). Outside any segment, the
// effective camera is the default (max-fit aspect-locked rect, centered
// in source). Transitions ease using the same Zoom-feel preset as zoom
// segments — same SmoothDamp + ramp machinery.
//
// Composition with zoom: getEffectiveCamera(time) returns the active crop
// camera (or default). computeSourceRect then sub-rects inside it for any
// active zoom segment.
// =====================================================================

function generateCropId() {
  return 'crop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

function getCropById(id) {
  return state.cropSegments.find(s => s.id === id);
}

// First segment whose [start, end) covers time. Sorted-order start tiebreaks.
function getActiveCropAt(time) {
  return state.cropSegments
    .filter(s => time >= s.start && time < s.end)
    .sort((a, b) => a.start - b.start)[0] || null;
}

function lerpCamera(a, b, t) {
  // Linear interp preserves aspect lock when both endpoints share the
  // same locked ratio (proven in the design notes).
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

// What camera was active at the instant just BEFORE `time`? If a previous
// segment ends exactly at this time (back-to-back) it'll be active at
// time-eps. If there's a gap (or nothing precedes), default camera applies.
function cameraNeighborBefore(time, sw, sh) {
  const seg = getActiveCropAt(time - 1e-4);
  if (seg) return seg.camera;
  return defaultCamera(sw, sh, aspectValue(state.output.aspect));
}

// Same idea for the instant just AFTER `time`. Used at the END of a segment
// to ease toward whatever comes next (gap or adjacent segment).
function cameraNeighborAfter(time, sw, sh) {
  const seg = getActiveCropAt(time + 1e-4);
  if (seg) return seg.camera;
  return defaultCamera(sw, sh, aspectValue(state.output.aspect));
}

// The camera to render at `time`. Inside a crop segment's ramp window we
// ease between `seg.camera` and the camera that's active immediately on
// the OTHER side of the boundary — so a segment with a gap before it eases
// from the default (not from a different segment ending earlier), and a
// segment ramping out eases toward what's next (default if gap, next
// segment's camera if back-to-back).
//
// Selection state does NOT change rendering — easing applies whether the
// segment is selected or not. WYSIWYG for handle drags is preserved by
// createCropSegment seeking the playhead to the segment's midpoint (where
// the ramp is at 1.0), so dragged camera changes show in the main preview.
function getEffectiveCamera(time, sw, sh) {
  const ar = aspectValue(state.output.aspect);
  const baseCam = defaultCamera(sw, sh, ar);

  const seg = getActiveCropAt(time);
  if (!seg) return baseCam;

  // Replicate computeZoomRamp's elapsed/remaining math here so we can pick
  // the correct neighbor (before vs after) based on which edge we're near.
  const { rampSec, curve } = getZoomPreset();
  const segLen = seg.end - seg.start;
  const rampDur = Math.min(rampSec, segLen / 3);
  const elapsed = time - seg.start;
  const remaining = seg.end - time;

  if (elapsed >= rampDur && remaining >= rampDur) {
    return seg.camera;  // steady state — far from both edges
  }

  let t, neighborCam, isRampingOut = false;
  if (elapsed < rampDur && (remaining >= rampDur || elapsed <= remaining)) {
    // Ramp-in side (or the in-half of a sub-ramp-duration segment)
    t = elapsed / rampDur;
    neighborCam = cameraNeighborBefore(seg.start, sw, sh);
  } else {
    // Ramp-out side
    t = remaining / rampDur;
    isRampingOut = true;
    neighborCam = cameraNeighborAfter(seg.end, sw, sh);
  }

  t = Math.max(0, Math.min(1, t));
  const eased = applyEase(t, isRampingOut ? 'easeInOutCubic' : curve);
  return lerpCamera(neighborCam, seg.camera, eased);
}

// Create a crop segment at the playhead, default 2s, default camera =
// max-fit (no actual cropping yet — user immediately drags handles to set).
function createCropSegment() {
  const t = elements.videoPlayer?.currentTime || 0;
  const remaining = (state.duration || 0) - t;
  if (!isFinite(remaining) || remaining <= 0.1) return null;
  const dur = Math.min(2, remaining);
  const { w: sw, h: sh } = sourceDimensions();
  const ar = aspectValue(state.output.aspect);
  const seg = {
    id: generateCropId(),
    start: t,
    end: t + dur,
    camera: defaultCamera(sw, sh, ar),
  };
  state.cropSegments.push(seg);
  state.cropSegments.sort((a, b) => a.start - b.start);
  state.selectedCropId = seg.id;
  state.selectedZoomId = null;
  state.selectedClipId = null;
  // Seek to mid-segment so the in/out ramp is at 1.0 — handle drags
  // immediately show in the main preview without waiting for ramp-in.
  // Outside the segment time range, ease-in/out applies on playback.
  const mid = (seg.start + seg.end) / 2;
  try { elements.videoPlayer.currentTime = mid; } catch (_) {}
  renderCropSegments();
  updateCropOverlay();
  updateCropPanel();
  return seg;
}

function selectCropSegment(id) {
  state.selectedCropId = id;
  state.selectedZoomId = null;
  state.selectedClipId = null;
  state.selectedCameraHideId = null;
  renderCropSegments();
  // Selecting a crop segment auto-switches to the Crop sidebar panel —
  // mirrors the Add Zoom → Zoom panel behavior.
  switchToCropPanel();
}

function deleteSelectedCropSegment() {
  if (!state.selectedCropId) return;
  state.cropSegments = state.cropSegments.filter(s => s.id !== state.selectedCropId);
  state.selectedCropId = null;
  renderCropSegments();
  updateCropPanel();
  updateCropOverlay();
}

// Mutate the SELECTED crop segment's camera and refresh UI.
function setSelectedCropCamera(cam) {
  const seg = getCropById(state.selectedCropId);
  if (!seg) return;
  seg.camera = cam;
  syncCameraInputsFromState();
  updateCropOverlay();
}

// When the global output aspect changes, every crop segment's camera must
// be re-clamped to the new aspect (the lock invariant must hold per-segment).
function reclampAllCropSegments() {
  const { w: sw, h: sh } = sourceDimensions();
  const ar = aspectValue(state.output.aspect);
  for (const seg of state.cropSegments) {
    // Preserve center if possible.
    const c = seg.camera;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const fit = aspectFitWithin(sw, sh, ar);
    seg.camera = clampCamera({ x: cx - fit.w / 2, y: cy - fit.h / 2, w: fit.w, h: fit.h }, sw, sh, ar, 'either');
  }
}

// Render the blocks for each crop segment on the timeline. Mirrors zoom
// segment rendering — same edge handles for resize, body-drag for move.
function renderCropSegments() {
  const container = document.getElementById('timelineCrops');
  if (!container) return;
  container.innerHTML = '';
  if (!isFinite(state.duration) || state.duration <= 0) return;

  const cropIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/>
    <path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/>
  </svg>`;

  state.cropSegments.forEach(seg => {
    const el = document.createElement('div');
    el.className = 'crop-segment' + (seg.id === state.selectedCropId ? ' selected' : '');
    el.dataset.cropId = seg.id;
    const leftPct = (seg.start / state.duration) * 100;
    const widthPct = ((seg.end - seg.start) / state.duration) * 100;
    el.style.left = leftPct + '%';
    el.style.width = widthPct + '%';
    el.innerHTML = `
      <div class="zoom-handle left"></div>
      <div class="zoom-segment-content">
        ${cropIcon}
        <span>Crop</span>
      </div>
      <div class="zoom-handle right"></div>
    `;

    // Click body to select.
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('zoom-handle')) return;
      e.stopPropagation();
      selectCropSegment(seg.id);
    });

    // Edge handles: resize.
    el.querySelector('.zoom-handle.left').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startCropResize(seg.id, 'left', e);
    });
    el.querySelector('.zoom-handle.right').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startCropResize(seg.id, 'right', e);
    });

    // Body: move.
    el.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('zoom-handle')) return;
      startCropDrag(seg.id, e);
    });

    container.appendChild(el);
  });
}

// Drag a crop segment along the timeline (preserves duration).
function startCropDrag(segId, e) {
  const seg = getCropById(segId);
  if (!seg) return;
  selectCropSegment(segId);
  const container = document.getElementById('timelineCrops');
  const rect = container.getBoundingClientRect();
  const startX = e.clientX;
  const startStart = seg.start;
  const segDur = seg.end - seg.start;

  const onMove = (ev) => {
    const dt = ((ev.clientX - startX) / rect.width) * state.duration;
    let newStart = startStart + dt;
    let newEnd = newStart + segDur;
    if (newStart < 0) { newStart = 0; newEnd = segDur; }
    if (newEnd > state.duration) { newEnd = state.duration; newStart = newEnd - segDur; }
    seg.start = newStart;
    seg.end = newEnd;
    renderCropSegments();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    state.cropSegments.sort((a, b) => a.start - b.start);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Resize a crop segment by dragging its left or right edge handle.
function startCropResize(segId, handle, e) {
  const seg = getCropById(segId);
  if (!seg) return;
  selectCropSegment(segId);
  const container = document.getElementById('timelineCrops');
  const rect = container.getBoundingClientRect();
  const startX = e.clientX;
  const startValue = handle === 'left' ? seg.start : seg.end;
  const minDur = 0.2;

  const onMove = (ev) => {
    const dt = ((ev.clientX - startX) / rect.width) * state.duration;
    if (handle === 'left') {
      let v = startValue + dt;
      v = Math.max(0, Math.min(seg.end - minDur, v));
      seg.start = v;
    } else {
      let v = startValue + dt;
      v = Math.min(state.duration, Math.max(seg.start + minDur, v));
      seg.end = v;
    }
    renderCropSegments();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Sync the X/Y/W/H number inputs from the SELECTED segment's camera.
function syncCameraInputsFromState() {
  if (!elements.cameraInputX) return;
  const seg = getCropById(state.selectedCropId);
  const c = seg ? seg.camera : { x: 0, y: 0, w: 0, h: 0 };
  elements.cameraInputX.value = (c.x * 100).toFixed(1);
  elements.cameraInputY.value = (c.y * 100).toFixed(1);
  elements.cameraInputW.value = (c.w * 100).toFixed(1);
  elements.cameraInputH.value = (c.h * 100).toFixed(1);
}

// Position the crop-rect handles over the SIDEBAR mini-preview. The mini's
// <video> fills the box (its CSS aspect-ratio is locked to source aspect),
// so overlay coords map 1:1 to source-normalized [0..1]. Visible only when
// a crop segment is selected.
function updateCropOverlay() {
  if (!elements.cropOverlay || !elements.cropRect) return;
  const editing = !!state.selectedCropId;
  elements.cropOverlay.toggleAttribute('hidden', !editing);
  if (!editing) return;

  const seg = getCropById(state.selectedCropId);
  if (!seg) return;

  // The mini-preview is the only frame we paint handles on now. Its CSS
  // aspect is locked to source aspect (see syncMiniPreview), so the overlay
  // box equals the source-display rectangle. No letterbox math needed.
  const overlayBox = elements.cropOverlay.getBoundingClientRect();
  if (!overlayBox.width || !overlayBox.height) return;

  const c = seg.camera;
  const r = elements.cropRect.style;
  r.left   = (c.x * overlayBox.width)  + 'px';
  r.top    = (c.y * overlayBox.height) + 'px';
  r.width  = (c.w * overlayBox.width)  + 'px';
  r.height = (c.h * overlayBox.height) + 'px';
}

// Set the mini-preview's CSS aspect-ratio + src so its <video> fills the
// box exactly with no letterboxing. Called once source dims are known.
function syncMiniPreview() {
  const mini = document.getElementById('cropMiniPreview');
  const miniVideo = document.getElementById('cropMiniVideo');
  if (!mini || !miniVideo) return;
  const { w: sw, h: sh } = sourceDimensions();
  if (sw && sh) {
    mini.style.aspectRatio = `${sw} / ${sh}`;
  }
  if (state.videoUrl && miniVideo.src !== state.videoUrl) {
    miniVideo.src = state.videoUrl;
  }
}

// True when the renderer should show the full source (with a darkening
// overlay outside the crop rect) instead of the cropped output. This is
// the case when the user is actively editing a crop segment.
function isCropEditingMode() {
  return !!state.selectedCropId;
}

// Test hook: lets Playwright introspect the camera resolver and inject
// segments without going through the UI race conditions. Purely additive.
if (typeof window !== 'undefined') {
  window.__editorTestProbe = {
    getEffectiveCamera: (time) => {
      const v = elements.videoPlayer;
      const sw = v?.videoWidth || 0;
      const sh = v?.videoHeight || 0;
      return getEffectiveCamera(time, sw, sh);
    },
    getCropSegments: () => state.cropSegments.map(s => ({
      id: s.id, start: s.start, end: s.end, camera: { ...s.camera },
    })),
    getOutput: () => ({ ...state.output }),
    // Replace the segment list outright — bypasses createCropSegment's seek
    // and event wiring so tests can construct deterministic timelines.
    setCropSegments: (list) => {
      state.cropSegments = list.map(s => ({
        id: s.id || ('crop_test_' + Math.random().toString(36).slice(2, 9)),
        start: s.start,
        end: s.end,
        camera: { ...s.camera },
      }));
      state.cropSegments.sort((a, b) => a.start - b.start);
      state.selectedCropId = null;
      renderCropSegments();
    },
  };
}

// Toggle empty-state vs selected-segment editor inside the Crop panel.
// Sync the camera inputs from the selected segment.
function updateCropPanel() {
  const empty = document.getElementById('cropEmptyState');
  const editor = document.getElementById('cropSegmentEditor');
  if (!empty || !editor) return;
  const seg = getCropById(state.selectedCropId);
  empty.classList.toggle('hidden', !!seg);
  editor.classList.toggle('hidden', !seg);
  if (seg) {
    syncCameraInputsFromState();
    syncMiniPreview();
    updateCropOverlay();
  }
}

// =====================================================================
// CropOverlay drag — direct manipulation handlers.
// =====================================================================
// Aspect-locked. Drag = INSTANT (no easing). All math in source-norm [0..1]
// after converting from overlay pixels via the same letterbox calculations
// updateCropOverlay uses.
// =====================================================================

function initCropOverlayDrag() {
  const overlay = elements.cropOverlay;
  const rect = elements.cropRect;
  if (!overlay || !rect) return;

  // Convert a clientX/Y into source-norm coordinates [0..1].
  // Overlay sits inside the mini-preview whose CSS aspect-ratio is locked
  // to source aspect → no letterbox math needed; box is 1:1 with source.
  function clientToSourceNorm(ev) {
    const overlayBox = overlay.getBoundingClientRect();
    if (!overlayBox.width || !overlayBox.height) return null;
    return {
      x: Math.max(0, Math.min(1, (ev.clientX - overlayBox.left) / overlayBox.width)),
      y: Math.max(0, Math.min(1, (ev.clientY - overlayBox.top)  / overlayBox.height)),
    };
  }

  let drag = null;  // { kind, startCam, startPt, segId }

  function onPointerDown(ev) {
    if (!isCropEditingMode()) return;
    const seg = getCropById(state.selectedCropId);
    if (!seg) return;
    const handleEl = ev.target.closest('.crop-handle');
    const inRect = ev.target === rect || (handleEl == null && rect.contains(ev.target));
    if (!handleEl && !inRect) return;
    ev.preventDefault();
    rect.setPointerCapture?.(ev.pointerId);
    const startPt = clientToSourceNorm(ev);
    if (!startPt) return;
    drag = {
      kind: handleEl ? handleEl.dataset.handle : 'move',
      startCam: { ...seg.camera },
      startPt,
      segId: seg.id,
    };
  }

  function onPointerMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    const pt = clientToSourceNorm(ev);
    if (!pt) return;
    const { w: sw, h: sh } = sourceDimensions();
    const ar = aspectValue(state.output.aspect);
    const dx = pt.x - drag.startPt.x;
    const dy = pt.y - drag.startPt.y;

    let cam;
    const c = drag.startCam;
    if (drag.kind === 'move') {
      cam = { x: c.x + dx, y: c.y + dy, w: c.w, h: c.h };
    } else {
      // Resize. Convention:
      //   corner: anchor at opposite corner; aspect-lock honors whichever
      //           dimension grew more (proportional to ratio).
      //   edge:   anchor at opposite edge; aspect-lock derives the other dim
      //           and recenters on the perpendicular axis (preserves center).
      let x = c.x, y = c.y, w = c.w, h = c.h;
      if (drag.kind === 'tl' || drag.kind === 'tr' || drag.kind === 'bl' || drag.kind === 'br') {
        const isLeft = drag.kind === 'tl' || drag.kind === 'bl';
        const isTop  = drag.kind === 'tl' || drag.kind === 'tr';
        const ax = isLeft ? c.x + c.w : c.x;       // anchor x (opposite corner)
        const ay = isTop  ? c.y + c.h : c.y;       // anchor y
        // Tentative new opposite corner = pointer
        const nx = pt.x, ny = pt.y;
        let nw = Math.abs(nx - ax);
        let nh = Math.abs(ny - ay);
        // Aspect-lock: pick the dim that yields the larger rect, honoring ratio.
        const camAspect = (nw * sw) / Math.max(1e-6, nh * sh);
        if (camAspect > ar) { nh = (nw * sw) / ar / sh; } else { nw = (nh * sh) * ar / sw; }
        x = isLeft ? ax - nw : ax;
        y = isTop  ? ay - nh : ay;
        w = nw; h = nh;
      } else if (drag.kind === 'l' || drag.kind === 'r') {
        // Horizontal edge: width changes, height derived, vertical center preserved.
        const ax = drag.kind === 'l' ? c.x + c.w : c.x;  // anchor x = opposite edge
        const cy = c.y + c.h / 2;
        let nw = Math.abs(pt.x - ax);
        let nh = (nw * sw) / ar / sh;
        x = drag.kind === 'l' ? ax - nw : ax;
        y = cy - nh / 2;
        w = nw; h = nh;
      } else if (drag.kind === 't' || drag.kind === 'b') {
        // Vertical edge: height changes, width derived, horizontal center preserved.
        const ay = drag.kind === 't' ? c.y + c.h : c.y;
        const cx = c.x + c.w / 2;
        let nh = Math.abs(pt.y - ay);
        let nw = (nh * sh) * ar / sw;
        x = cx - nw / 2;
        y = drag.kind === 't' ? ay - nh : ay;
        w = nw; h = nh;
      }
      cam = { x, y, w, h };
    }
    cam = clampCamera(cam, sw, sh, ar, drag.kind === 'move' ? 'either' : (
      drag.kind === 't' || drag.kind === 'b' ? 'h' : 'w'
    ));
    // Drag = instant: write directly to the selected segment.
    const seg = getCropById(drag.segId);
    if (seg) {
      seg.camera = cam;
      syncCameraInputsFromState();
      updateCropOverlay();
    }
  }

  function onPointerUp(ev) {
    if (!drag) return;
    rect.releasePointerCapture?.(ev.pointerId);
    drag = null;
  }

  rect.addEventListener('pointerdown', onPointerDown);
  // Listen on document so a fast drag past the overlay edge doesn't drop the move.
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
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
  previewCanvas: document.getElementById('previewCanvas'),
  cropOverlay: document.getElementById('cropOverlay'),
  cropRect: document.getElementById('cropRect'),
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
  imageBlur: document.getElementById('imageBlur'),
  frameShadow: document.getElementById('frameShadow'),
  frameBorder: document.getElementById('frameBorder'),
  cursorSize: document.getElementById('cursorSize'),
  smoothMovement: document.getElementById('smoothMovement'),
  cursorShadow: document.getElementById('cursorShadow'),
  clickStyle: document.getElementById('clickStyle'),
  clickForce: document.getElementById('clickForce'),
  exportResolution: document.getElementById('exportResolution'),
  exportQuality: document.getElementById('exportQuality'),
  qualityFill: document.getElementById('qualityFill'),
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
  cameraRadiusValue: document.getElementById('cameraRadiusValue'),
  // Crop panel — virtual camera controls
  cropPanel: document.getElementById('cropPanel'),
  outputAspectSelect: document.getElementById('outputAspectSelect'),
  outputHeightSelect: document.getElementById('outputHeightSelect'),
  cropOutputReadout: document.getElementById('cropOutputReadout'),
  cropResetCamera: document.getElementById('cropResetCamera'),
  cropFullscreen: document.getElementById('cropFullscreen'),
  cropHideMenuBar: document.getElementById('cropHideMenuBar'),
  cropHideDock: document.getElementById('cropHideDock'),
  cameraInputX: document.getElementById('cameraInputX'),
  cameraInputY: document.getElementById('cameraInputY'),
  cameraInputW: document.getElementById('cameraInputW'),
  cameraInputH: document.getElementById('cameraInputH')
};

// Initialize
async function init() {
  // Reflect the chosen output aspect/height into the dropdowns and canvas dims
  // BEFORE loadVideo so the canvas is the right size when the first frames arrive.
  reflectOutputUI();
  bindEvents();
  initCropOverlayDrag();
  // loadVideo kicks off async IndexedDB read; updatePreview / renderCropSegments
  // run from onloadedmetadata once source video pixel dimensions are known.
  await loadVideo();
  // Render loop runs forever, painting the canvas from the (possibly still-
  // loading) <video>. Once frames are decoded they show up on the next tick.
  startRenderLoop();
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
          // Now that source pixel dimensions are known, kick a render.
          // No global camera to init — segments are created on demand.
          updatePreview();
          renderCropSegments();
          syncMiniPreview();

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
  // Render loop will pick up the cleared state on its next tick.
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
      // raw position relative to the container (CSS pixels; container == canvas)
      const rawX = ev.clientX - rect.left - offsetX;
      const rawY = ev.clientY - rect.top - offsetY;
      // Normalize to the FULL OUTPUT canvas (0..1). The bubble is free to
      // sit in the bg padding around the recorder content.
      state.cameraSettings.customX = Math.max(0, Math.min(1, rawX / rect.width));
      state.cameraSettings.customY = Math.max(0, Math.min(1, rawY / rect.height));
      state.cameraSettings.anchor = null;
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
//
// Position is in OUTPUT space (the full canvas), so the bubble can extend
// into the background padding around the recorder content — matches what
// modern recorders (Cursorful, Screen Studio) do. customX/Y are normalized
// 0..1 of the entire output canvas.
function updateCameraBubble() {
  const bubble = elements.webcamBubble;
  if (!bubble) return;

  const s = state.cameraSettings;
  if (!s || !state.webcamUrl) { bubble.classList.add('hidden'); return; }
  if (!s.enabled) { bubble.classList.add('hidden'); return; }
  if (isCameraHiddenAt(elements.videoPlayer.currentTime || 0)) {
    bubble.classList.add('hidden'); return;
  }
  bubble.classList.remove('hidden');

  const canvas = elements.previewCanvas;
  const container = elements.videoContainer;
  if (!canvas || !container) return;

  // Canvas backing buffer is at output dims. Its CSS box fills container.
  const out = outputDimensions();
  const cssW = canvas.clientWidth || container.clientWidth || 0;
  const cssH = canvas.clientHeight || container.clientHeight || 0;
  if (!cssW || !cssH) return;

  // Bubble size scales with the full canvas width (was videoRect.w).
  const bubbleSize = Math.round((s.sizePct / 100) * cssW);
  bubble.style.width = bubbleSize + 'px';
  bubble.style.height = bubbleSize + 'px';
  bubble.style.opacity = String(s.opacity ?? 1);
  bubble.style.borderRadius = getCornerRadiusPct(s) + '%';

  let left, top;
  if (s.customX != null && s.customY != null) {
    // 0..1 of the full output canvas (CSS-pixel space here = the wrapper).
    left = s.customX * cssW;
    top  = s.customY * cssH;
  } else {
    const margin = Math.round(cssW * 0.02);
    left = margin;
    top  = margin;
    const [vAnchor, hAnchor] = (s.anchor || 'bottom-right').split('-');
    if (hAnchor === 'center') left = (cssW - bubbleSize) / 2;
    else if (hAnchor === 'right') left = cssW - bubbleSize - margin;
    if (vAnchor === 'middle') top = (cssH - bubbleSize) / 2;
    else if (vAnchor === 'bottom') top = cssH - bubbleSize - margin;
  }
  left = Math.max(0, Math.min(cssW - bubbleSize, left));
  top  = Math.max(0, Math.min(cssH - bubbleSize, top));

  bubble.style.left = Math.round(left) + 'px';
  bubble.style.top  = Math.round(top)  + 'px';
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

  // Play/Pause — click target is the previewCanvas (videoPlayer is hidden).
  elements.playBtn.addEventListener('click', togglePlay);
  elements.previewCanvas?.addEventListener('click', () => {
    // When a crop segment is being edited, clicks belong to the crop overlay
    // (drag/move detection happens there) — don't toggle play.
    if (isCropEditingMode()) return;
    togglePlay();
  });

  // Video events
  elements.videoPlayer.addEventListener('timeupdate', () => {
    handleClipBoundaries(); // Skip deleted sections during playback
    updateProgress();
    updatePlaybackRate();
    // Zoom + crop are driven by the rAF render loop now — no per-event work needed here.
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

  elements.imageBlur.addEventListener('change', (e) => {
    state.imageBlur = e.target.value;
    updatePreview();
  });

  // ----- Output settings (global, affect every crop segment + canvas) -----

  if (elements.outputAspectSelect) {
    elements.outputAspectSelect.addEventListener('change', (e) => {
      state.output.aspect = e.target.value;
      reflectOutputUI();
      // Re-clamp ALL crop segments to the new aspect (lock invariant).
      reclampAllCropSegments();
      renderCropSegments();
      updateCropOverlay();
      updatePreview();
    });
  }

  if (elements.outputHeightSelect) {
    elements.outputHeightSelect.addEventListener('change', (e) => {
      state.output.height = parseInt(e.target.value, 10) || 1080;
      reflectOutputUI();
    });
  }

  // ----- Crop segment controls (operate on the selected segment) -----
  // Each preset mutates the SELECTED segment's camera. If no segment is
  // selected, the click is a no-op (the empty-state CTA prompts the user
  // to click "Add Crop" first).

  function withSelectedSeg(fn) {
    const seg = getCropById(state.selectedCropId);
    if (!seg) return;
    const { w: sw, h: sh } = sourceDimensions();
    const ar = aspectValue(state.output.aspect);
    fn(seg, sw, sh, ar);
    syncCameraInputsFromState();
    updateCropOverlay();
  }

  if (elements.cropResetCamera) {
    elements.cropResetCamera.addEventListener('click', () => {
      withSelectedSeg((seg, sw, sh, ar) => { seg.camera = defaultCamera(sw, sh, ar); });
    });
  }

  if (elements.cropFullscreen) {
    // "Fullscreen" = literally include everything — Mac menu bar at top, dock
    // at bottom, full source pixels. To do that without letterboxing, we
    // first snap the OUTPUT aspect to the closest standard ratio matching
    // the source (e.g. 16:10 for typical Mac retina, 16:9 for Windows).
    // Then defaultCamera = {0,0,1,1} for that matched aspect.
    elements.cropFullscreen.addEventListener('click', () => {
      const seg = getCropById(state.selectedCropId);
      if (!seg) return;
      const { w: sw, h: sh } = sourceDimensions();
      if (!sw || !sh) return;

      // Find the nearest standard aspect to source.
      const sourceAspect = sw / sh;
      let bestName = state.output.aspect;
      let bestDiff = Infinity;
      for (const [name, ratio] of Object.entries(ASPECT_RATIOS)) {
        const diff = Math.abs(ratio - sourceAspect);
        if (diff < bestDiff) { bestDiff = diff; bestName = name; }
      }
      state.output.aspect = bestName;
      reflectOutputUI();
      reclampAllCropSegments();

      // Now camera = full source (defaultCamera is {0,0,1,1} for matched aspects).
      const ar = aspectValue(state.output.aspect);
      seg.camera = defaultCamera(sw, sh, ar);
      syncCameraInputsFromState();
      updateCropOverlay();
      renderCropSegments();
    });
  }

  if (elements.cropHideMenuBar) {
    elements.cropHideMenuBar.addEventListener('click', () => {
      withSelectedSeg((seg, sw, sh, ar) => {
        const c = seg.camera;
        const insetN = 0.045;
        seg.camera = clampCamera({ x: c.x, y: c.y + insetN, w: c.w, h: c.h - insetN }, sw, sh, ar, 'h');
      });
    });
  }

  if (elements.cropHideDock) {
    elements.cropHideDock.addEventListener('click', () => {
      withSelectedSeg((seg, sw, sh, ar) => {
        const c = seg.camera;
        const insetN = 0.07;
        seg.camera = clampCamera({ x: c.x, y: c.y, w: c.w, h: c.h - insetN }, sw, sh, ar, 'h');
      });
    });
  }

  // Numerical camera inputs (X/Y/W/H as % of source) — mutate selected segment.
  function commitCameraInputs(driverDim) {
    withSelectedSeg((seg, sw, sh, ar) => {
      seg.camera = clampCamera({
        x: parseFloat(elements.cameraInputX.value) / 100,
        y: parseFloat(elements.cameraInputY.value) / 100,
        w: parseFloat(elements.cameraInputW.value) / 100,
        h: parseFloat(elements.cameraInputH.value) / 100,
      }, sw, sh, ar, driverDim);
    });
  }
  ['X', 'Y'].forEach(k => {
    elements[`cameraInput${k}`]?.addEventListener('change', () => commitCameraInputs('w'));
  });
  elements.cameraInputW?.addEventListener('change', () => commitCameraInputs('w'));
  elements.cameraInputH?.addEventListener('change', () => commitCameraInputs('h'));

  // Add Crop / Delete Crop buttons in the panel
  document.getElementById('addCropBtn')?.addEventListener('click', () => {
    const seg = createCropSegment();
    if (seg) switchToCropPanel();
  });
  document.getElementById('deleteCropBtn')?.addEventListener('click', deleteSelectedCropSegment);

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

  // Quality slider fill update
  elements.exportQuality.addEventListener('input', () => {
    const value = elements.exportQuality.value;
    elements.qualityFill.style.width = value + '%';
  });

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
      const clickCount = (state.clickData || []).length;
      const n = generateZoomsFromClicks();
      if (n === 0) {
        if (clickCount === 0) {
          alert('No recorded clicks found.\n\nClick tracking only works when recording a browser tab. For window/monitor recordings, use manual zoom markers.');
        } else {
          alert(`Found ${clickCount} click(s), but no zoom segments created.\n\nThis shouldn't happen — please check the console for details.`);
        }
      } else {
        console.log(`[Editor] Created ${n} auto-zoom segment(s) from ${clickCount} clicks`);
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
      // Leaving the crop tab → drop the crop selection (overlay disappears,
      // canvas swaps back to rendering the effective camera output).
      if (tabType !== 'crop' && state.selectedCropId) {
        state.selectedCropId = null;
        renderCropSegments();
        updateCropOverlay();
      }
      if (tabType === 'settings') {
        switchToSettingsPanel();
      } else if (tabType === 'zoom') {
        switchToZoomPanel();
      } else if (tabType === 'camera') {
        switchToCameraPanel();
      } else if (tabType === 'crop') {
        switchToCropPanel();
      }
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
    // Zoom/crop are driven by the rAF render loop; nothing else to do here.
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

// =====================================================================
// renderFrame: single source of truth — drives both preview rAF and export.
// =====================================================================
//
// Inputs:
//   ctx     — destination Canvas2D (sized to outputDimensions())
//   time    — video time (seconds) to render at
//   opts:
//     mode         — 'output' (default): camera × zoom → fill canvas
//                  | 'crop-edit': source aspect-fitted into canvas (no zoom)
//     includeWebcam — true at export (paint webcam onto canvas);
//                     false at preview (DOM overlay handles it)
//     bgImage      — optional pre-loaded HTMLImageElement for image bg
//     useSmoothCamera — true to render state.smoothCamera (eased), false
//                       to render the raw state.camera (instant). Preview
//                       uses smoothCamera; export uses camera (no easing
//                       between fixed export camera positions).
//
// Coordinate spaces:
//   source-norm  — [0..1] of the recorded video frame
//   source-px    — [0..videoWidth/Height]
//   output-px    — [0..outputW/H], the canvas
// =====================================================================

// Compute the source rectangle (in source pixels) that maps to the entire
// output frame. Combines effective camera (from active crop segment, eased)
// + active zoom into a single rect.
//   opts.sourceWidth/Height: source pixel dims
//   opts.cursor: { x, y } in source-norm; overrides state.smoothCursor*
//                (used by export with its own SmoothDamp instance)
function computeSourceRect(time, opts) {
  const sw = opts.sourceWidth || 0;
  const sh = opts.sourceHeight || 0;
  const cam = getEffectiveCamera(time, sw, sh);
  const camPx = { x: cam.x * sw, y: cam.y * sh, w: cam.w * sw, h: cam.h * sh };

  if (!sw || !sh) return camPx;

  const zoom = getZoomAtTime(time);
  if (!zoom) return camPx;

  // Zoom: a sub-rect inside the camera, centered on cursor (follow) or
  // fixedX/fixedY (fixed). Cursor coords are in source-norm [0..1].
  const ramp = computeZoomRamp(time, zoom);
  const zoomScale = 1 + (zoom.depth - 1) * ramp;

  let cursorXn, cursorYn;
  if (zoom.position === 'fixed') {
    cursorXn = zoom.fixedX;
    cursorYn = zoom.fixedY;
  } else if (opts.cursor) {
    cursorXn = opts.cursor.x;
    cursorYn = opts.cursor.y;
  } else {
    cursorXn = state.smoothCursorX;
    cursorYn = state.smoothCursorY;
  }
  const cursorPx = { x: cursorXn * sw, y: cursorYn * sh };

  const subW = camPx.w / zoomScale;
  const subH = camPx.h / zoomScale;
  let subX = cursorPx.x - subW / 2;
  let subY = cursorPx.y - subH / 2;

  // Clamp the zoom sub-rect inside the camera (so we never expose pixels
  // outside the user-chosen crop, even when the cursor is at an edge).
  subX = Math.max(camPx.x, Math.min(camPx.x + camPx.w - subW, subX));
  subY = Math.max(camPx.y, Math.min(camPx.y + camPx.h - subH, subY));
  return { x: subX, y: subY, w: subW, h: subH };
}

// Where the video region sits inside the output canvas. Two layouts:
//   - hidden background → tight: video region = full canvas, no padding
//   - any visible background → padded so the bg shows around the video
function computeVideoRect(out) {
  const hidden = state.backgroundType === 'hidden';
  const frameH = (hidden || state.frameStyle === 'hidden')
    ? 0 : (state.frameStyle === 'minimal' ? 36 : 0);
  if (hidden) {
    return { x: 0, y: frameH, w: out.width, h: out.height - frameH, frameH };
  }
  // Padded layout — leave ~6% padding on each side so the bg shows.
  const pad = Math.round(out.width * 0.06);
  const availW = out.width - pad * 2;
  const availH = out.height - pad * 2 - frameH;
  // Camera viewport is already aspect-locked to output, so video region
  // matches the output aspect after the frame chrome is subtracted.
  const outAspect = (out.width) / (out.height);
  let w, h;
  // Fit availW/availH to output aspect (the camera region itself).
  if (availW / availH > outAspect) {
    h = availH;
    w = h * outAspect;
  } else {
    w = availW;
    h = w / outAspect;
  }
  const x = (out.width - w) / 2;
  const y = pad + frameH;  // frame chrome sits above the video region
  return { x, y, w, h, frameH };
}

function drawBackgroundToCanvas(ctx, out, bgImage) {
  if (state.backgroundType === 'hidden') {
    // Transparent — leave as-is.
    return;
  }
  if (state.backgroundType === 'color') {
    ctx.fillStyle = state.background || '#1a1a2e';
    ctx.fillRect(0, 0, out.width, out.height);
    return;
  }
  if (state.backgroundType === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, out.width, out.height);
    // Cheap gradient parser: pull the first two hex colors.
    const colors = (state.background || '').match(/#[0-9a-fA-F]{3,8}/g) || ['#667eea', '#764ba2'];
    g.addColorStop(0, colors[0] || '#667eea');
    g.addColorStop(1, colors[1] || colors[0] || '#764ba2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, out.width, out.height);
    return;
  }
  // Image background
  if (bgImage && bgImage.complete && bgImage.naturalWidth) {
    // Cover-fit
    const ia = bgImage.naturalWidth / bgImage.naturalHeight;
    const oa = out.width / out.height;
    let dw, dh;
    if (ia >= oa) { dh = out.height; dw = dh * ia; } else { dw = out.width; dh = dw / ia; }
    const dx = (out.width - dw) / 2;
    const dy = (out.height - dh) / 2;
    // Cheap blur via filter (CPU cost is fine at 30fps).
    const blurMap = { none: 0, light: 8, moderate: 16, heavy: 32 };
    const blurPx = blurMap[state.imageBlur] ?? 16;
    if (blurPx) {
      ctx.save();
      ctx.filter = `blur(${blurPx}px)`;
      // Expand slightly so blur edges don't feather into transparent.
      ctx.drawImage(bgImage, dx - 30, dy - 30, dw + 60, dh + 60);
      ctx.restore();
    } else {
      ctx.drawImage(bgImage, dx, dy, dw, dh);
    }
  } else {
    // Image not loaded yet → fallback gradient so the canvas isn't black.
    const g = ctx.createLinearGradient(0, 0, out.width, out.height);
    g.addColorStop(0, '#667eea'); g.addColorStop(1, '#764ba2');
    ctx.fillStyle = g; ctx.fillRect(0, 0, out.width, out.height);
  }
}

function drawFrameChromeToCanvas(ctx, videoRect, out) {
  if (state.backgroundType === 'hidden') return;  // no chrome on tight crop
  if (state.frameStyle === 'hidden') return;
  if (state.frameShadow) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 15;
    ctx.fillStyle = '#1a1a1d';
    const radius = 12;
    ctx.beginPath();
    ctx.roundRect(videoRect.x, videoRect.y - videoRect.frameH, videoRect.w, videoRect.h + videoRect.frameH, radius);
    ctx.fill();
    ctx.restore();
  }
  if (state.frameStyle === 'minimal' && videoRect.frameH > 0) {
    ctx.fillStyle = '#28282a';
    ctx.beginPath();
    ctx.roundRect(videoRect.x, videoRect.y - videoRect.frameH, videoRect.w, videoRect.frameH, [12, 12, 0, 0]);
    ctx.fill();

    // Traffic lights
    const dotR = 5;
    const dotY = videoRect.y - videoRect.frameH / 2;
    const baseX = videoRect.x + 14;
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(baseX + i * 16, dotY, dotR, 0, Math.PI * 2);
      ctx.fill();
    });

    // URL pill
    const urlW = Math.min(180, videoRect.w * 0.3);
    const urlH = 16;
    const urlX = videoRect.x + (videoRect.w - urlW) / 2;
    const urlY = videoRect.y - videoRect.frameH / 2 - urlH / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.roundRect(urlX, urlY, urlW, urlH, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('daddyrecorder.com', urlX + urlW / 2, urlY + urlH / 2);
  }
}

function drawFrameBorderToCanvas(ctx, videoRect) {
  if (!state.frameBorder) return;
  if (state.backgroundType === 'hidden') return;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(videoRect.x, videoRect.y - videoRect.frameH, videoRect.w, videoRect.h + videoRect.frameH, 12);
  ctx.stroke();
}

// Webcam composite into output canvas. Used at export time. Preview uses a
// DOM overlay (positioned in output coords via updateCameraBubble).
//
// Bubble positioning is in OUTPUT space (the full canvas), NOT videoRect.
// This lets the user park the bubble in the background padding around the
// recorder content — Cursorful / Screen Studio behavior.
function drawWebcamToCanvas(ctx, _videoRect, time) {
  const s = state.cameraSettings;
  if (!s || !s.enabled) return;
  if (isCameraHiddenAt(time)) return;
  const cam = elements.webcamPlayer;
  if (!cam || !cam.videoWidth || !cam.videoHeight) return;

  const out = outputDimensions();
  // Bubble size scales with output width (was videoRect.w — now whole canvas).
  const bubbleW = Math.round((s.sizePct / 100) * out.width);
  const bubbleH = bubbleW;
  const margin = Math.round(out.width * 0.02);
  let x, y;
  if (s.customX != null && s.customY != null) {
    // customX/Y are normalized to the OUTPUT canvas (0..1). The bubble can
    // sit anywhere in the exported frame, including the bg padding outside
    // the recorder content.
    x = s.customX * out.width;
    y = s.customY * out.height;
  } else {
    x = margin;
    y = margin;
    const [vAnc, hAnc] = (s.anchor || 'bottom-right').split('-');
    if (hAnc === 'center') x = (out.width - bubbleW) / 2;
    else if (hAnc === 'right') x = out.width - bubbleW - margin;
    if (vAnc === 'middle') y = (out.height - bubbleH) / 2;
    else if (vAnc === 'bottom') y = out.height - bubbleH - margin;
  }
  // Clamp inside the OUTPUT canvas (not videoRect).
  x = Math.max(0, Math.min(out.width - bubbleW, x));
  y = Math.max(0, Math.min(out.height - bubbleH, y));

  const radius = (getCornerRadiusPct(s) / 100) * bubbleW;
  ctx.save();
  ctx.globalAlpha = s.opacity ?? 1;
  ctx.beginPath();
  ctx.roundRect(x, y, bubbleW, bubbleH, radius);
  ctx.clip();
  // Cover-fit
  const cw = cam.videoWidth, ch = cam.videoHeight;
  const sc = Math.max(bubbleW / cw, bubbleH / ch);
  const dw = cw * sc, dh = ch * sc;
  const dx = x + (bubbleW - dw) / 2, dy = y + (bubbleH - dh) / 2;
  if (s.mirror) {
    ctx.translate(x + bubbleW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(cam, x + bubbleW - dx - dw, dy, dw, dh);
  } else {
    ctx.drawImage(cam, dx, dy, dw, dh);
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = (s.opacity ?? 1) * 0.7;
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.beginPath();
  ctx.roundRect(x, y, bubbleW, bubbleH, radius);
  ctx.stroke();
  ctx.restore();
}

// Cache for the background image element. Reloaded when state.backgroundImage
// changes; reused across rAF frames.
const _bgImageCache = { url: null, img: null };
function getBackgroundImage() {
  if (state.backgroundType !== 'image') return null;
  const url = state.backgroundImage;
  if (_bgImageCache.url !== url) {
    _bgImageCache.url = url;
    _bgImageCache.img = new Image();
    _bgImageCache.img.crossOrigin = 'anonymous';
    _bgImageCache.img.src = url;
  }
  return _bgImageCache.img;
}

function renderFrame(ctx, time, opts = {}) {
  const out = outputDimensions();
  // Make sure the canvas backing buffer matches.
  if (ctx.canvas.width !== out.width)  ctx.canvas.width = out.width;
  if (ctx.canvas.height !== out.height) ctx.canvas.height = out.height;

  const video = opts.video || elements.videoPlayer;
  const sw = opts.sourceWidth ?? video?.videoWidth ?? 0;
  const sh = opts.sourceHeight ?? video?.videoHeight ?? 0;

  ctx.clearRect(0, 0, out.width, out.height);

  // 1. Background
  drawBackgroundToCanvas(ctx, out, getBackgroundImage());

  if (!video || !sw || !sh) return;

  // Output mode (the only mode now): camera × zoom → video region.
  // Crop adjustment happens on the sidebar mini-preview, NOT on this canvas.
  const videoRect = computeVideoRect(out);
  drawFrameChromeToCanvas(ctx, videoRect, out);

  const src = computeSourceRect(time, {
    ...opts,
    sourceWidth: sw,
    sourceHeight: sh,
  });

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(videoRect.x, videoRect.y, videoRect.w, videoRect.h, 12);
  ctx.clip();

  // Motion blur during zoom in/out ramp.
  const z = getZoomAtTime(time);
  const ramp = z ? computeZoomRamp(time, z) : 0;
  const blurPx = zoomMotionBlurPx(ramp);
  if (blurPx > 0.05) ctx.filter = `blur(${blurPx.toFixed(2)}px)`;

  ctx.drawImage(video,
    src.x, src.y, src.w, src.h,
    videoRect.x, videoRect.y, videoRect.w, videoRect.h);
  ctx.restore();

  // 4. Webcam (canvas-side) — only at export. Preview uses DOM overlay.
  if (opts.includeWebcam) drawWebcamToCanvas(ctx, videoRect, time);

  // 5. Frame border on top
  drawFrameBorderToCanvas(ctx, videoRect);
}

// =====================================================================
// Preview render loop.
// Drives state.smoothCursor (for zoom follow) and state.smoothCamera
// (for eased crop transitions), then paints renderFrame() onto the
// preview canvas. Runs continuously while the editor is open.
// =====================================================================

let renderLoopId = null;
let lastRenderTs = 0;
let _previewCtx = null;

function startRenderLoop() {
  if (renderLoopId) return;
  _previewCtx = elements.previewCanvas?.getContext('2d');
  if (!_previewCtx) return;

  function tick(now) {
    const time = elements.videoPlayer?.currentTime || 0;

    let dt = lastRenderTs ? (now - lastRenderTs) / 1000 : 1 / 60;
    if (dt > 0.1) dt = 0.1;  // cap on tab resume
    lastRenderTs = now;

    // Cursor follow smoothing
    const cursorPos = getCursorAtTime(time);
    state.cursorX = cursorPos.x;
    state.cursorY = cursorPos.y;
    const { smoothTime } = getZoomPreset();
    state.smoothCursorX = smoothDamp(state.smoothCursorX, state.cursorX, state.smoothCursorVX, smoothTime, dt);
    state.smoothCursorY = smoothDamp(state.smoothCursorY, state.cursorY, state.smoothCursorVY, smoothTime, dt);

    // Camera easing comes from segment-level ramp (computeZoomRamp) inside
    // getEffectiveCamera — no per-frame smoothDamp needed here.

    // Main canvas ALWAYS renders the final cropped output. Crop adjustment
    // happens in the sidebar mini-preview (see updateCropOverlay).
    if (isCropEditingMode()) {
      updateCropOverlay();
      // Keep the sidebar mini-preview's currentTime synced with the main
      // video so the user sees what they're cropping at the playhead moment.
      const miniVideo = document.getElementById('cropMiniVideo');
      if (miniVideo && elements.videoPlayer && Math.abs(miniVideo.currentTime - time) > 0.05) {
        try { miniVideo.currentTime = time; } catch (_) {}
      }
    }
    elements.previewFrame?.classList.toggle('zoom-active', !!getZoomAtTime(time));

    renderFrame(_previewCtx, time, {
      mode: 'output',
      includeWebcam: false,  // DOM overlay handles preview webcam
    });

    renderLoopId = requestAnimationFrame(tick);
  }

  lastRenderTs = 0;
  renderLoopId = requestAnimationFrame(tick);
}

function stopRenderLoop() {
  if (renderLoopId) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }
}

// Reflect output settings (aspect / height) into UI dropdowns + canvas dims.
// Called on init and whenever output changes.
function reflectOutputUI() {
  if (elements.outputAspectSelect) elements.outputAspectSelect.value = state.output.aspect;
  if (elements.outputHeightSelect) elements.outputHeightSelect.value = String(state.output.height);
  const out = outputDimensions();
  if (elements.cropOutputReadout) {
    elements.cropOutputReadout.textContent = `${out.width} × ${out.height}`;
  }
  // Drive the preview-wrapper aspect attribute so CSS sizes the wrapper.
  if (elements.previewWrapper) elements.previewWrapper.setAttribute('data-aspect', state.output.aspect);
  // Resize the canvas backing buffer.
  if (elements.previewCanvas) {
    elements.previewCanvas.width = out.width;
    elements.previewCanvas.height = out.height;
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
  // Output / aspect — drives canvas size and wrapper aspect.
  reflectOutputUI();

  // .preview-background is now mostly unused (background lives on the
  // canvas) but we keep it transparent so legacy CSS doesn't shine through.
  if (elements.previewBackground) {
    elements.previewBackground.style.background = 'transparent';
    elements.previewBackground.style.backgroundImage = '';
    elements.previewBackground.style.filter = 'none';
    elements.previewBackground.style.transform = 'none';
  }

  // Minimal frame DOM chrome — the canvas draws a minimal frame too in
  // its own draw, but we keep this in DOM so the layout sizes correctly
  // for non-canvas decorations (shadows, borders).
  if (state.frameStyle === 'minimal') {
    elements.minimalFrame?.classList.remove('hidden');
  } else {
    elements.minimalFrame?.classList.add('hidden');
  }

  // Shadow & border classes — visual only, applied to the preview-frame box.
  elements.previewFrame.classList.toggle('has-shadow', state.frameShadow);
  elements.previewFrame.classList.toggle('has-border', state.frameBorder);

  // Webcam DOM overlay (preview side).
  updateCameraBubble();
}

// Export video
async function exportVideo() {
  elements.exportModal.classList.add('hidden');
  elements.loadingOverlay.classList.remove('hidden');

  const quality = elements.exportQuality.value / 100;
  const format = elements.exportFormat.value;
  // Output resolution is now driven by state.output (aspect + height) — the
  // export modal's "resolution" dropdown is honored by overriding height.
  const resMap = { '1080p': 1080, '720p': 720, '480p': 480 };
  const overrideH = resMap[elements.exportResolution.value];
  const savedHeight = state.output.height;
  if (overrideH) state.output.height = overrideH;

  const activeClips = state.clips.filter(c => !c.deleted);
  if (activeClips.length === 0) {
    state.output.height = savedHeight;
    elements.loadingOverlay.classList.add('hidden');
    alert('No clips to export');
    return;
  }

  try {
    // Offscreen <video> drives source frames + audio. We don't disturb the
    // editor's own videoPlayer (still bound to UI / current playback).
    const video = document.createElement('video');
    video.src = state.videoUrl;
    video.muted = true;
    await new Promise(resolve => { video.onloadedmetadata = resolve; });

    const out = outputDimensions();
    const canvas = document.createElement('canvas');
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = canvas.getContext('2d');

    // captureStream from canvas + carry source audio onto the same stream.
    const stream = canvas.captureStream(30);
    try {
      if (typeof video.captureStream === 'function') {
        const srcStream = video.captureStream();
        srcStream.getAudioTracks().forEach(t => stream.addTrack(t));
      }
    } catch (e) {
      console.warn('[Editor] Could not attach source audio to export:', e);
    }

    const mimeType = format === 'mp4' && MediaRecorder.isTypeSupported('video/mp4')
      ? 'video/mp4'
      : 'video/webm;codecs=vp9,opus';
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: quality * 10_000_000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
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

    const totalEditedDuration = getEditedDuration();
    let processedDuration = 0;

    // Independent SmoothDamp cursor for the export — keeps follow motion
    // identical to what the user saw in the preview, but isolated from the
    // live preview's smoothing state (which keeps running in the background).
    const expCur = { x: 0.5, y: 0.5, vx: { v: 0 }, vy: { v: 0 }, init: false };

    function drawExportFrame() {
      // Drive expCur via the same smoothDamp/smoothTime the preview uses.
      const t = video.currentTime;
      const z = getZoomAtTime(t);
      let cursor = null;
      if (z) {
        if (z.position === 'follow') {
          const target = getCursorAtTime(t);
          const { smoothTime } = getZoomPreset();
          const dt = 1 / 30;
          if (expCur.init) {
            expCur.x = smoothDamp(expCur.x, target.x, expCur.vx, smoothTime, dt);
            expCur.y = smoothDamp(expCur.y, target.y, expCur.vy, smoothTime, dt);
          } else {
            expCur.x = target.x; expCur.y = target.y;
            expCur.vx.v = 0; expCur.vy.v = 0; expCur.init = true;
          }
          cursor = { x: expCur.x, y: expCur.y };
        }
      } else {
        expCur.init = false;
      }

      renderFrame(ctx, t, {
        video,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        mode: 'output',
        includeWebcam: true,
        useSmoothCamera: false,  // export uses raw camera (no easing)
        cursor,
      });
    }

    recorder.start();

    const webcam = elements.webcamPlayer;
    const hasWebcam = !!(webcam && webcam.src && state.cameraSettings?.enabled);
    if (hasWebcam) { webcam.muted = true; webcam.pause(); }

    for (let i = 0; i < activeClips.length; i++) {
      const clip = activeClips[i];
      const clipDur = (clip.end - clip.start) / clip.speed;

      video.currentTime = clip.start;
      await new Promise(r => { video.onseeked = r; });
      video.playbackRate = clip.speed;

      if (hasWebcam) {
        webcam.playbackRate = clip.speed;
        try {
          webcam.currentTime = Math.min(clip.start, webcam.duration || clip.start);
          await new Promise(r => {
            const done = () => { webcam.onseeked = null; r(); };
            webcam.onseeked = done;
            setTimeout(done, 500);
          });
        } catch (_) {}
        webcam.play().catch(() => {});
      }

      await new Promise((resolveClip) => {
        let lastFrameTime = performance.now();
        const interval = 1000 / 30;

        const tick = () => {
          if (video.currentTime >= clip.end || video.ended) {
            video.pause();
            if (hasWebcam) webcam.pause();
            processedDuration += clipDur;
            resolveClip();
            return;
          }
          const now = performance.now();
          if (now - lastFrameTime >= interval) {
            lastFrameTime = now - ((now - lastFrameTime) % interval);
            drawExportFrame();

            const cp = (video.currentTime - clip.start) / (clip.end - clip.start);
            const overall = (processedDuration + cp * clipDur) / totalEditedDuration;
            elements.loadingProgressBar.style.width = `${Math.min(100, overall * 100)}%`;
          }
          requestAnimationFrame(tick);
        };

        video.play().then(tick);
      });
    }

    recorder.stop();
    await exportPromise;
  } catch (error) {
    console.error('Export error:', error);
    elements.loadingOverlay.classList.add('hidden');
    alert('Export failed: ' + error.message);
  } finally {
    state.output.height = savedHeight;
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
