// Builds 결과_보고서.docx from summary.json and the figures in this folder.
// usage: node build_report.js [toc.json]   (toc.json: heading text -> page number)
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
  ShadingType, AlignmentType, ImageRun, PageOrientation, Footer, Header, PageNumber, BorderStyle,
  LevelFormat, TabStopType, Tab, PositionalTab, PositionalTabAlignment, PositionalTabLeader,
  PositionalTabRelativeTo, VerticalAlign, PageBreak,
} = require("docx");

const S = JSON.parse(fs.readFileSync("summary.json", "utf8"));
const TOC = fs.existsSync(process.argv[2] || "") ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : {};
const C = S.cards;
const T = ["HEAD", "UPSTREAM", "SKIPLIST"];

// ---------- formatting ----------
const FONT = "NanumSquare";
const MONO = "D2Coding";
const INK = "1D2430";
const INK2 = "4A5564";
const ACCENT = "2F6FBF";
const nf = (v, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const m = (card, t, k) => C[card][t][k].mean;
const sd = (card, t, k) => C[card][t][k].std;
const pct = (a, b) => (a / b - 1) * 100;               // a vs b, %
const signed = (v, d = 0) => (v > 0 ? "+" : "") + nf(v, d) + "%";
const man = (v) => nf(v / 1e4, 1) + "만";

// ---------- page geometry (A4, 2.5cm margins) ----------
const PAGE_W = 11906, PAGE_H = 16838, MARGIN = 1418;
const CONTENT = PAGE_W - 2 * MARGIN;                     // 9070 DXA = 16.0cm
const PX = (dxa) => Math.round((dxa / 1440) * 96);       // DXA -> px at 96 dpi
const LAND_CONTENT = PAGE_H - 2 * MARGIN;

// ---------- building blocks ----------
const run = (text, o = {}) => new TextRun({ text, font: o.mono ? MONO : FONT, size: o.size, bold: o.bold,
  color: o.color, italics: o.italics, highlight: o.highlight });
function rich(parts, o = {}) {
  // parts: string or [text, {bold, mono, color}] ; `code` inside backticks becomes mono
  const out = [];
  for (const p of [].concat(parts)) {
    if (Array.isArray(p)) { out.push(run(p[0], { ...o, ...p[1] })); continue; }
    p.split(/(`[^`]+`)/).forEach((seg) => {
      if (!seg) return;
      if (seg.startsWith("`")) out.push(run(seg.slice(1, -1), { ...o, mono: true, color: "2C3A4D" }));
      else out.push(run(seg, o));
    });
  }
  return out;
}
const P = (parts, o = {}) => new Paragraph({ children: rich(parts, o), alignment: o.align,
  spacing: { after: o.after ?? 120, line: 300 }, indent: o.indent, keepNext: o.keepNext });
const H1 = (t, brk = true) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run(t)], pageBreakBefore: brk });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run(t)] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [run(t)] });
const B = (parts, level = 0) => new Paragraph({ numbering: { reference: "bul", level }, children: rich(parts),
  spacing: { after: 60, line: 290 } });
const NOTE = (parts) => new Paragraph({ children: rich(parts, { size: 18, color: INK2 }),
  spacing: { after: 120, line: 270 } });
const CAP = (t) => new Paragraph({ children: [run(t, { size: 18, color: INK2 })], alignment: AlignmentType.CENTER,
  spacing: { before: 60, after: 240 } });

function img(file, widthPx, caption) {
  const buf = fs.readFileSync(file);
  // PNG IHDR: width at 16, height at 20
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const out = [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 0 }, keepNext: true,
    children: [new ImageRun({ type: "png", data: buf, transformation: { width: widthPx, height: Math.round(widthPx * h / w) } })] })];
  if (caption) out.push(CAP(caption));
  return out;
}

const border = { style: BorderStyle.SINGLE, size: 4, color: "C3CAD4" };
const borders = { top: border, bottom: border, left: border, right: border };
function table(head, rows, widths, o = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (text, i, isHead, shade) => new TableCell({
    borders, width: { size: widths[i], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
    shading: isHead ? { fill: "E8EEF7", type: ShadingType.CLEAR, color: "auto" }
      : shade ? { fill: shade, type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    // text: a string, a parts array (one paragraph) or { paras: [...] } (several paragraphs)
    children: (text && text.paras ? text.paras : [text]).map((t) => new Paragraph({
      alignment: (o.align && o.align[i]) || AlignmentType.LEFT, spacing: { after: 0, line: 270 },
      children: rich(t, { size: isHead ? 18 : (o.size || 18), bold: isHead || (o.boldCol === i) }) })),
  });
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, i, true)) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, false, o.shade && o.shade(r, i))) })),
    ],
  });
}
const R = AlignmentType.RIGHT, CEN = AlignmentType.CENTER, L = AlignmentType.LEFT;
const gap = () => new Paragraph({ children: [], spacing: { after: 120 } });

function tocLine(text, level) {
  const page = TOC[text] ? String(TOC[text]) : "";
  const size = level === 1 ? 22 : 20;
  return new Paragraph({
    spacing: { after: level === 1 ? 80 : 40, before: level === 1 ? 120 : 0 },
    indent: { left: level === 1 ? 0 : 420 },
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT, leader: "dot" }],
    children: [
      run(text, { bold: level === 1, size }),
      new TextRun({ children: [new Tab(), page], font: FONT, size, bold: level === 1 }),
    ],
  });
}

// ---------- numbers used in the text ----------
const flushH = m("flush", "HEAD", "flush_avg_ms"), flushU = m("flush", "UPSTREAM", "flush_avg_ms"), flushS = m("flush", "SKIPLIST", "flush_avg_ms");
const wH = m("write", "HEAD", "ops_per_s"), wU = m("write", "UPSTREAM", "ops_per_s"), wS = m("write", "SKIPLIST", "ops_per_s");
const pH = m("scan", "HEAD", "scan_prefix_p50_us"), pU = m("scan", "UPSTREAM", "scan_prefix_p50_us"), pS = m("scan", "SKIPLIST", "scan_prefix_p50_us");
const tH = m("scan", "HEAD", "scan_total_p50_us"), tU = m("scan", "UPSTREAM", "scan_total_p50_us"), tS = m("scan", "SKIPLIST", "scan_total_p50_us");
const gH = m("get", "HEAD", "get_hit_p50_us"), gU = m("get", "UPSTREAM", "get_hit_p50_us"), gS = m("get", "SKIPLIST", "get_hit_p50_us");
const nH = m("get", "HEAD", "get_noprefix_p50_us"), nS = m("get", "SKIPLIST", "get_noprefix_p50_us");
const fwH = m("flush", "HEAD", "ops_per_s"), fwS = m("flush", "SKIPLIST", "ops_per_s");
const rounds = C.flush.HEAD.flush_avg_ms.n;
const ms = (v) => nf(v, 1) + " ms", us = (v, d = 2) => nf(v, d) + " µs";
const pm = (card, t, k, f, d) => f(m(card, t, k), d) + " ± " + nf(sd(card, t, k), d);

// ---------- content ----------
const H = [];   // body
const TOC_ITEMS = [];
const h1 = (t, brk = true) => { TOC_ITEMS.push([t, 1]); H.push(H1(t, brk)); };
const h2 = (t) => { TOC_ITEMS.push([t, 2]); H.push(H2(t)); };

// 1. 프로젝트 개요
h1("1. 프로젝트 개요", false);
h2("1.1 소개");
H.push(table(["항목", "내용"], [
  ["프로젝트명", [["HASH(Rocksdb)", { bold: true }]]],
  ["한 줄 소개", "RocksDB의 HashSkipList Memtable을 멀티 스레드와 Range Query까지 지원하도록 다시 설계해, 운영에서 쓸 수 있는 Memtable 선택지로 만든다."],
  ["결과물", ["RocksDB 수정 브랜치 `hash_skiplist_improvements`(커밋 5개), 성능 측정기 `op_trade_bench`, 벤치마크 웹 대시보드, 동작 애니메이션 페이지"]],
  ["저장소", ["github.com/psmsq4/rocksdb_hash_demo (RocksDB 수정본은 submodule `rocksdb/` = github.com/psmsq4/rocksdb_hash)"]],
], [1800, CONTENT - 1800]));
H.push(gap());
H.push(P("이 보고서는 세 가지 Memtable을 같은 데이터, 같은 조건으로 비교한다.", { keepNext: true }));
H.push(table(["이름", "구현", "특징"], [
  [[["HEAD", { bold: true, color: "3987E5" }]], "이 프로젝트의 HashSkipListRep", "bucket = InlineSkipList, 정렬된 prefix 목록(prefix_list_)과 PrefixOrderedIterator로 복사 없는 key 순서 순회, 동시 쓰기 지원"],
  [[["UPSTREAM", { bold: true, color: "D95926" }]], "facebook/rocksdb 원래 HashSkipListRep (e591f5f1a)", "bucket = SkipList, 동시 쓰기 불가, key 순서 순회 때마다 Memtable 전체 복사"],
  [[["SKIPLIST", { bold: true, color: "199E70" }]], "RocksDB 기본 Memtable", "InlineSkipList 하나에 모든 KV, 동시 쓰기 지원"],
], [1500, 2900, CONTENT - 4400]));

h2("1.2 개발 동기");
H.push(P("HashSkipList는 RocksDB가 기본 제공하는 Memtable 구현 중 하나지만, 다음 세 가지 문제로 실제 운영에서는 거의 쓰이지 않았다."));
H.push(B("멀티 스레드 쓰기 불가: 여러 스레드가 동시에 써도 RocksDB 쓰기 그룹의 리더 한 스레드가 모두 넣는다."));
H.push(B("느린 Range Query: 종목(prefix)을 넘는 key 순서 조회(total-order)와 flush 때마다 Memtable 전체를 새 SkipList로 복사한다. 200만 건이면 iterator 하나를 여는 데 0.3초가 걸린다."));
H.push(B("비효율적인 메모리 배치: bucket의 SkipList가 노드와 KV를 Arena 블록의 양 끝에서 따로 할당해, entry 하나를 읽을 때 멀리 떨어진 두 곳을 읽는다."));
H.push(H3("오픈소스SW빅데이터 과목에서의 시도와 반성"));
H.push(P("3학년 1학기 오픈소스SW빅데이터 과목에서 HashSkipList의 Bucket을 SkipList에서 InlineSkipList로 바꾸고, 변경 전보다 10배 이상 빨라졌다는 결과를 발표했다. 그런데 이번에 다시 측정해 보니 그 차이의 대부분은 같은 변경에 섞여 들어간 skiplist 최대 높이 변경(4 → 12)에서 나온 것이었다. 높이를 같게 맞추면 Bucket 교체만의 이득은 워크로드에 따라 약 5~16% 수준이다(무작위 삽입 14%, 큰 데이터의 Get 9~16%)."));
H.push(P("그래도 그 과목에서 얻은 성과는 분명하다. InlineSkipList는 동시 삽입(InsertConcurrently)을 지원하므로, Bucket 교체를 계기로 HashSkipList가 처음으로 멀티 스레드 쓰기를 지원하게 되었다. 이번 측정에서도 스레드 4개로 쓸 때 HEAD는 UPSTREAM보다 처리량이 " + nf(wH / wU, 2) + "배 높다(8장)."));
H.push(P("과목 발표 때 받은 질문 가운데 \"Hash 자료구조를 쓰지 않는 이유는 Range Query 때문\"이라는 지적이 남았다. 졸업작품에서는 이 문제를 정면으로 다루기로 하고, Hash bucket 구조를 유지하면서도 key 순서 순회를 복사 없이 할 수 있는 새 Memtable 구조를 구상했다."));
H.push(table(["", "목표"], [
  [[["1차 목표", { bold: true }]], "Hash 자료구조의 Range Query 난제 해결: total-order 조회와 flush를 Memtable 복사 없이, 기본 SkipList 수준의 지연으로 처리한다."],
  [[["2차 목표", { bold: true }]], "HashSkipList가 운영 환경에서 충분히 쓸 수 있는 성능을 갖추고, prefix가 있는 워크로드에서는 기본 SkipList보다 나은 성능을 보여, RocksDB 기반 시스템(Alluxio, MyRocks 등) 개발자가 고려할 만한 Memtable 선택지를 만든다."],
], [1500, CONTENT - 1500]));
H.push(H3("해결 방법"));
H.push(B([["멀티 스레드, 메모리 배치: ", { bold: true }], "Bucket을 InlineSkipList로 교체했다. `Allocate()`가 KV 공간을 InlineSkipList 노드로 받도록 바꿔 노드와 KV가 한 덩어리가 되었고, bucket 설치는 CAS로, 동시 삽입은 `InsertConcurrently()`로 처리한다."]));
H.push(B([["Range Query: ", { bold: true }], "입력되는 KV의 prefix를 따로 뽑아 InlineSkipList(prefix_list_)로 정렬 상태를 유지한다. 순회할 때는 prefix 경계에서 정렬된 prefix 목록의 다음 prefix로 넘어가, 그 prefix의 bucket으로 바로 이동해 해당 prefix가 시작하는 지점부터 읽는다(PrefixOrderedIterator)."]));
H.push(B([["prefix 등록 비용: ", { bold: true }], "삽입마다 prefix 목록을 찾으면 쓰기가 25~31% 느려졌다. bucket마다 마지막 prefix를 캐시(known_prefix)해 새 prefix일 때만 목록을 찾도록 해 UPSTREAM과 같은 쓰기 속도를 회복했다."]));

h2("1.3 기대 효과");
H.push(B([["Range Query가 가능한 Hash Memtable: ", { bold: true }], "종목을 넘는 key 순서 조회가 UPSTREAM 대비 약 " + nf(tU / tH, 0) + "배 빨라져 기본 SkipList와 같은 수준이 된다. iterator를 열 때 Memtable 크기만큼의 추가 메모리도 쓰지 않는다."]));
H.push(B([["prefix 워크로드에서 기본 SkipList보다 나은 성능: ", { bold: true }], "KV를 종목별 작은 skiplist 여러 개로 나누는 효과로, 시간순 쓰기는 SkipList보다 " + nf(pct(fwH, fwS), 0) + "% 빠르고, 없는 종목 조회는 약 " + nf(nS / nH, 1) + "배 빠르다. flush도 UPSTREAM보다 " + nf(-pct(flushH, flushU), 0) + "% 짧다."]));
H.push(B([["멀티 스레드 쓰기: ", { bold: true }], "동시 삽입으로 UPSTREAM보다 처리량 " + nf(wH / wU, 2) + "배, Put p99 지연은 절반 이하다."]));
H.push(B([["운영 관점의 선택지: ", { bold: true }], "KV Store는 스키마가 없어 key에 prefix(테넌트, 테이블, 종목 등)를 두는 경우가 많다. 예를 들어 MyRocks의 모든 key는 4바이트 index id로 시작한다. 이런 환경은 자연스럽게 HashSkipList에 맞는 워크로드가 되며, `prefix_extractor`만 설정하면 바로 쓸 수 있다."]));
H.push(B([["upstream 기여 가능성: ", { bold: true }], "변경은 RocksDB의 기존 인터페이스 안에서 이루어졌고, 커밋마다 단위 테스트와 release note를 갖췄다."]));

// 2. 팀 구성
h1("2. 팀 구성");
H.push(table(["항목", "내용"], [
  ["팀명", [["돌디비", { bold: true }]]],
  ["구성원", "1인"],
  ["이름", "신승호"],
  ["학과", "소프트웨어학과"],
  ["학번", "32212326"],
  ["역할", "문제 정의, RocksDB 구조 설계와 구현, 실험 설계, 결과 분석"],
], [2200, CONTENT - 2200]));

// 3. 개발 일정
h1("3. 개발 일정");
H.push(table(["기간", "내용", "결과"], [
  ["2025-04 ~ 2025-08", "오픈소스SW빅데이터 과목: HashSkipList의 Bucket을 SkipList에서 InlineSkipList로 교체, 멀티 스레드 입력 구현(bucket 생성 동기화를 Double-Checked Locking으로 처리)", "동시 쓰기 지원, 과목 발표"],
  ["2026-10 ~ 2026-11", "졸업작품: prefix_list_와 PrefixOrderedIterator 개발(복사 없는 total-order 순회), prefix_list_ 높이 정리, known_prefix 캐시. 기존 변경을 RocksDB 최신 main 위에 커밋 5개로 다시 정리(bucket 설치는 CAS)", "브랜치 hash_skiplist_improvements"],
  ["2026-11", "벤치마크 웹 대시보드, 측정기, 실험, 문서", "본 보고서의 측정 결과"],
], [1900, 5070, CONTENT - 6970]));

// 4. AI 사용 범위
h1("4. AI 사용 범위");
H.push(P("이 프로젝트는 생성형 AI 도구(Anthropic Claude, Claude Code)를 사용했다. 사용 범위는 다음과 같다."));
H.push(table(["영역", "본인", "AI"], [
  ["문제 정의, 목표 설정", "과목 발표 이후의 문제 인식, 1차·2차 목표 설정", "–"],
  [{ paras: ["RocksDB HashSkipListRep 수정", "(커밋 5개)"] }, [["[작성자 기재 필요]", { highlight: "yellow" }]], [["[작성자 기재 필요]", { highlight: "yellow" }]]],
  ["실험 설계", "비교할 조건과 질문 결정(높이, 순차·무작위 key, 점 조회, 정확도 검증 등), 결과 해석과 채택", "측정 스크립트 작성과 실행, 수치 집계"],
  ["벤치마크 웹 설계", "요구사항과 구성 설계: 카드별 실험, 세 Memtable 동시 실행, 1초 지표 수집, 화면 구성, 애니메이션 장면 구성", "–"],
  ["벤치마크 웹 구현", "결과 확인과 수정 요청", "Spring 백엔드, 프론트엔드, 측정기의 지표·검증 기능, 애니메이션 페이지 구현"],
  ["문서", "검토와 수정", "README와 본 보고서 초안 작성"],
], [2300, 3400, CONTENT - 5700]));

// 5. 벤치마크 환경
h1("5. 벤치마크 환경");
h2("5.1 하드웨어와 소프트웨어");
H.push(table(["항목", "사양"], [
  ["CPU", "Intel Core i9-12900K, 16코어 24스레드 (P코어 8개 = 논리 0-15, E코어 8개 = 16-23), 최대 5.2GHz"],
  ["캐시", "L2 14MB, L3 30MB"],
  ["메모리", "124GB"],
  ["저장장치", "Samsung PM9A1 NVMe 2TB × 2"],
  ["OS", "Rocky Linux 10.2, Linux 6.12"],
  ["컴파일러", "GCC 14.3.1 (C++20, -O3 -march=native -fno-rtti), CMake 3.31.8"],
  ["RocksDB", "facebook/rocksdb main e591f5f1a(2026-11-06) + 커밋 5개, Release 공유 라이브러리"],
  ["웹 서버", "OpenJDK 21.0.8, Spring Boot 3.5.9, Gradle 8.10"],
  ["데이터", "TPC-E EGen v1.14.0 Trade.txt (고객 5,000, scale factor 500, 초기 거래 300일, 28,664,881행, 3.2GB)"],
], [1800, CONTENT - 1800]));
h2("5.2 측정 방법");
H.push(B("벤치마크 웹의 카드 4종을 기본 설정으로 " + rounds + "회씩 실행했다. 표의 값은 " + rounds + "회 평균(± 표준편차)이고, 그래프의 막대는 평균, 오차 막대는 최소~최대 범위다."));
H.push(B("한 번의 실행에서 세 Memtable을 별도 프로세스로 동시에 돌리고, 서로 다른 P코어 4개씩(2-5, 6-9, 10-13)에 고정한다. 같은 KV를 같은 순서로 넣는다."));
H.push(B("공통 설정: WAL 끔, HashSkipList bucket 100만 개, HEAD와 UPSTREAM의 bucket 최대 높이 12(SKIPLIST 기본값과 같음), prefix는 key의 첫 `|`까지(종목)."));
H.push(gap());
const st = S.settings;
const keyName = (k) => (k === "symb_tid" ? "trade_종목|t_id" : "trade_종목|계좌|t_id");
H.push(table(["카드", "KV", "memtable", "key", "쓰기", "측정"], [
  ["Flush 시간", nf(st.flush.kv), st.flush.memtableMb + "MB", keyName(st.flush.keyFormat), "큐, 소비자 1", "flush 시간, 끝에 DB::Flush, 정확도 검증"],
  ["멀티 스레드 쓰기", nf(st.write.kv), st.write.memtableMb + "MB", keyName(st.write.keyFormat), "preload, 소비자 " + st.write.consumers + ", 동시 쓰기", "처리량, Put 지연, 정확도 검증"],
  ["Range query", nf(st.scan.kv), st.scan.memtableMb + "MB", keyName(st.scan.keyFormat), "preload, 소비자 1", "prefix scan, total-order scan 각 " + st.scan.scanSeconds + "초, scan당 최대 " + st.scan.scanLength + "개"],
  ["Point query", nf(st.get.kv), st.get.memtableMb + "MB", keyName(st.get.keyFormat), "preload, 소비자 1", "Get 있는 key / 없는 key / 없는 종목 각 " + st.get.getSeconds + "초"],
], [1400, 1100, 1050, 1950, 1650, CONTENT - 7150], { size: 16 }));

// 6. 아키텍처 (landscape section is inserted below)
const ARCH = [];
const archH1 = "6. 벤치마크 웹 서버 아키텍처";
TOC_ITEMS.push([archH1, 1]);
ARCH.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run(archH1)] }));
ARCH.push(...img("figures/arch_web.png", 790, "그림 1. 벤치마크 웹 서버 구성과 측정 한 번의 흐름"));

const AFTER = [];
const a2 = (t) => { TOC_ITEMS.push([t, 2]); AFTER.push(H2(t)); };
a2("6.1 기술 스택");
AFTER.push(table(["계층", "기술", "역할"], [
  ["프론트엔드", "HTML5, CSS, Vanilla JavaScript(ES2020), SVG, uPlot 1.6.30", "카드 4종, 설정 창, 1초 폴링으로 실시간 그래프, 통계·정확도 패널, 아키텍처 애니메이션(38단계)"],
  ["웹 서버", "Java 21, Spring Boot 3.5.9(Spring Web MVC, 내장 Tomcat), Gradle 8.10", "REST API, 측정 프로세스 실행·관리, 1초 지표 수집, perf 카운터와 워크로드 분석"],
  ["측정기", "C++20, RocksDB 공유 라이브러리, POSIX 소켓", "TPC-E 거래를 KV로 변환해 쓰기·scan·Get, Prometheus 형식 /metrics 노출, 정확도 검증"],
  ["실행 환경", "Linux taskset, perf stat", "코어 고정, 하드웨어 카운터(사이클, IPC, 캐시·TLB 미스)"],
], [1500, 3500, CONTENT - 5000]));
a2("6.2 지표 수집: Prometheus 형식 pull");
AFTER.push(B("측정기는 HTTP 서버를 띄워 `/metrics`에 Prometheus 텍스트 형식(`# HELP`, `# TYPE`, `이름{라벨} 값`)으로 지표를 노출한다. 별도의 Prometheus 서버 없이 Spring 백엔드가 1초마다 직접 요청해(pull) 파싱한다."));
AFTER.push(B("지표 값은 요청 시점에 계산한다: RocksDB 속성(`DB::GetIntProperty`로 memtable 크기, flush·compaction 진행, L0 파일, SST 크기), 누적 통계(`Statistics`의 ticker와 histogram), flush 완료 이벤트(`EventListener`), 프로세스 CPU와 RSS(`/proc`)."));
AFTER.push(B("백엔드는 직전 값과의 차이로 초당 처리량, CPU 사용률, scan·Get 평균 지연을 계산해 1초 간격 시계열을 만들고, 브라우저는 이를 `GET /api/benchmarks/{id}/run`으로 받아 그린다."));
AFTER.push(B("측정이 끝나면 측정기가 표준 출력의 마지막 `RESULT key=value …` 줄로 지연 분위수(p50, p99), scan·Get 결과, 검증 해시를 내고, 같은 지표를 파일(`final.prom`)로도 남긴다."));
a2("6.3 화면");
AFTER.push(...img("figures/shot_dashboard.png", 520, "그림 2. 벤치마크 페이지: 카드마다 세 Memtable을 동시에 실행하고 결과를 나란히 비교"));
AFTER.push(...img("figures/shot_scan.png", 520, "그림 3. 카드를 펼친 화면(Range query): 요약 비교, 1초 간격 시계열, 메모리·CPU, 하드웨어 카운터"));
AFTER.push(...img("figures/shot_arch.png", 560, "그림 4. 아키텍처 페이지: HEAD와 UPSTREAM의 동작을 같은 장면으로 나란히 애니메이션(Range Total Order Scan 장면)"));

// 7. 워크로드
const W = [];
const w1 = "7. 워크로드 설명";
TOC_ITEMS.push([w1, 1]);
W.push(H1(w1));
W.push(P("입력은 TPC-E의 거래 테이블(Trade.txt)이다. 한 행이 KV 하나가 되며, value는 종목을 뺀 나머지 열이다. key 형식은 두 가지이고, prefix는 둘 다 종목(첫 `|`까지)이다. 같은 데이터라도 key 형식에 따라 bucket 안에서의 삽입 패턴이 순차(sequential)와 무작위(random)로 나뉜다."));
W.push(table(["key 형식", "예", "bucket 안 삽입", "쓰는 카드"], [
  ["trade_종목|t_id", "`trade_IDBE|200000000000003`", "순차: 항상 꼬리에 추가", "Flush, Range query"],
  ["trade_종목|계좌|t_id", "`trade_IDBE|43000004472|200000000000003`", "무작위: 계좌 순 정렬이라 중간에 끼어듦", "멀티 스레드 쓰기, Point query"],
], [2000, 3600, 2000, CONTENT - 7600], { size: 17 }));
W.push(B("시간순 key는 bucket 안에서 새 key가 항상 가장 크므로, 직전 삽입 위치를 다시 쓰는 fast-path(InlineSkipList의 `seq_splice_`, SkipList의 `prev_`)로 탐색을 건너뛴다. 반면 SKIPLIST는 전역 리스트 하나라 연속한 두 거래가 대개 다른 종목이고, 매번 처음부터 탐색한다. 그래서 같은 데이터가 Hash 계열에는 순차, SKIPLIST에는 무작위 쓰기가 된다."));
W.push(B("계좌 key는 bucket 안이 계좌 번호 순이라 새 거래가 bucket 중간에 끼어든다. 매 삽입이 탐색이므로 노드와 key가 붙어 있는 InlineSkipList의 이점이 드러나고, 멀티 스레드에서는 삽입 위치가 흩어져 동시 삽입의 효과가 커진다."));
W.push(B("규모: 종목 3,425개, 계좌 5,000개, 종목당 거래는 앞 200만 행 기준 92~1,369건(중앙값 569). 평균 key 26바이트(계좌 key 38바이트), value 111바이트."));

W.push(new Paragraph({ children: [new PageBreak()] }), ...img("figures/workload.png", 560, "그림 5. key 형식에 따른 삽입 패턴"));

// 8. 결과
const X = [];
const x1 = (t) => { TOC_ITEMS.push([t, 1]); X.push(H1(t)); };
const x2 = (t) => { TOC_ITEMS.push([t, 2]); X.push(H2(t)); };
x1("8. 실제 실험 결과");
X.push(P("카드 4종을 " + rounds + "회씩 실행한 결과다. 표의 값은 평균 ± 표준편차, 괄호 안은 UPSTREAM 대비 변화다. 그래프의 오차 막대는 " + rounds + "회의 최소~최대 범위다."));

const row3 = (label, card, k, f, d, better = "low") => {
  const u = m(card, "UPSTREAM", k);
  return [label, ...T.map((t) => {
    const v = m(card, t, k);
    const s = f(v, d) + " ± " + nf(sd(card, t, k), d);
    const r = v / u;
    const rel = r >= 10 ? "×" + nf(r, 0) : r <= 0.1 ? "1/" + nf(1 / r, 0) : signed(pct(v, u));
    return t === "UPSTREAM" ? s : s + " (" + rel + ")";
  })];
};
const W3 = [2400, 2223, 2223, CONTENT - 6846];
const A3 = [L, R, R, R];
const fx = (v, d) => nf(v, d);

x2("8.1 Flush 시간");
X.push(table(["지표", "HEAD", "UPSTREAM", "SKIPLIST"], [
  row3("평균 flush 시간 (ms)", "flush", "flush_avg_ms", fx, 1),
  row3("flush 횟수", "flush", "flushes", fx, 0),
  row3("쓰기 처리량 (ops/s)", "flush", "ops_per_s", fx, 0),
  row3("Put p99 (µs)", "flush", "put_p99_us", fx, 2),
  row3("적재 시간 (초)", "flush", "total_s", fx, 2),
], W3, { align: A3, size: 17 }));
X.push(...img("figures/fig_flush.png", PX(CONTENT), "그림 6. Flush 카드 (" + rounds + "회 평균, 오차 막대 = 최소~최대)"));
X.push(P(["HEAD의 flush는 UPSTREAM보다 ", [nf(-pct(flushH, flushU), 0) + "% 짧다", { bold: true }], ". UPSTREAM은 flush가 쓰는 iterator를 열 때 memtable 전체(약 35만 건)를 새 SkipList로 복사한 뒤에야 SST를 쓰기 시작하지만, HEAD의 PrefixOrderedIterator는 복사 없이 prefix_list_ 순서로 bucket을 바로 읽는다. 쓰기 처리량은 HEAD와 UPSTREAM이 같고 SKIPLIST보다 " + nf(pct(fwH, fwS), 0) + "% 높다. 시간순 key가 Hash 계열에는 bucket 안 순차 삽입이기 때문이다(7장)."]));

x2("8.2 멀티 스레드 쓰기");
X.push(table(["지표", "HEAD", "UPSTREAM", "SKIPLIST"], [
  row3("쓰기 처리량 (ops/s)", "write", "ops_per_s", fx, 0),
  row3("Put p50 (µs)", "write", "put_p50_us", fx, 2),
  row3("Put p99 (µs)", "write", "put_p99_us", fx, 2),
  row3("적재 시간 (초)", "write", "total_s", fx, 2),
  row3("평균 flush 시간 (ms)", "write", "flush_avg_ms", fx, 0),
], W3, { align: A3, size: 17 }));
X.push(...img("figures/fig_write.png", PX(CONTENT), "그림 7. 멀티 스레드 쓰기 카드 (스레드 4개)"));
X.push(P(["스레드 4개가 동시에 쓸 때 HEAD의 처리량은 UPSTREAM의 ", [nf(wH / wU, 2) + "배", { bold: true }], "이고, Put p99 지연은 " + nf(-pct(m("write", "HEAD", "put_p99_us"), m("write", "UPSTREAM", "put_p99_us")), 0) + "% 낮다. UPSTREAM은 동시 삽입을 지원하지 않아 RocksDB가 쓰기를 모아 리더 한 스레드가 모두 넣는다. HEAD는 SKIPLIST보다도 " + nf(pct(wH, wS), 0) + "% 높다. 삽입 위치가 종목별 bucket으로 나뉘어 스레드끼리의 경합과 탐색 길이가 줄기 때문이다."]));

x2("8.3 Range query (범위 조회)");
X.push(table(["지표", "HEAD", "UPSTREAM", "SKIPLIST"], [
  row3("prefix scan p50 (µs)", "scan", "scan_prefix_p50_us", fx, 2),
  row3("prefix scan p99 (µs)", "scan", "scan_prefix_p99_us", fx, 2),
  row3("prefix scan 초당 횟수", "scan", "scan_prefix_per_s", fx, 0),
  row3("total-order scan p50 (µs)", "scan", "scan_total_p50_us", fx, 2),
  row3("total-order scan p99 (µs)", "scan", "scan_total_p99_us", fx, 2),
  row3("total-order scan 초당 횟수", "scan", "scan_total_per_s", fx, 1),
], W3, { align: A3, size: 17 }));
X.push(...img("figures/fig_scan.png", PX(CONTENT), "그림 8. Range query 카드 (오른쪽은 로그 눈금)"));
X.push(P(["이 프로젝트의 1차 목표다. 종목을 넘는 total-order scan에서 UPSTREAM은 scan마다 memtable 200만 건을 복사해 p50이 ", [ms(tU / 1000), { bold: true }], "이고 초당 " + nf(m("scan", "UPSTREAM", "scan_total_per_s"), 1) + "회밖에 처리하지 못한다. HEAD는 ", [us(tH), { bold: true }], "로 약 ", [nf(tU / tH, 0) + "배", { bold: true }], " 빠르고, 기본 SkipList(" + us(tS) + ")와 같은 수준이다. 한 종목 안의 prefix scan도 HEAD가 UPSTREAM보다 " + nf(-pct(pH, pU), 0) + "% 빠른데, 이는 노드와 KV를 한 덩어리로 할당해 entry마다 읽는 메모리 위치가 하나로 줄었기 때문이다."]));

x2("8.4 Point query (점 조회)");
X.push(table(["지표", "HEAD", "UPSTREAM", "SKIPLIST"], [
  row3("있는 key p50 (µs)", "get", "get_hit_p50_us", fx, 3),
  row3("있는 key p99 (µs)", "get", "get_hit_p99_us", fx, 3),
  row3("있는 key 초당 횟수", "get", "get_hit_per_s", fx, 0),
  row3("있는 종목의 없는 key p50 (µs)", "get", "get_miss_p50_us", fx, 3),
  row3("없는 종목 p50 (µs)", "get", "get_noprefix_p50_us", fx, 3),
], W3, { align: A3, size: 17 }));
X.push(...img("figures/fig_get.png", PX(CONTENT), "그림 9. Point query 카드 (500만 건, 2GB memtable)"));
X.push(P(["있는 key 조회에서 HEAD는 UPSTREAM보다 " + nf(-pct(gH, gU), 0) + "%, SKIPLIST보다 " + nf(-pct(gH, gS), 0) + "% 빠르다. Get은 fast-path 없이 매번 bucket을 탐색하므로 노드와 key가 붙은 InlineSkipList의 캐시 이점이 그대로 드러난다. 한 번도 쓰지 않은 종목은 Hash 계열이 빈 bucket에서 바로 끝나 ", [us(nH, 2), { bold: true }], ", SKIPLIST는 전체 리스트를 탐색해 " + us(nS, 2) + "로 약 " + nf(nS / nH, 1) + "배 차이가 난다."]));

x2("8.5 정확도 검증");
X.push(P("성능이 빨라도 결과가 다르면 의미가 없다. 측정기의 `--verify` 옵션은 쓰기가 끝난 뒤 다음 두 단계를 수행한다."));
X.push(B("1단계(flush 전): memtable과 SST를 포함한 DB 전체를 key 순서로 읽어 KV 개수, key가 엄격히 증가하는지, 모든 (key 길이, key, value 길이, value)의 64비트 FNV-1a 해시를 낸다. HashSkipList는 이때 PrefixOrderedIterator로 순회한다."));
X.push(B("2단계(flush 후): 남은 memtable을 모두 flush한 뒤 SST에서 같은 방법으로 다시 읽는다. flush 경로도 PrefixOrderedIterator를 쓰므로 flush 결과까지 검증된다."));
X.push(B("SST 파일 자체의 해시는 파일마다 들어가는 블록 checksum과 속성(생성 시각 등) 때문에 원래 다르므로, 내용 해시로 비교한다."));
const vrows = [];
for (const card of ["flush", "write"]) {
  for (const r of S.verify[card]) {
    const h = r.HEAD;
    const all = T.every((t) => r[t].verify_pre_hash === h.verify_pre_hash && r[t].verify_hash === h.verify_pre_hash &&
      r[t].verify_count === h.verify_count && r[t].verify_ok === "1" && r[t].verify_sorted === "1" && r[t].verify_pre_sorted === "1");
    vrows.push([card === "flush" ? "Flush" : "멀티 스레드", r.round, nf(Number(h.verify_count)),
      "`" + h.verify_pre_hash + "`", all ? [["세 Memtable 일치", { bold: true, color: "199E70" }]] : [["불일치", { bold: true, color: "D0452F" }]]]);
  }
}
X.push(table(["카드", "회차", "KV 개수", "내용 해시 (flush 전 = flush 후)", "판정"], vrows,
  [1500, 900, 1600, 3200, CONTENT - 7200], { align: [L, CEN, R, L, L], size: 17 }));
X.push(P(["두 카드의 " + rounds + "회 실행 모두에서 세 Memtable의 KV 개수, 정렬 여부, flush 전후 내용 해시가 ", ["모두 일치", { bold: true }], "했다. HEAD의 새 iterator와 flush 경로가 기본 SkipList와 정확히 같은 데이터를 같은 순서로 내놓는다는 뜻이다."], { after: 120 }));

x2("8.6 목표 달성");
X.push(table(["목표", "근거 (" + rounds + "회 평균)", "판정"], [
  [[["1차: Range Query 난제 해결", { bold: true }]], "total-order scan p50 " + us(tH) + " (UPSTREAM " + ms(tU / 1000) + ", 약 " + nf(tU / tH, 0) + "배), SKIPLIST " + us(tS) + "와 같은 수준. flush " + nf(-pct(flushH, flushU), 0) + "% 단축. 정확도 검증 전부 일치", [["달성", { bold: true, color: "199E70" }]]],
  [[["2차: 운영 가능한 성능", { bold: true }]], "모든 카드에서 UPSTREAM 이상. 멀티 스레드 쓰기 " + nf(wH / wU, 2) + "배, Put p99 " + nf(-pct(m("write", "HEAD", "put_p99_us"), m("write", "UPSTREAM", "put_p99_us")), 0) + "% 감소", [["달성", { bold: true, color: "199E70" }]]],
  [[["2차: SkipList보다 나은 경우", { bold: true }]], "시간순 쓰기 처리량 +" + nf(pct(fwH, fwS), 0) + "%, flush " + nf(-pct(flushH, flushS), 0) + "% 단축, 멀티 스레드 쓰기 +" + nf(pct(wH, wS), 0) + "%, 있는 key Get " + nf(-pct(gH, gS), 0) + "% 단축, 없는 종목 Get 약 " + nf(nS / nH, 1) + "배", [["달성", { bold: true, color: "199E70" }]]],
], [2500, 5370, CONTENT - 7870], { size: 17 }));
X.push(P("정리하면, HashSkipList를 기피하게 만든 세 문제(멀티 스레드, Range Query, 메모리 배치)를 모두 해결했고, Range Query는 기본 SkipList와 같은 수준까지 끌어올렸다. 동시에 prefix로 나뉘는 워크로드에서는 쓰기, flush, 점 조회 모두 기본 SkipList보다 빠르다. HashSkipList는 이제 prefix가 있는 운영 워크로드에서 충분히 고려할 만한 Memtable이다."));
X.push(NOTE("측정 한계: 세 Memtable을 동시에 실행하므로 코어는 나뉘지만 L3 캐시와 메모리 대역폭은 공유한다. 별도의 단독 실행 실험(experiments/)에서도 같은 경향을 확인했다. bucket 최대 높이는 12 기준이며, RocksDB 기본값 4에서는 큰 memtable에서 Hash 계열이 느려진다."));

// ---------- document ----------
const header = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
  children: [run("HASH(Rocksdb) 결과 보고서", { size: 16, color: "8A94A3" })] })] });
const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
  children: [new TextRun({ children: ["- ", PageNumber.CURRENT, " -"], font: FONT, size: 18, color: "8A94A3" })] })] });
const portrait = { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 700, footer: 700 } } };
const landscape = { page: { size: { width: PAGE_W, height: PAGE_H, orientation: PageOrientation.LANDSCAPE }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 700, footer: 700 } } };

const blank = (n) => Array.from({ length: n }, () => new Paragraph({ children: [run("", { size: 28 })], spacing: { after: 0 } }));
const center = (text, o) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: o.after ?? 0 },
  children: [new TextRun({ text, font: o.font || FONT, size: o.size, bold: o.bold, color: o.color || INK })] });
const coverPage = [
  ...blank(5),
  center("2026학년도 졸업 프로젝트 결과보고서", { size: 32, bold: true, color: INK2 }),
  ...blank(2),
  center("HASH(Rocksdb)", { size: 72, font: "NanumSquare ExtraBold", after: 240 }),
  center("HashSkipList Flush/점/범위 성능 개선 및 멀티스레드 지원", { size: 30, color: ACCENT }),
  ...blank(19),
  new Table({
    alignment: AlignmentType.CENTER, width: { size: 5200, type: WidthType.DXA }, columnWidths: [1600, 3600],
    rows: [["팀명", "돌디비"], ["소속", "단국대학교 소프트웨어학과"], ["이름", "신승호"], ["학번", "32212326"]].map(([k, v]) =>
      new TableRow({ children: [
        new TableCell({ width: { size: 1600, type: WidthType.DXA }, borders: { top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.SINGLE, size: 6, color: "C3CAD4" } },
          margins: { top: 60, bottom: 60, left: 120, right: 240 },
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(k, { size: 24, color: INK2 })] })] }),
        new TableCell({ width: { size: 3600, type: WidthType.DXA }, borders: { top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } },
          margins: { top: 60, bottom: 60, left: 240, right: 120 },
          children: [new Paragraph({ children: [run(v, { size: 24, bold: true })] })] }),
      ] })),
  }),
];

const tocPage = [
  new Paragraph({ children: [run("목차", { size: 40, bold: true })], spacing: { after: 360 } }),
  ...TOC_ITEMS.map(([t, l]) => tocLine(t, l)),
];

const hstyle = (size, before, after, color = INK) => ({ run: { font: FONT, size, bold: true, color }, paragraph: { spacing: { before, after }, keepNext: true, keepLines: true } });
const doc = new Document({
  creator: "신승호", title: "HASH(Rocksdb) 결과 보고서",
  styles: {
    default: {
      document: { run: { font: FONT, size: 20, color: INK } },
      heading1: hstyle(34, 0, 280, INK),
      heading2: hstyle(26, 360, 160, ACCENT),
      heading3: hstyle(22, 240, 100, INK),
    },
  },
  numbering: { config: [{ reference: "bul", levels: [
    { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 240 } } } },
    { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 800, hanging: 240 } } } },
  ] }] },
  sections: [
    { properties: { ...portrait, titlePage: false }, children: coverPage },
    { properties: { ...portrait, page: { ...portrait.page, pageNumbers: { start: 1 } } }, headers: { default: header }, footers: { default: footer }, children: tocPage },
    { properties: portrait, headers: { default: header }, footers: { default: footer }, children: H },
    { properties: landscape, headers: { default: header }, footers: { default: footer }, children: ARCH },
    { properties: portrait, headers: { default: header }, footers: { default: footer }, children: [...AFTER, ...W, ...X] },
  ],
});
fs.writeFileSync("toc_items.json", JSON.stringify(TOC_ITEMS));
Packer.toBuffer(doc).then((b) => { fs.writeFileSync("결과_보고서.docx", b); console.log("wrote 결과_보고서.docx", TOC_ITEMS.length, "toc items"); });
