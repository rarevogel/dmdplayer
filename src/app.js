/* DMD Player: the app (library, player, import, export). */
"use strict";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ""); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const nf = new Intl.NumberFormat("en-GB");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Bridge = window.DMDApp || null; // set by the Android app

/* ---------- settings ---------- */
const SETTINGS_KEY = "dmd-speler-settings";
const settings = Object.assign({ tint: "oranje", shape: "rond", glow: true, levels: 16, speed: 1, mode: "herhaal", current: null }, (() => {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
})());
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } };
const styleOf = () => ({ tint: settings.tint, shape: settings.shape, glow: settings.glow, levels: settings.levels });

/* ---------- storage (IndexedDB, with a memory fallback) ---------- */
const Store = (() => {
  let db = null;
  const mem = { meta: new Map(), frames: new Map() };
  const open = () => new Promise((res) => {
    try {
      const r = indexedDB.open("dmd-speler", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("meta", { keyPath: "id" }); r.result.createObjectStore("frames", { keyPath: "id" }); };
      r.onsuccess = () => { db = r.result; res(true); };
      r.onerror = () => res(false);
    } catch (e) { res(false); }
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => res(r && r.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("Storage full?"));
  });
  return {
    open,
    get persistent() { return !!db; },
    async all() { if (!db) return [...mem.meta.values()]; return tx("meta", "readonly", (s) => s.getAll()); },
    async put(meta, packed) {
      if (!db) { mem.meta.set(meta.id, meta); mem.frames.set(meta.id, packed); return; }
      await tx("frames", "readwrite", (s) => s.put({ id: meta.id, ...packed }));
      await tx("meta", "readwrite", (s) => s.put(meta));
    },
    async putMeta(meta) { if (!db) { mem.meta.set(meta.id, meta); return; } await tx("meta", "readwrite", (s) => s.put(meta)); },
    async frames(id) { if (!db) return mem.frames.get(id); return tx("frames", "readonly", (s) => s.get(id)); },
    async del(id) { if (!db) { mem.meta.delete(id); mem.frames.delete(id); return; } await tx("meta", "readwrite", (s) => s.delete(id)); await tx("frames", "readwrite", (s) => s.delete(id)); },
  };
})();

/* ---------- library ---------- */
let lib = [];
const cache = new Map(); // id -> frames (most recent last)
async function loadFrames(m) {
  if (cache.has(m.id)) { const f = cache.get(m.id); cache.delete(m.id); cache.set(m.id, f); return f; }
  const p = await Store.frames(m.id);
  const f = p ? await DMD.unpack(p, m.w, m.h) : [];
  cache.set(m.id, f);
  while (cache.size > 4) cache.delete(cache.keys().next().value);
  return f;
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
async function addAnimation({ name, w, h, frames, delays, source }) {
  const meta = { id: newId(), name, w, h, n: frames.length, delays, source: source || "", created: Date.now(), poster: frames[Math.floor(frames.length / 3)].slice().buffer };
  await Store.put(meta, await DMD.pack(frames));
  lib.push(meta);
  cache.set(meta.id, frames);
  return meta;
}
function sortLib() { lib.sort((a, b) => b.created - a.created); }

/* ---------- player ---------- */
const hero = new DMD.Renderer($("#hero"), styleOf());
const fsR = new DMD.Renderer($("#fscv"), styleOf());
const P = { meta: null, frames: [], i: 0, playing: true, acc: 0, last: 0, played: 0 };

async function select(id, { play = true } = {}) {
  const m = lib.find((x) => x.id === id) || lib[0];
  if (!m) { P.meta = null; P.frames = []; showNow(); drawNow(); return; }
  P.meta = m; P.frames = await loadFrames(m); P.i = 0; P.acc = 0; P.played = 0;
  if (play) P.playing = true;
  settings.current = m.id; saveSettings();
  hero.setGrid(m.w, m.h); fsR.setGrid(m.w, m.h);
  $("#hero").style.aspectRatio = m.w + " / " + m.h;
  showNow(); drawNow(); markTiles();
}
function showNow() {
  const m = P.meta;
  $("#nowName").textContent = m ? m.name : "No animations yet";
  $("#nowMeta").textContent = m ? `${m.w}×${m.h} · ${m.n} ${m.n === 1 ? "frame" : "frames"}` : "";
  $("#fsname").textContent = m ? m.name : "";
  $("#scrub").max = Math.max(0, P.frames.length - 1);
  for (const b of ["#gifBtn", "#renameBtn", "#delBtn"]) $(b).disabled = !m;
  setPlayIcon();
}
function setPlayIcon() {
  const d = P.playing ? "M6 4h4v16H6zm8 0h4v16h-4z" : "M7 4l13 8-13 8z";
  $("#playIcon").setAttribute("d", d); $("#fsPlayIcon").setAttribute("d", d);
  $("#playBtn").setAttribute("aria-label", P.playing ? "Pause" : "Play");
}
function drawNow() {
  const f = P.frames[P.i] || null;
  if (document.body.classList.contains("fs")) fsR.draw(f); else hero.draw(f);
  $("#scrub").value = P.i;
  $("#fcount").textContent = P.frames.length ? `${P.i + 1}/${P.frames.length}` : "0/0";
}
function delayOf(i) { const d = P.meta && P.meta.delays ? P.meta.delays[i] : 66; return (d > 0 ? d : 66) / settings.speed; }
function step(dir) {
  if (!P.frames.length) return;
  P.i = (P.i + dir + P.frames.length) % P.frames.length;
  drawNow();
}
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(250, t - (P.last || t));
  P.last = t;
  if (P.playing && P.frames.length > 1) {
    P.acc += dt; P.played += dt;
    let moved = false;
    while (P.acc >= delayOf(P.i)) {
      P.acc -= delayOf(P.i);
      P.i++;
      moved = true;
      if (P.i >= P.frames.length) {
        P.i = 0;
        if (settings.mode !== "herhaal" && P.played > 4000 && lib.length > 1) { nextAnim(settings.mode === "shuffle" ? 0 : 1); return; }
      }
    }
    if (moved) drawNow();
  } else if (P.playing && P.frames.length === 1 && settings.mode !== "herhaal" && lib.length > 1) {
    P.played += dt;
    if (P.played > 4000) nextAnim(settings.mode === "shuffle" ? 0 : 1);
  }
  animateCands(dt);
}
function visibleLib() {
  const q = $("#search").value.trim().toLowerCase();
  return q ? lib.filter((m) => m.name.toLowerCase().includes(q)) : lib;
}
function nextAnim(dir) {
  const list = lib;
  if (!list.length) return;
  let k = list.findIndex((m) => m === P.meta);
  if (dir === 0) { let r; do { r = Math.floor(Math.random() * list.length); } while (list.length > 1 && r === k); k = r; }
  else k = (k + dir + list.length) % list.length;
  select(list[k].id);
}

/* ---------- controls ---------- */
function seg(id, options, get, set) {
  const box = $(id);
  box.replaceChildren();
  for (const [v, label] of options) {
    box.append(el("button", { class: get() === v ? "on" : "", onclick: () => { set(v); saveSettings(); seg(id, options, get, set); } }, label));
  }
}
function applyStyle() {
  hero.setStyle(styleOf()); fsR.setStyle(styleOf());
  drawNow(); drawTiles(); logo();
}
function buildControls() {
  seg("#speedSeg", [[0.5, "½×"], [1, "1×"], [1.5, "1½×"], [2, "2×"], [3, "3×"]], () => settings.speed, (v) => { settings.speed = v; });
  seg("#modeSeg", [["herhaal", "Repeat"], ["volgende", "All"], ["shuffle", "Shuffle"]], () => settings.mode, (v) => { settings.mode = v; P.played = 0; });
  seg("#shapeSeg", [["rond", "Round"], ["vierkant", "Square"]], () => settings.shape, (v) => { settings.shape = v; applyStyle(); });
  seg("#glowSeg", [[true, "Glow"], [false, "Sharp"]], () => settings.glow, (v) => { settings.glow = v; applyStyle(); });
  seg("#levelSeg", [[4, "4"], [16, "16"], [256, "Smooth"]], () => settings.levels, (v) => { settings.levels = v; applyStyle(); });
  const sw = $("#tintSw");
  sw.replaceChildren();
  for (const [k, t] of Object.entries(DMD.TINTS)) {
    const b = el("button", { class: "sw " + (k === "kleur" ? "kleur " : "") + (settings.tint === k ? "on" : ""), title: t.label, "aria-label": t.label,
      onclick: () => { settings.tint = k; saveSettings(); buildControls(); applyStyle(); } });
    if (t.rgb) b.style.background = `rgb(${t.rgb.join(",")})`;
    sw.append(b);
  }
}
$("#playBtn").onclick = $("#fsPlay").onclick = () => { P.playing = !P.playing; setPlayIcon(); };
$("#prevF").onclick = () => { P.playing = false; setPlayIcon(); step(-1); };
$("#nextF").onclick = () => { P.playing = false; setPlayIcon(); step(1); };
$("#scrub").oninput = (e) => { P.playing = false; setPlayIcon(); P.i = +e.target.value; drawNow(); };
$("#search").oninput = () => renderGrid();

/* ---------- library grid ---------- */
const tileR = new Map(); // id -> renderer
function renderGrid() {
  const grid = $("#grid");
  grid.replaceChildren();
  tileR.clear();
  const list = visibleLib();
  $("#libCount").textContent = lib.length ? "(" + lib.length + ")" : "";
  if (!list.length) { grid.append(el("div", { class: "empty" }, lib.length ? "Nothing found." : "The library is empty. Import a table or a GIF.")); return; }
  for (const m of list) {
    const cv = el("canvas");
    const t = el("button", { class: "tile" + (P.meta && P.meta.id === m.id ? " on" : ""), "data-id": m.id, onclick: () => select(m.id) },
      cv, el("b", {}, m.name), el("span", {}, `${m.n} ${m.n === 1 ? "frame" : "frames"} · ${m.w}×${m.h}${m.source ? " · " + m.source : ""}`));
    grid.append(t);
    const r = new DMD.Renderer(cv, styleOf());
    r.setGrid(m.w, m.h);
    cv.style.aspectRatio = m.w + " / " + m.h;
    tileR.set(m.id, { r, m });
  }
  requestAnimationFrame(drawTiles);
}
function drawTiles() {
  for (const { r, m } of tileR.values()) { r.setStyle(styleOf()); r.draw(new Uint8ClampedArray(m.poster)); }
}
function markTiles() { document.querySelectorAll(".tile").forEach((t) => t.classList.toggle("on", !!P.meta && t.dataset.id === P.meta.id)); }

/* logo: "DMD PLAYER" on its own little display */
const logoR = new DMD.Renderer($("#logo"), { glow: true, levels: 16 });
function logo() {
  const w = 61, h = 9, buf = new Float32Array(w * h);
  DMD.drawText(buf, w, h, "DMD PLAYER", 1, 1, 1, 1);
  const f = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < buf.length; i++) { f[i * 4] = f[i * 4 + 1] = f[i * 4 + 2] = buf[i] * 255; f[i * 4 + 3] = 255; }
  logoR.setGrid(w, h);
  logoR.setStyle({ tint: settings.tint === "kleur" ? "oranje" : settings.tint, shape: settings.shape });
  $("#logo").style.width = "122px"; $("#logo").style.height = "18px";
  logoR.draw(f);
}

/* ---------- dialogs and toast ---------- */
function ask(title, body, yes = "OK", withInput = null) {
  return new Promise((res) => {
    const d = $("#dlg");
    $("#dlgTitle").textContent = title;
    const b = $("#dlgBody");
    b.replaceChildren();
    let inp = null;
    if (body) b.append(el("p", { class: "note" }, body));
    if (withInput != null) { inp = el("input", { type: "text", value: withInput }); b.append(inp); }
    $("#dlgYes").textContent = yes;
    const done = (v) => { d.close(); $("#dlgYes").onclick = $("#dlgNo").onclick = null; res(v); };
    $("#dlgYes").onclick = () => done(inp ? inp.value.trim() || null : true);
    $("#dlgNo").onclick = () => done(null);
    d.oncancel = (e) => { e.preventDefault(); done(null); };
    d.showModal();
    if (inp) { inp.focus(); inp.select(); inp.onkeydown = (e) => { if (e.key === "Enter") $("#dlgYes").click(); }; }
  });
}
let toastT = 0;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), ms);
}

$("#renameBtn").onclick = async () => {
  if (!P.meta) return;
  const v = await ask("Rename", null, "Save", P.meta.name);
  if (!v) return;
  P.meta.name = v;
  await Store.putMeta(P.meta);
  showNow(); renderGrid();
};
$("#delBtn").onclick = async () => {
  if (!P.meta) return;
  if (!(await ask("Delete?", `“${P.meta.name}” will be removed from the library.`, "Delete"))) return;
  const k = lib.indexOf(P.meta);
  await Store.del(P.meta.id);
  cache.delete(P.meta.id);
  lib.splice(k, 1);
  renderGrid();
  await select(lib[Math.min(k, lib.length - 1)] ? lib[Math.min(k, lib.length - 1)].id : null);
};

/* ---------- GIF export ---------- */
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function saveBytes(name, mime, bytes) {
  if (Bridge && Bridge.saveFile) { Bridge.saveFile(name, mime, toBase64(bytes)); return; }
  const a = el("a", { href: URL.createObjectURL(new Blob([bytes], { type: mime })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Saved as " + name);
}
window.onSaved = (ok) => toast(ok ? "GIF saved" : "Not saved");
$("#gifBtn").onclick = async () => {
  const m = P.meta;
  if (!m) return;
  $("#gifBtn").disabled = true;
  toast("Making GIF…", 20000);
  await sleep(30);
  try {
    const p = Math.max(2, Math.min(6, Math.floor(768 / m.w)));
    const cv = document.createElement("canvas");
    const r = new DMD.Renderer(cv, Object.assign(styleOf(), { glow: false, fixedSize: { w: m.w * p, h: m.h * p } }));
    r.setGrid(m.w, m.h);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const frames = P.frames.slice(0, 600).map((f) => { r.draw(f); return ctx.getImageData(0, 0, cv.width, cv.height).data; });
    const delays = P.frames.slice(0, 600).map((_, i) => (m.delays[i] > 0 ? m.delays[i] : 66) / settings.speed);
    const gif = DMD.encodeGIF(frames, cv.width, cv.height, delays);
    saveBytes(m.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") + ".gif", "image/gif", gif);
  } catch (e) { toast("Could not make the GIF: " + e.message); }
  $("#gifBtn").disabled = false;
};

/* ---------- fullscreen ---------- */
let barT = 0;
function showBar() {
  $("#fsbar").classList.remove("hide"); $("#fsname").classList.remove("hide");
  clearTimeout(barT);
  barT = setTimeout(() => { $("#fsbar").classList.add("hide"); $("#fsname").classList.add("hide"); }, 2800);
}
function enterFS() {
  if (!P.meta) return;
  document.body.classList.add("fs");
  if (Bridge && Bridge.setFullscreen) Bridge.setFullscreen(true);
  else {
    const d = document.documentElement;
    if (d.requestFullscreen) d.requestFullscreen().then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape").catch(() => {})).catch(() => {});
  }
  fsR.mask = null;
  setTimeout(() => { fsR.mask = null; drawNow(); }, 250);
  drawNow(); showBar();
}
function exitFS() {
  document.body.classList.remove("fs");
  if (Bridge && Bridge.setFullscreen) Bridge.setFullscreen(false);
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setTimeout(() => { hero.mask = null; drawNow(); drawTiles(); }, 250);
  drawNow();
}
$("#fsBtn").onclick = enterFS;
$("#hero").onclick = enterFS;
$("#fsExit").onclick = exitFS;
$("#fsPrev").onclick = (e) => { e.stopPropagation(); nextAnim(-1); showBar(); };
$("#fsNext").onclick = (e) => { e.stopPropagation(); nextAnim(1); showBar(); };
$("#fsview").onclick = (e) => { if (e.target === $("#fscv")) showBar(); };
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("fs") && !Bridge) exitFS(); });
let swipeX = null;
$("#fscv").addEventListener("touchstart", (e) => { swipeX = e.touches[0].clientX; }, { passive: true });
$("#fscv").addEventListener("touchend", (e) => {
  if (swipeX == null) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) > 60) nextAnim(dx < 0 ? 1 : -1);
});
window.addEventListener("resize", () => { hero.mask = null; fsR.mask = null; drawNow(); drawTiles(); });
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || $("#dlg").open) return;
  if (e.key === " ") { e.preventDefault(); $("#playBtn").click(); }
  else if (e.key === "ArrowRight") nextAnim(1);
  else if (e.key === "ArrowLeft") nextAnim(-1);
  else if (e.key === "f") document.body.classList.contains("fs") ? exitFS() : enterFS();
  else if (e.key === "Escape" && document.body.classList.contains("fs")) exitFS();
});

/* ---------- import ---------- */
const MAX_DMD_W = 1024, MAX_OTHER = 256;
let imp = null; // { items, groups, cands: [...], previews: [...] }

// shrink big pictures right away so a table with hundreds of textures fits in memory
function shrinkItem(it) {
  const dmd = Formats.dmdLike(it.w, it.h);
  const lim = dmd ? MAX_DMD_W : MAX_OTHER;
  const s = Math.min(1, lim / Math.max(it.w, it.h));
  if (s >= 1) return it;
  const w = Math.max(1, Math.round(it.w * s)), h = Math.max(1, Math.round(it.h * s));
  it.frames = it.frames.map((f) => ({ data: DMD.toGrid({ w: it.w, h: it.h, data: f.data }, w, h, "contain"), delay: f.delay }));
  it.origW = it.w; it.origH = it.h; it.w = w; it.h = h;
  return it;
}
function gridChoice(w, h) {
  const v = $("#gridSel").value;
  if (v !== "auto") return v.split("x").map(Number);
  return DMD.gridFor(w, h);
}
// all frames (with delays) of a candidate, resampled to its grid
function candFrames(c) {
  const key = $("#gridSel").value;
  if (c.cacheKey === key) return c.cache;
  const first = c.items[0];
  const [gw, gh] = gridChoice(first.origW || first.w, first.origH || first.h);
  const fit = Formats.dmdLike(first.w, first.h) ? "contain" : "cover";
  const frames = [], delays = [];
  for (const it of c.items) for (const f of it.frames) {
    frames.push(DMD.toGrid({ w: it.w, h: it.h, data: f.data }, gw, gh, fit));
    delays.push(f.delay > 0 ? f.delay : 66);
  }
  c.cache = { gw, gh, frames, delays }; c.cacheKey = key;
  return c.cache;
}

async function startImport(files) {
  if (!files.length) return;
  $("#importSheet").hidden = false;
  $("#impFoot").hidden = true;
  const body = $("#impBody");
  const bar = el("i");
  const status = el("p", { class: "note" }, "Reading files…");
  body.replaceChildren(el("p", {}, files.length === 1 ? files[0].name : files.length + " files"), el("div", { class: "progress" }, bar), status);
  imp = { items: [], cands: [], previews: [], summary: [] };
  let skipped = 0;
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    try {
      const res = await Formats.scan(Formats.fileSource(f), (it) => {
        if (it.kind === "image") imp.items.push(shrinkItem(it));
        else if (it.kind === "list") imp.items.push(it);
        else skipped++;
      }, (i, n, name) => {
        bar.style.width = (((k + (n ? i / n : 1)) / files.length) * 100).toFixed(1) + "%";
        status.textContent = `${name}: ${i} of ${n}`;
      });
      if (res.table === "vp" || res.table === "fp") imp.summary.push(`${f.name}: ${res.images} images in the table${res.lists ? ", " + res.lists + (res.lists === 1 ? " image list" : " image lists") : ""}.`);
    } catch (e) {
      imp.summary.push(`${f.name}: could not be read (${e.message || e}).`);
    }
    await sleep(0);
  }
  bar.style.width = "100%";
  showResults(skipped);
}

function showResults(skipped) {
  const g = Formats.group(imp.items);
  const body = $("#impBody");
  body.replaceChildren();
  imp.cands = []; imp.previews = [];
  for (const s of imp.summary) body.append(el("p", { class: "note" }, s));
  if (skipped) body.append(el("p", { class: "warn" }, `${skipped} ${skipped === 1 ? "item" : "items"} could not be read as an image and ${skipped === 1 ? "was" : "were"} skipped.`));
  const total = g.anims.length + g.singles.length + g.others.length;
  if (!total) {
    body.append(el("div", { class: "tip" }, el("b", {}, "No images found. "),
      "Many Visual Pinball recreations of real machines get their DMD from a PinMAME ROM; those animations are not in the table file. Tables that use FlexDMD or UltraDMD often keep their animations in a separate folder next to the table: put that folder in a ZIP and import it."));
    return;
  }
  const row = (c, checked) => {
    const cv = el("canvas");
    const cb = el("input", { type: "checkbox", checked, onchange: updateSel, "aria-label": "Select" });
    const name = el("input", { type: "text", value: c.name, "aria-label": "Name", oninput: (e) => (c.name = e.target.value) });
    const frames = c.items.reduce((s, it) => s + it.frames.length, 0), first = c.items[0];
    const meta = el("span", {}, `${frames} ${frames === 1 ? "frame" : "frames"} · ${first.origW || first.w}×${first.origH || first.h}${c.reason ? " · " + c.reason : ""}`);
    c.cb = cb;
    const r = new DMD.Renderer(cv, styleOf());
    imp.previews.push({ c, r, i: 0, acc: 0 });
    return el("div", { class: "cand" }, cb, cv, el("div", { class: "nm" }, name, meta));
  };
  if (g.anims.length) {
    body.append(el("div", { class: "sec" }, `Animations (${g.anims.length})`));
    const box = el("div", { class: "found" });
    for (const a of g.anims) { const c = { name: a.name, items: a.items, reason: a.reason, kind: "anim" }; imp.cands.push(c); box.append(row(c, Formats.dmdLike(a.items[0].w, a.items[0].h))); }
    body.append(box);
  }
  if (g.singles.length) {
    const box = el("div", { class: "found" });
    const cs = g.singles.map((im) => ({ name: im.name.replace(/\.[a-z]{3,4}$/i, ""), items: [im], reason: "", kind: "single" }));
    body.append(el("div", { class: "sec" }, `Single DMD images (${cs.length})`,
      el("button", { class: "btn ghost", onclick: () => { const on = !cs.every((c) => c.cb.checked); cs.forEach((c) => (c.cb.checked = on)); updateSel(); } }, "Toggle all")));
    for (const c of cs) { imp.cands.push(c); box.append(row(c, false)); }
    body.append(box);
  }
  if (g.others.length) {
    const det = el("details", {}, el("summary", { class: "sec", style: "cursor:pointer" }, `Other images (${g.others.length}) — playfield, backglass, textures…`));
    const box = el("div", { class: "thumbs" });
    for (const im of g.others) {
      const c = { name: im.name.replace(/\.[a-z]{3,4}$/i, ""), items: [im], reason: "", kind: "other" };
      imp.cands.push(c);
      const cv = el("canvas", { width: im.w, height: im.h });
      cv.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(im.frames[0].data), im.w, im.h), 0, 0);
      c.cb = el("input", { type: "checkbox", onchange: updateSel, "aria-label": c.name });
      box.append(el("label", { class: "thumb" }, cv, c.cb, el("span", {}, `${c.name} · ${im.origW || im.w}×${im.origH || im.h}`)));
    }
    det.append(box, el("p", { class: "note" }, "Pick images here to view them as a DMD image or to merge them into an animation."));
    body.append(det);
  }
  $("#impFoot").hidden = false;
  updateSel();
}
function updateSel() {
  if (!imp) return;
  const sel = imp.cands.filter((c) => c.cb && c.cb.checked);
  $("#selInfo").textContent = sel.length ? `${sel.length} selected` : "Nothing selected";
  $("#saveBtn").textContent = sel.length > 1 ? `Save (${sel.length})` : "Save";
  $("#saveBtn").disabled = !sel.length;
  $("#mergeBtn").disabled = sel.length < 2;
}
function animateCands(dt) {
  if (!imp || $("#importSheet").hidden) return;
  for (const p of imp.previews) {
    const cf = candFrames(p.c);
    if (p.r.gw !== cf.gw || p.r.gh !== cf.gh) { p.r.setGrid(cf.gw, cf.gh); p.r.cv.style.aspectRatio = cf.gw + " / " + cf.gh; p.i = 0; p.drawn = false; }
    p.acc += dt;
    let moved = !p.drawn;
    if (cf.frames.length > 1) while (p.acc >= cf.delays[p.i] / settings.speed) { p.acc -= cf.delays[p.i] / settings.speed; p.i = (p.i + 1) % cf.frames.length; moved = true; }
    if (moved) { p.r.draw(cf.frames[p.i]); p.drawn = true; }
  }
}
$("#gridSel").onchange = () => { if (imp) imp.previews.forEach((p) => (p.drawn = false)); };
async function saveCands(merge) {
  const sel = imp.cands.filter((c) => c.cb && c.cb.checked);
  if (!sel.length) return;
  const made = [];
  if (merge) {
    const name = await ask("Merge", `${sel.length} items become one animation, in the order of the list.`, "Merge", sel[0].name);
    if (!name) return;
    const first = candFrames(sel[0]);
    const frames = [], delays = [];
    for (const c of sel) {
      const fit = Formats.dmdLike(c.items[0].w, c.items[0].h) ? "contain" : "cover";
      for (const it of c.items) for (const f of it.frames) { frames.push(DMD.toGrid({ w: it.w, h: it.h, data: f.data }, first.gw, first.gh, fit)); delays.push(f.delay > 0 ? f.delay : 66); }
    }
    made.push(await addAnimation({ name, w: first.gw, h: first.gh, frames, delays, source: sel[0].items[0].origin }));
  } else {
    for (const c of sel) {
      const cf = candFrames(c);
      made.push(await addAnimation({ name: c.name.trim() || "Animation", w: cf.gw, h: cf.gh, frames: cf.frames, delays: cf.delays, source: c.items[0].origin }));
    }
  }
  closeImport();
  sortLib(); renderGrid();
  await select(made[0].id);
  toast(made.length === 1 ? `“${made[0].name}” saved` : `${made.length} animations saved`);
}
$("#saveBtn").onclick = () => saveCands(false).catch((e) => toast("Saving failed: " + e.message, 5000));
$("#mergeBtn").onclick = () => saveCands(true).catch((e) => toast("Saving failed: " + e.message, 5000));
function closeImport() { $("#importSheet").hidden = true; imp = null; $("#impBody").replaceChildren(); }
$("#impClose").onclick = closeImport;
$("#importBtn").onclick = () => { $("#fileIn").value = ""; $("#fileIn").click(); };
$("#fileIn").onchange = (e) => startImport([...e.target.files]);
// drag and drop on desktop
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files.length) startImport([...e.dataTransfer.files]); });

/* ---------- back button (Android) ---------- */
window.atlasBack = () => {
  if ($("#dlg").open) { $("#dlgNo").click(); return true; }
  if (document.body.classList.contains("fs")) { exitFS(); return true; }
  if (!$("#importSheet").hidden) { closeImport(); return true; }
  return false;
};
window.dmdFullscreenEnded = () => { if (document.body.classList.contains("fs")) exitFS(); };

/* ---------- start ---------- */
(async () => {
  buildControls();
  logo();
  await Store.open();
  lib = await Store.all();
  let demosDone = false;
  let demoVer = null;
  try { demoVer = localStorage.getItem("dmd-speler-demos"); demosDone = demoVer === "2"; } catch (e) { /* ignore */ }
  if (demoVer === "1") {
    // the first version had Dutch demos; swap them for the English ones
    for (const m of lib.filter((x) => x.source === "Demo")) await Store.del(m.id);
    lib = lib.filter((x) => x.source !== "Demo");
    let t = 1000;
    for (const d of DMD.demos().reverse()) { const m = await addAnimation(d); m.created = t++; await Store.putMeta(m); }
    demosDone = true;
    try { localStorage.setItem("dmd-speler-demos", "2"); } catch (e) { /* ignore */ }
  }
  if (!lib.length && !demosDone) {
    let t = 1000;
    for (const d of DMD.demos().reverse()) { const m = await addAnimation(d); m.created = t++; await Store.putMeta(m); }
    try { localStorage.setItem("dmd-speler-demos", "2"); } catch (e) { /* ignore */ }
  }
  sortLib();
  renderGrid();
  await select(settings.current);
  requestAnimationFrame(loop);
  if (!Store.persistent) toast("Note: storage is not available, the library will not be kept.", 5000);
})();
