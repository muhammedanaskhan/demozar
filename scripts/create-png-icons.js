#!/usr/bin/env node
// Create PNG icons without external dependencies
// Uses pure Node.js to create valid PNG files

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
  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(6, 9);  // color type (RGBA)
  ihdr.writeUInt8(0, 10); // compression method
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // interlace method

  // Create raw image data with filter bytes
  const rawData = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rawData[y * (width * 4 + 1)] = 0; // Filter type: None
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (width * 4 + 1) + 1 + x * 4;
      rawData[dstIdx] = pixels[srcIdx];
      rawData[dstIdx + 1] = pixels[srcIdx + 1];
      rawData[dstIdx + 2] = pixels[srcIdx + 2];
      rawData[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }

  // Compress image data
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  // Create IEND chunk
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
  } : { r: 99, g: 102, b: 241 };
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

// Generate icon pixels
function generateIconPixels(size) {
  const pixels = new Uint8Array(size * size * 4);
  const center = size / 2;
  const cornerRadius = size * 0.2;

  const color1 = hexToRgb('#6366f1');
  const color2 = hexToRgb('#8b5cf6');

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Check if inside rounded rectangle
      let inside = false;
      if (x >= cornerRadius && x < size - cornerRadius) {
        inside = true;
      } else if (y >= cornerRadius && y < size - cornerRadius) {
        inside = true;
      } else {
        // Check corners
        const corners = [
          [cornerRadius, cornerRadius],
          [size - cornerRadius, cornerRadius],
          [cornerRadius, size - cornerRadius],
          [size - cornerRadius, size - cornerRadius]
        ];
        for (const [cx, cy] of corners) {
          const dx = x - cx;
          const dy = y - cy;
          if (Math.abs(x - center) >= Math.abs(cx - center) &&
              Math.abs(y - center) >= Math.abs(cy - center) &&
              dx * dx + dy * dy <= cornerRadius * cornerRadius) {
            inside = true;
            break;
          }
        }
      }

      if (!inside) {
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
        continue;
      }

      // Gradient color based on position
      const t = (x + y) / (size * 2);
      const bgColor = lerpColor(color1, color2, t);

      // Distance from center
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Outer ring
      const outerRingRadius = size * 0.35;
      const ringWidth = Math.max(1.5, size * 0.04);
      const outerRingDist = Math.abs(dist - outerRingRadius);

      // Inner circle
      const innerRadius = size * 0.15;

      if (dist < innerRadius) {
        // Inner white circle
        pixels[idx] = 255;
        pixels[idx + 1] = 255;
        pixels[idx + 2] = 255;
        pixels[idx + 3] = 255;
      } else if (outerRingDist < ringWidth) {
        // Outer ring (white with some antialiasing)
        const alpha = Math.max(0, 1 - outerRingDist / ringWidth);
        pixels[idx] = Math.round(lerp(bgColor.r, 255, alpha));
        pixels[idx + 1] = Math.round(lerp(bgColor.g, 255, alpha));
        pixels[idx + 2] = Math.round(lerp(bgColor.b, 255, alpha));
        pixels[idx + 3] = 255;
      } else if (outerRingDist < ringWidth * 2) {
        // Glow around ring
        const alpha = Math.max(0, (1 - (outerRingDist - ringWidth) / ringWidth) * 0.3);
        pixels[idx] = Math.round(lerp(bgColor.r, 255, alpha));
        pixels[idx + 1] = Math.round(lerp(bgColor.g, 255, alpha));
        pixels[idx + 2] = Math.round(lerp(bgColor.b, 255, alpha));
        pixels[idx + 3] = 255;
      } else {
        // Background
        pixels[idx] = bgColor.r;
        pixels[idx + 1] = bgColor.g;
        pixels[idx + 2] = bgColor.b;
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
  const pixels = generateIconPixels(size);
  const png = createPNG(size, size, pixels);
  const filename = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filename, png);
  console.log(`Created ${filename}`);
});

console.log('\nAll PNG icons created successfully!');
