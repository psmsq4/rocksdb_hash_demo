# 결과 보고서 원본

저장소 루트의 `결과_보고서.pdf`를 만드는 원본이다.

| 파일 | 내용 |
|---|---|
| `결과_보고서.docx` | 편집용 Word 원본(나눔스퀘어). 표지 등을 손으로 고칠 때 쓴다 |
| `build_report.js` | 본문 생성(docx npm). 수치는 `summary.json`에서 계산 |
| `rounds/r{1..5}_{flush,write,scan,get}.json` | 벤치마크 웹 카드 4종 × 5회 실행 결과(2026-11-14, 기본 설정) |
| `aggregate.py` | `rounds/` → `summary.json`(평균, 표준편차, 최소, 최대, 검증 해시) |
| `charts.py` | `summary.json` → `figures/fig_*.png`(matplotlib) |
| `figures/` | 그림. `arch_web.svg`, `workload.svg`는 원본 SVG, PNG는 헤드리스 Chrome으로 2배 렌더링 |
| `make_report.sh` | docx → PDF(LibreOffice) → 제목 쪽 번호로 목차 채우기 → 루트에 PDF 복사 |

다시 만들기:
```bash
cd docs/report
npm ci                      # docx 9.5.1
python3 aggregate.py        # rounds/ 를 새로 쟀다면
python3 charts.py
./make_report.sh            # flatpak LibreOffice, pdftotext 필요
```
- 글꼴: NanumSquare. 서버에서는 `~/.local/share/fonts/NanumSquare`와 fontconfig 별칭(`60-nanumsquare.conf`)으로 정식 이름 `NanumSquare`를 쓴다.
- 목차는 LibreOffice가 Word 목차 필드를 채우지 않아, 한 번 렌더링한 PDF에서 각 제목의 쪽을 찾아(`find_toc.py`) 다시 만든다.
- 4장 "AI 사용 범위"의 RocksDB 수정 행은 작성자가 직접 기재한다.
