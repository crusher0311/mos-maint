"""Render the review Markdown subset as a dependency-free, printable HTML file."""
from pathlib import Path
import html
import re

ROOT = Path(__file__).resolve().parent
source = ROOT / "workflow-manager-review.md"
target = ROOT / "workflow-manager-review.html"


def inline(text):
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html.escape(text))


lines = source.read_text().splitlines()
contents_start = lines.index("## Contents")
contents_end = lines.index("## 1. Read this first")
lines = lines[:contents_start] + lines[contents_end:]
body, contents = [], []
paragraph, listing, code = [], False, None


def flush():
    if paragraph:
        text = " ".join(paragraph)
        cls = ' class="notes"' if text.startswith("Notes:") else ""
        body.append(f"<p{cls}>{inline(text)}</p>")
        paragraph.clear()


for line in lines:
    if line.startswith("```"):
        flush()
        if code is None:
            code = []
        else:
            body.append("<pre>" + html.escape("\n".join(code)) + "</pre>")
            code = None
        continue
    if code is not None:
        code.append(line)
        continue
    if not line.startswith("- ") and listing:
        body.append("</ul>")
        listing = False
    if line.startswith("#"):
        flush()
        level = len(line) - len(line.lstrip("#"))
        title = line[level:].strip()
        if level == 2:
            number = title.split(".")[0]
            contents.append(f'<li><a href="#section-{number}">{inline(title)}</a></li>')
            body.append(f'<h2 id="section-{number}">{inline(title)}</h2>')
        else:
            body.append(f"<h{level}>{inline(title)}</h{level}>")
    elif line.startswith("- "):
        flush()
        if not listing:
            body.append("<ul>")
            listing = True
        body.append(f"<li>{inline(line[2:])}</li>")
    elif not line:
        flush()
    else:
        paragraph.append(line)
flush()
nav = '<nav aria-label="Contents"><h2>Contents</h2><ol>' + "".join(contents) + "</ol></nav>"
body.insert(2, nav)
target.write_text("""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workflow Manager Review Guide — Detect Dog</title>
<style>
:root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; color: #182f28; background: #edf1ed; }
* { box-sizing: border-box; }
body { margin: 0; font-size: 16px; line-height: 1.6; }
main { max-width: 900px; margin: 32px auto; padding: 48px 56px; background: white; }
h1 { font-size: 2.3rem; line-height: 1.15; margin-top: 0; }
h2 { font-size: 1.5rem; line-height: 1.3; border-top: 3px solid #285746; padding-top: 18px; margin-top: 40px; }
h3 { margin-top: 28px; }
a { color: #285746; text-decoration: underline; }
nav { background: #f1f5f2; padding: 8px 24px 20px; margin: 26px 0; }
nav h2 { border: none; margin-top: 8px; }
nav ol { list-style: none; padding: 0; }
li { margin: 8px 0; }
pre { font-family: Consolas, monospace; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #b8c9bf; padding: 16px; }
p { overflow-wrap: anywhere; }
.notes { color: #41564d; margin: 24px 0; }
@media(max-width: 600px) { main { margin: 0; padding: 24px; } h1 { font-size: 1.8rem; } }
@page { size: auto; margin: 17mm; }
@media print {
  :root { background: white; color: #111; }
  body { font-size: 10pt; line-height: 1.35; }
  main { max-width: none; margin: 0; padding: 0; }
  h1 { font-size: 25pt; }
  h2 { break-before: page; font-size: 17pt; margin-top: 0; }
  h2, h3 { break-after: avoid; }
  nav h2 { break-before: auto; }
  p, li { orphans: 3; widows: 3; }
  pre { font-size: 8pt; break-inside: avoid; }
  .notes { break-inside: avoid; margin: 16px 0; }
  nav { background: white; padding: 0; }
  nav li { margin: 3px 0; }
  a { color: #111; text-decoration: none; }
}
</style></head><body><main>
""" + "\n".join(body) + "\n</main></body></html>\n")
print(target)
