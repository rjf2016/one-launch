// Renders build/icon.svg to build/icon.png (1024x1024, transparent) with Electron's own
// Chromium, so no image dependency is needed. electron-builder turns the PNG into the .ico.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SIZE = 1024;
const buildDir = join(__dirname, '..', 'build');

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
    });
    win.webContents.setFrameRate(1);
    const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8');
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style></head><body>${svg}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 300));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const corner = bitmap[3];
    const centre = bitmap[((SIZE / 2) * SIZE + SIZE / 2) * 4 + 3];
    writeFileSync(join(buildDir, 'icon.png'), image.toPNG());
    console.log(`build/icon.png ${width}x${height}, corner alpha ${corner}, centre alpha ${centre}`);
    app.quit();
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
