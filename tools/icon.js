// Renders android/res/drawable/icon.png with the app's own dot renderer: node tools/icon.js
const { chromium } = require("playwright"), path = require("path"), fs = require("fs");
(async () => {
  const b = await chromium.launch(), pg = await b.newPage();
  await pg.goto("file://" + path.join(__dirname, "..", "index.html"));
  const url = await pg.evaluate(() => {
    const S = 512, c = document.createElement("canvas"); c.width = c.height = S;
    const x = c.getContext("2d");
    x.fillStyle = "#1a1512"; x.beginPath(); x.roundRect(16, 16, S - 32, S - 32, 100); x.fill();
    x.fillStyle = "#000"; x.beginPath(); x.roundRect(52, 140, S - 104, S - 280, 26); x.fill();
    const gw = 21, gh = 11, buf = new Float32Array(gw * gh);
    DMD.drawText(buf, gw, gh, "DMD", 2, 2, 1, 1);
    for (let i = 0; i < gw; i++) { buf[i] = Math.max(buf[i], 0.35); buf[(gh - 1) * gw + i] = Math.max(buf[(gh - 1) * gw + i], 0.35); }
    const f = new Uint8ClampedArray(gw * gh * 4);
    for (let i = 0; i < buf.length; i++) { f[i * 4] = f[i * 4 + 1] = f[i * 4 + 2] = buf[i] * 255; f[i * 4 + 3] = 255; }
    const d = document.createElement("canvas");
    const r = new DMD.Renderer(d, { tint: "oranje", glow: false, levels: 16, unlit: 0.1, fixedSize: { w: S - 136, h: (S - 136) * gh / gw } });
    r.setGrid(gw, gh); r.draw(f);
    x.drawImage(d, 68, 256 - d.height / 2);
    return c.toDataURL("image/png");
  });
  fs.writeFileSync(path.join(__dirname, "..", "android", "res", "drawable", "icon.png"), Buffer.from(url.split(",")[1], "base64"));
  await b.close();
})();
