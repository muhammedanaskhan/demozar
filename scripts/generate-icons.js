// Icon generation script for Spotlight Recorder
// Run: node scripts/generate-icons.js

const fs = require('fs');
const path = require('path');

// SVG icon template
const generateSVG = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="${size * 0.03}" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="url(#grad)"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.35}" stroke="white" stroke-width="${size * 0.04}" fill="none" filter="url(#glow)" opacity="0.9"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.15}" fill="white" filter="url(#glow)"/>
</svg>
`.trim();

// Sizes needed
const sizes = [16, 32, 48, 128];

// Create icons directory if it doesn't exist
const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate SVG files (these can be converted to PNG using browser or tools)
sizes.forEach(size => {
  const svg = generateSVG(size);
  const filename = `icon${size}.svg`;
  fs.writeFileSync(path.join(iconsDir, filename), svg);
  console.log(`Generated ${filename}`);
});

console.log('\nSVG icons generated. To convert to PNG:');
console.log('1. Open each SVG in a browser');
console.log('2. Right-click and save as PNG');
console.log('Or use an online converter like https://svgtopng.com/');
