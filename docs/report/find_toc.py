"""Finds the printed page number of every TOC heading in the rendered PDF.

Physical page 1 is the unnumbered cover and page 2 the TOC, which is numbered 1.
"""
COVER = 1
import json, subprocess, sys
pdf = sys.argv[1]
items = json.load(open("toc_items.json"))
n = int([l for l in subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout.splitlines() if l.startswith("Pages:")][0].split()[1])
pages = [subprocess.run(["pdftotext", "-layout", "-f", str(p), "-l", str(p), pdf, "-"], capture_output=True, text=True).stdout for p in range(1, n + 1)]
toc, start = {}, COVER + 2
for text, _ in items:
    for p in range(start, n + 1):
        if any(line.strip() == text or line.strip().startswith(text + " ") for line in pages[p - 1].splitlines()):
            toc[text] = p - COVER; start = p; break
    else:
        print("NOT FOUND:", text)
json.dump(toc, open("toc.json", "w"), ensure_ascii=False, indent=1)
print(n, "pages;", len(toc), "of", len(items), "headings found")
