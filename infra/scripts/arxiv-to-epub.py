"""arXiv HTML (CC BY 4.0 papers only) -> EPUB with an attribution page.
Usage: python3 -I infra/scripts/arxiv-to-epub.py <arxiv_id> <out_dir>"""
import html, re, subprocess, sys, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path

aid, out = sys.argv[1], Path(sys.argv[2]).resolve()
work = out / "work" / aid
work.mkdir(parents=True, exist_ok=True)

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "textstack-import"})).read().decode()

# metadata + licence from the arXiv API / abs page
ns = {"a": "http://www.w3.org/2005/Atom"}
entry = ET.fromstring(get(f"https://export.arxiv.org/api/query?id_list={aid}")).find("a:entry", ns)
title = " ".join(entry.find("a:title", ns).text.split())
authors = [a.find("a:name", ns).text for a in entry.findall("a:author", ns)]
year = entry.find("a:published", ns).text[:4]
abs_page = get(f"https://arxiv.org/abs/{aid}")
if "creativecommons.org/licenses/by/4.0" not in abs_page:
    sys.exit(f"{aid}: not CC BY 4.0, refusing")

page = get(f"https://arxiv.org/html/{aid}")
m = re.search(r'<article class="ltx_document.*?</article>', page, re.S)
if not m:
    sys.exit(f"{aid}: no ltx_document article")
body = m.group(0)
# relative image paths -> absolute so pandoc can embed them
base = "https://arxiv.org/html/"  # img src is "<id>v<N>/fig.png", relative to /html/
body = re.sub(r'src="(?!https?:|data:)([^"]+)"', lambda x: f'src="{base}{x.group(1)}"', body)

# pandoc only splits chapters on top-level headings, so unwrap LaTeXML's nested <section>/<article>
body = re.sub(r'</?(section|article)\b[^>]*>', '', body)

# "3</span>Arithmetic" -> "3 Arithmetic": LaTeXML puts no space after section numbers
body = re.sub(r'(<span class="ltx_tag[^"]*">[^<]*</span>)(?=[^\s<])', r'\1 ', body)
body = re.sub(r'<h1 class="ltx_title[^"]*ltx_title_document">.*?</h1>', '', body, flags=re.S)

shown = ", ".join(authors[:8]) + (" et al." if len(authors) > 8 else "")
attribution = f"""<section><h1>About this edition</h1>
<p><strong>{html.escape(title)}</strong> by {html.escape(shown)} ({year}).</p>
<p>Original: <a href="https://arxiv.org/abs/{aid}">arXiv:{aid}</a>. Licensed under
<a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 (CC BY 4.0)</a>.</p>
<p>Changes: converted from the arXiv HTML version to EPUB for reading in TextStack; page chrome removed.
The text is otherwise unchanged.</p></section>"""

src = work / "paper.html"
src.write_text(f"<html><head><meta charset='utf-8'><title>{html.escape(title)}</title></head><body>{attribution}{body}</body></html>")
slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]
epub = out / f"{slug}.epub"
cmd = ["pandoc", str(src), "-f", "html", "-o", str(epub), "--mathml", "--split-level=2",
       "--metadata", f"title={title}", "--metadata", "lang=en",
       "--metadata", f"rights=CC BY 4.0 — https://arxiv.org/abs/{aid}", "--metadata", f"date={year}"]
for a in authors:
    cmd += ["--metadata", f"author={a}"]
subprocess.run(cmd, check=True, cwd=work)
print(f"{aid}\t{epub.name}\t{epub.stat().st_size // 1024} KB\t{title}")
