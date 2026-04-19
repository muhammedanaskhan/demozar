#!/usr/bin/env node
/**
 * Optimize background images for Demozar extension
 * - Resizes to max 1920px width (maintains aspect ratio)
 * - Converts to WebP format (much smaller than JPEG)
 * - Quality set to 85 (good balance of size/quality)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const assetsDir = path.join(__dirname, '..', 'assets');
const outputDir = path.join(__dirname, '..', 'assets', 'optimized');

// Check if sharp is installed
try {
  require.resolve('sharp');
} catch (e) {
  console.log('Installing sharp for image optimization...');
  execSync('npm install sharp --save-dev', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });
}

const sharp = require('sharp');

const MAX_WIDTH = 1920;
const QUALITY = 85;

async function optimizeImages() {
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const files = fs.readdirSync(assetsDir).filter(f =>
    /\.(jpg|jpeg|png|webp)$/i.test(f) && !fs.statSync(path.join(assetsDir, f)).isDirectory()
  );

  console.log(`\nOptimizing ${files.length} images...\n`);

  let totalOriginal = 0;
  let totalOptimized = 0;

  for (const file of files) {
    const inputPath = path.join(assetsDir, file);
    const baseName = path.basename(file, path.extname(file));
    const outputPath = path.join(outputDir, `${baseName}.webp`);

    const originalSize = fs.statSync(inputPath).size;
    totalOriginal += originalSize;

    try {
      const image = sharp(inputPath);
      const metadata = await image.metadata();

      // Resize if wider than MAX_WIDTH
      let pipeline = image;
      if (metadata.width > MAX_WIDTH) {
        pipeline = pipeline.resize(MAX_WIDTH, null, {
          withoutEnlargement: true,
          fit: 'inside'
        });
      }

      // Convert to WebP
      await pipeline
        .webp({ quality: QUALITY })
        .toFile(outputPath);

      const optimizedSize = fs.statSync(outputPath).size;
      totalOptimized += optimizedSize;

      const reduction = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
      const originalKB = (originalSize / 1024).toFixed(1);
      const optimizedKB = (optimizedSize / 1024).toFixed(1);

      console.log(`✓ ${file}`);
      console.log(`  ${metadata.width}x${metadata.height} → ${Math.min(metadata.width, MAX_WIDTH)}x${Math.round(metadata.height * Math.min(1, MAX_WIDTH / metadata.width))}`);
      console.log(`  ${originalKB}KB → ${optimizedKB}KB (${reduction}% smaller)\n`);

    } catch (err) {
      console.error(`✗ Error processing ${file}:`, err.message);
    }
  }

  const totalReduction = ((1 - totalOptimized / totalOriginal) * 100).toFixed(1);
  console.log('━'.repeat(50));
  console.log(`Total: ${(totalOriginal / 1024 / 1024).toFixed(2)}MB → ${(totalOptimized / 1024 / 1024).toFixed(2)}MB`);
  console.log(`Saved: ${totalReduction}% (${((totalOriginal - totalOptimized) / 1024 / 1024).toFixed(2)}MB)`);
  console.log(`\nOptimized images saved to: assets/optimized/`);
  console.log('\nTo use these instead, update your code to reference the optimized folder.');
}

optimizeImages().catch(console.error);
