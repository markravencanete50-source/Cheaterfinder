import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function convertToWebp(inputPath, quality = 82) {
  const outputPath = inputPath.replace(/\.png$/, '.webp');
  const inputStats = fs.statSync(inputPath);

  await sharp(inputPath)
    .webp({ quality })
    .toFile(outputPath);

  const outputStats = fs.statSync(outputPath);
  const savings = ((1 - outputStats.size / inputStats.size) * 100).toFixed(1);

  console.log(
    `${path.relative(root, inputPath)} (${(inputStats.size / 1024).toFixed(0)}KB) -> ` +
    `${path.relative(root, outputPath)} (${(outputStats.size / 1024).toFixed(0)}KB) [${savings}% smaller]`
  );

  return outputPath;
}

async function main() {
  console.log('=== Image Optimization: PNG -> WebP ===\n');

  // 1. Asset images (imported via Vite)
  const assetDir = path.join(root, 'client/src/assets');
  await convertToWebp(path.join(assetDir, 'hero-radar.png'));
  await convertToWebp(path.join(assetDir, 'analytics-chart.png'));

  // 2. Celeb images (served from public/)
  const celebDir = path.join(root, 'client/public/celebs');
  const celebFiles = fs.readdirSync(celebDir).filter(f => f.endsWith('.png'));
  for (const file of celebFiles) {
    await convertToWebp(path.join(celebDir, file));
  }

  console.log('\nDone! Update component imports to use .webp files.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
