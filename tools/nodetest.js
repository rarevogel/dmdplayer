// Node checks for the parts of formats.js that need no browser (run: node tools/nodetest.js)
const fs = require("fs"), path = require("path");
const F = require("../src/formats.js");
const fx = (n) => path.join(__dirname, "..", "test", "fixtures", n);
const ok = (c, m) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
(async () => {
  for (const t of ["test.vpx", "test.fpt"]) {
    const b = new Uint8Array(fs.readFileSync(fx(t)));
    const cfb = await F.openCFB(F.bytesSource(t, b));
    ok(cfb.streams.length >= 14, t + " streams " + cfb.streams.length);
    for (const s of cfb.streams.filter((s) => /Image/.test(s.path))) {
      const raw = await cfb.readStream(s);
      if (t === "test.vpx") {
        const im = F.parseVPXImage(raw);
        if (im.bitsData) { const d = await F.decodeVPXImage(im); ok(d && d.w === 128 && d.frames[0].data[3] === 255, s.path + " BITS " + im.name); }
        else ok(im.bytes && F.sniff(im.bytes), s.path + " file " + im.name + " " + F.sniff(im.bytes));
      } else if (/ImageList/.test(s.path)) {
        const r = F.parseFPRecords(raw, true); ok(r.items && r.items.length === 8 && r.name === "Explosion", "list " + r.items);
      } else {
        const r = F.parseFPRecords(raw, false);
        const data = F.unpackFP(r.data);
        const kind = F.sniff(data);
        if (!kind) { const t = F.decodeTGA(data); ok(t && t.w === 128 && t.h === 32 && t.data.some((v, i) => i % 4 === 0 && v > 200), s.path + " TGA " + r.name); }
        else ok(true, s.path + " " + kind + " " + r.name);
      }
    }
  }
  // vpin's own LZW sample (128x128 BGRA)
  const lz = new Uint8Array(fs.readFileSync(process.argv[2]));
  const im = await F.decodeVPXImage({ bitsData: lz, w: 128, h: 128 });
  ok(im && im.frames[0].data.length === 128 * 128 * 4, "vpin raw_lzw_bmp_128_128");
  const g = F.decodeGIF(new Uint8Array(fs.readFileSync(fx("anim.gif"))));
  ok(g && g.frames.length === 10 && g.frames[0].delay === 80, "gif frames " + (g && g.frames.length));
  const d = F.parseDump(fs.readFileSync(fx("dump.txt"), "utf8"));
  ok(d && d.frames.length === 12 && d.w === 128 && d.h === 32 && d.frames[0].delay === 50, "dump");
  ok(F.splitName("Explode 7").key === "explode" && F.splitName("dmd_jackpot_12.png").num === 12, "splitName");
})();
