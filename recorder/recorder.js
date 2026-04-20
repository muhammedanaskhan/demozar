// ========== State ==========
let settings = null;

// Source streams
let micCamStream = null;    // getUserMedia output — stays alive for the whole session
let screenStream = null;    // getDisplayMedia output

// Composed stream fed into the screen recorder (screen video + merged audio)
let recorderStream = null;
let screenRecorder = null;
let screenChunks = [];

// Webcam-only recorder (if camera enabled)
let webcamRecorder = null;
let webcamChunks = [];

// Web Audio — mixes system + mic audio into one track
let audioContext = null;
let micMeterHandle = null;

// Pending payload — both recorders finalize before we hand off to the service worker
let pending = null;

// ========== DOM ==========
const $ = (id) => document.getElementById(id);
const el = {
  timer: $('timer'),
  subtitle: $('subtitle'),
  screenStatus: $('screenStatus'),
  micStatus: $('micStatus'),
  cameraStatus: $('cameraStatus'),
  sourceScreen: $('sourceScreen'),
  sourceMic: $('sourceMic'),
  sourceCamera: $('sourceCamera'),
  cameraPreview: $('cameraPreview'),
  micMeter: $('micMeter'),
  micFill: $('micFill'),
  micSelect: $('micSelect'),
  cameraSelect: $('cameraSelect'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  pauseBtn: $('pauseBtn'),
  pauseIcon: $('pauseIcon'),
  pauseLabel: $('pauseLabel'),
  statusBar: $('statusBar'),
};

let isPaused = false;

// Selected deviceIds (null = default)
let selectedMicId = null;
let selectedCameraId = null;

function setStatus(msg, tone = '') {
  el.statusBar.textContent = msg || '';
  el.statusBar.className = 'status-bar' + (tone ? ' ' + tone : '');
}

// ========== Boot ==========

(async function boot() {
  try {
    const stored = await chrome.storage.local.get('settings');
    settings = stored.settings || {};
    selectedMicId = settings.selectedMicId || null;
    selectedCameraId = settings.selectedCameraId || null;
    console.log('[Recorder] settings', settings);

    reflectSourceCards();
    await primeMicCamStream();
    await populateDeviceSelects();

    el.micSelect.addEventListener('change', (e) => {
      selectedMicId = e.target.value || null;
      persistDeviceSelections();
      reacquireMicCamStream();
    });
    el.cameraSelect.addEventListener('change', (e) => {
      selectedCameraId = e.target.value || null;
      persistDeviceSelections();
      reacquireMicCamStream();
    });

    el.startBtn.addEventListener('click', startRecording);
    el.stopBtn.addEventListener('click', stopRecording);
    el.pauseBtn.addEventListener('click', togglePause);

    // Background can message us to stop (e.g. toolbar icon click during record).
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'STOP_RECORDING_FROM_BG') {
        stopRecording();
      }
    });

    // If the user closes/navigates away from the tab mid-recording, clean up.
    window.addEventListener('beforeunload', () => {
      cleanup(/* keepStream */ false);
    });
  } catch (e) {
    console.error('[Recorder] boot failed', e);
    setStatus('Recorder failed to initialize: ' + (e?.message || e), 'err');
  }
})();

function reflectSourceCards() {
  // Screen is always on (the user will pick at record time)
  el.sourceScreen.classList.add('on');
  el.screenStatus.textContent = 'Picker will open on Start';

  if (settings.micEnabled) {
    el.micStatus.textContent = 'Requesting access…';
  } else {
    el.micStatus.textContent = 'Off';
  }
  if (settings.cameraEnabled) {
    el.cameraStatus.textContent = 'Requesting access…';
  } else {
    el.cameraStatus.textContent = 'Off';
  }
}

function buildMediaConstraints() {
  const wantCamera = !!settings.cameraEnabled;
  const wantMic = !!settings.micEnabled;
  const video = wantCamera ? {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30 },
    ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
  } : false;
  const audio = wantMic ? {
    echoCancellation: true,
    noiseSuppression: true,
    ...(selectedMicId ? { deviceId: { exact: selectedMicId } } : {}),
  } : false;
  return { video, audio };
}

async function persistDeviceSelections() {
  const stored = await chrome.storage.local.get('settings');
  const next = { ...(stored.settings || {}), selectedMicId, selectedCameraId };
  await chrome.storage.local.set({ settings: next });
}

async function populateDeviceSelects() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    if (settings.micEnabled) {
      const inputs = devices.filter(d => d.kind === 'audioinput');
      if (inputs.length > 0) {
        el.micSelect.innerHTML = '';
        inputs.forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Microphone ${i + 1}`;
          el.micSelect.appendChild(opt);
        });
        const active = micCamStream?.getAudioTracks()[0]?.getSettings()?.deviceId;
        if (active) el.micSelect.value = active;
        else if (selectedMicId) el.micSelect.value = selectedMicId;
        el.micSelect.classList.remove('hidden');
      }
    }

    if (settings.cameraEnabled) {
      const cams = devices.filter(d => d.kind === 'videoinput');
      if (cams.length > 0) {
        el.cameraSelect.innerHTML = '';
        cams.forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Camera ${i + 1}`;
          el.cameraSelect.appendChild(opt);
        });
        const active = micCamStream?.getVideoTracks()[0]?.getSettings()?.deviceId;
        if (active) el.cameraSelect.value = active;
        else if (selectedCameraId) el.cameraSelect.value = selectedCameraId;
        el.cameraSelect.classList.remove('hidden');
      }
    }
  } catch (e) {
    console.warn('[Recorder] enumerateDevices failed', e);
  }
}

async function reacquireMicCamStream() {
  if (!micCamStream) {
    await primeMicCamStream();
    return;
  }
  // Stop old tracks + old meter before replacing
  try { micCamStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  if (micMeterHandle) cancelAnimationFrame(micMeterHandle);
  micMeterHandle = null;
  micCamStream = null;
  try {
    micCamStream = await navigator.mediaDevices.getUserMedia(buildMediaConstraints());
  } catch (e) {
    console.warn('[Recorder] reacquire failed', e);
    setStatus('Could not switch device: ' + (e?.message || e), 'err');
    return;
  }
  attachPreview();
  if (settings.micEnabled && micCamStream.getAudioTracks().length > 0) {
    startMicMeter();
  }
}

function attachPreview() {
  if (!micCamStream) return;
  if (settings.cameraEnabled) {
    const track = micCamStream.getVideoTracks()[0];
    if (track) {
      el.cameraPreview.srcObject = new MediaStream([track]);
      el.cameraPreview.classList.remove('hidden');
      el.sourceCamera.classList.add('on');
      el.cameraStatus.textContent = track.label || 'Ready';
    }
  }
  if (settings.micEnabled) {
    const track = micCamStream.getAudioTracks()[0];
    if (track) {
      el.sourceMic.classList.add('on');
      el.micStatus.textContent = track.label || 'Ready';
    }
  }
}

// Get camera/mic permission here in the tab context (tabs can anchor
// permission prompts; the extension popup cannot). Stream stays alive
// for the duration of the page so the grant is visible to all other
// extension contexts.
async function primeMicCamStream() {
  const wantCamera = !!settings.cameraEnabled;
  const wantMic = !!settings.micEnabled;
  if (!wantCamera && !wantMic) return;

  try {
    micCamStream = await navigator.mediaDevices.getUserMedia(buildMediaConstraints());
  } catch (err) {
    console.warn('[Recorder] getUserMedia failed', err);
    if (wantCamera) {
      el.sourceCamera.classList.add('err');
      el.cameraStatus.textContent = 'Access denied — ' + (err?.message || 'unknown');
    }
    if (wantMic) {
      el.sourceMic.classList.add('err');
      el.micStatus.textContent = 'Access denied — ' + (err?.message || 'unknown');
    }
    return;
  }

  attachPreview();
  if (wantMic && micCamStream.getAudioTracks().length > 0) {
    startMicMeter();
  }
}

function startMicMeter() {
  if (!micCamStream) return;
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(micCamStream.getAudioTracks()));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    el.micMeter.classList.remove('hidden');

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      el.micFill.style.width = Math.min(100, peak * 200) + '%';
      micMeterHandle = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    console.warn('[Recorder] mic meter failed', e);
  }
}

// ========== Recording control ==========

async function startRecording() {
  setStatus('Requesting screen…');
  el.startBtn.disabled = true;

  try {
    const displayMediaOptions = {
      video: { cursor: 'always', ...getVideoConstraints(settings.quality) },
      audio: !!settings.audioEnabled,
      selfBrowserSurface: 'exclude',
      systemAudio: settings.audioEnabled ? 'include' : 'exclude',
    };
    screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
  } catch (err) {
    console.warn('[Recorder] getDisplayMedia cancelled', err);
    setStatus('Screen picker was cancelled.', 'err');
    el.startBtn.disabled = false;
    return;
  }

  // Tab-surface captures can show a 3-2-1 overlay on the recorded tab
  // (via content script). For window/screen captures we can't overlay
  // native surfaces from a Chrome extension, so we skip the countdown.
  const track = screenStream.getVideoTracks()[0];
  const surface = track?.getSettings?.().displaySurface;
  if (surface === 'browser') {
    try {
      await chrome.runtime.sendMessage({ type: 'RUN_COUNTDOWN_ON_SOURCE' });
    } catch (_) { /* non-fatal */ }
  }

  const videoTracks = screenStream.getVideoTracks();
  if (!videoTracks.length) {
    setStatus('No screen video track.', 'err');
    el.startBtn.disabled = false;
    return;
  }

  // If Chrome ends the screen share (user hits "Stop sharing"), stop us too.
  videoTracks[0].addEventListener('ended', () => {
    stopRecording();
  });

  // Compose: screen video + merged audio
  recorderStream = composeRecordingStream(screenStream, micCamStream);

  // Screen MediaRecorder
  try {
    const mime = getMimeType(settings.format);
    screenRecorder = new MediaRecorder(recorderStream, {
      mimeType: mime,
      videoBitsPerSecond: getBitrate(settings.quality),
    });
  } catch (e) {
    screenRecorder = new MediaRecorder(recorderStream);
  }
  screenRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) screenChunks.push(e.data); };
  screenRecorder.onstop = () => finalizeScreen();
  screenRecorder.start(1000);

  // Webcam-only recorder (video from micCamStream, no audio — already merged above)
  const camTracks = (micCamStream && settings.cameraEnabled) ? micCamStream.getVideoTracks() : [];
  pending = { screen: null, webcam: null, needsWebcam: camTracks.length > 0 };
  if (camTracks.length > 0) {
    try {
      const camOnly = new MediaStream(camTracks);
      webcamRecorder = new MediaRecorder(camOnly, {
        mimeType: getMimeType(settings.format),
        videoBitsPerSecond: 2_000_000,
      });
    } catch (e) {
      webcamRecorder = new MediaRecorder(new MediaStream(camTracks));
    }
    webcamRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) webcamChunks.push(e.data); };
    webcamRecorder.onstop = () => finalizeWebcam();
    webcamRecorder.start(1000);
  }

  // UI: swap to recording state
  el.startBtn.classList.add('hidden');
  el.pauseBtn.classList.remove('hidden');
  el.stopBtn.classList.remove('hidden');
  el.subtitle.textContent = 'Recording. Come back to this tab or click the Demozar icon to stop.';
  el.screenStatus.textContent = 'Recording';
  setStatus('Recording started', 'ok');
  startTimer();

  chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
  // Hand focus back to the tab the user was on before they clicked Record.
  chrome.runtime.sendMessage({ type: 'FOCUS_SOURCE_TAB' });
}

function composeRecordingStream(screen, micCam) {
  const videoTracks = screen.getVideoTracks();
  const screenAudio = screen.getAudioTracks();
  const micAudio = (micCam && settings.micEnabled) ? micCam.getAudioTracks() : [];

  if (screenAudio.length === 0 && micAudio.length === 0) {
    return new MediaStream(videoTracks);
  }
  if (screenAudio.length === 0) {
    return new MediaStream([...videoTracks, ...micAudio]);
  }
  if (micAudio.length === 0) {
    return new MediaStream([...videoTracks, ...screenAudio]);
  }

  audioContext = new AudioContext();
  const dest = audioContext.createMediaStreamDestination();
  audioContext.createMediaStreamSource(new MediaStream(screenAudio)).connect(dest);
  audioContext.createMediaStreamSource(new MediaStream(micAudio)).connect(dest);
  return new MediaStream([...videoTracks, ...dest.stream.getAudioTracks()]);
}

function stopRecording() {
  if (!screenRecorder) return;
  setStatus('Finalizing…');
  try {
    if (screenRecorder.state !== 'inactive') screenRecorder.stop();
  } catch (_) {}
  try {
    if (webcamRecorder && webcamRecorder.state !== 'inactive') webcamRecorder.stop();
  } catch (_) {}
  stopTimer();
  el.stopBtn.disabled = true;
  el.pauseBtn.disabled = true;
}

function togglePause() {
  if (!screenRecorder) return;
  if (!isPaused) {
    try { if (screenRecorder.state === 'recording') screenRecorder.pause(); } catch (_) {}
    try { if (webcamRecorder && webcamRecorder.state === 'recording') webcamRecorder.pause(); } catch (_) {}
    isPaused = true;
    pauseTimer();
    el.pauseBtn.classList.add('paused');
    el.pauseLabel.textContent = 'Resume';
    el.pauseIcon.innerHTML = '<polygon points="6 4 20 12 6 20 6 4"/>';
    el.screenStatus.textContent = 'Paused';
    setStatus('Paused');
  } else {
    try { if (screenRecorder.state === 'paused') screenRecorder.resume(); } catch (_) {}
    try { if (webcamRecorder && webcamRecorder.state === 'paused') webcamRecorder.resume(); } catch (_) {}
    isPaused = false;
    resumeTimer();
    el.pauseBtn.classList.remove('paused');
    el.pauseLabel.textContent = 'Pause';
    el.pauseIcon.innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
    el.screenStatus.textContent = 'Recording';
    setStatus('Recording', 'ok');
  }
}

async function finalizeScreen() {
  if (screenChunks.length === 0) {
    setStatus('No screen data captured.', 'err');
    return;
  }
  const mime = screenRecorder?.mimeType || 'video/webm';
  const blobMime = mime.split(';')[0];
  const blob = new Blob(screenChunks, { type: blobMime });
  const format = mime.includes('mp4') ? 'mp4' : 'webm';
  const dataUrl = await blobToDataUrl(blob);
  if (!pending) return;
  pending.screen = { dataUrl, format };
  maybeBundle();
}

async function finalizeWebcam() {
  if (webcamChunks.length === 0) {
    if (pending) pending.needsWebcam = false;
    maybeBundle();
    return;
  }
  const mime = webcamRecorder?.mimeType || 'video/webm';
  const blobMime = mime.split(';')[0];
  const blob = new Blob(webcamChunks, { type: blobMime });
  const format = mime.includes('mp4') ? 'mp4' : 'webm';
  const dataUrl = await blobToDataUrl(blob);
  if (!pending) return;
  pending.webcam = { dataUrl, format };
  maybeBundle();
}

function maybeBundle() {
  if (!pending) return;
  if (!pending.screen) return;
  if (pending.needsWebcam && !pending.webcam) return;

  chrome.runtime.sendMessage({
    type: 'RECORDING_DATA',
    screen: pending.screen,
    webcam: pending.webcam || null,
  });
  pending = null;
  // Background will close this tab once it's stored the data.
  // Release media streams locally regardless.
  cleanup(false);
}

function cleanup(keepStream) {
  for (const s of [screenStream, recorderStream, keepStream ? null : micCamStream]) {
    if (!s) continue;
    try { s.getTracks().forEach(t => t.stop()); } catch (_) {}
  }
  if (audioContext) {
    try { audioContext.close(); } catch (_) {}
    audioContext = null;
  }
  screenStream = null;
  recorderStream = null;
  if (!keepStream) micCamStream = null;
  screenRecorder = null;
  webcamRecorder = null;
  screenChunks = [];
  webcamChunks = [];
  if (micMeterHandle) cancelAnimationFrame(micMeterHandle);
}

// ========== Helpers ==========

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function getVideoConstraints(quality) {
  switch (quality) {
    case 'high':   return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    case 'medium': return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    case 'low':    return { width: { ideal: 854 },  height: { ideal: 480 }, frameRate: { ideal: 24 } };
    default:       return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  }
}

function getMimeType(format) {
  if (format === 'mp4' && MediaRecorder.isTypeSupported('video/mp4')) return 'video/mp4';
  const codecs = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const c of codecs) if (MediaRecorder.isTypeSupported(c)) return c;
  return 'video/webm';
}

function getBitrate(quality) {
  switch (quality) {
    case 'high':   return 8_000_000;
    case 'medium': return 5_000_000;
    case 'low':    return 2_500_000;
    default:       return 5_000_000;
  }
}

// Timer — tracks accumulated active time, excludes paused periods.
let tStart = 0, tHandle = null, tAccum = 0;
function renderTimer(totalMs) {
  const s = Math.floor(totalMs / 1000);
  const m = Math.floor(s / 60);
  el.timer.textContent = String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function startTimer() {
  tAccum = 0;
  tStart = performance.now();
  el.timer.classList.add('recording');
  const tick = () => {
    renderTimer(tAccum + (performance.now() - tStart));
    tHandle = requestAnimationFrame(tick);
  };
  tick();
}
function pauseTimer() {
  if (tHandle) cancelAnimationFrame(tHandle);
  tHandle = null;
  tAccum += performance.now() - tStart;
  renderTimer(tAccum);
}
function resumeTimer() {
  tStart = performance.now();
  const tick = () => {
    renderTimer(tAccum + (performance.now() - tStart));
    tHandle = requestAnimationFrame(tick);
  };
  tick();
}
function stopTimer() {
  if (tHandle) cancelAnimationFrame(tHandle);
  tHandle = null;
}
