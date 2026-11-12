// Run under electron.exe, not node: node_modules\electron\dist\electron.exe scripts/oracle/assets/tray.cjs <profile folder> <output folder>
// Reproduces the tray icon resize of src/main/tray.ts with Electron's own nativeImage, at every scale factor Windows offers.
const { app, nativeImage } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [profile, outDir] = process.argv.slice(-2);
app.setPath('userData', profile);

const SOURCE = join(__dirname, '..', '..', '..', 'build', 'icon.png');
const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.25, 4.5, 4.75, 5];

app
  .whenReady()
  .then(() => {
    const icon = nativeImage.createFromPath(SOURCE);
    if (icon.isEmpty()) throw new Error(`tray icon not found at ${SOURCE}`);
    mkdirSync(outDir, { recursive: true });
    const made = [];
    for (const scaleFactor of SCALES) {
      const px = Math.max(16, Math.round(16 * scaleFactor));
      if (made.some((m) => m.px === px)) continue;
      const png = icon.resize({ width: px, height: px }).toPNG();
      writeFileSync(join(outDir, `tray-${px}.png`), png);
      made.push({ px, scaleFactor, bytes: png.length });
    }
    writeFileSync(join(outDir, 'tray.json'), JSON.stringify({ source: icon.getSize(), electron: process.versions.electron, made }));
    app.quit();
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
