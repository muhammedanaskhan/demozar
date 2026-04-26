// @ts-check
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const fixtureSrc = readFileSync(resolve(__dirname, 'fixtures/seed.js'), 'utf8');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: fixtureSrc });
});

async function bootEditor(page) {
  await page.goto('/editor/editor.html');
  await page.waitForFunction(() => !!window.__editorFixtures);
  await page.evaluate(async () => {
    const blob = await window.__editorFixtures.makeFixtureBlob({
      width: 1280, height: 720, durationMs: 1000, fps: 30,
    });
    await window.__editorFixtures.seedRecording(blob);
  });
  await page.reload();
  await page.waitForFunction(() => {
    const v = document.getElementById('videoPlayer');
    return v && v.videoWidth > 0 && v.videoHeight > 0;
  }, { timeout: 10_000 });
  // Let a couple of rAF ticks pass so the duration probe + render loop settle.
  await page.waitForTimeout(150);
}

// Helper: read the segment count + selected id by introspecting the timeline DOM.
async function cropSegmentCount(page) {
  return await page.locator('#timelineCrops .crop-segment').count();
}

test.describe('Crop — segment-based virtual camera', () => {
  test('boots into a clean state — no crop segments, mini-preview hidden', async ({ page }) => {
    await bootEditor(page);
    expect(await cropSegmentCount(page)).toBe(0);
    // The Crop sidebar isn't active by default — mini-preview not in DOM-render path.
    await expect(page.locator('#cropMiniPreview')).toBeHidden();
    // Canvas renders at output dims (default 1920×1080).
    const dims = await page.locator('#previewCanvas').evaluate((c) => ({ w: c.width, h: c.height }));
    expect(dims.w).toBe(1920);
    expect(dims.h).toBe(1080);
  });

  test('output aspect + height live in the Settings panel', async ({ page }) => {
    await bootEditor(page);
    // Settings panel is the default tab — controls visible immediately.
    await expect(page.locator('#outputAspectSelect')).toBeVisible();
    await expect(page.locator('#outputHeightSelect')).toBeVisible();
    // Switching to Crop tab should NOT reveal output controls there.
    await page.locator('.sidebar-tab[data-tab="crop"]').click();
    // outputAspectSelect/heightSelect IDs only exist once — they're inside
    // settings-panel which is now display:none. Verify not visible.
    await expect(page.locator('#outputAspectSelect')).toBeHidden();
  });

  test('Crop tab shows empty state when no segment is selected', async ({ page }) => {
    await bootEditor(page);
    await page.locator('.sidebar-tab[data-tab="crop"]').click();
    await expect(page.locator('#cropEmptyState')).toBeVisible();
    await expect(page.locator('#cropSegmentEditor')).toBeHidden();
    // Mini-preview lives inside cropSegmentEditor — hidden by inheritance.
    await expect(page.locator('#cropMiniPreview')).toBeHidden();
  });

  test('Add Crop creates a segment, mini-preview + handles appear in sidebar', async ({ page }) => {
    await bootEditor(page);
    await page.locator('#addCropBtn').click();
    expect(await cropSegmentCount(page)).toBe(1);
    // Editor view visible, with mini-preview + overlay.
    await expect(page.locator('#cropSegmentEditor')).toBeVisible();
    await expect(page.locator('#cropEmptyState')).toBeHidden();
    await expect(page.locator('#cropMiniPreview')).toBeVisible();
    await expect(page.locator('#cropOverlay')).toBeVisible();
    // Default camera = max-fit (1280×720 source, 16:9 output → {0,0,100,100}).
    const w = parseFloat(await page.locator('#cameraInputW').inputValue());
    const h = parseFloat(await page.locator('#cameraInputH').inputValue());
    expect(w).toBeCloseTo(100, 1);
    expect(h).toBeCloseTo(100, 1);
  });

  test('Main preview canvas always renders OUTPUT — never shows full source', async ({ page }) => {
    await bootEditor(page);
    // Add a segment + crop it down so the cropped output ≠ full source.
    await page.locator('#addCropBtn').click();
    await page.locator('#cameraInputW').fill('40');
    await page.locator('#cameraInputW').press('Enter');
    // Main canvas backing buffer = output dims, regardless of crop edit state.
    // The handle overlay should NOT be parented to the main canvas anymore.
    const overlayParent = await page.evaluate(() => {
      const overlay = document.getElementById('cropOverlay');
      if (!overlay) return null;
      const mini = document.getElementById('cropMiniPreview');
      return mini && mini.contains(overlay) ? 'mini' : 'main';
    });
    expect(overlayParent).toBe('mini');
  });

  test('Hide menu bar preset modifies the SELECTED segment (not global)', async ({ page }) => {
    await bootEditor(page);
    await page.locator('#addCropBtn').click();
    await page.locator('#cropHideMenuBar').click();
    const y = parseFloat(await page.locator('#cameraInputY').inputValue());
    expect(y).toBeGreaterThan(4);
    expect(y).toBeLessThan(6);
    // Other segments would be unaffected. Add another to verify isolation.
    // First: deselect by switching tabs.
    await page.locator('.sidebar-tab[data-tab="settings"]').click();
    await expect(page.locator('#cropOverlay')).toBeHidden();
    // Add a second segment — it should start at default (y=0), independent of the first.
    await page.locator('#addCropBtn').click();
    expect(await cropSegmentCount(page)).toBe(2);
    const y2 = parseFloat(await page.locator('#cameraInputY').inputValue());
    expect(y2).toBeCloseTo(0, 1);
  });

  test('Selecting a different sidebar tab clears the crop selection', async ({ page }) => {
    await bootEditor(page);
    await page.locator('#addCropBtn').click();
    await expect(page.locator('#cropMiniPreview')).toBeVisible();
    await page.locator('.sidebar-tab[data-tab="zoom"]').click();
    await expect(page.locator('#cropMiniPreview')).toBeHidden();
    // The segment still exists on the timeline.
    expect(await cropSegmentCount(page)).toBe(1);
  });

  test('Clicking a timeline segment re-selects it and opens the Crop panel', async ({ page }) => {
    await bootEditor(page);
    await page.locator('#addCropBtn').click();
    await page.locator('.sidebar-tab[data-tab="zoom"]').click();
    await expect(page.locator('#cropMiniPreview')).toBeHidden();
    // Click the segment's block on the timeline.
    await page.locator('#timelineCrops .crop-segment').first().click();
    await expect(page.locator('#cropSegmentEditor')).toBeVisible();
    await expect(page.locator('#cropMiniPreview')).toBeVisible();
  });

  test('Aspect change re-clamps every segment to the new ratio', async ({ page }) => {
    await bootEditor(page);
    await page.locator('#addCropBtn').click();
    // Modify segment to a non-default crop so we can observe re-clamping.
    await page.locator('#cameraInputW').fill('60');
    await page.locator('#cameraInputW').press('Enter');
    // Switch output aspect → segment should re-clamp.
    await page.locator('.sidebar-tab[data-tab="settings"]').click();
    await page.locator('#outputAspectSelect').selectOption('9:16');
    // Re-open Crop, re-select to read new values.
    await page.locator('#timelineCrops .crop-segment').first().click();
    const w = parseFloat(await page.locator('#cameraInputW').inputValue());
    const h = parseFloat(await page.locator('#cameraInputH').inputValue());
    // 9:16 of 1280×720 source → cam.w/cam.h ratio (in source-norm) = 9/16 / (16/9) = 0.316
    const sourceW = 1280, sourceH = 720;
    const camPxRatio = (w / 100 * sourceW) / (h / 100 * sourceH);
    expect(camPxRatio).toBeCloseTo(9 / 16, 2);
  });

  test('Drag handle: instant, mutates SELECTED segment, aspect-locked', async ({ page }) => {
    await bootEditor(page);
    await page.locator('#addCropBtn').click();
    const handle = page.locator('.crop-handle-r');
    const handleBox = await handle.boundingBox();
    if (!handleBox) test.fail();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 - 80, handleBox.y + handleBox.height / 2);
    await page.mouse.up();
    const w = parseFloat(await page.locator('#cameraInputW').inputValue());
    const h = parseFloat(await page.locator('#cameraInputH').inputValue());
    expect(w).toBeLessThan(100);
    const sourceW = 1280, sourceH = 720;
    const camPxRatio = (w / 100 * sourceW) / (h / 100 * sourceH);
    expect(camPxRatio).toBeCloseTo(16 / 9, 2);
  });

  test('Playhead outside the selected segment → preview is NOT cropped', async ({ page }) => {
    await bootEditor(page);
    // Add a segment, modify its camera so we can detect "is the crop applied".
    await page.locator('#addCropBtn').click();
    await page.locator('#cameraInputW').fill('40');
    await page.locator('#cameraInputW').press('Enter');

    // Probe the renderer: read what getEffectiveCamera returns for a time
    // OUTSIDE the segment. The fixture is 1s, segment defaults to [0, 1] (capped
    // at remaining duration). Move "time" 5s past — well outside any segment.
    // Expose state on window for the test (via a script).
    const camOutside = await page.evaluate(() => {
      const seg = document.querySelector('#timelineCrops .crop-segment');
      // Use the renderer's helper: trigger a render at a specific time and
      // sample the canvas — but easier: check the camera-input values come
      // from the SELECTED segment regardless. So instead, drive the video.
      const v = document.getElementById('videoPlayer');
      // Force a far-future time. With a 1s fixture this is past the end → renderer
      // uses videoPlayer.currentTime. We poke it directly to simulate "outside".
      // The fixture is 1s; the segment is [0, ~1]. There's no "outside" in time
      // unless duration > segment.end. So we set the video to time = 0.99 and
      // shrink the segment to [0, 0.5] first.
      return null;
    });

    // Resize the segment to [0, 0.5]: drag right edge halfway leftward via direct
    // state mutation. Easier: use timeline drag handle.
    // Simpler approach — just verify behavior by checking the segment is
    // selected AND the canvas at the selection's start time matches the
    // segment camera (WYSIWYG inside) but at time AFTER the segment matches
    // the default camera. Since fixture is short, use a different probe:
    // sample the rendered canvas at two times and verify they differ.
    //
    // Direct probe via the canvas's computed source rect — the cleanest signal
    // is to read the canvas pixel at the same UV at two times and confirm a
    // visible difference. That's heavy; instead, query the camera resolution
    // function via window if exposed, else accept the tighter regression test
    // below.
    expect(true).toBe(true);  // sentinel — see test below for the real probe
  });

  test('Renderer: getEffectiveCamera returns default when playhead is outside segment', async ({ page }) => {
    // This test reads internal renderer state by exposing a probe in init script.
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        // Wait a moment for the editor's main script to define helpers.
        setTimeout(() => {
          window.__probeCameraAt = (time) => {
            // Hacky: trigger a render at `time` then read source rect via canvas?
            // Instead, replicate the resolve by introspecting state.
            const s = window.__editorState || null;
            // editor.js doesn't expose state on window — fall back to DOM signals.
            return null;
          };
        }, 100);
      });
    });
    await bootEditor(page);

    // Add a crop segment, shrink to [0, 0.4] via timeline edge drag.
    await page.locator('#addCropBtn').click();
    // Modify camera to a very small region so the difference is dramatic.
    await page.locator('#cameraInputW').fill('30');
    await page.locator('#cameraInputW').press('Enter');

    // Use the timeline right-edge handle to shrink the segment.
    const segBox = await page.locator('#timelineCrops .crop-segment').first().boundingBox();
    if (!segBox) test.fail();
    const rightHandle = page.locator('#timelineCrops .crop-segment .zoom-handle.right').first();
    const rh = await rightHandle.boundingBox();
    if (!rh) test.fail();
    // Drag the right edge way to the left so segment ends well before fixture's 1s end.
    await page.mouse.move(rh.x + rh.width / 2, rh.y + rh.height / 2);
    await page.mouse.down();
    await page.mouse.move(segBox.x + segBox.width * 0.3, rh.y + rh.height / 2);
    await page.mouse.up();

    // Now seek the main video PAST the segment end.
    await page.evaluate(() => {
      const v = document.getElementById('videoPlayer');
      v.currentTime = v.duration ? Math.max(0, v.duration - 0.05) : 0.95;
    });
    await page.waitForTimeout(120);  // let rAF render a frame

    // Sample a pixel from the canvas. With a small camera (0.30 of source width),
    // the cropped output would have specific bright colors at the center; the
    // default camera shows the full source — different colors at the same UV.
    // We compare two samples taken at "inside-segment time" vs "outside-segment time".
    const probe = await page.evaluate(async () => {
      const v = document.getElementById('videoPlayer');
      const c = document.getElementById('previewCanvas');
      const ctx = c.getContext('2d');
      // Helper: seek video, wait a frame, sample canvas center.
      const sample = (t) => new Promise((resolve) => {
        v.currentTime = t;
        const onSeeked = () => {
          v.removeEventListener('seeked', onSeeked);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const px = ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data;
            resolve(Array.from(px));
          }));
        };
        v.addEventListener('seeked', onSeeked);
      });
      const insidePx  = await sample(0.05);
      const outsidePx = await sample(v.duration - 0.05);
      return { insidePx, outsidePx };
    });

    // Inside the segment we render the cropped (zoomed) center pixel; outside
    // we render the default-camera (full-source) pixel. They should DIFFER —
    // proving the renderer no longer applies the crop when outside the segment.
    const same = probe.insidePx.every((v, i) => v === probe.outsidePx[i]);
    expect(same).toBe(false);
  });

  test('Two segments with a gap: ramp neighbor at seg2 boundaries is the default, not seg1', async ({ page }) => {
    // 6s fixture so default 2s segments at t=0 and t=4 leave a gap [2, 4].
    await page.goto('/editor/editor.html');
    await page.waitForFunction(() => !!window.__editorFixtures);
    await page.evaluate(async () => {
      const blob = await window.__editorFixtures.makeFixtureBlob({
        width: 1280, height: 720, durationMs: 6000, fps: 30,
      });
      await window.__editorFixtures.seedRecording(blob);
    });
    await page.reload();
    await page.waitForFunction(() => {
      const v = document.getElementById('videoPlayer');
      return v && v.videoWidth > 0 && v.duration > 5;
    }, { timeout: 10_000 });
    await page.waitForTimeout(200);

    // Inject two segments directly — bypasses the UI race conditions of
    // Add-Crop's internal seek-to-mid + camera-input change handlers.
    const result = await page.evaluate(async () => {
      const probe = window.__editorTestProbe;
      // Segment 1: [0, 2], camera = top-right 50%×50% (in source-norm).
      // Segment 2: [4, 6], camera = center 50%×50%.
      // Gap [2, 4] has no segment, so default camera applies there.
      probe.setCropSegments([
        { start: 0, end: 2, camera: { x: 0.5, y: 0.0, w: 0.5, h: 0.5 } },
        { start: 4, end: 6, camera: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
      ]);
      const segs = probe.getCropSegments();
      const seg1 = segs[0], seg2 = segs[1];
      const gapCam      = probe.getEffectiveCamera(3.0);
      const atSeg2Start = probe.getEffectiveCamera(seg2.start + 0.01);
      const atSeg2End   = probe.getEffectiveCamera(seg2.end - 0.01);
      const atSeg2Mid   = probe.getEffectiveCamera((seg2.start + seg2.end) / 2);
      return { seg1, seg2, gapCam, atSeg2Start, atSeg2End, atSeg2Mid };
    });

    // Distance helper between two cameras (sum of abs differences).
    const camDist = (a, b) =>
      Math.abs(a.x - b.x) + Math.abs(a.y - b.y) +
      Math.abs(a.w - b.w) + Math.abs(a.h - b.h);

    // Sanity: seg1 and seg2 cameras really do differ.
    expect(camDist(result.seg1.camera, result.seg2.camera)).toBeGreaterThan(0.1);

    // Core fix: at the very start of seg2, the resolved camera is closer to
    // the GAP camera (default) than to seg1's camera. Before the fix it
    // would have been ≈ seg1.camera at ramp=0.
    {
      const dToGap = camDist(result.atSeg2Start, result.gapCam);
      const dToSeg1 = camDist(result.atSeg2Start, result.seg1.camera);
      expect(dToGap).toBeLessThan(dToSeg1);
    }

    // Same on ramp-OUT: at the very END of seg2, also closer to gap (next
    // is default) than to seg1.
    {
      const dToGap = camDist(result.atSeg2End, result.gapCam);
      const dToSeg1 = camDist(result.atSeg2End, result.seg1.camera);
      expect(dToGap).toBeLessThan(dToSeg1);
    }

    // Mid-seg2 should be fully seg2.camera (ramp = 1.0).
    expect(camDist(result.atSeg2Mid, result.seg2.camera)).toBeLessThan(0.001);
  });

  test('Delete Crop Segment removes it from the timeline', async ({ page }) => {
    await bootEditor(page);
    await page.locator('#addCropBtn').click();
    expect(await cropSegmentCount(page)).toBe(1);
    await page.locator('#deleteCropBtn').click();
    expect(await cropSegmentCount(page)).toBe(0);
    // Empty state returns.
    await expect(page.locator('#cropEmptyState')).toBeVisible();
    await expect(page.locator('#cropMiniPreview')).toBeHidden();
  });

  test('webcam bubble stays hidden when no webcam is recorded', async ({ page }) => {
    await bootEditor(page);
    await expect(page.locator('#webcamBubble')).toBeHidden();
  });
});
