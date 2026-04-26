import { defineConfig, devices } from '@playwright/test';

// Editor-only tests: load editor.html in isolation, seed IndexedDB with a
// synthetic recording, drive the crop UI from the test. No extension load —
// the editor is a plain web page that only needs IndexedDB + a video blob.
//
// Why a webserver? editor.html references ../assets/*.webp which only resolve
// when served over HTTP. file:// URLs break the asset paths and the
// background image cache.

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,  // tests share a global IndexedDB origin
  workers: 1,
  reporter: 'list',

  use: {
    baseURL: 'http://127.0.0.1:8765',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // The editor's MediaRecorder fixture needs a non-blocked permission to
    // record. Headless Chromium grants by default for canvas captureStream.
    launchOptions: {
      args: [
        '--allow-file-access-from-files',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Static server for editor.html + assets.
  webServer: {
    command: 'npx http-server -p 8765 -c-1 -s --cors',
    url: 'http://127.0.0.1:8765/editor/editor.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
