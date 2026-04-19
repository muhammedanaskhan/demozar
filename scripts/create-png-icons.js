#!/usr/bin/env node
// Create PNG icons for DaddyRecorder extension
// Uses pure Node.js to create valid PNG files with the 3D ribbon logo

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// PNG signature
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Create CRC table for PNG
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData));

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createPNG(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const rawData = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rawData[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (width * 4 + 1) + 1 + x * 4;
      rawData[dstIdx] = pixels[srcIdx];
      rawData[dstIdx + 1] = pixels[srcIdx + 1];
      rawData[dstIdx + 2] = pixels[srcIdx + 2];
      rawData[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    PNG_SIGNATURE,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', iend)
  ]);
}

// Color utilities
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
  return {
    r: Math.round(lerp(c1.r, c2.r, t)),
    g: Math.round(lerp(c1.g, c2.g, t)),
    b: Math.round(lerp(c1.b, c2.b, t))
  };
}

// Check if point is inside polygon
function pointInPolygon(x, y, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i][0], yi = vertices[i][1];
    const xj = vertices[j][0], yj = vertices[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// DaddyRecorder brand colors
const BRAND = {
  main1: hexToRgb('#17FEA0'),  // gradient start
  main2: hexToRgb('#01FD48'),  // gradient end
  dark1: hexToRgb('#0AA868'),  // shadow start
  dark2: hexToRgb('#027A26'),  // shadow end
  light1: hexToRgb('#B6FFD9'), // highlight start
  light2: hexToRgb('#6CFFA3'), // highlight end
  ink: hexToRgb('#0B1A12'),    // dark background
};

// Generate DaddyRecorder ribbon logo pixels
function generateDaddyRecorderLogo(size, withBackground = true) {
  const pixels = new Uint8Array(size * size * 4);
  const scale = size / 100;

  // Logo polygon paths (scaled from 100x100 viewBox)
  // Path 1: Bottom shadow - M 88 50 L 82 56 L 36 82 L 36 74 Z
  const shadow1 = [[88, 50], [82, 56], [36, 82], [36, 74]].map(p => [p[0] * scale, p[1] * scale]);

  // Path 2: Left shadow - M 36 74 L 36 82 L 30 78 L 30 70 Z
  const shadow2 = [[36, 74], [36, 82], [30, 78], [30, 70]].map(p => [p[0] * scale, p[1] * scale]);

  // Path 3: Main face - M 30 18 L 82 50 L 30 70 Z
  const mainFace = [[30, 18], [82, 50], [30, 70]].map(p => [p[0] * scale, p[1] * scale]);

  // Path 4: Top highlight - M 30 18 L 36 14 L 88 46 L 82 50 Z
  const topHighlight = [[30, 18], [36, 14], [88, 46], [82, 50]].map(p => [p[0] * scale, p[1] * scale]);

  // Path 5: Left highlight - M 30 18 L 36 14 L 36 74 L 30 70 Z
  const leftHighlight = [[30, 18], [36, 14], [36, 74], [30, 70]].map(p => [p[0] * scale, p[1] * scale]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const t = (x + y) / (size * 2); // gradient factor

      // Default: transparent or dark background
      if (withBackground) {
        pixels[idx] = BRAND.ink.r;
        pixels[idx + 1] = BRAND.ink.g;
        pixels[idx + 2] = BRAND.ink.b;
        pixels[idx + 3] = 255;
      } else {
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
      }

      // Check which part of the logo this pixel belongs to
      // Order matters - later parts are drawn on top

      if (pointInPolygon(x, y, shadow1) || pointInPolygon(x, y, shadow2)) {
        // Dark shadow
        const color = lerpColor(BRAND.dark1, BRAND.dark2, t);
        pixels[idx] = color.r;
        pixels[idx + 1] = color.g;
        pixels[idx + 2] = color.b;
        pixels[idx + 3] = 255;
      }

      if (pointInPolygon(x, y, mainFace)) {
        // Main green face
        const color = lerpColor(BRAND.main1, BRAND.main2, t);
        pixels[idx] = color.r;
        pixels[idx + 1] = color.g;
        pixels[idx + 2] = color.b;
        pixels[idx + 3] = 255;
      }

      if (pointInPolygon(x, y, topHighlight) || pointInPolygon(x, y, leftHighlight)) {
        // Light highlight
        const color = lerpColor(BRAND.light1, BRAND.light2, t);
        pixels[idx] = color.r;
        pixels[idx + 1] = color.g;
        pixels[idx + 2] = color.b;
        pixels[idx + 3] = 255;
      }
    }
  }

  return pixels;
}

// Generate recording icon (with red indicator)
function generateRecordingIcon(size) {
  const pixels = generateDaddyRecorderLogo(size, true);
  const scale = size / 100;

  // Add red recording dot in top-right
  const dotCenterX = 78 * scale;
  const dotCenterY = 22 * scale;
  const outerRadius = 18 * scale;
  const innerRadius = 10 * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - dotCenterX;
      const dy = y - dotCenterY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < innerRadius) {
        // White inner circle
        pixels[idx] = 255;
        pixels[idx + 1] = 255;
        pixels[idx + 2] = 255;
        pixels[idx + 3] = 255;
      } else if (dist < outerRadius) {
        // Red outer circle
        pixels[idx] = 239; // #ef4444
        pixels[idx + 1] = 68;
        pixels[idx + 2] = 68;
        pixels[idx + 3] = 255;
      }
    }
  }

  return pixels;
}

// Generate icons
const sizes = [16, 32, 48, 128];
const iconsDir = path.join(__dirname, '..', 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

sizes.forEach(size => {
  // Normal icon
  const pixels = generateDaddyRecorderLogo(size, true);
  const png = createPNG(size, size, pixels);
  const filename = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filename, png);
  console.log(`Created ${filename}`);

  // Recording icon
  const recPixels = generateRecordingIcon(size);
  const recPng = createPNG(size, size, recPixels);
  const recFilename = path.join(iconsDir, `icon${size}-recording.png`);
  fs.writeFileSync(recFilename, recPng);
  console.log(`Created ${recFilename}`);
});

console.log('\nAll DaddyRecorder icons created successfully!');
console.log('Brand colors: #17FEA0 → #01FD48 (green gradient)');
