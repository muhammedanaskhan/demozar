// Editor State
const state = {
  videoBlob: null,
  videoUrl: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
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
      if (data && data.blob) {
        state.videoBlob = data.blob;
        state.videoUrl = URL.createObjectURL(data.blob);
        elements.videoPlayer.src = state.videoUrl;

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
    elements.durationEl.textContent = formatTime(state.duration);
    elements.timelineRuler.setAttribute('data-duration', formatTime(state.duration));
  } else {
    elements.durationEl.textContent = '00:00';
  }
  updateProgress();
}

// Open IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('SpotlightRecorder', 1);

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
    <button onclick="window.close()" style="
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
}

// Bind events
function bindEvents() {
  // Play/Pause
  elements.playBtn.addEventListener('click', togglePlay);
  elements.videoPlayer.addEventListener('click', togglePlay);

  // Video events
  elements.videoPlayer.addEventListener('timeupdate', updateProgress);
  elements.videoPlayer.addEventListener('ended', () => {
    state.isPlaying = false;
    updatePlayButton();
  });

  // Progress bar
  elements.progressBar.addEventListener('click', seekVideo);
  elements.progressBar.addEventListener('mousedown', startDrag);

  // Timeline track - make it clickable for seeking
  const timelineTrack = document.querySelector('.timeline-track');
  if (timelineTrack) {
    timelineTrack.addEventListener('click', seekFromTimeline);
    timelineTrack.addEventListener('mousedown', startTimelineDrag);
    timelineTrack.style.cursor = 'pointer';
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

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    }
  });
}

// Toggle play/pause
function togglePlay() {
  if (state.isPlaying) {
    elements.videoPlayer.pause();
  } else {
    elements.videoPlayer.play();
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

  // Update timeline playhead
  const timelineTrack = elements.timelinePlayhead.parentElement;
  if (timelineTrack) {
    const padding = 12;
    const timelineWidth = timelineTrack.offsetWidth - (padding * 2);
    elements.timelinePlayhead.style.left = `${padding + (percent / 100) * timelineWidth}px`;
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
  }
}

// Drag handling
let isDragging = false;

function startDrag(e) {
  isDragging = true;
  seekVideo(e);

  const handleDrag = (e) => {
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
  const timelineTrack = document.querySelector('.timeline-track');
  if (!timelineTrack || !isFinite(state.duration) || state.duration <= 0) {
    return;
  }

  const rect = timelineTrack.getBoundingClientRect();
  const padding = 12; // Account for padding
  const effectiveWidth = rect.width - (padding * 2);
  let clickX = e.clientX - rect.left - padding;
  let percent = clickX / effectiveWidth;
  percent = Math.max(0, Math.min(1, percent));

  const newTime = percent * state.duration;
  if (!isNaN(newTime) && isFinite(newTime)) {
    elements.videoPlayer.currentTime = newTime;
    updateProgress();
  }
}

function startTimelineDrag(e) {
  isDragging = true;
  seekFromTimeline(e);

  const handleDrag = (e) => {
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

    // Calculate video dimensions to fit in frame
    const videoAspect = video.videoWidth / video.videoHeight;
    const canvasAspect = width / height;

    let videoWidth, videoHeight, videoX, videoY;
    const padding = 60; // Padding for background visibility

    if (videoAspect > canvasAspect) {
      videoWidth = width - padding * 2;
      videoHeight = videoWidth / videoAspect;
    } else {
      videoHeight = height - padding * 2;
      videoWidth = videoHeight * videoAspect;
    }

    videoX = (width - videoWidth) / 2;
    videoY = (height - videoHeight) / 2;

    // Set up MediaRecorder for canvas
    const stream = canvas.captureStream(30);

    // Add audio from original video if available
    if (state.videoBlob.type.includes('audio') || true) {
      try {
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);
        source.connect(audioCtx.destination);
        dest.stream.getAudioTracks().forEach(track => {
          stream.addTrack(track);
        });
      } catch (e) {
        console.log('Could not add audio:', e);
      }
    }

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

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `spotlight-export-${Date.now()}.${format}`;
      a.click();

      elements.loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    };

    // Start recording
    recorder.start();
    video.currentTime = 0;
    await video.play();

    // Render frames
    const renderFrame = () => {
      if (video.ended || video.paused) {
        recorder.stop();
        return;
      }

      // Draw background
      if (state.backgroundType !== 'hidden') {
        // Create gradient
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        // Parse gradient colors (simplified)
        gradient.addColorStop(0, '#667eea');
        gradient.addColorStop(1, '#764ba2');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, width, height);
      }

      // Draw shadow if enabled
      if (state.frameShadow) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 40;
        ctx.shadowOffsetY = 20;
      }

      // Draw browser frame if not hidden
      if (state.frameStyle !== 'hidden') {
        const frameHeight = state.frameStyle === 'minimal' ? 30 : 40;

        // Frame background
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'transparent';

        // Rounded rectangle for frame
        const frameX = videoX;
        const frameY = videoY - frameHeight;
        const radius = 12;

        ctx.beginPath();
        ctx.moveTo(frameX + radius, frameY);
        ctx.lineTo(frameX + videoWidth - radius, frameY);
        ctx.quadraticCurveTo(frameX + videoWidth, frameY, frameX + videoWidth, frameY + radius);
        ctx.lineTo(frameX + videoWidth, frameY + frameHeight);
        ctx.lineTo(frameX, frameY + frameHeight);
        ctx.lineTo(frameX, frameY + radius);
        ctx.quadraticCurveTo(frameX, frameY, frameX + radius, frameY);
        ctx.closePath();
        ctx.fill();

        // Traffic light dots
        const dotY = frameY + frameHeight / 2;
        const dotRadius = 6;
        const dotSpacing = 20;

        ctx.fillStyle = '#ff5f57';
        ctx.beginPath();
        ctx.arc(frameX + 20, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#febc2e';
        ctx.beginPath();
        ctx.arc(frameX + 20 + dotSpacing, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#28c840';
        ctx.beginPath();
        ctx.arc(frameX + 20 + dotSpacing * 2, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Reset shadow for video
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // Draw video frame
      ctx.drawImage(video, videoX, videoY, videoWidth, videoHeight);

      // Update progress
      const progress = (video.currentTime / video.duration) * 100;
      elements.loadingProgressBar.style.width = `${progress}%`;

      requestAnimationFrame(renderFrame);
    };

    renderFrame();

  } catch (error) {
    console.error('Export error:', error);
    elements.loadingOverlay.classList.add('hidden');
    alert('Export failed: ' + error.message);
  }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
