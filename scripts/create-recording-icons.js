#!/usr/bin/env node
// Create recording state icons (red dot indicator)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// PNG utilities (same as before)
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Generate recording icon (red/stop indicator)
function generateRecordingIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const center = size / 2;
  const cornerRadius = size * 0.2;

  // Red gradient for recording state
  const color1 = { r: 239, g: 68, b: 68 };   // red-500
  const color2 = { r: 220, g: 38, b: 38 };   // red-600

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

      // Gradient background
      const t = (x + y) / (size * 2);
      const bgR = Math.round(lerp(color1.r, color2.r, t));
      const bgG = Math.round(lerp(color1.g, color2.g, t));
      const bgB = Math.round(lerp(color1.b, color2.b, t));

      // Distance from center
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // White stop square in center
      const squareSize = size * 0.25;
      const inSquare = Math.abs(dx) < squareSize && Math.abs(dy) < squareSize;

      if (inSquare) {
        // White stop icon
        pixels[idx] = 255;
        pixels[idx + 1] = 255;
        pixels[idx + 2] = 255;
        pixels[idx + 3] = 255;
      } else {
        // Red background
        pixels[idx] = bgR;
        pixels[idx + 1] = bgG;
        pixels[idx + 2] = bgB;
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
  const pixels = generateRecordingIcon(size);
  const png = createPNG(size, size, pixels);
  const filename = path.join(iconsDir, `icon${size}-recording.png`);
  fs.writeFileSync(filename, png);
  console.log(`Created ${filename}`);
});

console.log('\nRecording icons created successfully!');
