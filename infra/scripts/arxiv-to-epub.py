"""arXiv HTML (CC BY 4.0 papers only) -> EPUB with an attribution page.
Usage: python3 -I infra/scripts/arxiv-to-epub.py <arxiv_id> <out_dir>"""
import html, re, subprocess, sys, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path

aid, out = sys.argv[1], Path(sys.argv[2]).resolve()
work = out / "work" / aid
work.mkdir(parents=True, exist_ok=True)

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "textstack-import"}), timeout=60) as r:
        return r.read().decode(), r.url

# metadata + licence from the arXiv API / abs page
ns = {"a": "http://www.w3.org/2005/Atom"}
entry = ET.fromstring(get(f"https://export.arxiv.org/api/query?id_list={aid}")[0]).find("a:entry", ns)
if entry is None or entry.find("a:title", ns) is None:
    sys.exit(f"{aid}: not found on arXiv")
title = " ".join(entry.find("a:title", ns).text.split())
authors = [a.find("a:name", ns).text for a in entry.findall("a:author", ns)]
year = entry.find("a:published", ns).text[:4]
# the licence is the abs page's "Rights to this article" link, nothing else on the page counts
lic = re.search(r'<div class="abs-license"><a href="([^"]+)"', get(f"https://arxiv.org/abs/{aid}")[0])
if not lic or not re.fullmatch(r"https?://creativecommons\.org/licenses/by/4\.0/?", lic.group(1)):
    sys.exit(f"{aid}: not CC BY 4.0 ({lic.group(1) if lic else 'no licence link'}), refusing")

page, page_url = get(f"https://arxiv.org/html/{aid}")
start = page.find('<article class="ltx_document')
end = page.rfind("</article>")  # rfind: an inner </article> must not cut the paper short
if start < 0 or end < start:
    sys.exit(f"{aid}: no ltx_document article")
body = page[start:end + len("</article>")]
# images -> absolute URLs so pandoc can embed them
body = re.sub(r'src="(?!https?:|data:)([^"]+)"', lambda x: f'src="{urllib.parse.urljoin(page_url, x.group(1))}"', body)

# pandoc only splits chapters on top-level headings, so unwrap LaTeXML's nested <section>/<article>
body = re.sub(r'</?(section|article)\b[^>]*>', '', body)
# "3</span>Arithmetic" -> "3 Arithmetic": LaTeXML may put no space after section numbers
body = re.sub(r'(<span class="ltx_tag[^"]*">[^<]*</span>)(?=[^\s<])', r'\1 ', body)
# the title lives on the attribution page; the author block + abstract get their own chapter
body = re.sub(r'<h1 class="ltx_title[^"]*ltx_title_document">.*?</h1>', '', body, flags=re.S)
body = re.sub(r'<h6 class="ltx_title ltx_title_abstract">.*?</h6>', '', body, flags=re.S)
body = "<h1>Abstract</h1>" + body

shown_authors = authors[:8]
shown = ", ".join(shown_authors) + (" et al." if len(authors) > 8 else "")
attribution = f"""<h1>About this edition</h1>
<p><strong>{html.escape(title)}</strong> by {html.escape(shown)} ({year}).</p>
<p>Original: <a href="https://arxiv.org/abs/{aid}">arXiv:{aid}</a>. Licensed under
<a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 (CC BY 4.0)</a>.</p>
<p>Changes: converted from the arXiv HTML version to EPUB for reading in TextStack; page chrome removed.
The text is otherwise unchanged.</p>"""

src = work / "paper.html"
src.write_text(f"<html><head><meta charset='utf-8'><title>{html.escape(title)}</title></head><body>{attribution}{body}</body></html>")
slug = re.sub(r"[^a-z0-9]+", "-", title.lower())[:60].strip("-")
epub = out / f"{aid}-{slug}.epub"
cmd = ["pandoc", str(src), "-f", "html", "-o", str(epub), "--mathml", "--split-level=2",
       "--metadata", f"title={title}", "--metadata", "lang=en",
       "--metadata", f"rights=CC BY 4.0 — https://arxiv.org/abs/{aid}", "--metadata", f"date={year}"]
for a in shown_authors:  # a 1,000-author report must not become a 1,000-name title page
    cmd += ["--metadata", f"author={a}"]
subprocess.run(cmd, check=True, cwd=work)
print(f"{aid}\t{epub.name}\t{epub.stat().st_size // 1024} KB\t{title}")
