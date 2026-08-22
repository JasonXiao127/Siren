// Rasterizes client/public/siren.svg -> packaging/icon.ico (+icon.png).
// One-off utility: npx electron scripts/gen-icon.cjs
//
// - Renders via <canvas> so per-pixel alpha survives (capturePage flattens
//   transparency unless the whole window is composited transparent).
// - Emits a multi-resolution ICO (PNG-compressed entries, Vista+) covering
//   16..256 so Windows draws crisp at every size.
// - packaging/icon.png (256) remains for electron-builder's mac/linux
//   conversions.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 256;

/** Minimal multi-size ICO builder using PNG-compressed entries. */
function buildIco(entries) {
  // entries: [{size, buf}]
  const headerSize = 6 + 16 * entries.length;
  const totalSize = headerSize + entries.reduce((n, e) => n + e.buf.length, 0);
  const out = Buffer.alloc(totalSize);
  out.writeUInt16LE(0, 0); // reserved
  out.writeUInt16LE(1, 2); // type: icon
  out.writeUInt16LE(entries.length, 4);
  let offset = headerSize;
  entries.forEach((e, i) => {
    const b = 6 + i * 16;
    out.writeUInt8(e.size >= 256 ? 0 : e.size, b); // width (0 = 256)
    out.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1);
    out.writeUInt8(0, b + 2); // palette
    out.writeUInt8(0, b + 3); // reserved
    out.writeUInt16LE(1, b + 4); // color planes
    out.writeUInt16LE(32, b + 6); // bits per pixel
    out.writeUInt32LE(e.buf.length, b + 8);
    out.writeUInt32LE(offset, b + 12);
    offset += e.buf.length;
    e.buf.copy(out, offset - e.buf.length);
  });
  return out;
}

app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..');
  const svgPath = path.join(root, 'client', 'public', 'siren.svg');
  const outDir = path.join(root, 'packaging');

  if (!fs.existsSync(svgPath)) {
    console.error(`[gen-icon] source SVG not found: ${svgPath}`);
    app.exit(1);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 320,
    webPreferences: { offscreen: true },
  });

  const svgBase64 = fs.readFileSync(svgPath).toString('base64');
  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<html><body style="margin:0;background:transparent;">' +
          '<canvas id="c" width="256" height="256"></canvas></body></html>'
      )
  );

  // Draw the SVG onto the canvas at each requested size; canvas.toDataURL
  // preserves alpha exactly.
  const result = await win.webContents.executeJavaScript(
    `(async function(){
      const svgB64 = ${JSON.stringify(svgBase64)};
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + svgB64;
      await img.decode();
      const canvas = document.getElementById('c');
      const ctx = canvas.getContext('2d');
      async function render(size){
        canvas.width = size; canvas.height = size;
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        return canvas.toDataURL('image/png');
      }
      const sizes = ${JSON.stringify([...ICO_SIZES])};
      const out = {};
      for (const s of sizes) out[s] = await render(s);
      // Alpha sanity check at a corner pixel of the largest render.
      await render(${PNG_SIZE});
      const px = ctx.getImageData(1, 1, 1, 1).data;
      return { dataUrls: out, cornerAlpha: px[3] };
    })()`
  );

  const toBuf = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(path.join(outDir, 'icon.png'), toBuf(result.dataUrls[String(PNG_SIZE)]));
  const icoEntries = ICO_SIZES.map((s) => ({ size: s, buf: toBuf(result.dataUrls[String(s)]) }));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(icoEntries));

  console.log(
    `[gen-icon] wrote icon.ico (${ICO_SIZES.join('/')}) + icon${PNG_SIZE}.png | ` +
      `cornerAlpha=${result.cornerAlpha} (0 = fully transparent ✓)`
  );
  app.exit(result.cornerAlpha === 0 ? 0 : 1);
});
