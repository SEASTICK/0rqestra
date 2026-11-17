// Renders the app icon from its SVG sources into the committed PNG and ICO files.
//
//   npx electron scripts/render-icons.mjs        (run from apps/desktop)
//
// It uses Electron's own Chromium to draw the SVG onto a canvas at each size (transparency is
// kept), then writes:
//   assets/icon/icon.png    1024 x 1024, used by electron-builder for macOS and Linux
//   assets/icon/icon.ico    Windows: 16, 20, 24, 32, 40, 48, 64, 128 and 256 px (PNG-compressed)
//   assets/icon/png/*.png   every rendered size, for inspection
// Sizes up to 48 px use icon-small.svg, a heavier-weight version of the same design that stays
// legible at taskbar and title-bar sizes; larger sizes use the master icon.svg.
// No network access; nothing is downloaded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'assets', 'icon');
const master = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(dir, 'icon-small.svg'), 'utf8');
const SMALL_MAX = 48;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_SIZES = [...new Set([...ICO_SIZES, 512, 1024])];

function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html,<!doctype html><title>icons</title>');
  const render = (svg, size) =>
    window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = ${size};
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, ${size}, ${size});
        resolve(canvas.toDataURL('image/png').split(',')[1]);
      };
      image.onerror = () => reject(new Error('SVG failed to load'));
      image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
  const pngDir = path.join(dir, 'png');
  fs.mkdirSync(pngDir, { recursive: true });
  const rendered = new Map();
  for (const size of PNG_SIZES) {
    const png = Buffer.from(await render(size <= SMALL_MAX ? small : master, size), 'base64');
    rendered.set(size, png);
    fs.writeFileSync(path.join(pngDir, `icon-${size}.png`), png);
  }
  fs.writeFileSync(path.join(dir, 'icon.png'), rendered.get(1024));
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico(ICO_SIZES.map((size) => ({ size, png: rendered.get(size) }))));
  console.log(`Rendered ${PNG_SIZES.length} sizes; icon.ico holds ${ICO_SIZES.join(', ')} px.`);
  app.quit();
});
