// Spotlight Overlay for Cursor Effects
(function() {
  'use strict';

  let canvas = null;
  let ctx = null;
  let isActive = false;
  let animationId = null;
  let mouseX = 0;
  let mouseY = 0;
  let targetX = 0;
  let targetY = 0;
  let settings = {
    size: 80,
    color: '#6366f1',
    style: 'glow' // glow, ring, solid
  };

  // Easing for smooth cursor following
  const easing = 0.15;

  // Create and inject the canvas overlay
  function createOverlay() {
    if (canvas) return;

    canvas = document.createElement('canvas');
    canvas.id = 'spotlight-overlay';
    canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 2147483647;
      mix-blend-mode: normal;
    `;

    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');

    // Set canvas size
    resizeCanvas();

    // Add resize listener
    window.addEventListener('resize', resizeCanvas);
  }

  // Resize canvas to window size
  function resizeCanvas() {
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.scale(dpr, dpr);
  }

  // Remove overlay
  function removeOverlay() {
    if (canvas) {
      canvas.remove();
      canvas = null;
      ctx = null;
    }
    window.removeEventListener('resize', resizeCanvas);
  }

  // Parse color to RGB
  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 99, g: 102, b: 241 };
  }

  // Draw spotlight effect
  function drawSpotlight() {
    if (!ctx || !isActive) return;

    // Smooth cursor following
    mouseX += (targetX - mouseX) * easing;
    mouseY += (targetY - mouseY) * easing;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const rgb = hexToRgb(settings.color);
    const size = settings.size;

    switch (settings.style) {
      case 'glow':
        drawGlowEffect(mouseX, mouseY, size, rgb);
        break;
      case 'ring':
        drawRingEffect(mouseX, mouseY, size, rgb);
        break;
      case 'solid':
        drawSolidEffect(mouseX, mouseY, size, rgb);
        break;
      default:
        drawGlowEffect(mouseX, mouseY, size, rgb);
    }

    animationId = requestAnimationFrame(drawSpotlight);
  }

  // Glow effect - soft radial gradient
  function drawGlowEffect(x, y, size, rgb) {
    // Outer glow
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
    gradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`);
    gradient.addColorStop(0.4, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
    gradient.addColorStop(0.7, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.05)`);
    gradient.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);

    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Inner bright spot
    const innerGradient = ctx.createRadialGradient(x, y, 0, x, y, size * 0.3);
    innerGradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`);
    innerGradient.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);

    ctx.beginPath();
    ctx.arc(x, y, size * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = innerGradient;
    ctx.fill();
  }

  // Ring effect - circular outline
  function drawRingEffect(x, y, size, rgb) {
    // Outer ring with glow
    ctx.beginPath();
    ctx.arc(x, y, size * 0.6, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Outer glow
    ctx.beginPath();
    ctx.arc(x, y, size * 0.6, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.2)`;
    ctx.lineWidth = 8;
    ctx.stroke();

    // Inner subtle fill
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size * 0.5);
    gradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.1)`);
    gradient.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);

    ctx.beginPath();
    ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  // Solid effect - filled circle with subtle gradient
  function drawSolidEffect(x, y, size, rgb) {
    // Main circle
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size * 0.5);
    gradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`);
    gradient.addColorStop(0.7, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`);
    gradient.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);

    ctx.beginPath();
    ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Subtle border
    ctx.beginPath();
    ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Mouse move handler
  function handleMouseMove(e) {
    targetX = e.clientX;
    targetY = e.clientY;
  }

  // Start spotlight
  function startSpotlight(newSettings) {
    if (newSettings) {
      settings = { ...settings, ...newSettings };
    }

    createOverlay();
    isActive = true;

    // Initialize position
    mouseX = window.innerWidth / 2;
    mouseY = window.innerHeight / 2;
    targetX = mouseX;
    targetY = mouseY;

    // Add mouse listener
    document.addEventListener('mousemove', handleMouseMove);

    // Start animation
    if (!animationId) {
      drawSpotlight();
    }
  }

  // Stop spotlight
  function stopSpotlight() {
    isActive = false;

    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }

    document.removeEventListener('mousemove', handleMouseMove);
    removeOverlay();
  }

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'START_SPOTLIGHT':
        startSpotlight(message.settings);
        sendResponse({ success: true });
        break;

      case 'STOP_SPOTLIGHT':
        stopSpotlight();
        sendResponse({ success: true });
        break;

      case 'UPDATE_SPOTLIGHT_SETTINGS':
        if (message.settings) {
          settings = { ...settings, ...message.settings };
        }
        sendResponse({ success: true });
        break;
    }
    return true;
  });

  // Check if we should auto-start (from injected settings)
  if (window.__spotlightSettings) {
    startSpotlight(window.__spotlightSettings);
    delete window.__spotlightSettings;
  }
})();
