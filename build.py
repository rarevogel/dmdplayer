#!/usr/bin/env python3
"""Builds DMD Player: index.html (web, font from Google Fonts) and android/assets/index.html (font bundled)."""
import re
from pathlib import Path
HERE = Path(__file__).resolve().parent
GOOGLE = re.compile(r'<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/[^"]+">')
def main():
    t = (HERE / "src" / "index.html").read_text(encoding="utf-8")
    js = lambda n: (HERE / "src" / n).read_text(encoding="utf-8").replace("</script", "<\\/script")
    html = t.replace("__FORMATS__", js("formats.js")).replace("__DMD__", js("dmd.js")).replace("__APP__", js("app.js"))
    assert GOOGLE.search(html)
    (HERE / "index.html").write_text(html, encoding="utf-8")
    (HERE / "android" / "assets").mkdir(parents=True, exist_ok=True)
    (HERE / "android" / "assets" / "index.html").write_text(GOOGLE.sub('<link rel="stylesheet" href="fonts/fonts.css">', html), encoding="utf-8")
    print(f"index.html {len(html) // 1024} KB")
if __name__ == "__main__":
    main()
