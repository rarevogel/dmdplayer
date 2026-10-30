/* DMD Player: the dot-matrix renderer, resampling, a small pixel font, demo animations, GIF export and frame storage. */
"use strict";

const DMD = (() => {
  const TINTS = {
    oranje: { label: "Orange", rgb: [255, 92, 16] },
    rood: { label: "Red", rgb: [255, 36, 28] },
    geel: { label: "Yellow", rgb: [255, 196, 30] },
    groen: { label: "Green", rgb: [60, 255, 90] },
    blauw: { label: "Blue", rgb: [60, 150, 255] },
    wit: { label: "White", rgb: [236, 240, 255] },
    kleur: { label: "Original", rgb: null },
  };
  const SIZES = [[128, 32], [192, 64], [256, 64]];

  /* ---------- resampling any image onto the dot grid ---------- */
  // fit: "contain" (letterbox) or "cover" (crop)
  function toGrid(src, gw, gh, fit) {
    const { w: sw, h: sh, data } = src;
    const out = new Uint8ClampedArray(gw * gh * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    if (sw === gw && sh === gh) {
      for (let i = 0; i < out.length; i += 4) { const a = data[i + 3] / 255; out[i] = data[i] * a; out[i + 1] = data[i + 1] * a; out[i + 2] = data[i + 2] * a; }
      return out;
    }
    const s = fit === "cover" ? Math.max(gw / sw, gh / sh) : Math.min(gw / sw, gh / sh);
    const tw = sw * s, th = sh * s, ox = (gw - tw) / 2, oy = (gh - th) / 2;
    for (let y = 0; y < gh; y++) {
      const sy0 = (y - oy) / s, sy1 = (y + 1 - oy) / s;
      if (sy1 <= 0 || sy0 >= sh) continue;
      for (let x = 0; x < gw; x++) {
        const sx0 = (x - ox) / s, sx1 = (x + 1 - ox) / s;
        if (sx1 <= 0 || sx0 >= sw) continue;
        let r = 0, g = 0, b = 0, wsum = 0;
        const ya = Math.max(0, Math.floor(sy0)), yb = Math.min(sh, Math.ceil(sy1));
        const xa = Math.max(0, Math.floor(sx0)), xb = Math.min(sw, Math.ceil(sx1));
        // with big sources sample a sub-grid instead of every pixel
        const stepY = Math.max(1, Math.floor((yb - ya) / 6)), stepX = Math.max(1, Math.floor((xb - xa) / 6));
        for (let yy = ya; yy < yb; yy += stepY) {
          const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
          if (wy <= 0) continue;
          for (let xx = xa; xx < xb; xx += stepX) {
            const wx = Math.min(xx + 1, sx1) - Math.max(xx, sx0);
            if (wx <= 0) continue;
            const k = (yy * sw + xx) * 4, a = data[k + 3] / 255, wgt = wx * wy;
            r += data[k] * a * wgt; g += data[k + 1] * a * wgt; b += data[k + 2] * a * wgt; wsum += wgt;
          }
        }
        // the part of a dot outside the picture counts as black
        const cover = (Math.min(sx1, sw) - Math.max(sx0, 0)) * (Math.min(sy1, sh) - Math.max(sy0, 0)) / ((sx1 - sx0) * (sy1 - sy0));
        if (wsum > 0) { const k = (y * gw + x) * 4, f = cover / wsum; out[k] = r * f; out[k + 1] = g * f; out[k + 2] = b * f; }
      }
    }
    return out;
  }
  // a good grid for a picture of w x h
  function gridFor(w, h) {
    for (const [a, b] of SIZES) if (w === a && h === b) return [a, b];
    for (const [a, b] of SIZES) if (w % a === 0 && h % b === 0 && w / a === h / b) return [a, b];
    const r = w / h;
    if (r >= 3.5) return [128, 32];
    if (r >= 2.5) return [192, 64];
    return [128, 32];
  }

  /* ---------- renderer ---------- */
  class Renderer {
    constructor(canvas, opts = {}) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.small = document.createElement("canvas");
      this.sctx = this.small.getContext("2d");
      this.style = Object.assign({ tint: "oranje", shape: "rond", glow: true, levels: 16, unlit: 0.09 }, opts);
      this.gw = 0; this.gh = 0; this.mask = null; this.maskKey = "";
      this.fixed = opts.fixedSize || null; // {w,h} for exports
    }
    setGrid(gw, gh) {
      if (gw === this.gw && gh === this.gh) return;
      this.gw = gw; this.gh = gh;
      this.small.width = gw; this.small.height = gh;
      this.img = this.sctx.createImageData(gw, gh);
      this.mask = null;
    }
    setStyle(s) { Object.assign(this.style, s); this.mask = null; }
    fitCanvas() {
      if (this.fixed) { this.cv.width = this.fixed.w; this.cv.height = this.fixed.h; return; }
      const r = this.cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 3);
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; this.mask = null; }
    }
    layout() {
      const W = this.cv.width, H = this.cv.height;
      const p = Math.min(W / this.gw, H / this.gh);
      return { p, ox: (W - p * this.gw) / 2, oy: (H - p * this.gh) / 2, W, H };
    }
    buildMask() {
      const { p, ox, oy, W, H } = this.layout();
      const key = [W, H, this.gw, this.gh, this.style.shape].join();
      if (this.mask && this.maskKey === key) return;
      const m = this.mask || document.createElement("canvas");
      m.width = W; m.height = H;
      const c = m.getContext("2d");
      c.globalCompositeOperation = "source-over";
      c.clearRect(0, 0, W, H);
      c.fillStyle = "#000";
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = "destination-out";
      c.fillStyle = "#000";
      if (p < 2.2) { // too small for gaps: show plain pixels
        c.fillRect(ox, oy, p * this.gw, p * this.gh);
      } else if (this.style.shape === "vierkant") {
        const g = Math.max(1, p * 0.16);
        for (let y = 0; y < this.gh; y++) for (let x = 0; x < this.gw; x++) c.fillRect(ox + x * p + g / 2, oy + y * p + g / 2, p - g, p - g);
      } else {
        const rad = p * 0.42;
        c.beginPath();
        for (let y = 0; y < this.gh; y++) for (let x = 0; x < this.gw; x++) {
          const cx = ox + (x + 0.5) * p, cy = oy + (y + 0.5) * p;
          c.moveTo(cx + rad, cy);
          c.arc(cx, cy, rad, 0, Math.PI * 2);
        }
        c.fill();
      }
      this.mask = m; this.maskKey = key;
    }
    // frame: RGBA at grid size
    draw(frame) {
      if (!this.gw) return;
      this.fitCanvas();
      const st = this.style, d = this.img.data, tint = TINTS[st.tint] ? TINTS[st.tint].rgb : TINTS.oranje.rgb;
      const lv = st.levels > 1 && st.levels < 256 ? st.levels - 1 : 0, un = st.unlit;
      if (frame) {
        for (let i = 0; i < d.length; i += 4) {
          let r = frame[i], g = frame[i + 1], b = frame[i + 2];
          if (tint) {
            let L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            L = Math.min(1, L * 1.08);
            if (lv) L = Math.round(L * lv) / lv;
            const f = un + (1 - un) * L;
            d[i] = tint[0] * f; d[i + 1] = tint[1] * f; d[i + 2] = tint[2] * f;
          } else {
            if (lv) { r = Math.round(r / 255 * lv) / lv * 255; g = Math.round(g / 255 * lv) / lv * 255; b = Math.round(b / 255 * lv) / lv * 255; }
            const base = 255 * un * 0.55;
            d[i] = Math.max(r, base); d[i + 1] = Math.max(g, base); d[i + 2] = Math.max(b, base);
          }
          d[i + 3] = 255;
        }
      } else {
        const f = tint ? un : un * 0.55;
        for (let i = 0; i < d.length; i += 4) { d[i] = (tint ? tint[0] : 255) * f; d[i + 1] = (tint ? tint[1] : 255) * f; d[i + 2] = (tint ? tint[2] : 255) * f; d[i + 3] = 255; }
      }
      this.sctx.putImageData(this.img, 0, 0);
      const { p, ox, oy, W, H } = this.layout(), ctx = this.ctx;
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.small, ox, oy, p * this.gw, p * this.gh);
      this.buildMask();
      ctx.drawImage(this.mask, 0, 0);
      if (st.glow && p >= 2.2 && frame) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.55;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = "blur(" + Math.max(1, p * 0.9).toFixed(1) + "px)";
        ctx.drawImage(this.small, ox, oy, p * this.gw, p * this.gh);
        ctx.filter = "none";
      }
      ctx.restore();
    }
  }

  /* ---------- a 5x7 pixel font ---------- */
  const GLYPHS = {
    A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"], D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"], H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"], J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
    K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"], L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"], N: ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
    O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"], P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"], R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"], V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"], X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"], Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], 1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], 3: ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], 5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"], 7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], 9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"], "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
    ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"], ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"], ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
    "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"], "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
    "×": ["00000", "10001", "01010", "00100", "01010", "10001", "00000"],
  };
  const textWidth = (s, scale = 1) => s.length ? (s.length * 6 - 1) * scale : 0;
  // draws text into a gray buffer (Float32Array w*h, 0..1)
  function drawText(buf, w, h, s, x0, y0, scale = 1, v = 1) {
    let x = Math.round(x0);
    for (const ch of s.toUpperCase()) {
      const g = GLYPHS[ch] || GLYPHS["?"];
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
        if (g[gy][gx] !== "1") continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const px = x + gx * scale + sx, py = Math.round(y0) + gy * scale + sy;
          if (px >= 0 && px < w && py >= 0 && py < h) buf[py * w + px] = Math.max(buf[py * w + px], v);
        }
      }
      x += 6 * scale;
    }
  }
  const grayToRGBA = (buf) => { const o = new Uint8ClampedArray(buf.length * 4); for (let i = 0; i < buf.length; i++) { const v = Math.max(0, Math.min(1, buf[i])) * 255; o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v; o[i * 4 + 3] = 255; } return o; };

  /* ---------- demo animations (made here, so the library is never empty) ---------- */
  function demos() {
    const W = 128, H = 32, out = [];
    const make = (name, n, fn, delay = 40) => {
      const frames = [];
      for (let i = 0; i < n; i++) { const b = new Float32Array(W * H); fn(b, i, n); frames.push(grayToRGBA(b)); }
      out.push({ name, w: W, h: H, frames, delays: frames.map(() => delay), source: "Demo" });
    };
    make("Welcome", 150, (b, i) => {
      const t1 = "DMD PLAYER", w1 = textWidth(t1, 2);
      const x = i < 40 ? W - (W - (W - w1) / 2) * (i / 40) : (W - w1) / 2;
      drawText(b, W, H, t1, x, 2, 2, 1);
      if (i > 50) {
        const t2 = "LOAD YOUR TABLES", w2 = textWidth(t2);
        const vis = Math.min(t2.length, Math.floor((i - 50) / 3));
        drawText(b, W, H, t2.slice(0, vis), (W - w2) / 2, 22, 1, 0.55);
      }
      if (i > 120 && i % 8 < 4) for (let k = 0; k < W; k++) { b[k] = 0.3; b[(H - 1) * W + k] = 0.3; }
    });
    make("Jackpot", 72, (b, i) => {
      const cx = W / 2, cy = H / 2, a0 = i * 0.06;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const a = Math.atan2((y - cy) * 2, x - cx) + a0;
        const ray = Math.cos(a * 8) > 0.6 ? 0.22 : 0;
        b[y * W + x] = ray;
      }
      const t = "JACKPOT", w = textWidth(t, 2);
      for (let y = 6; y < 26; y++) for (let x = (W - w) / 2 - 4; x < (W + w) / 2 + 4; x++) b[y * W + (x | 0)] = 0;
      drawText(b, W, H, t, (W - w) / 2, 9, 2, i % 12 < 8 ? 1 : 0.35);
    }, 45);
    make("Multiball", 120, (b, i) => {
      for (let k = 0; k < W; k++) { b[k] = 0.25; b[(H - 1) * W + k] = 0.25; }
      for (let k = 0; k < H; k++) { b[k * W] = 0.25; b[k * W + W - 1] = 0.25; }
      const balls = [[3.1, 1.7, 0], [2.3, 2.1, 1.4], [3.7, 1.3, 2.9]];
      for (const [vx, vy, ph] of balls) for (let tr = 4; tr >= 0; tr--) {
        const t = (i - tr * 1.2) + ph * 20;
        const px = 4 + Math.abs(((t * vx) % (2 * (W - 9))) - (W - 9));
        const py = 4 + Math.abs(((t * vy) % (2 * (H - 9))) - (H - 9));
        const v = tr ? 0.5 - tr * 0.1 : 1;
        for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) if (x * x + y * y <= 5) {
          const X = Math.round(px + x), Y = Math.round(py + y);
          if (X > 0 && X < W - 1 && Y > 0 && Y < H - 1) b[Y * W + X] = Math.max(b[Y * W + X], v * (x === -1 && y === -1 && !tr ? 1 : 0.85));
        }
      }
      if (i < 30 || i % 20 < 12) drawText(b, W, H, "MULTIBALL", (W - textWidth("MULTIBALL")) / 2, 12, 1, 0.6);
    }, 35);
    make("Star storm", 110, (b, i) => {
      for (let s = 0; s < 70; s++) {
        const ang = s * 2.399, sp = 0.6 + (s % 7) * 0.15;
        const r = ((i * sp + s * 13) % 70);
        const x = W / 2 + Math.cos(ang) * r * 1.6, y = H / 2 + Math.sin(ang) * r * 0.45;
        const X = Math.round(x), Y = Math.round(y);
        if (X >= 0 && X < W && Y >= 0 && Y < H) b[Y * W + X] = Math.min(1, 0.25 + r / 50);
      }
      if (i > 45) {
        const t = "BONUS ×5", w = textWidth(t, 2), sc = i < 60 ? (i - 45) / 15 : 1;
        if (sc >= 1) drawText(b, W, H, t, (W - w) / 2, 9, 2, 1);
        else drawText(b, W, H, t, (W - textWidth(t)) / 2, 12, 1, sc);
      }
    }, 40);
    make("Score", 90, (b, i) => {
      const score = Math.floor(Math.min(1, i / 60) ** 0.6 * 4321560);
      const s = score.toLocaleString("en-US");
      drawText(b, W, H, "PLAYER 1", 2, 1, 1, 0.45);
      drawText(b, W, H, "BALL 3", W - textWidth("BALL 3") - 2, 1, 1, 0.45);
      drawText(b, W, H, s, W - textWidth(s, 2) - 4, 13, 2, i > 60 && i % 10 < 5 ? 0.5 : 1);
    }, 40);
    return out;
  }

  /* ---------- GIF encoder ---------- */
  function quantize(frames) {
    // reduce colour precision until at most 255 colours remain (index 255 is spare)
    for (let bits = 8; bits >= 3; bits--) {
      const sh = 8 - bits, map = new Map();
      let over = false;
      outer: for (const f of frames) for (let i = 0; i < f.length; i += 4) {
        const k = ((f[i] >> sh) << 16) | ((f[i + 1] >> sh) << 8) | (f[i + 2] >> sh);
        if (!map.has(k)) { map.set(k, map.size); if (map.size > 255) { over = true; break outer; } }
      }
      if (!over) {
        const pal = [], fill = (v) => sh ? Math.min(255, (v << sh) | ((1 << sh) - 1) * (v ? 1 : 0)) : v;
        for (const k of map.keys()) pal.push([fill(k >> 16), fill((k >> 8) & 255), fill(k & 255)]);
        const idx = frames.map((f) => { const o = new Uint8Array(f.length / 4); for (let i = 0, j = 0; i < f.length; i += 4, j++) o[j] = map.get(((f[i] >> sh) << 16) | ((f[i + 1] >> sh) << 8) | (f[i + 2] >> sh)); return o; });
        return { pal, idx };
      }
    }
    return null;
  }
  function lzwEncode(idx, minCode, out) {
    const clear = 1 << minCode, eoi = clear + 1;
    let size = minCode + 1, next = eoi + 1, dict = new Map();
    let acc = 0, nb = 0;
    const bytes = [];
    const emit = (c) => { acc |= c << nb; nb += size; while (nb >= 8) { bytes.push(acc & 255); acc >>>= 8; nb -= 8; } };
    emit(clear);
    let w = idx[0];
    for (let i = 1; i < idx.length; i++) {
      const c = idx[i], key = (w << 8) | c;
      const hit = dict.get(key);
      if (hit !== undefined) { w = hit; continue; }
      emit(w);
      if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
      else { emit(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
      w = c;
    }
    emit(w); emit(eoi);
    if (nb > 0) bytes.push(acc & 255);
    out.push(minCode);
    for (let i = 0; i < bytes.length; i += 255) { const n = Math.min(255, bytes.length - i); out.push(n); for (let k = 0; k < n; k++) out.push(bytes[i + k]); }
    out.push(0);
  }
  function encodeGIF(frames, w, h, delays) {
    const q = quantize(frames);
    if (!q) throw new Error("Te veel kleuren");
    let bits = 1;
    while ((1 << bits) < Math.max(2, q.pal.length)) bits++;
    const out = [];
    const push16 = (v) => out.push(v & 255, (v >> 8) & 255);
    for (const c of "GIF89a") out.push(c.charCodeAt(0));
    push16(w); push16(h);
    out.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
    for (let i = 0; i < (1 << bits); i++) { const c = q.pal[i] || [0, 0, 0]; out.push(c[0], c[1], c[2]); }
    out.push(0x21, 0xff, 11); for (const c of "NETSCAPE2.0") out.push(c.charCodeAt(0)); out.push(3, 1, 0, 0, 0);
    q.idx.forEach((ix, n) => {
      out.push(0x21, 0xf9, 4, 0x04); push16(Math.max(2, Math.round((delays[n] || 40) / 10))); out.push(0, 0);
      out.push(0x2c); push16(0); push16(0); push16(w); push16(h); out.push(0);
      lzwEncode(ix, Math.max(2, bits), out);
    });
    out.push(0x3b);
    return new Uint8Array(out);
  }

  /* ---------- frame storage: all frames in one gzip-compressed buffer ---------- */
  async function pack(frames) {
    const n = frames.reduce((s, f) => s + f.length, 0), all = new Uint8Array(n);
    let o = 0;
    for (const f of frames) { all.set(f, o); o += f.length; }
    try {
      const cs = new CompressionStream("gzip");
      return { gz: true, buf: await new Response(new Blob([all]).stream().pipeThrough(cs)).arrayBuffer() };
    } catch (e) { return { gz: false, buf: all.buffer }; }
  }
  async function unpack(p, w, h) {
    let buf = p.buf;
    if (p.gz) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const all = new Uint8ClampedArray(buf), sz = w * h * 4, out = [];
    for (let o = 0; o + sz <= all.length; o += sz) out.push(all.subarray(o, o + sz));
    return out;
  }

  return { TINTS, SIZES, toGrid, gridFor, Renderer, drawText, textWidth, demos, encodeGIF, quantize, pack, unpack };
})();
