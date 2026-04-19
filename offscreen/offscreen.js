// Recording state
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentSettings = null;

console.log('[Offscreen] Script loaded and ready');

// Helper to log to background (appears in service worker console)
function logToBackground(msg) {
  chrome.runtime.sendMessage({ type: 'LOG', message: msg }).catch(() => {});
}

logToBackground('Offscreen script loaded');

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Offscreen] Received message:', message.type, 'target:', message.target);

  if (message.target !== 'offscreen') {
    return false;
  }

  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.settings).then(() => {
        sendResponse({ success: true });
      }).catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
      return true;

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
  }

  return false;
});

// Start recording
async function startRecording(settings) {
  try {
    currentSettings = settings;
    recordedChunks = [];

    console.log('[Offscreen] Starting recording with settings:', settings);
    logToBackground('Starting recording, source: ' + settings.source);

    // Check if we have a stream ID for tab capture
    if (settings.streamId) {
      logToBackground('Using tab capture with stream ID');

      try {
        // Use getUserMedia with the tab capture stream ID
        const videoConstraints = getVideoConstraints(settings.quality);

        const constraints = {
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: settings.streamId
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: settings.streamId,
              maxWidth: videoConstraints.width?.ideal || 1920,
              maxHeight: videoConstraints.height?.ideal || 1080,
              maxFrameRate: videoConstraints.frameRate?.ideal || 30
            }
          }
        };

        logToBackground('Calling getUserMedia...');
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

        const videoTracks = mediaStream.getVideoTracks();
        const audioTracks = mediaStream.getAudioTracks();
        logToBackground('Got stream - video: ' + videoTracks.length + ', audio: ' + audioTracks.length);

        if (videoTracks.length === 0) {
          throw new Error('No video track obtained from tab capture');
        }

        // Verify track is live
        const videoTrack = videoTracks[0];
        logToBackground('Video track state: ' + videoTrack.readyState + ', enabled: ' + videoTrack.enabled);
        if (videoTrack.readyState !== 'live') {
          throw new Error('Video track is not live: ' + videoTrack.readyState);
        }
      } catch (tabError) {
        logToBackground('Tab capture FAILED: ' + tabError.message);
        throw new Error('Tab capture failed: ' + tabError.message);
      }
    } else if (settings.source === 'tab') {
      // Tab capture requested but no stream ID - this shouldn't happen
      console.error('[Offscreen] Tab capture requested but no stream ID provided');
      throw new Error('Tab capture requires a stream ID. Please try screen capture instead.');
    } else {
      // Use getDisplayMedia for screen/window capture
      console.log('[Offscreen] Using getDisplayMedia for', settings.source);

      const displayMediaOptions = {
        video: {
          cursor: 'always',
          ...getVideoConstraints(settings.quality)
        },
        audio: settings.audioEnabled
      };

      if (settings.source === 'window') {
        displayMediaOptions.selfBrowserSurface = 'exclude';
      }

      if (settings.audioEnabled) {
        displayMediaOptions.systemAudio = 'include';
      }

      mediaStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
      console.log('[Offscreen] Got display media stream');
    }

    // Handle stream ending
    mediaStream.getVideoTracks()[0].addEventListener('ended', () => {
      logToBackground('Stream ended by user/system');
      stopRecording();
    });

    logToBackground('Starting MediaRecorder...');
    // Start MediaRecorder directly on the stream
    startMediaRecorder(settings);

    // Notify background that recording started
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });

  } catch (error) {
    console.error('[Offscreen] Error starting recording:', error);
    const errorMessage = error.name === 'NotAllowedError'
      ? 'Permission denied or cancelled'
      : error.message;
    sendRecordingError(errorMessage);
  }
}

// Get video constraints based on quality
function getVideoConstraints(quality) {
  switch (quality) {
    case 'high':
      return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    case 'medium':
      return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    case 'low':
      return { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } };
    default:
      return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  }
}

// Start MediaRecorder
function startMediaRecorder(settings) {
  const mimeType = getMimeType(settings.format);
  const options = {
    mimeType: mimeType,
    videoBitsPerSecond: getBitrate(settings.quality)
  };

  console.log('[Offscreen] Creating MediaRecorder with:', options);

  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  } catch (e) {
    console.log('[Offscreen] Falling back to default options');
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
      logToBackground('Chunk: ' + event.data.size + ' bytes, total: ' + recordedChunks.length);
    } else {
      logToBackground('Empty chunk received!');
    }
  };

  mediaRecorder.onstop = () => {
    logToBackground('MediaRecorder stopped, chunks: ' + recordedChunks.length);
    processRecording();
  };

  mediaRecorder.onerror = (event) => {
    console.error('[Offscreen] MediaRecorder error:', event.error);
    sendRecordingError('Recording error occurred');
  };

  mediaRecorder.onstart = () => {
    console.log('[Offscreen] MediaRecorder started, state:', mediaRecorder.state);
    // Log stream state
    if (mediaStream) {
      const tracks = mediaStream.getTracks();
      tracks.forEach(track => {
        console.log('[Offscreen] Track:', track.kind, 'state:', track.readyState, 'enabled:', track.enabled);
      });
    }
  };

  console.log('[Offscreen] Starting MediaRecorder...');
  mediaRecorder.start(1000);
  console.log('[Offscreen] MediaRecorder.start() called, state:', mediaRecorder.state);
}

// Get appropriate MIME type
function getMimeType(format) {
  if (format === 'mp4' && MediaRecorder.isTypeSupported('video/mp4')) {
    return 'video/mp4';
  }

  const codecs = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  for (const codec of codecs) {
    if (MediaRecorder.isTypeSupported(codec)) {
      return codec;
    }
  }

  return 'video/webm';
}

// Get bitrate based on quality
function getBitrate(quality) {
  switch (quality) {
    case 'high': return 8000000;
    case 'medium': return 5000000;
    case 'low': return 2500000;
    default: return 5000000;
  }
}

// Stop recording
function stopRecording() {
  console.log('[Offscreen] Stopping recording...');

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
}

// Pause recording
function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    console.log('[Offscreen] Recording paused');
  }
}

// Resume recording
function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    console.log('[Offscreen] Recording resumed');
  }
}

// Process recording and send to background
async function processRecording() {
  logToBackground('Processing recording, chunks: ' + recordedChunks.length);

  if (recordedChunks.length === 0) {
    logToBackground('ERROR: No chunks to process!');
    sendRecordingError('No recording data captured');
    return;
  }

  try {
    const mimeType = mediaRecorder?.mimeType || 'video/webm';
    logToBackground('Creating blob with mimeType: ' + mimeType);
    const blob = new Blob(recordedChunks, { type: mimeType });

    logToBackground('Blob created, size: ' + (blob.size / 1024 / 1024).toFixed(2) + ' MB');

    let format = 'webm';
    if (mimeType.includes('mp4')) {
      format = 'mp4';
    }

    const reader = new FileReader();
    reader.onload = () => {
      logToBackground('FileReader done, sending RECORDING_DATA to background');
      chrome.runtime.sendMessage({
        type: 'RECORDING_DATA',
        data: reader.result,
        format: format
      });
    };
    reader.onerror = () => {
      logToBackground('FileReader ERROR');
      sendRecordingError('Failed to process recording');
    };
    reader.readAsDataURL(blob);

  } catch (error) {
    logToBackground('processRecording ERROR: ' + error.message);
    sendRecordingError('Failed to process recording');
  }

  recordedChunks = [];
  mediaRecorder = null;
}

// Send recording error
function sendRecordingError(error) {
  console.error('[Offscreen] Error:', error);
  chrome.runtime.sendMessage({
    type: 'RECORDING_ERROR',
    error: error
  });
}
