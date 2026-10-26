"""Build the two submission files from their sources, with every image embedded so each opens by double-clicking.

Run from the repo folder:  python docs/build_docs.py
  docs/report_src.html  ->  report.html
  docs/slides_src.html  ->  slides.html   (only if that source exists)
Images come from evidence/screenshots/. Slides load reveal.js from a CDN.
"""
import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "evidence" / "screenshots"


def embed(html: str) -> str:
    def swap(m):
        data = (SHOTS / m.group(1)).read_bytes()
        return "data:image/jpeg;base64," + base64.b64encode(data).decode()
    return re.sub(r"\{\{IMG:([^}]+)\}\}", swap, html)


for src, out in (("report_src.html", "report.html"), ("slides_src.html", "slides.html")):
    path = ROOT / "docs" / src
    if path.exists():
        (ROOT / out).write_text(embed(path.read_text(encoding="utf-8")), encoding="utf-8")
        print(f"built {out} ({(ROOT / out).stat().st_size // 1024} KB)")
