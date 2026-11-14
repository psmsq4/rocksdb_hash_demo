#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
pdf() { rm -f 결과_보고서.pdf; zip -d 결과_보고서.docx '*/' >/dev/null 2>&1 || true
        flatpak run org.libreoffice.LibreOffice --headless --convert-to pdf 결과_보고서.docx >/dev/null 2>&1; }
rm -f toc.json
node build_report.js >/dev/null && pdf && python3 find_toc.py 결과_보고서.pdf
cp toc.json toc_pass1.json
node build_report.js toc.json >/dev/null && pdf && python3 find_toc.py 결과_보고서.pdf
cmp -s toc.json toc_pass1.json && echo "TOC stable" || { echo "TOC changed, rebuilding"; node build_report.js toc.json >/dev/null && pdf; }
rm -f toc_pass1.json toc_items.json
cp 결과_보고서.pdf ../../결과_보고서.pdf && echo "copied to ../../결과_보고서.pdf"
