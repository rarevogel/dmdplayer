// Playwright walk-through: node tools/uitest.js <outdir>   (serves android/assets on :8765)
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "android", "assets"), fx = path.join(__dirname, "..", "test", "fixtures");
const out = process.argv[2] || ".";
const types = { ".html": "text/html", ".css": "text/css", ".woff2": "font/woff2" };
const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(q.url.split("?")[0])); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); r.end(d); } }); }).listen(8765);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push("pageerror " + e.message));
  pg.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text()); });
  await pg.goto("http://localhost:8765/");
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + "/1-start.png", fullPage: true });
  const imp = async (files, shot) => {
    await pg.setInputFiles("#fileIn", files.map((f) => path.join(fx, f)));
    await pg.waitForSelector("#impFoot:not([hidden])", { timeout: 30000 });
    await pg.waitForTimeout(800);
    await pg.screenshot({ path: out + "/" + shot, fullPage: false });
    return pg.evaluate(() => [...document.querySelectorAll(".cand .nm")].map((n) => n.querySelector("input").value + " | " + n.querySelector("span").textContent + " | " + n.parentElement.querySelector("input[type=checkbox]").checked)
      .concat([...document.querySelectorAll(".thumb span")].map((s) => "other: " + s.textContent)).concat([...document.querySelectorAll("#impBody > p")].map((p) => "note: " + p.textContent)));
  };
  console.log(await imp(["test.vpx"], "2-vpx.png"));
  await pg.click("#saveBtn"); await pg.waitForTimeout(800);
  console.log(await imp(["test.fpt"], "3-fpt.png"));
  await pg.click("#saveBtn"); await pg.waitForTimeout(800);
  console.log(await imp(["anim.gif", "dump.txt", "frames.zip"], "4-mixed.png"));
  await pg.click("#saveBtn"); await pg.waitForTimeout(800);
  // merge: VPX again, pick singles + others
  await imp(["test.vpx"], "5-vpx2.png");
  await pg.evaluate(() => { document.querySelectorAll(".cand input[type=checkbox]").forEach((c) => (c.checked = false)); document.querySelector("details").open = true; document.querySelectorAll(".cand input[type=checkbox]")[2].checked = true; document.querySelector(".thumb input").checked = true; document.querySelector(".thumb input").dispatchEvent(new Event("change")); });
  await pg.click("#mergeBtn"); await pg.waitForTimeout(300); await pg.click("#dlgYes"); await pg.waitForTimeout(800);
  console.log("lib:", await pg.evaluate(() => [...document.querySelectorAll(".tile b")].map((b) => b.textContent).join(", ")));
  await pg.screenshot({ path: out + "/6-library.png", fullPage: true });
  // gif export
  const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click("#gifBtn")]);
  await dl.saveAs(out + "/export.gif");
  console.log("gif", fs.statSync(out + "/export.gif").size, dl.suggestedFilename());
  // style changes + fullscreen
  await pg.click("#tintSw button:nth-child(4)"); await pg.click("#shapeSeg button:nth-child(2)");
  await pg.click(".tile:nth-child(3)"); await pg.waitForTimeout(500);
  await pg.screenshot({ path: out + "/7-green.png" });
  await pg.setViewportSize({ width: 900, height: 412 });
  await pg.click("#fsBtn"); await pg.waitForTimeout(700);
  await pg.screenshot({ path: out + "/8-fullscreen.png" });
  await pg.evaluate(() => atlasBack());
  // reload: library persists
  await pg.reload(); await pg.waitForTimeout(1200);
  console.log("after reload:", await pg.evaluate(() => document.querySelectorAll(".tile").length));
  await pg.setViewportSize({ width: 1280, height: 800 }); await pg.waitForTimeout(600);
  await pg.screenshot({ path: out + "/9-tablet.png" });
  console.log("errors:", errs);
  await b.close(); srv.close();
})();
