// Recording state
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentSettings = null;

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages meant for offscreen
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
      return true; // Will respond asynchronously

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

    // Build getDisplayMedia constraints
    const displayMediaOptions = {
      video: {
        cursor: 'always',
        ...getVideoConstraints(settings.quality)
      },
      audio: settings.audioEnabled
    };

    // Add source hints based on selection
    if (settings.source === 'tab') {
      displayMediaOptions.preferCurrentTab = true;
      displayMediaOptions.selfBrowserSurface = 'include';
    } else if (settings.source === 'window') {
      displayMediaOptions.selfBrowserSurface = 'exclude';
    }

    if (settings.audioEnabled) {
      displayMediaOptions.systemAudio = 'include';
    }

    // Request display media
    mediaStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

    // Handle stream ending (user clicked "Stop sharing")
    mediaStream.getVideoTracks()[0].addEventListener('ended', () => {
      stopRecording();
    });

    // Notify background that recording started
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });

    // Start MediaRecorder
    startMediaRecorder(settings);

  } catch (error) {
    console.error('Error starting recording:', error);
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
      return {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      };
    case 'medium':
      return {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      };
    case 'low':
      return {
        width: { ideal: 854 },
        height: { ideal: 480 },
        frameRate: { ideal: 24 }
      };
    default:
      return {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      };
  }
}

// Start MediaRecorder
function startMediaRecorder(settings) {
  const mimeType = getMimeType(settings.format);
  const options = {
    mimeType: mimeType,
    videoBitsPerSecond: getBitrate(settings.quality)
  };

  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  } catch (e) {
    console.log('Falling back to default MediaRecorder options');
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    processRecording();
  };

  mediaRecorder.onerror = (event) => {
    console.error('MediaRecorder error:', event.error);
    sendRecordingError('Recording error occurred');
  };

  // Start recording, collect data every second
  mediaRecorder.start(1000);
  console.log('MediaRecorder started');
}

// Get appropriate MIME type
function getMimeType(format) {
  if (format === 'mp4') {
    if (MediaRecorder.isTypeSupported('video/mp4')) {
      return 'video/mp4';
    }
    console.log('MP4 not supported, falling back to WebM');
  }

  // WebM codecs preference order
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
    case 'high':
      return 8000000; // 8 Mbps
    case 'medium':
      return 5000000; // 5 Mbps
    case 'low':
      return 2500000; // 2.5 Mbps
    default:
      return 5000000;
  }
}

// Stop recording
function stopRecording() {
  console.log('Stopping recording...');

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
    console.log('Recording paused');
  }
}

// Resume recording
function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    console.log('Recording resumed');
  }
}

// Process recording and send to background
async function processRecording() {
  console.log('Processing recording, chunks:', recordedChunks.length);

  if (recordedChunks.length === 0) {
    sendRecordingError('No recording data captured');
    return;
  }

  try {
    const mimeType = mediaRecorder?.mimeType || 'video/webm';
    const blob = new Blob(recordedChunks, { type: mimeType });

    console.log('Recording blob size:', blob.size);

    // Determine format from mimeType
    let format = 'webm';
    if (mimeType.includes('mp4')) {
      format = 'mp4';
    }

    // Convert to data URL for transfer
    const reader = new FileReader();
    reader.onload = () => {
      console.log('Sending recording data to background');
      chrome.runtime.sendMessage({
        type: 'RECORDING_DATA',
        data: reader.result,
        format: format
      });
    };
    reader.onerror = () => {
      console.error('FileReader error');
      sendRecordingError('Failed to process recording');
    };
    reader.readAsDataURL(blob);

  } catch (error) {
    console.error('Error processing recording:', error);
    sendRecordingError('Failed to process recording');
  }

  // Clean up
  recordedChunks = [];
  mediaRecorder = null;
}

// Send recording error to background
function sendRecordingError(error) {
  console.error('Recording error:', error);
  chrome.runtime.sendMessage({
    type: 'RECORDING_ERROR',
    error: error
  });
}
