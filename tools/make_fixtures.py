#!/usr/bin/env python3
"""Makes small synthetic test tables (no real tables are needed or included):
  test/fixtures/test.vpx   Visual Pinball: DMD frames as LZW 'BITS' and as embedded PNG, plus a playfield JPEG
  test/fixtures/test.fpt   Future Pinball: frames as zLZO-compressed TGA and plain BMP, an image list, old-style tags
  test/fixtures/anim.gif, dump.txt, frames.zip
The OLE writer below is minimal: enough for the reader in src/formats.js and for olefile-style readers."""
import ctypes, io, math, struct, zipfile
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "test" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)

# ---------- OLE / compound file writer ----------
SS, MS, CUT = 512, 64, 4096
END, FREE, FATSECT = 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFD

def write_cfb(path, files):
    """files: {"Storage/Stream": bytes}. Streams < 4096 bytes go to the mini stream."""
    # directory tree
    entries = [{"name": "Root Entry", "type": 5, "kids": []}]
    index = {"": 0}
    for full in files:
        parts = full.split("/")
        for i in range(1, len(parts)):
            p = "/".join(parts[:i])
            if p not in index:
                index[p] = len(entries); entries.append({"name": parts[i - 1], "type": 1, "kids": []})
                entries[index["/".join(parts[:i - 1])]]["kids"].append(index[p])
        index[full] = len(entries); entries.append({"name": parts[-1], "type": 2, "kids": [], "data": files[full]})
        entries[index["/".join(parts[:-1])]]["kids"].append(index[full])
    # mini stream
    mini, minifat = bytearray(), []
    for e in entries:
        d = e.get("data")
        if d is not None and len(d) < CUT:
            n = max(1, math.ceil(len(d) / MS)); e["start"] = len(minifat)
            minifat += [len(minifat) + k + 1 for k in range(n - 1)] + [END]
            mini += d + b"\0" * (n * MS - len(d))
    # sector chains: dir, minifat, ministream, big streams
    def secs(n): return max(1, math.ceil(n / SS))
    chains = []  # (owner, bytes)
    dirbytes_len = len(entries) * 128
    chains.append(("dir", secs(dirbytes_len)))
    mf = struct.pack("<%dI" % len(minifat), *minifat) if minifat else b""
    if mf: chains.append(("minifat", secs(len(mf))))
    if mini: chains.append(("mini", secs(len(mini))))
    for i, e in enumerate(entries):
        d = e.get("data")
        if d is not None and len(d) >= CUT: chains.append((i, secs(len(d))))
    data_secs = sum(n for _, n in chains)
    nfat = 1
    while nfat * (SS // 4) < data_secs + nfat: nfat += 1
    assert nfat <= 109
    fat = [FATSECT] * nfat
    starts = {}
    for owner, n in chains:
        starts[owner] = len(fat)
        fat += [len(fat) + k + 1 for k in range(n - 1)] + [END]
    fat += [FREE] * (nfat * (SS // 4) - len(fat))
    entries[0]["start"] = starts.get("mini", END); entries[0]["size"] = len(mini)
    for i, e in enumerate(entries):
        d = e.get("data")
        if d is not None:
            e["size"] = len(d)
            if len(d) >= CUT: e["start"] = starts[i]
        elif i: e["start"], e["size"] = 0, 0
    # directory bytes; siblings chained through the right pointer
    for e in entries:
        e["left"] = e["right"] = e["child"] = FREE
    for e in entries:
        k = e["kids"]
        if k:
            e["child"] = k[0]
            for a, b in zip(k, k[1:]): entries[a]["right"] = b
    db = bytearray()
    for e in entries:
        nm = (e["name"] + "\0").encode("utf-16-le")
        rec = nm + b"\0" * (64 - len(nm))
        rec += struct.pack("<HBB3I16sI8s8sII", len(nm), e["type"], 1, e["left"], e["right"], e["child"], b"\0" * 16, 0, b"\0" * 8, b"\0" * 8, e.get("start", 0), e.get("size", 0))
        rec += b"\0" * 4
        assert len(rec) == 128
        db += rec
    hdr = bytearray(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 16)
    hdr += struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6) + b"\0" * 6
    hdr += struct.pack("<IIIIIIIII", 0, nfat, starts["dir"], 0, CUT, starts.get("minifat", END), secs(len(mf)) if mf else 0, END, 0)
    difat = list(range(nfat)) + [FREE] * (109 - nfat)
    hdr += struct.pack("<109I", *difat)
    assert len(hdr) == 512
    body = bytearray(struct.pack("<%dI" % len(fat), *fat))
    def pad(b): return bytes(b) + b"\0" * (secs(len(b)) * SS - len(b))
    for owner, n in chains:
        if owner == "dir": body += pad(db)
        elif owner == "minifat": body += pad(mf)
        elif owner == "mini": body += pad(mini)
        else: body += pad(entries[owner]["data"])
    Path(path).write_bytes(bytes(hdr) + bytes(body))

# ---------- frames ----------
def frame(i, n, w=128, h=32, text="JACKPOT"):
    im = Image.new("RGB", (w, h), (0, 0, 0)); d = ImageDraw.Draw(im)
    x = int((w + 40) * i / n) - 20
    d.ellipse([x - 6, h // 2 - 6, x + 6, h // 2 + 6], fill=(255, 120, 0))
    d.text((w // 2 - 20, 2), text, fill=(255, 160, 40))
    d.rectangle([0, h - 3, int(w * (i + 1) / n), h - 1], fill=(160, 70, 0))
    return im

def png(im):
    b = io.BytesIO(); im.save(b, "PNG"); return b.getvalue()
def bmp(im):
    b = io.BytesIO(); im.save(b, "BMP"); return b.getvalue()
def tga(im, rle=False):
    b = io.BytesIO(); im.save(b, "TGA", compression="tga_rle" if rle else None); return b.getvalue()
def jpg(im):
    b = io.BytesIO(); im.save(b, "JPEG", quality=85); return b.getvalue()

# ---------- LZW (GIF style, LSB, 8-bit minimum code size) for VPX BITS ----------
def lzw_encode(data):
    clear, eoi = 256, 257
    out, acc, nbits = bytearray(), 0, 0
    def emit(code, size):
        nonlocal acc, nbits
        acc |= code << nbits; nbits += size
        while nbits >= 8: out.append(acc & 255); acc >>= 8; nbits -= 8
    table = {bytes([i]): i for i in range(256)}; nxt, size = 258, 9
    emit(clear, size)
    w = b""
    for c in data:
        wc = w + bytes([c])
        if wc in table: w = wc; continue
        emit(table[w], size)
        if nxt < 4096:
            table[wc] = nxt; nxt += 1
            if nxt > (1 << size) and size < 12: size += 1
        else:
            emit(clear, size); table = {bytes([i]): i for i in range(256)}; nxt, size = 258, 9
        w = bytes([c])
    if w: emit(table[w], size)
    emit(eoi, size)
    if nbits: out.append(acc & 255)
    blocks = bytearray()
    for i in range(0, len(out), 254): chunk = out[i:i + 254]; blocks += bytes([len(chunk)]) + chunk
    return bytes(blocks)

def biff(tag, data): return struct.pack("<I", len(data) + 4) + tag.encode() + data
def bstr(s): b = s.encode("latin1"); return struct.pack("<I", len(b)) + b

def vpx_image_bits(name, im):
    w, h = im.size; rgba = im.convert("RGBA").tobytes()
    bgra = bytearray(rgba)
    bgra[0::4], bgra[2::4] = rgba[2::4], rgba[0::4]
    return (biff("NAME", bstr(name)) + biff("PATH", bstr("C:\\dmd\\" + name + ".bmp")) + biff("WDTH", struct.pack("<I", w)) + biff("HGHT", struct.pack("<I", h))
            + struct.pack("<I", 4) + b"BITS" + lzw_encode(bytes(bgra)) + biff("ALTV", struct.pack("<f", 1.0)) + struct.pack("<I", 4) + b"ENDB")

def vpx_image_file(name, im, data, ext):
    w, h = im.size
    pin = biff("NAME", bstr(name)) + biff("PATH", bstr("C:\\img\\" + name + "." + ext)) + biff("SIZE", struct.pack("<I", len(data))) + biff("DATA", data) + struct.pack("<I", 4) + b"ENDB"
    return (biff("NAME", bstr(name)) + biff("PATH", bstr("C:\\img\\" + name + "." + ext)) + biff("WDTH", struct.pack("<I", w)) + biff("HGHT", struct.pack("<I", h))
            + struct.pack("<I", 4) + b"JPEG" + pin + biff("ALTV", struct.pack("<f", 1.0)) + struct.pack("<I", 4) + b"ENDB")

# ---------- LZO for FPT ----------
LZO = ctypes.CDLL("liblzo2.so.2")
def zlzo(data):
    dst = ctypes.create_string_buffer(len(data) + len(data) // 16 + 64 + 3); dl = ctypes.c_size_t(0)
    assert LZO.lzo1x_1_compress(data, len(data), dst, ctypes.byref(dl), ctypes.create_string_buffer(131072)) == 0
    return b"zLZO" + struct.pack("<I", len(data)) + dst.raw[:dl.value]

FPTAG = dict(type=0xA4F1B9D1, name=0xA4F4D1D7, path=0xA1EDD1D5, data=0xA8EDD1E1, data_len=0xA4E7C9D2, end=0xA7FDC4E0)
def fp_rec(tag, data, old=False):
    t = (FPTAG[tag] + (0x15BDECDB if old else 0)) & 0xFFFFFFFF
    return struct.pack("<II", len(data) + 4, t) + data
def fp_image(name, raw, ext, old=False, packed=True):
    payload = zlzo(raw) if packed else raw
    return (fp_rec("type", struct.pack("<I", 1), old) + fp_rec("name", bstr(name), old) + fp_rec("path", bstr("C:\\fp\\" + name + "." + ext), old)
            + fp_rec("data_len", struct.pack("<I", len(payload)), old) + fp_rec("data", payload, old) + fp_rec("end", b"", old))
def fp_list(name, items):
    body = struct.pack("<I", len(items)) + b"".join(bstr(s) for s in items)
    return fp_rec("name", bstr(name)) + struct.pack("<II", 4, FPTAG["data"]) + body + fp_rec("end", b"")  # declared length is wrong on purpose, like real files

def main():
    # VPX: 6 frames as BITS, 5 frames as PNG, a playfield JPEG, a lone DMD title
    files = {"GameStg/Version": struct.pack("<I", 1080), "GameStg/GameData": b"\0" * 100}
    n = 0
    for i in range(6):
        files[f"GameStg/Image{n}"] = vpx_image_bits(f"dmd_jackpot_{i + 1}", frame(i, 6)); n += 1
    for i in range(5):
        im = frame(i, 5, text="MULTI")
        files[f"GameStg/Image{n}"] = vpx_image_file(f"Multiball{i:02d}", im, png(im.resize((512, 128), Image.NEAREST)), "png"); n += 1
    pf = Image.new("RGB", (600, 1200), (20, 60, 120)); ImageDraw.Draw(pf).ellipse([100, 300, 500, 700], fill=(200, 40, 40))
    files[f"GameStg/Image{n}"] = vpx_image_file("playfield", pf, jpg(pf), "jpg"); n += 1
    files[f"GameStg/Image{n}"] = vpx_image_bits("DMDTitle", frame(3, 6, text="TITLE")); n += 1
    write_cfb(OUT / "test.vpx", files)

    # FPT: 8 frames in an image list (zLZO TGA, one RLE), 4 numbered BMPs (unpacked, old tags), a backglass
    fp = {"Future Pinball/File Version": b"\0" * 4, "Future Pinball/Table Data": b"\0" * 64}
    names = []
    for i in range(8):
        nm = f"Explode {i}"; names.append(nm)
        fp[f"Future Pinball/Image {i + 1}"] = fp_image(nm, tga(frame(i, 8, text="BOOM"), rle=(i == 3)), "tga")
    for i in range(4):
        fp[f"Future Pinball/Image {i + 9}"] = fp_image(f"Ramp-{i + 1}", bmp(frame(i, 4, w=192, h=64, text="RAMP")), "bmp", old=True, packed=False)
    bg = Image.new("RGB", (800, 600), (90, 20, 90))
    fp["Future Pinball/Image 13"] = fp_image("backglass", jpg(bg), "jpg", packed=False)
    fp["Future Pinball/ImageList 1"] = fp_list("Explosion", list(reversed(names)))
    write_cfb(OUT / "test.fpt", fp)

    # GIF, dump, zip
    fr = [frame(i, 10, text="GIF").convert("P", palette=Image.ADAPTIVE) for i in range(10)]
    fr[0].save(OUT / "anim.gif", save_all=True, append_images=fr[1:], duration=80, loop=0)
    lines = []
    for i in range(12):
        lines.append("0x%08x" % (i * 50))
        for y in range(32):
            lines.append("".join("3" if (x + y + i * 3) % 16 < 4 else ("1" if (x * y) % 7 == 0 else "0") for x in range(128)))
        lines.append("")
    (OUT / "dump.txt").write_text("\n".join(lines))
    with zipfile.ZipFile(OUT / "frames.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(7): z.writestr(f"flexdmd/attract/frame_{i:03d}.png", png(frame(i, 7, text="ZIP")))
        z.writestr("readme.txt", "not a dump")
    print("fixtures in", OUT)

if __name__ == "__main__":
    main()
