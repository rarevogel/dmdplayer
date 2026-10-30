/* DMD Player: file formats.
   Reads Visual Pinball (.vpx/.vpt) and Future Pinball (.fpt) tables, GIF, TGA, ZIP and PinMAME/DMDExt text dumps,
   and turns what it finds into frames (RGBA) that the player can show.
   Everything works on a "source": { name, size, read(offset, length) -> Promise<Uint8Array> },
   so a table of several hundred MB is read piece by piece instead of all at once. */
"use strict";

const Formats = (() => {
  const td = new TextDecoder("latin1");
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function fileSource(file) {
    return { name: file.name, size: file.size, read: async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer()) };
  }
  function bytesSource(name, bytes) {
    return { name, size: bytes.length, read: async (off, len) => bytes.subarray(off, off + len) };
  }

  /* ---------- Compound File Binary (OLE), the container of .vpx, .vpt and .fpt ---------- */
  const CFB_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const ENDCHAIN = 0xfffffffe, FREESECT = 0xffffffff;

  async function openCFB(src) {
    const h = await src.read(0, 512);
    if (!CFB_SIG.every((v, i) => h[i] === v)) throw new Error("Not an OLE file");
    const shift = u16(h, 0x1e), ssz = 1 << shift, miniShift = u16(h, 0x20);
    const nFat = u32(h, 0x2c), dirStart = u32(h, 0x30), cutoff = u32(h, 0x38);
    const miniFatStart = u32(h, 0x3c), nMiniFat = u32(h, 0x40);
    let difatNext = u32(h, 0x44), nDifat = u32(h, 0x48);
    const off = (s) => (s + 1) * ssz;

    // read a list of sectors, merging neighbours into one read
    async function readSectors(list, total) {
      const out = new Uint8Array(list.length * ssz);
      let i = 0;
      while (i < list.length) {
        let j = i + 1;
        while (j < list.length && list[j] === list[j - 1] + 1 && j - i < 8192) j++;
        const chunk = await src.read(off(list[i]), (j - i) * ssz);
        out.set(chunk, i * ssz);
        i = j;
      }
      return total != null ? out.subarray(0, total) : out;
    }

    // the FAT sector list: 109 entries in the header, the rest in DIFAT sectors
    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(u32(h, 0x4c + i * 4));
    const per = ssz / 4;
    let guard = 0;
    while (fatSecs.length < nFat && difatNext < ENDCHAIN && nDifat-- > 0 && guard++ < 100000) {
      const d = await src.read(off(difatNext), ssz);
      for (let i = 0; i < per - 1 && fatSecs.length < nFat; i++) fatSecs.push(u32(d, i * 4));
      difatNext = u32(d, (per - 1) * 4);
    }
    const fatBytes = await readSectors(fatSecs);
    const fat = new Uint32Array(fatBytes.buffer, fatBytes.byteOffset, fatBytes.length / 4);
    const chain = (start, table) => {
      const out = [];
      let s = start;
      while (s < ENDCHAIN && s < table.length && out.length <= table.length) { out.push(s); s = table[s]; }
      return out;
    };

    // directory
    const dirBytes = await readSectors(chain(dirStart, fat));
    const entries = [];
    for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
      const nl = u16(dirBytes, o + 64);
      let name = "";
      for (let k = 0; k + 2 < nl && k < 64; k += 2) name += String.fromCharCode(u16(dirBytes, o + k));
      entries.push({ name, type: dirBytes[o + 66], left: u32(dirBytes, o + 68), right: u32(dirBytes, o + 72),
        child: u32(dirBytes, o + 76), start: u32(dirBytes, o + 116), size: u32(dirBytes, o + 120), path: "" });
    }
    const root = entries[0];
    if (!root) throw new Error("Empty directory in OLE file");
    // walk the tree to give every entry its full path
    const seen = new Set();
    const walk = (idx, prefix) => {
      const stack = [idx];
      while (stack.length) {
        const i = stack.pop();
        if (i >= entries.length || seen.has(i)) continue;
        seen.add(i);
        const e = entries[i];
        e.path = prefix ? prefix + "/" + e.name : e.name;
        if (e.left < entries.length) stack.push(e.left);
        if (e.right < entries.length) stack.push(e.right);
        if (e.type === 1 && e.child < entries.length) walk(e.child, e.path);
      }
    };
    seen.add(0);
    if (root.child < entries.length) walk(root.child, "");
    const streams = entries.filter((e) => e.type === 2 && e.path);

    // the mini stream (all streams smaller than the cutoff) is loaded once when first needed
    let mini = null, miniFat = null;
    async function loadMini() {
      if (mini) return;
      const mb = await readSectors(chain(miniFatStart, fat));
      miniFat = new Uint32Array(mb.buffer, mb.byteOffset, mb.length / 4);
      mini = await readSectors(chain(root.start, fat), root.size);
    }
    async function readStream(e) {
      if (e.size === 0) return new Uint8Array(0);
      if (e.size < cutoff && nMiniFat > 0) {
        await loadMini();
        const ms = 1 << miniShift, out = new Uint8Array(e.size);
        let pos = 0;
        for (const s of chain(e.start, miniFat)) {
          const n = Math.min(ms, e.size - pos);
          out.set(mini.subarray(s * ms, s * ms + n), pos);
          pos += n;
          if (pos >= e.size) break;
        }
        return out;
      }
      return readSectors(chain(e.start, fat), e.size);
    }
    return { streams, readStream, find: (p) => streams.find((e) => e.path.toLowerCase() === p.toLowerCase()) };
  }

  /* ---------- LZW as used by GIF and by the BITS records of Visual Pinball ---------- */
  function lzwDecode(data, minCode, expected) {
    const clear = 1 << minCode, eoi = clear + 1;
    const out = new Uint8Array(expected);
    const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
    for (let i = 0; i < clear; i++) { suffix[i] = i; first[i] = i; len[i] = 1; }
    let size = minCode + 1, mask = (1 << size) - 1, next = eoi + 1, old = -1;
    let bits = 0, acc = 0, op = 0;
    for (let ip = 0; ip < data.length && op < expected;) {
      while (bits < size && ip < data.length) { acc |= data[ip++] << bits; bits += 8; }
      if (bits < size) break;
      const code = acc & mask;
      acc >>>= size; bits -= size;
      if (code === clear) { size = minCode + 1; mask = (1 << size) - 1; next = eoi + 1; old = -1; continue; }
      if (code === eoi) break;
      let c = code, L;
      if (old === -1) {
        if (code >= next) break;
        out[op++] = suffix[code]; old = code; continue;
      }
      if (code < next) {
        L = len[code];
        if (next < 4096) { prefix[next] = old; suffix[next] = first[code]; first[next] = first[old]; len[next] = len[old] + 1; next++; }
      } else if (code === next && next < 4096) {
        prefix[next] = old; suffix[next] = first[old]; first[next] = first[old]; len[next] = len[old] + 1; next++;
        L = len[code];
      } else break;
      // write the string backwards
      let p = op + L - 1;
      if (p >= expected) { // clip
        let skip = p - expected + 1; p = expected - 1;
        while (skip-- > 0) c = prefix[c];
      }
      const end = p;
      while (p >= op) { out[p--] = suffix[c]; c = prefix[c]; }
      op = end + 1;
      old = code;
      if (next > mask && size < 12) { size++; mask = (1 << size) - 1; }
    }
    return op === expected ? out : out.subarray(0, op);
  }

  /* ---------- LZO1X decompression (Future Pinball "zLZO" data) ---------- */
  function lzo1xDecompress(src, outLen) {
    const out = new Uint8Array(outLen);
    let ip = 0, op = 0, t, m;
    const lit = (n) => { if (op + n > outLen || ip + n > src.length) throw new Error("LZO: too much data"); out.set(src.subarray(ip, ip + n), op); op += n; ip += n; };
    const copy = (from, n) => { if (from < 0 || op + n > outLen) throw new Error("LZO: bad back-reference"); for (let k = 0; k < n; k++) out[op++] = out[from++]; };
    const run = (base) => { let n = 0; while (src[ip] === 0) { n += 255; ip++; if (ip >= src.length) throw new Error("LZO: unexpected end"); } return n + base + src[ip++]; };
    let state = 0; // 0: start of a literal run, 1: right after a literal run, 2: match with t set, 3: trailing literals
    if (src[0] > 17) {
      t = src[ip++] - 17;
      if (t < 4) { state = 3; } else { lit(t); state = 1; }
    }
    for (let guard = 0; guard < 1e9; guard++) {
      if (state === 0) {
        t = src[ip++];
        if (t >= 16) { state = 2; continue; }
        if (t === 0) t = run(15);
        lit(t + 3);
        state = 1;
        continue;
      }
      if (state === 1) {
        t = src[ip++];
        if (t >= 16) { state = 2; continue; }
        m = op - 0x801 - (t >> 2) - (src[ip++] << 2);
        copy(m, 3);
        t = src[ip - 2] & 3;
        if (t === 0) { state = 0; continue; }
        state = 3; continue;
      }
      if (state === 2) {
        if (t >= 64) {
          m = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3);
          copy(m, (t >> 5) - 1 + 2);
        } else if (t >= 32) {
          t &= 31;
          if (t === 0) t = run(31);
          m = op - 1 - ((src[ip] >> 2) + (src[ip + 1] << 6));
          ip += 2;
          copy(m, t + 2);
        } else if (t >= 16) {
          m = op - ((t & 8) << 11);
          t &= 7;
          if (t === 0) t = run(7);
          m -= (src[ip] >> 2) + (src[ip + 1] << 6);
          ip += 2;
          if (m === op) return out.subarray(0, op); // end of stream
          m -= 0x4000;
          copy(m, t + 2);
        } else {
          m = op - 1 - (t >> 2) - (src[ip++] << 2);
          copy(m, 2);
        }
        t = src[ip - 2] & 3;
        if (t === 0) { state = 0; continue; }
        state = 3; continue;
      }
      // state 3: 1..3 literals after a match, then the next instruction is always a match
      lit(t);
      t = src[ip++];
      state = 2;
    }
    throw new Error("LZO: no end marker");
  }
  function unpackFP(data) {
    if (data.length > 8 && str4(data, 0) === "zLZO") {
      const n = u32(data, 4);
      if (n > 0 && n < 512 * 1024 * 1024) return lzo1xDecompress(data.subarray(8), n);
    }
    return data;
  }

  /* ---------- image decoding ---------- */
  function sniff(b) {
    if (b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
    if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
    if (str4(b, 0) === "RIFF" && str4(b, 8) === "WEBP") return "webp";
    if (str4(b, 0) === "PK\x03\x04") return "zip";
    if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "ico";
    return null;
  }

  // TGA (Future Pinball tables often keep their images as Targa)
  function decodeTGA(b) {
    const idLen = b[0], cmType = b[1], type = b[2];
    const cmFirst = u16(b, 3), cmLen = u16(b, 5), cmBits = b[7];
    const w = u16(b, 12), h = u16(b, 14), bpp = b[16], desc = b[17];
    if (![1, 2, 3, 9, 10, 11].includes(type) || !w || !h || w > 8192 || h > 8192) return null;
    if (![8, 15, 16, 24, 32].includes(bpp)) return null;
    let p = 18 + idLen;
    let cmap = null;
    const readPx = (bb, q, bits) => {
      if (bits === 32) return [bb[q + 2], bb[q + 1], bb[q], bb[q + 3]];
      if (bits === 24) return [bb[q + 2], bb[q + 1], bb[q], 255];
      if (bits === 15 || bits === 16) { const v = u16(bb, q); return [((v >> 10) & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, (v & 31) * 255 / 31 | 0, 255]; }
      return [bb[q], bb[q], bb[q], 255];
    };
    if (cmType === 1) {
      const eb = Math.ceil(cmBits / 8);
      cmap = [];
      for (let i = 0; i < cmLen; i++) cmap[cmFirst + i] = readPx(b, p + i * eb, cmBits);
      p += cmLen * eb;
    }
    const pxBytes = Math.ceil(bpp / 8), n = w * h;
    const raw = new Uint8Array(n * 4);
    const put = (i, q) => {
      let c;
      if (type === 1 || type === 9) c = (cmap && cmap[b[q] | (pxBytes > 1 ? b[q + 1] << 8 : 0)]) || [0, 0, 0, 255];
      else c = readPx(b, q, (type === 3 || type === 11) ? 8 : bpp);
      raw[i * 4] = c[0]; raw[i * 4 + 1] = c[1]; raw[i * 4 + 2] = c[2]; raw[i * 4 + 3] = c[3];
    };
    if (type < 9) {
      if (p + n * pxBytes > b.length) return null;
      for (let i = 0; i < n; i++) put(i, p + i * pxBytes);
    } else {
      let i = 0;
      while (i < n && p < b.length) {
        const hdr = b[p++], cnt = (hdr & 127) + 1;
        if (hdr & 128) { for (let k = 0; k < cnt && i < n; k++) put(i++, p); p += pxBytes; }
        else { for (let k = 0; k < cnt && i < n; k++) { put(i++, p); p += pxBytes; } }
      }
    }
    // alpha: 32-bit files with no alpha bits set are opaque
    if (bpp === 32 && (desc & 15) === 0) for (let i = 3; i < raw.length; i += 4) raw[i] = 255;
    // origin: bit 5 set = top-left, otherwise bottom-left
    const out = new Uint8ClampedArray(n * 4);
    const top = desc & 0x20, right = desc & 0x10;
    for (let y = 0; y < h; y++) {
      const sy = top ? y : h - 1 - y;
      for (let x = 0; x < w; x++) {
        const sx = right ? w - 1 - x : x;
        const s = (sy * w + sx) * 4, d = (y * w + x) * 4;
        out[d] = raw[s]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s + 2]; out[d + 3] = raw[s + 3];
      }
    }
    return { w, h, data: out };
  }

  // GIF, with every frame composed onto the logical screen
  function decodeGIF(b) {
    if (str4(b, 0) !== "GIF8") return null;
    const W = u16(b, 6), H = u16(b, 8), flags = b[10];
    let p = 13, gct = null;
    const readTable = (n) => { const t = []; for (let i = 0; i < n; i++) t.push([b[p + i * 3], b[p + i * 3 + 1], b[p + i * 3 + 2]]); p += n * 3; return t; };
    if (flags & 0x80) gct = readTable(1 << ((flags & 7) + 1));
    const canvas = new Uint8ClampedArray(W * H * 4);
    const frames = [];
    let delay = 100, trans = -1, disposal = 0;
    while (p < b.length) {
      const blk = b[p++];
      if (blk === 0x3b) break;
      if (blk === 0x21) {
        const label = b[p++];
        if (label === 0xf9 && b[p] >= 4) {
          const pf = b[p + 1];
          disposal = (pf >> 2) & 7;
          delay = u16(b, p + 2) * 10;
          trans = pf & 1 ? b[p + 4] : -1;
        }
        while (p < b.length && b[p] !== 0) p += b[p] + 1;
        p++;
        continue;
      }
      if (blk !== 0x2c) break;
      const fx = u16(b, p), fy = u16(b, p + 2), fw = u16(b, p + 4), fh = u16(b, p + 6), lf = b[p + 8];
      p += 9;
      let table = gct;
      if (lf & 0x80) table = readTable(1 << ((lf & 7) + 1));
      const interlaced = lf & 0x40;
      const minCode = b[p++];
      const parts = [];
      let total = 0;
      while (p < b.length && b[p] !== 0) { parts.push(b.subarray(p + 1, p + 1 + b[p])); total += b[p]; p += b[p] + 1; }
      p++;
      const joined = new Uint8Array(total);
      let q = 0;
      for (const s of parts) { joined.set(s, q); q += s.length; }
      const idx = lzwDecode(joined, minCode, fw * fh);
      const before = disposal === 3 ? canvas.slice() : null;
      const rows = [];
      if (interlaced) { for (const [st, stp] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = st; y < fh; y += stp) rows.push(y); }
      else for (let y = 0; y < fh; y++) rows.push(y);
      for (let r = 0; r < fh; r++) {
        const y = rows[r] + fy;
        if (y >= H) continue;
        for (let x = 0; x < fw; x++) {
          const k = r * fw + x;
          if (k >= idx.length) break;
          const ci = idx[k];
          if (ci === trans || !table || !table[ci]) continue;
          const X = x + fx;
          if (X >= W) continue;
          const d = (y * W + X) * 4, c = table[ci];
          canvas[d] = c[0]; canvas[d + 1] = c[1]; canvas[d + 2] = c[2]; canvas[d + 3] = 255;
        }
      }
      frames.push({ data: canvas.slice(), delay: delay < 20 ? 100 : delay });
      if (disposal === 2) {
        for (let y = fy; y < Math.min(H, fy + fh); y++) canvas.fill(0, (y * W + fx) * 4, (y * W + Math.min(W, fx + fw)) * 4);
      } else if (disposal === 3 && before) canvas.set(before);
      delay = 100; trans = -1; disposal = 0;
    }
    return frames.length ? { w: W, h: H, frames } : null;
  }

  async function decodeWithBrowser(bytes, type) {
    const blob = new Blob([bytes], { type: "image/" + type });
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
  }

  // any image bytes -> { w, h, frames: [{data, delay}] } or null
  async function decodeImage(bytes, nameHint) {
    const t = sniff(bytes);
    try {
      if (t === "gif") return decodeGIF(bytes);
      if (t === "png" || t === "jpeg" || t === "bmp" || t === "webp" || t === "ico") {
        const im = await decodeWithBrowser(bytes, t === "jpeg" ? "jpeg" : t === "ico" ? "x-icon" : t);
        return { w: im.w, h: im.h, frames: [{ data: im.data, delay: 0 }] };
      }
      if (!t || /\.tga$/i.test(nameHint || "")) {
        const im = decodeTGA(bytes);
        if (im) return { w: im.w, h: im.h, frames: [{ data: im.data, delay: 0 }] };
      }
    } catch (e) { /* not an image we can read */ }
    return null;
  }

  /* ---------- Visual Pinball images (GameStg/Image<n>, BIFF records) ---------- */
  function parseVPXImage(b) {
    const img = { name: "", path: "", w: 0, h: 0, bytes: null, bgra: null };
    let p = 0;
    const getStr = (q) => td.decode(b.subarray(q + 4, q + 4 + u32(b, q)));
    while (p + 8 <= b.length) {
      const size = u32(b, p), tag = str4(b, p + 4);
      const d = p + 8;
      if (tag === "ENDB") break;
      if (tag === "BITS") {
        // LZW blocks without a length: each block is a length byte plus data, up to the ALTV record
        let q = d;
        while (q < b.length) {
          if (q + 8 <= b.length && str4(b, q + 4) === "ALTV") break;
          const n = b[q];
          q += 1 + n;
          if (n === 0) break;
        }
        img.bitsData = b.subarray(d, q);
        p = q;
        continue;
      }
      if (tag === "JPEG") {
        // a nested PinBinary record list with the original file in DATA
        let q = d, dataLen = 0;
        while (q + 8 <= b.length) {
          const s2 = u32(b, q), t2 = str4(b, q + 4);
          if (t2 === "ENDB") { q += 8; break; }
          if (t2 === "SIZE") { dataLen = u32(b, q + 8); q += 4 + s2; continue; }
          if (t2 === "DATA") { img.bytes = b.subarray(q + 8, q + 8 + dataLen); q += 8 + dataLen; continue; }
          if (t2 === "PATH" && !img.path) img.path = getStr(q + 8);
          q += 4 + s2;
        }
        p = q;
        continue;
      }
      if (tag === "NAME") img.name = getStr(d);
      else if (tag === "PATH") img.path = getStr(d);
      else if (tag === "WDTH") img.w = u32(b, d);
      else if (tag === "HGHT") img.h = u32(b, d);
      p += 4 + size;
    }
    return img;
  }
  async function decodeVPXImage(img) {
    if (img.bytes) return decodeImage(img.bytes, img.path);
    if (img.bitsData && img.w && img.h) {
      const blocks = img.bitsData, parts = [];
      let q = 0, total = 0;
      while (q < blocks.length) { const n = blocks[q]; if (!n) break; parts.push(blocks.subarray(q + 1, q + 1 + n)); total += n; q += 1 + n; }
      const joined = new Uint8Array(total);
      let o = 0;
      for (const s of parts) { joined.set(s, o); o += s.length; }
      const bgra = lzwDecode(joined, 8, img.w * img.h * 4);
      if (bgra.length !== img.w * img.h * 4) return null;
      const rgba = new Uint8ClampedArray(bgra.length);
      let alpha = false;
      for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = bgra[i + 3]; if (bgra[i + 3] !== 255) alpha = true; }
      // some old tables store 0 alpha everywhere: treat them as opaque
      if (alpha) { let any = false; for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) { any = true; break; } if (!any) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; }
      return { w: img.w, h: img.h, frames: [{ data: rgba, delay: 0 }] };
    }
    return null;
  }

  /* ---------- Future Pinball images (Future Pinball/Image <n>, tagged records) ---------- */
  const FP = { type: 0xa4f1b9d1, name: 0xa4f4d1d7, id: 0xa4f4c4dc, path: 0xa1edd1d5, data: 0xa8edd1e1, dataLen: 0xa4e7c9d2, end: 0xa7fdc4e0 };
  const FP_KNOWN = new Set(Object.values(FP).concat([0x9ef3c6d9, 0xa6e9bee4, 0x95f5cce1, 0x96f3c0d1, 0x95efbbd9]));
  const FP_OLD = 0x15bdecdb; // tables from older Future Pinball versions use tags shifted by this amount
  const fpTag = (t) => (FP_KNOWN.has(t) ? t : (t - FP_OLD) >>> 0);
  function parseFPRecords(b, isList) {
    const r = { name: "", path: "", type: 0, data: null, items: null };
    let p = 0;
    while (p + 8 <= b.length) {
      const len = u32(b, p), tag = fpTag(u32(b, p + 4)), d = p + 8;
      if (tag === FP.end) break;
      if (tag === FP.name || tag === FP.path) {
        const s = td.decode(b.subarray(d + 4, d + 4 + u32(b, d)));
        if (tag === FP.name) r.name = s; else r.path = s;
      } else if (tag === FP.type) r.type = u32(b, d);
      else if (tag === FP.data && isList) {
        // a list of image names; the record length is not reliable here, so count it out
        const n = u32(b, d);
        let q = d + 4;
        r.items = [];
        for (let i = 0; i < n && q + 4 <= b.length; i++) { const l = u32(b, q); r.items.push(td.decode(b.subarray(q + 4, q + 4 + l))); q += 4 + l; }
        p = q;
        continue;
      } else if (tag === FP.data) r.data = b.subarray(d, Math.min(b.length, p + 4 + len));
      if (len < 4) break;
      p += 4 + len;
    }
    return r;
  }

  /* ---------- ZIP (deflate via DecompressionStream) ---------- */
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function readZip(src) {
    const tailLen = Math.min(src.size, 66000);
    const tail = await src.read(src.size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("Broken ZIP");
    const n = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
    const cd = await src.read(cdOff, cdSize);
    const files = [];
    for (let p = 0, i = 0; i < n && p + 46 <= cd.length; i++) {
      const method = u16(cd, p + 10), csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      const nl = u16(cd, p + 28), xl = u16(cd, p + 30), cl = u16(cd, p + 32), lho = u32(cd, p + 42);
      const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + xl + cl;
      if (name.endsWith("/")) continue;
      files.push({ name, size: usize, async bytes() {
        const lh = await src.read(lho, 30);
        const start = lho + 30 + u16(lh, 26) + u16(lh, 28);
        const raw = await src.read(start, csize);
        if (method === 0) return raw;
        if (method === 8) return inflateRaw(raw);
        throw new Error("Unknown ZIP compression");
      } });
    }
    return files;
  }

  /* ---------- PinMAME / DMDExt text dumps ---------- */
  function parseDump(text) {
    const lines = text.split(/\r?\n/);
    const frames = [];
    let cur = null, maxV = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (/^0x[0-9a-f]+$/i.test(l)) { cur = { t: parseInt(l, 16), rows: [] }; frames.push(cur); continue; }
      if (/^[0-9a-f]{16,}$/i.test(l)) {
        if (!cur) { cur = { t: frames.length * 40, rows: [] }; frames.push(cur); }
        cur.rows.push(l);
        for (const ch of l) { const v = parseInt(ch, 16); if (v > maxV) maxV = v; }
      } else if (l === "" && cur && cur.rows.length) cur = null;
    }
    const good = frames.filter((f) => f.rows.length);
    if (!good.length) return null;
    const w = good[0].rows[0].length, h = good[0].rows.length;
    const top = maxV <= 3 ? 3 : 15;
    const out = [];
    good.forEach((f, i) => {
      if (f.rows.length !== h) return;
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = Math.round(parseInt(f.rows[y][x] || "0", 16) * 255 / top), k = (y * w + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
      }
      const next = good[i + 1];
      const dl = next ? next.t - f.t : 0;
      out.push({ data: d, delay: dl > 0 && dl < 5000 ? dl : 40 });
    });
    return out.length ? { w, h, frames: out } : null;
  }

  /* ---------- grouping images into animations ---------- */
  const DMD_SIZES = [[128, 32], [192, 64], [256, 64], [128, 16], [160, 32], [192, 32]];
  function dmdLike(w, h) {
    if (!w || !h) return false;
    if (DMD_SIZES.some(([a, b]) => w % a === 0 && h % b === 0 && w / a === h / b && w / a <= 8)) return true;
    const r = w / h;
    return r >= 2.9 && r <= 6.1 && h <= 512;
  }
  function splitName(name) {
    const base = name.replace(/\.[a-z0-9]{2,4}$/i, "");
    const m = base.match(/^(.*?)[\s_\-.#(]*(\d+)\)?$/);
    if (!m || !m[1]) return null;
    return { key: m[1].toLowerCase(), label: m[1].replace(/[\s_\-.]+$/, ""), num: parseInt(m[2], 10) };
  }

  /* Reads one source (file or zip entry) and reports items through onItem(item):
     item = { kind: "image", name, w, h, frames, origin } or { kind: "list", name, items: [names], origin } */
  async function scan(src, onItem, onProgress, depth = 0, origin0 = null) {
    const head = await src.read(0, Math.min(src.size, 64));
    const lower = src.name.toLowerCase();
    if (CFB_SIG.every((v, i) => head[i] === v)) {
      const cfb = await openCFB(src);
      const isFP = cfb.streams.some((s) => /^Future Pinball\//i.test(s.path));
      const imgs = cfb.streams.filter((s) => isFP ? /\/Image \d+$/i.test(s.path) : /^GameStg\/Image\d+$/i.test(s.path));
      const lists = isFP ? cfb.streams.filter((s) => /\/ImageList \d+$/i.test(s.path)) : [];
      const num = (s) => parseInt(s.path.match(/(\d+)$/)[1], 10);
      imgs.sort((a, b) => num(a) - num(b));
      const origin = origin0 || src.name;
      for (let i = 0; i < imgs.length; i++) {
        onProgress && onProgress(i, imgs.length, src.name);
        try {
          const raw = await cfb.readStream(imgs[i]);
          let name, dec = null;
          if (isFP) {
            const r = parseFPRecords(raw, false);
            name = r.name || "Image " + num(imgs[i]);
            if (r.data) {
              const data = unpackFP(r.data);
              dec = await decodeImage(data, r.path || name);
            }
          } else {
            const im = parseVPXImage(raw);
            name = im.name || "Image" + num(imgs[i]);
            dec = await decodeVPXImage(im);
          }
          if (dec) onItem({ kind: "image", name, w: dec.w, h: dec.h, frames: dec.frames, origin });
          else onItem({ kind: "skip", name, origin });
        } catch (e) { onItem({ kind: "skip", name: imgs[i].path, origin, error: String(e.message || e) }); }
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
      for (const l of lists) {
        try {
          const r = parseFPRecords(await cfb.readStream(l), true);
          if (r.items && r.items.length) onItem({ kind: "list", name: r.name || "List", items: r.items, origin });
        } catch (e) { /* skip */ }
      }
      onProgress && onProgress(imgs.length, imgs.length, src.name);
      return { table: isFP ? "fp" : "vp", images: imgs.length, lists: lists.length };
    }
    if (str4(head, 0) === "PK\x03\x04" && depth < 2) {
      const files = await readZip(src);
      let n = 0;
      for (const f of files) {
        if (!/\.(vpx|vpt|fpt|gif|png|jpe?g|bmp|tga|webp|txt|zip)$/i.test(f.name)) continue;
        n++;
        onProgress && onProgress(n, files.length, f.name);
        const dir = f.name.includes("/") ? f.name.replace(/\/[^/]*$/, "") : "";
        try { await scan(bytesSource(f.name, await f.bytes()), (it) => { if (dir) it.folder = dir.replace(/^.*\//, ""); onItem(it); }, onProgress, depth + 1, src.name + ":" + dir); } catch (e) { onItem({ kind: "skip", name: f.name, origin: src.name }); }
      }
      return { table: "zip", images: n };
    }
    if (/\.txt$/i.test(lower) || /^0x[0-9a-f]+\s/i.test(td.decode(head))) {
      const text = new TextDecoder().decode(await src.read(0, src.size));
      const d = parseDump(text);
      if (d) onItem({ kind: "image", name: src.name.replace(/^.*\//, "").replace(/\.txt$/i, ""), w: d.w, h: d.h, frames: d.frames, origin: origin0 || src.name, dump: true });
      else onItem({ kind: "skip", name: src.name, origin: src.name });
      return { table: "txt" };
    }
    const bytes = await src.read(0, src.size);
    const dec = await decodeImage(bytes, src.name);
    if (dec) onItem({ kind: "image", name: src.name.replace(/^.*\//, ""), w: dec.w, h: dec.h, frames: dec.frames, origin: origin0 || src.name });
    else onItem({ kind: "skip", name: src.name, origin: src.name });
    return { table: "file" };
  }

  /* Turns scanned items into suggested animations.
     Returns { anims: [{name, items:[image items], reason}], singles: [items], others: [items] } */
  function group(items) {
    const images = items.filter((i) => i.kind === "image");
    const byName = new Map();
    for (const im of images) byName.set(im.origin + "|" + im.name.toLowerCase(), im);
    const used = new Set();
    const anims = [];
    // 1. Future Pinball image lists
    for (const l of items.filter((i) => i.kind === "list")) {
      const frames = l.items.map((n) => byName.get(l.origin + "|" + n.toLowerCase())).filter(Boolean);
      if (frames.length >= 2) { anims.push({ name: l.name, items: frames, reason: "Image list from the table" }); frames.forEach((f) => used.add(f)); }
    }
    // 2. animated GIFs and dumps
    for (const im of images) if (!used.has(im) && im.frames.length > 1) { anims.push({ name: im.name.replace(/\.gif$/i, ""), items: [im], reason: im.dump ? "DMD dump" : "Animated GIF" }); used.add(im); }
    // 3. numbered names of the same size
    const buckets = new Map();
    for (const im of images) {
      if (used.has(im)) continue;
      const s = splitName(im.name);
      if (!s) continue;
      const k = im.origin + "|" + s.key + "|" + im.w + "x" + im.h;
      const generic = /^(frame|frames|img|image|pic|dmd|anim|animation|f|)$/i.test(s.label.trim());
      if (!buckets.has(k)) buckets.set(k, { label: generic && im.folder ? im.folder : s.label || im.folder || "Animation", list: [] });
      buckets.get(k).list.push({ im, num: s.num });
    }
    for (const b of buckets.values()) {
      if (b.list.length < 2) continue;
      b.list.sort((a, c) => a.num - c.num);
      anims.push({ name: b.label, items: b.list.map((x) => x.im), reason: "Numbered images" });
      b.list.forEach((x) => used.add(x.im));
    }
    const rest = images.filter((im) => !used.has(im));
    const singles = rest.filter((im) => dmdLike(im.w, im.h));
    const others = rest.filter((im) => !dmdLike(im.w, im.h));
    // DMD-shaped animations first
    anims.sort((a, b) => (dmdLike(b.items[0].w, b.items[0].h) - dmdLike(a.items[0].w, a.items[0].h)) || b.items.length - a.items.length);
    return { anims, singles, others };
  }

  return { fileSource, bytesSource, openCFB, lzwDecode, lzo1xDecompress, unpackFP, decodeGIF, decodeTGA, decodeImage, parseVPXImage, decodeVPXImage, parseFPRecords, readZip, parseDump, scan, group, dmdLike, splitName, DMD_SIZES, sniff };
})();
if (typeof module !== "undefined") module.exports = Formats;
