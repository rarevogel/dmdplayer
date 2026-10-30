#!/usr/bin/env python3
"""Copies Chakra Petch from an unpacked @fontsource/chakra-petch package into android/assets/fonts with a fonts.css.
Usage: tools/fonts.py <folder with unpacked @fontsource packages>"""
import glob, re, shutil, sys
from pathlib import Path
SRC = Path(sys.argv[1]); OUT = Path(__file__).resolve().parent.parent / "android" / "assets" / "fonts"
OUT.mkdir(parents=True, exist_ok=True)
faces = []
d = Path(glob.glob(str(SRC / "fontsource-chakra-petch-[0-9]*" / "package"))[-1])
for w in ["400", "500", "600", "700"]:
    css = (d / f"{w}.css").read_text()
    for name, body in re.findall(r"/\* ([^*]+) \*/\s*(@font-face \{.*?\})", css, re.S):
        if not re.search(r"-(latin|latin-ext)-\d+-normal$", name.strip()):
            continue
        fn = name.strip() + ".woff2"
        shutil.copy(d / "files" / fn, OUT / fn)
        faces.append(re.sub(r"src:[^;]+;", f"src: url(./{fn}) format('woff2');", body))
shutil.copy(d / "LICENSE", OUT / "OFL-chakra-petch.txt")
(OUT / "fonts.css").write_text("/* Chakra Petch, SIL Open Font License 1.1 (see OFL-chakra-petch.txt), via Fontsource */\n" + "\n".join(faces) + "\n")
print(len(faces), "font faces")
