// Browser-side fixture helpers. Imported by spec files via
// `await page.evaluate(seedRecording, opts)`.
//
// makeFixtureBlob():
//   Generates a 1-second 1280×720 WebM Blob via canvas+MediaRecorder.
//   Each frame is a different solid color so we can visually verify
//   playback in screenshots / trace viewer.
//
// seedRecording(blob, extras):
//   Writes the blob (+ optional cursor/click data + cameraSettings) into
//   the editor's IndexedDB store under key 'latest'. Idempotent.
//
// These functions are sourced as strings into the page via addInitScript
// in the spec, since Playwright can't call file-imported funcs directly
// in page context.

window.__editorFixtures = {
  async makeFixtureBlob({ width = 1280, height = 720, durationMs = 1000, fps = 30 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const stream = canvas.captureStream(fps);
    // Prefer vp9 (smallest), fall back to vp8 / generic.
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    return new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
      recorder.start(100);
      const totalFrames = Math.round((durationMs / 1000) * fps);
      let f = 0;
      const tick = () => {
        ctx.fillStyle = `hsl(${(f * 360) / totalFrames}, 80%, 45%)`;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 96px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`F${f}`, width / 2, height / 2);
        // Corner markers — useful to verify which part is cropped.
        const m = 60;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, m, m);                       // TL
        ctx.fillStyle = '#f00';
        ctx.fillRect(width - m, 0, m, m);               // TR
        ctx.fillStyle = '#0f0';
        ctx.fillRect(0, height - m, m, m);              // BL
        ctx.fillStyle = '#00f';
        ctx.fillRect(width - m, height - m, m, m);      // BR
        f++;
        if (f < totalFrames) requestAnimationFrame(tick);
        else setTimeout(() => recorder.stop(), 50);
      };
      tick();
    });
  },

  async seedRecording(blob, extras = {}) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('DaddyRecorder', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('recordings')) {
          db.createObjectStore('recordings');
        }
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(['recordings'], 'readwrite');
        tx.objectStore('recordings').put({
          blob,
          format: 'webm',
          timestamp: Date.now(),
          cursorData: extras.cursorData || [],
          clickData: extras.clickData || [],
          webcamBlob: extras.webcamBlob || null,
          webcamFormat: extras.webcamFormat || null,
          cameraSettings: extras.cameraSettings || null,
          cameraHideSegments: extras.cameraHideSegments || [],
        }, 'latest');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async clearRecording() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('DaddyRecorder');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();  // not fatal
    });
  },
};
