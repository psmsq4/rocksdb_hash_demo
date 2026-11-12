"use strict";

const TARGETS = ["HEAD", "UPSTREAM", "SKIPLIST"];
const POLL_MS = 1000;
const css = getComputedStyle(document.documentElement);
const COLOR = {
  HEAD: css.getPropertyValue("--head").trim(),
  UPSTREAM: css.getPropertyValue("--upstream").trim(),
  SKIPLIST: css.getPropertyValue("--skiplist").trim(),
};
const INK3 = css.getPropertyValue("--ink-3").trim();
const GRID = css.getPropertyValue("--grid").trim();
const FONT = '12px "Meslo LG S DZ for Powerline", "Noto Sans KR", sans-serif';

const STATE_TEXT = {
  STARTING: "준비 중",
  RUNNING: "측정 중",
  DONE: "완료",
  FAILED: "실패",
  STOPPED: "중단",
};

// ---------- formatting ----------
const nf0 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const fmtCount = (v) => (isNum(v) ? nf0.format(v) : "–");
function fmtCompact(v) {
  if (!isNum(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return nf1.format(v / 1e9) + "G";
  if (a >= 1e6) return nf1.format(v / 1e6) + "M";
  if (a >= 1e3) return nf1.format(v / 1e3) + "K";
  return nf1.format(v);
}
function fmtBytes(v) {
  if (!isNum(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1024 ** 3) return nf2.format(v / 1024 ** 3) + " GB";
  if (a >= 1024 ** 2) return nf1.format(v / 1024 ** 2) + " MB";
  if (a >= 1024) return nf1.format(v / 1024) + " KB";
  return nf0.format(v) + " B";
}
function fmtMicros(v) {
  if (!isNum(v)) return "–";
  if (Math.abs(v) >= 1e6) return nf2.format(v / 1e6) + " s";
  if (Math.abs(v) >= 1e3) return nf1.format(v / 1e3) + " ms";
  return nf2.format(v) + " µs";
}
const fmtMs = (v) => (isNum(v) ? nf1.format(v) + " ms" : "–");
const fmtSec = (v) => (isNum(v) ? nf1.format(v) + "초" : "–");
function fmtDelta(v, base, name = "UPSTREAM") {
  if (!isNum(v) || !isNum(base) || base === 0) return "";
  const ratio = v / base;
  // Orders of magnitude read better as a ratio than as a percentage.
  if (ratio >= 3) return `${name}의 ${nf0.format(ratio)}배`;
  if (ratio > 0 && ratio <= 1 / 3) return `${name}의 1/${nf1.format(1 / ratio)}`;
  const d = (ratio - 1) * 100;
  if (Math.abs(d) < 0.05) return `${name}와 같음`;
  return `${name} 대비 ${d > 0 ? "+" : "−"}${nf1.format(Math.abs(d))}%`;
}

// Microseconds shown in the unit that fits.
function fmtLatency(us) {
  if (!isNum(us)) return "–";
  if (us >= 1e6) return nf2.format(us / 1e6) + " s";
  if (us >= 1e3) return nf1.format(us / 1e3) + " ms";
  return (us < 10 ? nf2 : nf1).format(us) + " µs";
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("data-")) n.setAttribute(k, v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

// ---------- derived values per memtable ----------
const num = (v) => (v == null || v === "" ? null : Number(v));

function lastSample(t) {
  return t && t.samples.length ? t.samples[t.samples.length - 1] : null;
}
function progressOf(t) {
  if (!t) return 0;
  if (t.state === "DONE") return 1;
  const s = lastSample(t);
  return s && s.limit ? Math.min(1, s.consumed / s.limit) : 0;
}
function autoFlushes(t) {
  return (t ? t.flushEvents : []).filter((e) => e.reason !== "Manual Flush");
}
function avgFlushMs(t) {
  const r = t && t.result && num(t.result.flush_avg_ms);
  const ev = autoFlushes(t);
  if (ev.length) return ev.reduce((a, e) => a + (e.ms || 0), 0) / ev.length;
  return isNum(r) && r > 0 ? r : null;
}
function finalFlushMs(t) {
  const r = t && t.result && num(t.result.final_flush_ms);
  if (isNum(r) && r >= 0) return r;
  const s = lastSample(t);
  return s && isNum(s.finalFlushMs) && s.finalFlushMs >= 0 ? s.finalFlushMs : null;
}
function loadSeconds(t) {
  const r = t && t.result && num(t.result.load_s);
  if (isNum(r)) return r;
  const s = lastSample(t);
  return s ? s.loadSec : null;
}
function throughput(t) {
  const r = t && t.result && num(t.result.ops_per_s);
  if (isNum(r)) return r;
  const s = lastSample(t);
  return s && s.loadSec > 0 ? s.consumed / s.loadSec : null;
}

// ---------- statistics shown with descriptions ----------
const STAT_ROWS = [
  { group: "Flush" },
  { kind: "hist", key: "rocksdb.db.flush.micros", label: "flush 1회 소요 시간", fmt: fmtMicros,
    desc: "memtable 하나를 SST 파일로 내리는 데 걸린 시간. 평균과 p99. 작을수록 좋습니다." },
  { kind: "hist", key: "rocksdb.flush.memtable.memory.bytes", label: "flush 시 memtable 메모리", fmt: fmtBytes,
    desc: "flush 직전 memtable이 차지한 메모리(평균). 자료구조 비용이 포함됩니다." },
  { kind: "hist", key: "rocksdb.flush.memtable.total.data.size.bytes", label: "flush 시 실제 데이터", fmt: fmtBytes,
    desc: "같은 memtable에 담긴 key와 value의 실제 크기(평균)." },
  { kind: "ratio", label: "memtable 메모리 ÷ 데이터",
    num: "rocksdb.flush.memtable.memory.bytes", den: "rocksdb.flush.memtable.total.data.size.bytes",
    desc: "1에 가까울수록 데이터 1바이트당 메모리 낭비가 적습니다." },
  { kind: "ticker", key: "rocksdb.flush.write.bytes", label: "flush가 쓴 바이트", fmt: fmtBytes,
    desc: "flush로 SST 파일에 기록된 총량." },
  { kind: "hist", key: "rocksdb.file.write.flush.micros", label: "flush 파일 쓰기 1회", fmt: fmtMicros,
    desc: "flush 중 파일에 블록을 한 번 쓰는 데 걸린 시간." },
  { kind: "ticker", key: "rocksdb.flush.reason.write_buffer_full", label: "memtable 가득 참으로 인한 flush", fmt: fmtCount,
    desc: "write_buffer_size에 도달해 자동으로 일어난 flush 횟수." },
  { group: "쓰기" },
  { kind: "ticker", key: "rocksdb.number.keys.written", label: "쓴 key 수", fmt: fmtCount,
    desc: "Put으로 기록된 key 개수." },
  { kind: "ticker", key: "rocksdb.write.self", label: "직접 처리한 쓰기", fmt: fmtCount,
    desc: "쓰기 그룹의 리더가 되어 직접 처리한 쓰기 요청 수." },
  { kind: "ticker", key: "rocksdb.write.other", label: "대신 처리된 쓰기", fmt: fmtCount,
    desc: "다른 스레드(리더)가 그룹으로 묶어 대신 처리한 쓰기 요청 수. 소비자가 여럿이면 늘어납니다." },
  { kind: "ticker", key: "rocksdb.bytes.written", label: "쓴 바이트", fmt: fmtBytes,
    desc: "Put으로 넘긴 key와 value의 총량." },
  { kind: "hist", key: "rocksdb.db.write.micros", label: "쓰기 1회 소요 시간", fmt: fmtMicros,
    desc: "DB::Put 한 번이 끝날 때까지의 시간. 평균과 p99." },
  { kind: "ticker", key: "rocksdb.stall.micros", label: "쓰기 정지 시간", fmt: fmtMicros,
    desc: "flush나 컴팩션이 밀려 쓰기가 멈춘 누적 시간. 0이면 flush가 쓰기를 막지 않았습니다." },
  { group: "읽기" },
  { kind: "ticker", key: "rocksdb.number.keys.read", label: "Get 호출", fmt: fmtCount, optional: true,
    desc: "DB::Get으로 읽으려 한 key 수." },
  { kind: "ticker", key: "rocksdb.memtable.hit", label: "memtable에서 찾음", fmt: fmtCount, optional: true,
    desc: "Get이 memtable에서 값을 찾은 수." },
  { kind: "ticker", key: "rocksdb.memtable.miss", label: "memtable에서 못 찾음", fmt: fmtCount, optional: true,
    desc: "memtable에 없어 SST까지 내려간 Get 수. 여기서는 SST가 없어 바로 끝납니다." },
  { kind: "hist", key: "rocksdb.db.get.micros", label: "Get 1회 소요 시간", fmt: fmtMicros, optional: true,
    desc: "DB::Get 한 번. 세 종류가 섞인 평균과 p99." },
  { kind: "ticker", key: "rocksdb.number.db.seek", label: "Seek 호출", fmt: fmtCount, optional: true,
    desc: "iterator의 Seek 수. scan마다 한 번입니다." },
  { kind: "ticker", key: "rocksdb.number.db.next", label: "Next 호출", fmt: fmtCount, optional: true,
    desc: "iterator가 다음 entry로 넘어간 수." },
  { kind: "hist", key: "rocksdb.db.seek.micros", label: "Seek 1회 소요 시간", fmt: fmtMicros, optional: true,
    desc: "Seek 한 번. UPSTREAM의 total-order iterator 복사는 Seek이 아니라 iterator를 만들 때 듭니다." },
  { group: "컴팩션과 파일" },
  { kind: "ticker", key: "rocksdb.compact.read.bytes", label: "컴팩션 읽기", fmt: fmtBytes,
    desc: "L0 파일을 합치며 읽은 양." },
  { kind: "ticker", key: "rocksdb.compact.write.bytes", label: "컴팩션 쓰기", fmt: fmtBytes,
    desc: "컴팩션 결과로 새로 쓴 양." },
  { kind: "hist", key: "rocksdb.compaction.times.micros", label: "컴팩션 1회 소요 시간", fmt: fmtMicros,
    desc: "백그라운드 컴팩션 작업 하나의 시간." },
  { kind: "hist", key: "rocksdb.sst.write.micros", label: "SST 쓰기 1회", fmt: fmtMicros,
    desc: "flush와 컴팩션이 SST 파일에 쓰는 한 번의 시간." },
  { kind: "ticker", key: "rocksdb.no.file.opens", label: "연 파일 수", fmt: fmtCount,
    desc: "생성되거나 열린 SST 파일 수." },
];

function statValue(row, t) {
  if (!t) return null;
  if (row.kind === "ticker") {
    const v = t.tickers[row.key];
    return { main: v == null ? 0 : v };
  }
  if (row.kind === "hist") {
    const h = t.histograms[row.key];
    return h ? { main: h.avg, p99: h.p99, count: h.count } : null;
  }
  if (row.kind === "ratio") {
    const n = t.histograms[row.num];
    const d = t.histograms[row.den];
    return n && d && d.avg ? { main: n.avg / d.avg } : null;
  }
  return null;
}

// ---------- charts ----------
const CHARTS = [
  { id: "flushEvents", title: "flush별 소요 시간", unit: "ms", hint: "점 하나가 flush 한 번",
    points: true, fmt: (v) => fmtMs(v) },
  { id: "flushRate", title: "flush 속도", unit: "KV/s", hint: "flush 한 번이 1초에 내린 KV 수",
    points: true, fmt: (v) => (isNum(v) ? fmtCompact(v) + " KV/s" : "–") },
  { id: "ops", title: "쓰기 처리량", unit: "ops/s", hint: "1초 간격",
    fmt: (v) => (isNum(v) ? fmtCompact(v) + " ops/s" : "–") },
  { id: "flushSec", title: "누적 flush 시간", unit: "s", hint: "flush에 쓴 시간의 합",
    fmt: (v) => (isNum(v) ? nf2.format(v) + " s" : "–") },
  { id: "cpu", title: "CPU 사용률", unit: "%", hint: "프로세스 전체, 100% = 코어 1개",
    fmt: (v) => (isNum(v) ? nf0.format(v) + "%" : "–") },
  { id: "rssMb", title: "메모리 사용량 (RSS)", unit: "MB", hint: "프로세스 상주 메모리",
    fmt: (v) => (isNum(v) ? nf0.format(v) + " MB" : "–") },
];

const fmtOps = (v) => (isNum(v) ? fmtCompact(v) + " ops/s" : "–");
const fmtUs = (v) => (isNum(v) ? nf2.format(v) + " µs" : "–");

// Latest rate while running, the load average once done.
function liveOps(t) {
  const r = t && t.result && num(t.result.ops_per_s);
  if (isNum(r)) return r;
  const s = t ? [...t.samples].reverse().find((x) => isNum(x.ops)) : null;
  return s ? s.ops : null;
}

// Put latency from op_trade_bench's own histogram at the end; while running,
// RocksDB's cumulative db.write.micros p99.
function putLatency(t, q) {
  const r = t && t.result && num(t.result[`put_${q}_us`]);
  if (isNum(r)) return r;
  const s = lastSample(t);
  return q === "p99" && s && isNum(s.writeP99) ? s.writeP99 : null;
}

const WRITE_CHARTS = [
  { id: "ops", title: "쓰기 처리량", unit: "ops/s", hint: "1초 간격", fmt: fmtOps },
  { id: "cpu", title: "CPU 사용률", unit: "%", hint: "프로세스 전체, 100% = 코어 1개. 프로세스마다 CPU 4개",
    fmt: (v) => (isNum(v) ? nf0.format(v) + "%" : "–") },
  { id: "writeP99", title: "Put 지연 p99", unit: "µs", hint: "RocksDB db.write.micros, 시작부터 누적",
    fmt: fmtUs },
  { id: "rssMb", title: "메모리 사용량 (RSS)", unit: "MB", hint: "preload한 KV 포함",
    fmt: (v) => (isNum(v) ? nf0.format(v) + " MB" : "–") },
];

// Range scan results: from RESULT at the end, live from the scrapes.
function scanResult(t, mode, field) {
  const r = t && t.result && num(t.result[`scan_${mode}_${field}`]);
  return isNum(r) ? r : null;
}
function scanLatency(t, mode) {
  const r = scanResult(t, mode, "p50_us");
  if (isNum(r)) return r;
  const want = mode === "prefix" ? 1 : 2;
  const xs = t ? t.samples.filter((x) => x.scanMode === want && isNum(x.scanAvgUs)) : [];
  return xs.length ? xs[xs.length - 1].scanAvgUs : null;
}
function scanRate(t, mode) {
  const r = scanResult(t, mode, "per_s");
  if (isNum(r)) return r;
  const want = mode === "prefix" ? 1 : 2;
  const xs = t ? t.samples.filter((x) => x.scanMode === want && isNum(x.scanOps)) : [];
  return xs.length ? xs[xs.length - 1].scanOps : null;
}
const fmtScans = (v) => (isNum(v) ? (v >= 100 ? fmtCompact(v) : nf1.format(v)) + " 회/s" : "–");

// Load first (about 30% of the dial), then the two scan phases.
function scanProgress(t) {
  if (!t) return 0;
  if (t.state === "DONE") return 1;
  const s = lastSample(t);
  if (!s) return 0;
  const load = s.limit ? Math.min(1, s.consumed / s.limit) : 0;
  const scan = isNum(s.scanProgress) ? s.scanProgress : 0;
  return 0.3 * load + 0.7 * scan;
}
const PHASE_TEXT = {
  1: "KV 준비 중", 2: "적재 중", 5: "prefix scan 중", 6: "total-order scan 중", 3: "flush 중",
  7: "hit 조회 중", 8: "miss 조회 중", 9: "없는 종목 조회 중",
};

// Point lookups: from RESULT at the end, live from the scrapes.
const GET_KINDS = { hit: 1, miss: 2, noprefix: 3 };
function getLatency(t, kind) {
  const r = t && t.result && num(t.result[`get_${kind}_p50_us`]);
  if (isNum(r)) return r;
  const xs = t ? t.samples.filter((x) => x.getMode === GET_KINDS[kind] && isNum(x.getAvgUs)) : [];
  return xs.length ? xs[xs.length - 1].getAvgUs : null;
}
function getRate(t, kind) {
  const r = t && t.result && num(t.result[`get_${kind}_per_s`]);
  if (isNum(r)) return r;
  const xs = t ? t.samples.filter((x) => x.getMode === GET_KINDS[kind] && isNum(x.getOps)) : [];
  return xs.length ? xs[xs.length - 1].getOps : null;
}
const fmtGets = (v) => (isNum(v) ? fmtCompact(v) + " 회/s" : "–");

// Load is close to half of a point lookup run.
function getProgress(t) {
  if (!t) return 0;
  if (t.state === "DONE") return 1;
  const s = lastSample(t);
  if (!s) return 0;
  const load = s.limit ? Math.min(1, s.consumed / s.limit) : 0;
  const gets = isNum(s.getProgress) ? s.getProgress : 0;
  return 0.45 * load + 0.55 * gets;
}

const GET_CHARTS = [
  { id: "getOps", title: "Get 처리량", unit: "회/s", hint: "앞쪽부터 hit, miss, 없는 종목", fmt: fmtGets },
  { id: "getAvgUs", title: "Get 평균 지연", unit: "µs", hint: "1초 구간 평균", fmt: fmtLatency },
  { id: "ops", title: "적재 처리량", unit: "ops/s", hint: "조회 전 적재 구간", fmt: fmtOps },
  { id: "cpu", title: "CPU 사용률", unit: "%", hint: "프로세스 전체, 100% = 코어 1개",
    fmt: (v) => (isNum(v) ? nf0.format(v) + "%" : "–") },
];

const SCAN_CHARTS = [
  { id: "scanOps", title: "scan 처리량", unit: "회/s", hint: "앞쪽은 prefix, 뒤쪽은 total-order", fmt: fmtScans },
  { id: "scanAvgUs", title: "scan 평균 지연", unit: "µs", hint: "로그 눈금, 1초 구간 평균", log: true, fmt: fmtLatency },
  { id: "rssMb", title: "메모리 사용량 (RSS)", unit: "MB", hint: "UPSTREAM은 total-order iterator마다 memtable을 복사",
    fmt: (v) => (isNum(v) ? nf0.format(v) + " MB" : "–") },
  { id: "cpu", title: "CPU 사용률", unit: "%", hint: "프로세스 전체, 100% = 코어 1개",
    fmt: (v) => (isNum(v) ? nf0.format(v) + "%" : "–") },
];

// What each kind of card leads with: the tile's number, the comparison bars
// and the charts.
const VIEWS = {
  flush: {
    tile: {
      value: avgFlushMs, show: (v) => nf1.format(v), unit: "ms 평균 flush", empty: "평균 flush",
      sub: (t, secs) => `flush ${autoFlushes(t).length}회, ${fmtSec(secs)}`,
    },
    compare: [
      { title: "평균 flush 시간", hint: "자동 flush", get: avgFlushMs, fmt: fmtMs },
      { title: "마지막 flush 시간", hint: "적재 후 DB::Flush", get: finalFlushMs, fmt: fmtMs },
      { title: "적재 소요 시간", hint: "첫 Put부터 마지막 Put까지", get: loadSeconds, fmt: fmtSec },
      { title: "쓰기 처리량", hint: "적재 구간 평균", get: throughput, fmt: fmtOps },
    ],
    charts: CHARTS,
  },
  write: {
    tile: {
      value: liveOps, show: (v) => fmtCompact(v), unit: "ops/s", empty: "쓰기 처리량",
      sub: (t) => `적재 ${fmtSec(loadSeconds(t))}, p99 ${fmtUs(putLatency(t, "p99"))}`,
    },
    compare: [
      { title: "쓰기 처리량", hint: "적재 구간 평균", get: throughput, fmt: fmtOps },
      { title: "적재 소요 시간", hint: "첫 Put부터 마지막 Put까지", get: loadSeconds, fmt: fmtSec },
      { title: "Put 지연 p50", hint: "Put 한 번", get: (t) => putLatency(t, "p50"), fmt: fmtUs },
      { title: "Put 지연 p99", hint: "Put 한 번", get: (t) => putLatency(t, "p99"), fmt: fmtUs },
    ],
    charts: WRITE_CHARTS,
  },
  scan: {
    progress: scanProgress,
    tile: {
      value: (t) => scanLatency(t, "total"), show: (v) => fmtLatency(v),
      unit: "total-order p50", empty: "total-order scan",
      sub: (t) => `prefix scan p50 ${fmtLatency(scanLatency(t, "prefix"))}`,
    },
    compare: [
      { title: "prefix scan 지연 p50", hint: "한 종목 안", get: (t) => scanLatency(t, "prefix"), fmt: fmtLatency },
      { title: "prefix scan 처리량", hint: "초당 scan 수", get: (t) => scanRate(t, "prefix"), fmt: fmtScans },
      { title: "total-order scan 지연 p50", hint: "종목을 넘어 key 순서대로", get: (t) => scanLatency(t, "total"), fmt: fmtLatency },
      { title: "total-order scan 처리량", hint: "초당 scan 수", get: (t) => scanRate(t, "total"), fmt: fmtScans },
    ],
    charts: SCAN_CHARTS,
  },
  get: {
    progress: getProgress,
    tile: {
      value: (t) => getLatency(t, "hit"), show: (v) => fmtLatency(v),
      unit: "hit p50", empty: "Get 지연",
      sub: (t) => `없는 종목 p50 ${fmtLatency(getLatency(t, "noprefix"))}`,
    },
    compare: [
      { title: "hit 지연 p50", hint: "있는 key", get: (t) => getLatency(t, "hit"), fmt: fmtLatency },
      { title: "miss 지연 p50", hint: "있는 종목 안의 없는 key", get: (t) => getLatency(t, "miss"), fmt: fmtLatency },
      { title: "없는 종목 지연 p50", hint: "한 번도 쓰지 않은 종목", get: (t) => getLatency(t, "noprefix"), fmt: fmtLatency,
        vs: "SKIPLIST" },
      { title: "hit 처리량", hint: "초당 Get 수", get: (t) => getRate(t, "hit"), fmt: fmtGets },
    ],
    charts: GET_CHARTS,
  },
};

function seriesTable(run, chart) {
  return TARGETS.map((m) => {
    const t = run && run.targets[m];
    if (!t) return [[], []];
    if (chart.id === "flushEvents") {
      const ev = autoFlushes(t);
      return [ev.map((e) => e.t), ev.map((e) => e.ms)];
    }
    if (chart.id === "flushRate") {
      const ev = autoFlushes(t).filter((e) => e.ms > 0);
      return [ev.map((e) => e.t), ev.map((e) => e.entries / (e.ms / 1000))];
    }
    const s = t.samples.filter((p) => isNum(p[chart.id]));
    return [s.map((p) => p.t), s.map((p) => p[chart.id])];
  });
}

function joined(tables) {
  const xs = new Set();
  tables.forEach(([x]) => x.forEach((v) => xs.add(v)));
  const sorted = [...xs].sort((a, b) => a - b);
  const index = new Map(sorted.map((v, i) => [v, i]));
  const ys = tables.map(([x, y]) => {
    const col = new Array(sorted.length).fill(null);
    x.forEach((v, i) => { col[index.get(v)] = y[i]; });
    return col;
  });
  return [sorted, ...ys];
}

function tooltipPlugin(chart) {
  let tip;
  return {
    hooks: {
      init: (u) => {
        tip = el("div", { class: "tip" });
        u.over.append(tip);
        u.over.addEventListener("mouseleave", () => { tip.style.display = "none"; });
      },
      setCursor: (u) => {
        const i = u.cursor.idx;
        if (i == null || u.data[0].length === 0) { tip.style.display = "none"; return; }
        const x = u.data[0][i];
        const rows = [];
        TARGETS.forEach((m, k) => {
          const v = nearest(u.data[k + 1], i, chart.points);
          if (v == null) return;
          const r = el("div", { class: "tip-row", "data-target": m });
          r.append(el("span", { text: m }), document.createTextNode(chart.fmt(v)));
          rows.push(r);
        });
        if (!rows.length) { tip.style.display = "none"; return; }
        tip.replaceChildren(el("div", { class: "tip-t", text: `${nf1.format(x)}초` }), ...rows);
        tip.style.display = "block";
        const left = u.cursor.left;
        const w = tip.offsetWidth;
        const overW = u.over.clientWidth;
        tip.style.left = (left + 14 + w > overW ? left - 14 - w : left + 14) + "px";
        tip.style.top = Math.max(0, (u.cursor.top || 0) - tip.offsetHeight / 2) + "px";
      },
    },
  };
}

// For lines, the closest earlier value; for points, only an exact hit.
function nearest(col, i, exact) {
  if (col[i] != null || exact) return col[i];
  for (let j = i; j >= 0; j--) if (col[j] != null) return col[j];
  return null;
}

// Powers of ten within [min, max], for log-scale axes.
function decades(u, axisIdx, min, max) {
  const out = [];
  for (let e = Math.ceil(Math.log10(Math.max(min, 1e-9))); 10 ** e <= max; e++) out.push(10 ** e);
  return out;
}

function makeChart(host, chart, data, width) {
  const series = [{}];
  TARGETS.forEach((m) => {
    series.push(chart.points
      ? { label: m, stroke: COLOR[m], fill: COLOR[m], width: 0, paths: () => null,
          points: { show: true, size: 8, width: 2, stroke: "#1c1f25", fill: COLOR[m] } }
      : { label: m, stroke: COLOR[m], width: 2, spanGaps: true, points: { show: false } });
  });
  const axis = {
    stroke: INK3,
    font: FONT,
    grid: { stroke: GRID, width: 1 },
    ticks: { show: false },
  };
  return new uPlot({
    width,
    height: 220,
    padding: [12, 12, 0, 0],
    legend: { show: false },
    cursor: { y: false, points: { size: 7 }, drag: { x: false, y: false } },
    scales: {
      x: { time: false, range: (u, lo, hi) => [0, Math.max(5, Math.ceil(hi || 0))] },
      y: chart.log
        ? { distr: 3, log: 10, range: (u, lo, hi) => [Math.max(0.1, (lo || 1) / 2), Math.max(1, (hi || 1) * 2)] }
        : { range: (u, lo, hi) => [0, hi > 0 ? hi * 1.12 : 1] },
    },
    axes: [
      { ...axis, values: (u, vals) => vals.map((v) => `${v}s`) },
      chart.log
        ? { ...axis, size: 64, splits: decades, values: (u, vals) => vals.map((v) => fmtLatency(v)) }
        : { ...axis, size: 56, values: (u, vals) => vals.map((v) => fmtCompact(v)) },
    ],
    series,
    plugins: [tooltipPlugin(chart)],
  }, data, host);
}

// ---------- settings ----------
const KEY_LABEL = { symb_tid: "trade_종목|t_id", symb_acct_tid: "trade_종목|계좌|t_id" };

function specChips(s) {
  if (!s) return [];
  return [
    ["KV", fmtCount(s.kv)],
    ["memtable", `${s.memtableMb}MB`],
    ["key", KEY_LABEL[s.keyFormat] || s.keyFormat],
    ["WAL", s.wal ? "켬" : "끔"],
    ["쓰기", `${s.preload ? "preload" : "큐"}, 소비자 ${s.consumers}개`],
    ["bucket 높이", String(s.hashHeight)],
    ["동시 쓰기", s.concurrent ? "켬" : "끔"],
    ...(s.scanSeconds > 0 ? [["scan", `${s.scanSeconds}초씩, ${fmtCount(s.scanLength)}개`]] : []),
    ...(s.getSeconds > 0 ? [["Get", `${s.getSeconds}초씩`]] : []),
  ];
}

function sameSettings(a, b) {
  return !!a && !!b && ["kv", "memtableMb", "keyFormat", "preload", "wal", "consumers", "hashHeight", "concurrent", "scanSeconds", "scanLength", "getSeconds"]
    .every((k) => a[k] === b[k]);
}

// Same formula as RunSettings.estimateSeconds on the server.
function estimateSeconds(s, rates) {
  let rate = rates[(s.preload ? "preload" : "queue") + (s.wal ? "Wal" : "")];
  if (s.keyFormat === "symb_acct_tid") rate *= rates.accountKeyFactor;
  if (s.preload && s.consumers > 1) rate *= rates.multiWriterFactor;
  return s.kv / rate + rates.overheadSeconds + 2 * (s.scanSeconds || 0) + 3 * (s.getSeconds || 0);
}

// Rough bytes one preloaded KV takes in memory (two std::strings and heap).
const PRELOAD_BYTES_PER_KV = 250;

const settingsDialog = {
  dialog: null,
  card: null,
  draft: null,
  info: null,

  init() {
    const d = (this.dialog = document.getElementById("settings"));
    this.kv = this.stepper("kv", {
      parse: (t) => Number(String(t).replace(/[^\d]/g, "")),
      show: (v) => fmtCount(v),
      next: (v, dir) => v + dir * this.info.limits.kvStep,
      fix: (v) => {
        const l = this.info.limits;
        const r = Math.round(v / l.kvStep) * l.kvStep;
        return Math.min(l.kvMax, Math.max(l.kvMin, r));
      },
    });
    this.mem = this.stepper("memtableMb", {
      parse: (t) => Number(String(t).replace(/[^\d]/g, "")),
      show: (v) => `${v} MB`,
      next: (v, dir) => {
        const l = this.info.limits;
        if (dir > 0) return v < l.memtableStepMb ? l.memtableStepMb : v + l.memtableStepMb;
        return v <= l.memtableStepMb ? l.memtableMinMb : v - l.memtableStepMb;
      },
      fix: (v) => {
        const l = this.info.limits;
        if (v < (l.memtableMinMb + l.memtableStepMb) / 2) return l.memtableMinMb;
        const r = Math.max(l.memtableStepMb, Math.round(v / l.memtableStepMb) * l.memtableStepMb);
        return Math.min(l.memtableMaxMb, r);
      },
    });
    this.scanSeconds = this.stepper("scanSeconds", {
      parse: (t) => Number(String(t).replace(/[^\d]/g, "")),
      show: (v) => `${v}초`,
      next: (v, dir) => v + dir,
      fix: (v) => Math.min(this.info.limits.scanSecondsMax, Math.max(1, Math.round(v) || 1)),
    });
    this.scanLength = this.stepper("scanLength", {
      parse: (t) => Number(String(t).replace(/[^\d]/g, "")),
      show: (v) => fmtCount(v),
      next: (v, dir) => v + dir * this.info.limits.scanLengthStep,
      fix: (v) => {
        const l = this.info.limits;
        const r = Math.round(v / l.scanLengthStep) * l.scanLengthStep;
        return Math.min(l.scanLengthMax, Math.max(l.scanLengthStep, r));
      },
    });
    this.getSeconds = this.stepper("getSeconds", {
      parse: (t) => Number(String(t).replace(/[^\d]/g, "")),
      show: (v) => `${v}초`,
      next: (v, dir) => v + dir,
      fix: (v) => Math.min(this.info.limits.getSecondsMax, Math.max(1, Math.round(v) || 1)),
    });
    this.consumers = this.stepper("consumers", {
      parse: (t) => Number(String(t).replace(/[^\d]/g, "")),
      show: (v) => String(v),
      next: (v, dir) => v + dir,
      fix: (v) => Math.min(this.info.limits.consumersMax, Math.max(1, Math.round(v) || 1)),
    });

    d.querySelectorAll(".switch").forEach((sw) => {
      sw.addEventListener("click", () => {
        this.draft[sw.dataset.field] = !this.draft[sw.dataset.field];
        this.render();
      });
    });
    d.querySelector(".modal-close").addEventListener("click", () => d.close());
    d.querySelector('[data-action="cancel"]').addEventListener("click", () => d.close());
    d.querySelector('[data-action="reset"]').addEventListener("click", () => {
      this.draft = { ...this.info.defaults };
      this.render();
    });
    d.querySelector('[data-action="save"]').addEventListener("click", () => this.save());
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });  // backdrop
    d.addEventListener("close", () => { if (this.card) this.card.$(".settings-btn").focus(); });
  },

  // Steppers the current card shows.
  steppers() {
    const all = [this.kv, this.mem, this.consumers];
    const kind = this.card && this.card.bench.kind;
    if (kind === "scan") return [...all, this.scanSeconds, this.scanLength];
    if (kind === "get") return [...all, this.getSeconds];
    return all;
  },

  // A rounded −/value/+ control. Holding a button repeats, faster over time;
  // the value can also be typed and is snapped to the step on blur or Enter.
  stepper(field, ops) {
    const root = this.dialog.querySelector(`.stepper[data-field="${field}"]`);
    const input = root.querySelector(".step-value");
    const [dec, inc] = root.querySelectorAll(".step");
    const set = (v) => {
      this.draft[field] = ops.fix(v);
      this.render();
    };
    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; };
    const press = (dir) => {
      let delay = 380;
      const tick = () => {
        const before = this.draft[field];
        set(ops.next(before, dir));
        if (this.draft[field] === before) return stop();
        delay = Math.max(30, delay * 0.82);
        timer = setTimeout(tick, delay);
      };
      tick();
    };
    [[dec, -1], [inc, 1]].forEach(([btn, dir]) => {
      btn.addEventListener("pointerdown", (e) => { e.preventDefault(); btn.focus(); press(dir); });
      ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, stop));
      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(ops.next(this.draft[field], dir)); }
      });
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        set(ops.next(this.draft[field], e.key === "ArrowUp" ? 1 : -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        set(ops.parse(input.value));
      }
    });
    input.addEventListener("blur", () => set(ops.parse(input.value)));
    return { input, dec, inc, ops, field };
  },

  async open(card) {
    this.card = card;
    this.error(null);
    try {
      const res = await fetch(`/api/benchmarks/${card.bench.id}/settings`);
      this.info = await res.json();
    } catch (e) {
      card.showNotice("설정을 불러오지 못했습니다. 서버가 실행 중인지 확인하세요.");
      return;
    }
    this.draft = { ...this.info.settings };
    this.dialog.querySelector(".modal-title").textContent = `${card.bench.title} 설정`;
    this.dialog.querySelectorAll("[data-kinds]").forEach((f) => {
      f.hidden = !f.dataset.kinds.split(" ").includes(card.bench.kind);
    });
    this.buildSegments();
    this.render();
    this.dialog.showModal();
  },

  // Rounded single-choice buttons: picking one releases the others.
  buildSegments() {
    this.dialog.querySelectorAll(".segmented").forEach((group) => {
      const field = group.dataset.field;
      const asNumber = group.hasAttribute("data-number");
      const opts = Object.entries(this.info.limits[group.dataset.options])
        .map(([v, label]) => [asNumber ? Number(v) : v, label]);
      const pick = (value) => { this.draft[field] = value; this.render(); };
      group.replaceChildren(...opts.map(([value, label]) => {
        const b = el("button", { type: "button", class: "seg", role: "radio", "data-value": String(value), text: label });
        b.addEventListener("click", () => pick(value));
        b.addEventListener("keydown", (e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const i = opts.findIndex(([v]) => v === this.draft[field]);
          const j = (i + (e.key === "ArrowRight" ? 1 : -1) + opts.length) % opts.length;
          pick(opts[j][0]);
          group.querySelector(`[data-value="${opts[j][0]}"]`).focus();
        });
        return b;
      }));
    });
  },

  render() {
    const s = this.draft;
    const l = this.info.limits;
    for (const st of this.steppers()) {
      if (document.activeElement !== st.input) st.input.value = st.ops.show(s[st.field]);
      st.dec.disabled = st.ops.fix(st.ops.next(s[st.field], -1)) === s[st.field];
      st.inc.disabled = st.ops.fix(st.ops.next(s[st.field], 1)) === s[st.field];
    }
    this.dialog.querySelectorAll(".seg").forEach((b) => {
      const on = b.dataset.value === String(s[b.closest(".segmented").dataset.field]);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    this.dialog.querySelectorAll(".switch").forEach((sw) => {
      const on = !!s[sw.dataset.field];
      sw.setAttribute("aria-checked", String(on));
      sw.querySelector("span").textContent = on ? "켬" : "끔";
    });

    const est = estimateSeconds(s, l.rates);
    const parts = [`예상 소요 <b>약 ${nf0.format(Math.ceil(est))}초</b> (가장 느린 SKIPLIST 기준)`];
    if (s.preload) {
      const gb = (s.kv * PRELOAD_BYTES_PER_KV * 3) / 1024 ** 3;
      parts.push(`preload는 세 프로세스가 KV를 모두 메모리에 올립니다. 약 ${nf1.format(gb)} GB`);
    }
    if (this.card && this.card.run && this.card.run.active) parts.push("지금 측정 중입니다. 저장한 설정은 다음 측정부터 적용됩니다.");
    this.dialog.querySelector(".estimate").innerHTML = parts.join("<br>");
    this.dialog.querySelector('[data-action="reset"]').disabled = sameSettings(s, this.info.defaults);
  },

  error(text) {
    const n = this.dialog.querySelector(".modal-error");
    n.hidden = !text;
    n.textContent = text || "";
  },

  async save() {
    // Commit a value still being typed.
    for (const st of this.steppers()) {
      if (document.activeElement === st.input) this.draft[st.field] = st.ops.fix(st.ops.parse(st.input.value));
    }
    const btn = this.dialog.querySelector('[data-action="save"]');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/benchmarks/${this.card.bench.id}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.draft),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.error(body.error || `저장하지 못했습니다 (HTTP ${res.status}).`);
        return;
      }
      this.card.setSettings(body.settings);
      this.card.render();
      this.dialog.close();
    } catch (e) {
      this.error("저장하지 못했습니다. 서버 연결을 확인하세요.");
    } finally {
      btn.disabled = false;
    }
  },
};

// ---------- hardware counters (perf stat, after the run) ----------
const HW_METRICS = [
  { key: "cycles", title: "사이클/KV", desc: "KV 하나에 든 CPU 사이클. 작을수록 빠릅니다." },
  { key: "instructions", title: "명령어/KV", desc: "실행한 명령어 수, 곧 하는 일의 양입니다." },
  { key: "ipc", title: "IPC", desc: "사이클당 명령어. 메모리를 기다리는 시간이 적을수록 높습니다.", ratio: true },
  { key: "l1Misses", title: "L1 미스/KV", desc: "L1 데이터 캐시에서 못 찾은 읽기. 다른 노드나 key를 따라갈 때 생깁니다." },
  { key: "tlbMisses", title: "dTLB 미스/KV", desc: "주소 변환 캐시 미스. 메모리 여기저기를 건너뛸수록 늘어납니다." },
  { key: "llcMisses", title: "LLC 미스/KV", desc: "L3까지 놓친 읽기. 하드웨어 prefetch도 세므로 상대 비교로만 보세요." },
];

function hwValue(t, m, kvs) {
  const p = t && t.perf;
  if (!p) return null;
  if (m.ratio) return p.cycles && p.instructions ? p.instructions / p.cycles : null;
  return isNum(p[m.key]) && kvs > 0 ? p[m.key] / kvs : null;
}

function fmtHw(v, m) {
  if (!isNum(v)) return "–";
  if (m.ratio) return nf2.format(v);
  return v >= 100 ? nf0.format(v) : nf1.format(v);
}

function hwDelta(head, other, name) {
  if (!isNum(head) || !isNum(other) || other === 0) return null;
  const d = (head / other - 1) * 100;
  if (Math.abs(d) < 0.5) return `${name}와 같음`;
  return `${name} 대비 ${d > 0 ? "+" : "−"}${nf0.format(Math.abs(d))}%`;
}

// ---------- KV samples and workload ----------
const KV_SAMPLES = 8;  // RunService.KV_SAMPLES

// Splits a key into its prefix (up to and including the first '|') and rest.
function keyParts(key) {
  const i = key.indexOf("|");
  return i < 0 ? ["", key] : [key.slice(0, i + 1), key.slice(i + 1)];
}

// Bytes one KV takes inside a memtable beyond its key and value (node,
// sequence number and type, varint lengths). 64MB held about 351K trades.
const MEMTABLE_OVERHEAD_BYTES = 54;

function heightTrait(s, p) {
  const h = s.hashHeight;
  let text = h >= 12
    ? `HEAD, UPSTREAM의 bucket skiplist 높이 ${h}. SKIPLIST(12)와 조건이 같습니다.`
    : `HEAD, UPSTREAM의 bucket skiplist 높이 ${h}(RocksDB 기본). bucket에 KV가 약 ${4 ** h}개를 넘으면 맨 위 레벨을 차례로 훑어 삽입이 느려집니다. SKIPLIST는 12입니다.`;
  if (p && p.available && h < 12) {
    const entry = p.avgKeyBytes[s.keyFormat] + p.avgValueBytes + MEMTABLE_OVERHEAD_BYTES;
    const perMemtable = Math.min(s.kv, (s.memtableMb * 1024 * 1024) / entry);
    const perBucket = perMemtable / p.symbols;
    if (perBucket > 4 ** h) {
      text += ` 이번 설정은 memtable 하나에 bucket당 약 ${fmtCount(perBucket)}개가 쌓여 이 영향을 크게 받습니다.`;
    }
  }
  return text;
}

// Plain-language traits of the workload a run writes.
function workloadTraits(s, p) {
  const rows = [];
  const acct = s.keyFormat === "symb_acct_tid";
  rows.push(["key", acct
    ? "trade_종목|계좌|거래ID. prefix는 첫 | 까지인 trade_종목| 입니다."
    : "trade_종목|거래ID. prefix는 첫 | 까지인 trade_종목| 입니다."]);
  if (p && p.available) {
    const perPrefix = s.kv / p.symbols;
    rows.push(["prefix 수", `종목 ${fmtCount(p.symbols)}개. HashSkipList는 prefix마다 bucket을 나눠 담으므로 bucket당 평균 약 ${fmtCount(perPrefix)}개 KV가 쌓입니다.`]);
    rows.push(["쏠림", `종목별 거래 수는 중앙값 ${fmtCount(p.perSymbolMedian)}건, 최대 ${fmtCount(p.perSymbolMax)}건으로 고르지 않습니다. 인기 종목 bucket이 훨씬 깁니다.`]);
  }
  rows.push(["bucket 높이", heightTrait(s, p)]);
  rows.push(["삽입 순서", acct
    ? "같은 종목 안에서 계좌 번호가 먼저 와서, 새 KV가 bucket 중간 아무 곳에나 들어갑니다. 흩어진 삽입이라 여러 스레드가 동시에 써도 서로 덜 부딪힙니다."
    : "Trade.txt가 거래 시각 순서라 같은 종목 안에서 거래ID가 계속 커집니다. 새 KV는 거의 항상 bucket 끝에 붙는 순차 삽입입니다."]);
  if (p && p.available) {
    const k = p.avgKeyBytes[s.keyFormat];
    const v = p.avgValueBytes;
    rows.push(["크기", `key 평균 ${k}B, value 평균 ${v}B(나머지 14개 컬럼). 이번 측정은 약 ${fmtBytes(s.kv * (k + v))}입니다.`]);
    let src = `TPC-E Trade.txt 약 ${fmtCount(p.estimatedRows)}행, ${String(p.firstTime).slice(0, 10)}부터 거래 시각 순입니다.`;
    if (s.kv > p.estimatedRows) src += " KV가 행 수보다 많아 파일을 다시 읽고 key 끝에 #1, #2를 붙입니다.";
    rows.push(["데이터", src]);
  } else if (p && p.error) {
    rows.push(["데이터", p.error]);
  }
  const how = s.preload
    ? `KV를 모두 메모리에 먼저 만든 뒤 소비자 ${s.consumers}개가 Put만 합니다. 파일 읽기는 시간에 들어가지 않습니다.`
    : `생산자 스레드가 파일을 읽어 큐에 넣고, 소비자 ${s.consumers}개가 꺼내 Put합니다.`;
  rows.push(["쓰기", `${how} WAL은 ${s.wal ? "켜서 Put마다 로그도 씁니다" : "꺼서 memtable에만 씁니다"}.`]);
  if (s.scanSeconds > 0) {
    rows.push(["scan", `적재가 끝나면 prefix scan(한 종목 안, prefix_same_as_start)을 ${s.scanSeconds}초, total-order scan(total_order_seek, 종목을 넘어 key 순서대로)을 ${s.scanSeconds}초 합니다. scan마다 iterator를 새로 열고 적재한 key 중 하나로 seek한 뒤 최대 ${fmtCount(s.scanLength)}개를 읽습니다.`]);
    rows.push(["iterator", "UPSTREAM은 total-order iterator를 열 때마다 memtable 전체를 정렬된 skiplist로 복사합니다. HEAD는 정렬된 prefix 목록으로 복사 없이 순서대로 읽습니다."]);
  }
  if (s.getSeconds > 0) {
    rows.push(["Get", `적재가 끝나면 DB::Get을 ${s.getSeconds}초씩 세 번 합니다. 적재한 key 약 6.5만 개 중에서 무작위로 고릅니다. hit는 그 key, miss는 그 key 바로 뒤의 없는 key(같은 종목), 없는 종목은 trade_종목~| 처럼 한 번도 쓰지 않은 종목입니다.`]);
    rows.push(["탐색", "Get은 순차 삽입과 달리 지름길 없이 매번 bucket 맨 위 레벨부터 찾습니다. hash 계열은 없는 종목이면 빈 bucket이라 탐색 없이 끝나고, SKIPLIST는 전체 리스트를 찾아 내려갑니다."]);
  }
  if (s.scanSeconds > 0 || s.getSeconds > 0) {
    if (p && p.available) {
      const entry = p.avgKeyBytes[s.keyFormat] + p.avgValueBytes + MEMTABLE_OVERHEAD_BYTES;
      const fits = s.kv * entry <= s.memtableMb * 1024 * 1024 * 0.95;
      rows.push(["memtable", fits
        ? `KV 약 ${fmtBytes(s.kv * entry)}가 memtable(${s.memtableMb}MB) 하나에 들어가 읽기가 memtable만 봅니다.`
        : `KV 약 ${fmtBytes(s.kv * entry)}가 memtable(${s.memtableMb}MB)보다 커서 일부가 SST로 flush됩니다. 읽기는 SST도 함께 봅니다.`]);
    }
  }
  if (s.consumers > 1) {
    rows.push(["동시 쓰기", s.concurrent
      ? "HEAD와 SKIPLIST는 소비자들이 memtable에 동시에 넣습니다(allow_concurrent_memtable_write). UPSTREAM은 동시 쓰기를 지원하지 않아 RocksDB가 쓰기를 모아 한 스레드가 차례로 넣습니다."
      : "꺼 두어서 세 memtable 모두 RocksDB가 쓰기를 모아 한 스레드가 차례로 넣습니다."]);
  }
  return rows;
}

// ---------- card ----------
class Card {
  constructor(bench) {
    this.bench = bench;
    this.view = VIEWS[bench.kind] || VIEWS.flush;
    this.run = null;
    this.expanded = false;
    this.charts = new Map();
    this.row = document.getElementById("card-template").content.firstElementChild.cloneNode(true);
    this.root = this.row.querySelector(".card");
    this.panel = this.row.querySelector(".kv-panel");
    this.root.dataset.state = "idle";
    this.$ = (sel) => this.root.querySelector(sel);
    this.build();
  }

  build() {
    const b = this.bench;
    this.$(".card-title").textContent = b.title;
    this.$(".summary").textContent = b.summary;
    this.setSettings(b.settings);
    this.$(".settings-btn").addEventListener("click", () => settingsDialog.open(this));

    const targets = this.$(".targets");
    this.tiles = {};
    b.targets.forEach((m) => {
      const tile = el("div", { class: "target", "data-target": m });
      const top = el("div", { class: "target-top" },
        el("span", { class: "target-name", text: m }),
        el("span", { class: "target-state", text: "대기" }));
      const value = el("div", { class: "target-value" },
        el("strong", { text: "–" }), el("span", { text: this.view.tile.empty }));
      const sub = el("div", { class: "target-sub", text: "아직 측정하지 않았습니다" });
      const bar = el("div", { class: "target-bar" }, el("i"));
      tile.append(top, value, sub, bar);
      targets.append(tile);
      this.tiles[m] = tile;
    });

    this.$(".dial").addEventListener("click", () => this.onDial());
    const toggle = this.$(".expand");
    toggle.addEventListener("click", () => this.setExpanded(!this.expanded));
    this.$(".card-body").addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      this.setExpanded(!this.expanded);
    });
    this.$(".card-body").style.cursor = "pointer";

    this.buildDetail();
  }

  buildDetail() {
    // Comparison bars
    this.compare = this.view.compare.map((c) => {
      const panel = el("div", { class: "panel" });
      const bars = el("div", { class: "bars" });
      const rows = {};
      TARGETS.forEach((m) => {
        const fill = el("div", { class: "bar-fill" });
        const value = el("span", { class: "bar-value", text: "–" });
        const row = el("div", { class: "bar-row", "data-target": m },
          el("span", { class: "bar-name", text: m }),
          el("div", { class: "bar-track" }, fill),
          value);
        bars.append(row);
        rows[m] = { fill, value, row };
      });
      const foot = el("div", { class: "bar-delta", text: " " });
      panel.append(
        el("div", { class: "panel-head" }, el("h3", { class: "panel-title", text: c.title }),
          el("span", { class: "panel-hint", text: c.hint })),
        el("div", { class: "panel-body" }, bars, foot),
      );
      this.$(".compare").append(panel);
      return { ...c, rows, foot };
    });

    // Chart panels
    this.chartPanels = this.view.charts.map((c) => {
      const host = el("div", { class: "chart" });
      const empty = el("div", { class: "chart-empty", text: "측정을 시작하면 1초마다 그려집니다" });
      const legend = el("div", { class: "legend" });
      const panel = el("div", { class: "panel" },
        el("div", { class: "panel-head" }, el("h3", { class: "panel-title", text: c.title }),
          el("span", { class: "panel-hint", text: c.hint })),
        el("div", { class: "panel-body" }, legend, empty, host));
      this.$(".charts").append(panel);
      return { ...c, host, empty, legend, panel };
    });

    this.resize = new ResizeObserver(() => {
      for (const p of this.chartPanels) {
        const u = this.charts.get(p.id);
        if (u && p.host.clientWidth > 0) u.setSize({ width: p.host.clientWidth, height: 220 });
      }
    });
    this.chartPanels.forEach((p) => this.resize.observe(p.host));
  }

  setSettings(s) {
    this.settings = s;
    this.$(".specs").replaceChildren(...specChips(s).map(([label, value]) =>
      el("li", {}, label, el("b", { text: value }))));
  }

  setExpanded(open) {
    this.expanded = open;
    this.$(".expand").setAttribute("aria-expanded", String(open));
    const detail = this.$(".card-detail");
    detail.hidden = !open;
    if (open) {
      this.root.classList.add("opening");
      setTimeout(() => this.root.classList.remove("opening"), 260);
      this.render();
      app.pollSoon(this);
    }
  }

  async onDial() {
    if (this.run && this.run.active) {
      await fetch(`/api/benchmarks/${this.bench.id}/stop`, { method: "POST" });
      app.pollSoon(this);
      return;
    }
    this.showNotice(null);
    const res = await fetch(`/api/benchmarks/${this.bench.id}/run`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.showNotice(body.error || `시작하지 못했습니다 (HTTP ${res.status}).`);
      if (!this.expanded) this.setExpanded(true);
      return;
    }
    this.run = body;
    this.destroyCharts();
    if (!this.expanded) this.setExpanded(true);
    this.render();
  }

  showNotice(text) {
    const n = this.$(".notice");
    n.hidden = !text;
    n.textContent = text || "";
  }

  destroyCharts() {
    this.charts.forEach((u) => u.destroy());
    this.charts.clear();
  }

  cardState() {
    const r = this.run;
    if (!r) return "idle";
    if (r.active) return "running";
    const bad = Object.values(r.targets).some((t) => t.state === "FAILED" || t.state === "STOPPED");
    return bad ? "failed" : "done";
  }

  render() {
    const r = this.run;
    const state = this.cardState();
    this.root.dataset.state = state;

    // Dial
    const main = this.$(".dial-main");
    const sub = this.$(".dial-sub");
    const dial = this.$(".dial");
    if (state === "idle") {
      main.textContent = "측정 시작"; sub.textContent = "";
      dial.setAttribute("aria-label", "측정 시작");
    } else if (state === "running") {
      main.textContent = "측정 중"; sub.textContent = `${nf1.format(r.elapsed)}초`;
      dial.setAttribute("aria-label", "측정 중단");
    } else {
      main.textContent = "다시 측정";
      const ends = Object.values(r.targets).map((t) => t.endedAt).filter(isNum);
      sub.textContent = ends.length ? `${nf1.format(Math.max(...ends))}초 걸림` : "";
      dial.setAttribute("aria-label", "다시 측정");
    }
    this.root.querySelectorAll(".dial-arc").forEach((arc) => {
      const t = r && r.targets[arc.dataset.target];
      const c = 2 * Math.PI * Number(arc.getAttribute("r"));
      arc.style.strokeDasharray = `${c}`;
      arc.style.strokeDashoffset = `${c * (1 - (this.view.progress || progressOf)(t))}`;
    });

    // Tiles
    for (const m of this.bench.targets) {
      const tile = this.tiles[m];
      const t = r && r.targets[m];
      tile.dataset.state = t ? t.state : "IDLE";
      const p = (this.view.progress || progressOf)(t);
      const phase = lastSample(t) ? lastSample(t).phase : 0;
      const doing = this.view.progress && PHASE_TEXT[phase] ? PHASE_TEXT[phase] : "측정 중";
      tile.querySelector(".target-state").textContent = !t ? "대기"
        : t.state === "RUNNING" ? `${doing} ${nf0.format(p * 100)}%` : STATE_TEXT[t.state];
      const tv = this.view.tile;
      const v = t ? tv.value(t) : null;
      tile.querySelector(".target-value strong").textContent = isNum(v) ? tv.show(v) : "–";
      tile.querySelector(".target-value span").textContent = isNum(v) ? tv.unit : tv.empty;
      const secs = t ? (t.endedAt ?? (lastSample(t) ? lastSample(t).t : null)) : null;
      tile.querySelector(".target-sub").textContent = !t ? "아직 측정하지 않았습니다"
        : t.error ? t.error : tv.sub(t, secs);
      tile.querySelector(".target-bar i").style.width = `${(t ? p : 0) * 100}%`;
    }

    if (r) {
      const errors = Object.values(r.targets).filter((t) => t.error).map((t) => `${t.memtable}: ${t.error}`);
      if (errors.length && state !== "running") this.showNotice(errors.join("\n"));
    }

    this.renderSamples();
    if (this.expanded) this.renderDetail();
  }

  // The panel beside the card: KVs the run is writing and what they are like.
  renderSamples() {
    const r = this.run;
    const open = !!r;
    this.row.classList.toggle("has-panel", open);
    document.body.classList.toggle("panels-open",
      !!document.querySelector(".card-row.has-panel"));
    this.panel.setAttribute("aria-hidden", String(!open));
    if (!open) return;
    const s = r.settings || this.settings;
    const samples = r.kvSamples || [];
    const key = `${r.id}:${samples.length}:${!!app.workload}`;
    if (this.samplesKey === key) return;
    const fresh = this.samplesKey && this.samplesKey.startsWith(`${r.id}:`);
    this.samplesKey = key;

    this.panel.querySelector(".kv-hint").textContent = `${fmtCount(s.kv)}개 중 ${KV_SAMPLES}개, 고른 간격`;
    const stride = Math.max(1, Math.floor(s.kv / KV_SAMPLES));
    const byIndex = new Map(samples.map((x) => [x.index, x]));
    const items = [];
    for (let i = 0; i < KV_SAMPLES; i++) {
      const idx = i * stride;
      const x = byIndex.get(idx);
      if (!x) {
        items.push(el("li", { class: "kv-item pending" },
          el("span", { class: "kv-idx", text: `${fmtCount(idx + 1)}번째 KV` }),
          el("span", { class: "kv-wait", text: r.active ? "생산자가 여기에 오면 채워집니다" : "기록되지 않았습니다" })));
        continue;
      }
      const [prefix, rest] = keyParts(x.key);
      const li = el("li", { class: "kv-item" },
        el("span", { class: "kv-idx", text: `${fmtCount(idx + 1)}번째 KV` }),
        el("code", { class: "kv-key" }, el("mark", { title: "prefix", text: prefix }), rest),
        el("code", { class: "kv-val", title: x.value, text: x.value }));
      if (fresh && !this.seenSamples.has(idx)) li.classList.add("arrive");
      items.push(li);
    }
    this.seenSamples = new Set(samples.map((x) => x.index));
    this.panel.querySelector(".kv-list").replaceChildren(...items);

    const p = app.workload;
    this.panel.querySelector(".kv-traits-hint").textContent =
      p && p.available ? `Trade.txt 앞 ${fmtCount(p.sampledRows)}행 기준` : "";
    this.panel.querySelector(".kv-traits").replaceChildren(...workloadTraits(s, p).flatMap(([k, v]) =>
      [el("dt", { text: k }), el("dd", { text: v })]));
  }

  renderDetail() {
    const r = this.run;
    const note = this.$(".run-note");
    if (r && r.settings) {
      const chips = specChips(r.settings).map(([k, v]) => `${k} ${v}`).join(", ");
      note.textContent = sameSettings(r.settings, this.settings)
        ? `이 결과의 설정: ${chips}`
        : `이 결과는 이전 설정으로 측정했습니다: ${chips}. 바꾼 설정은 다음 측정부터 적용됩니다.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
    // Comparison bars
    for (const c of this.compare) {
      const vals = Object.fromEntries(TARGETS.map((m) => [m, r ? c.get(r.targets[m]) : null]));
      const max = Math.max(0, ...Object.values(vals).filter(isNum));
      for (const m of TARGETS) {
        const v = vals[m];
        const row = c.rows[m];
        row.fill.style.width = isNum(v) && max > 0 ? `${(v / max) * 100}%` : "0";
        row.value.textContent = c.fmt(v);
        row.row.title = m === "UPSTREAM" ? "" : fmtDelta(v, vals.UPSTREAM);
        // A panel can name the memtable HEAD is best compared with.
      }
      const vs = c.vs || "UPSTREAM";
      const d = fmtDelta(vals.HEAD, vals[vs], vs);
      c.foot.textContent = d ? `HEAD: ${d}` : " ";
    }

    // Charts
    for (const p of this.chartPanels) {
      const tables = seriesTable(r, p);
      const any = tables.some(([x]) => x.length > 0);
      p.empty.hidden = any;
      p.host.hidden = !any;
      p.legend.replaceChildren(...TARGETS.map((m, k) => {
        const ys = tables[k][1];
        const last = ys.length ? ys[ys.length - 1] : null;
        return el("span", { "data-target": m }, `${m} `, el("b", { text: p.fmt(last) }));
      }));
      if (!any) continue;
      const data = joined(tables);
      const u = this.charts.get(p.id);
      if (u) {
        u.setData(data, true);
      } else if (p.host.clientWidth > 0) {
        this.charts.set(p.id, makeChart(p.host, p, data, p.host.clientWidth));
      }
    }

    this.renderHw();
    this.renderStats();
    this.renderLogs();
  }

  // perf stat counters, read when each process exits.
  renderHw() {
    const r = this.run;
    const host = this.$(".hw");
    if (!r) { host.replaceChildren(); this.hwKey = null; return; }
    const done = !r.active;
    const key = `${r.id}:${done}:${TARGETS.map((m) => (r.targets[m] && r.targets[m].perf ? Object.keys(r.targets[m].perf).length : 0)).join(",")}`;
    if (this.hwKey === key) return;
    this.hwKey = key;

    const head = el("div", { class: "hw-head" },
      el("h3", { class: "panel-title", text: "하드웨어 카운터" }),
      el("span", { class: "panel-hint", text: "perf stat, 측정이 끝난 뒤의 프로세스 전체 값 (파일 읽기 포함)" }));
    if (r.perfNote) {
      host.replaceChildren(head, el("p", { class: "hw-wait", text: r.perfNote }));
      return;
    }
    if (!done) {
      host.replaceChildren(head, el("p", { class: "hw-wait", text: "측정이 끝나면 세 memtable의 카운터가 여기에 나옵니다." }));
      return;
    }
    const kvs = num(r.targets.HEAD && r.targets.HEAD.result.consumed) || (r.settings && r.settings.kv);
    const panels = HW_METRICS.map((m) => {
      const vals = Object.fromEntries(TARGETS.map((t) => [t, hwValue(r.targets[t], m, kvs)]));
      const max = Math.max(0, ...Object.values(vals).filter(isNum));
      const bars = el("div", { class: "bars" }, ...TARGETS.map((t) => {
        const v = vals[t];
        const fill = el("div", { class: "bar-fill" });
        fill.style.width = isNum(v) && max > 0 ? `${(v / max) * 100}%` : "0";
        return el("div", { class: "bar-row", "data-target": t },
          el("span", { class: "bar-name", text: t }),
          el("div", { class: "bar-track" }, fill),
          el("span", { class: "bar-value", text: fmtHw(v, m) }));
      }));
      const deltas = [hwDelta(vals.HEAD, vals.UPSTREAM, "UPSTREAM"), hwDelta(vals.HEAD, vals.SKIPLIST, "SKIPLIST")]
        .filter(Boolean);
      return el("div", { class: "panel" },
        el("div", { class: "panel-head" }, el("h3", { class: "panel-title", text: m.title })),
        el("div", { class: "panel-body" },
          el("p", { class: "hw-desc", text: m.desc }), bars,
          el("div", { class: "bar-delta", text: deltas.length ? `HEAD: ${deltas.join(", ")}` : " " })));
    });
    host.replaceChildren(head, el("div", { class: "hw-grid" }, ...panels),
      el("p", { class: "hw-foot", text: "세 프로세스를 동시에 실행해 L3 캐시를 나눠 쓰므로, 하나씩 따로 잰 값보다 미스가 많을 수 있습니다." }));
  }

  renderStats() {
    const r = this.run;
    const host = this.$(".stats");
    if (!r) {
      host.replaceChildren();
      return;
    }
    const head = el("tr", {}, el("th", { text: "지표" }),
      ...TARGETS.map((m) => el("th", { "data-target": m, text: m })),
      el("th", { text: "HEAD ÷ UPSTREAM" }));
    const body = el("tbody");
    // Rows marked optional show only when some memtable reported them; a
    // group with no rows left is dropped.
    const present = (row) => !row.optional || TARGETS.some((m) => {
      const t = r.targets[m];
      return t && (row.kind === "hist" ? t.histograms[row.key] : t.tickers[row.key] != null);
    });
    const rows = STAT_ROWS.filter((row, i) => {
      if (!row.group) return present(row);
      for (let j = i + 1; j < STAT_ROWS.length && !STAT_ROWS[j].group; j++) {
        if (present(STAT_ROWS[j])) return true;
      }
      return false;
    });
    for (const row of rows) {
      if (row.group) {
        body.append(el("tr", { class: "stats-group" }, el("td", { colspan: "5", text: row.group })));
        continue;
      }
      const vals = Object.fromEntries(TARGETS.map((m) => [m, statValue(row, r.targets[m])]));
      const cells = TARGETS.map((m) => {
        const v = vals[m];
        const fmt = row.kind === "ratio" ? (x) => (isNum(x) ? nf2.format(x) + "배" : "–") : row.fmt;
        const td = el("td", { class: "num" }, v ? fmt(v.main) : "–");
        if (v && isNum(v.p99)) td.append(el("span", { class: "stat-desc", text: `p99 ${fmt(v.p99)}` }));
        return td;
      });
      const h = vals.HEAD && vals.HEAD.main;
      const u = vals.UPSTREAM && vals.UPSTREAM.main;
      const ratio = isNum(h) && isNum(u) && u !== 0 ? `${nf2.format(h / u)}배` : "–";
      const label = el("td", {},
        el("span", { class: "stat-name", text: row.label }), " ",
        el("span", { class: "stat-key", text: row.key || "" }),
        el("span", { class: "stat-desc", text: row.desc }));
      body.append(el("tr", {}, label, ...cells, el("td", { class: "delta", text: ratio })));
    }
    const table = el("table", { class: "stats-table" }, el("thead", {}, head), body);

    // Every non-zero ticker and histogram, without descriptions.
    const keys = new Set();
    const hkeys = new Set();
    TARGETS.forEach((m) => {
      const t = r.targets[m];
      if (!t) return;
      Object.keys(t.tickers).forEach((k) => keys.add(k));
      Object.keys(t.histograms).forEach((k) => hkeys.add(k));
    });
    const allBody = el("tbody");
    [...keys].sort().forEach((k) => {
      allBody.append(el("tr", {}, el("td", { class: "stat-key", text: k }),
        ...TARGETS.map((m) => el("td", { class: "num", text: fmtCount(r.targets[m] && r.targets[m].tickers[k]) }))));
    });
    [...hkeys].sort().forEach((k) => {
      allBody.append(el("tr", {}, el("td", { class: "stat-key", text: `${k} (평균 / p99)` }),
        ...TARGETS.map((m) => {
          const h = r.targets[m] && r.targets[m].histograms[k];
          return el("td", { class: "num", text: h ? `${fmtCompact(h.avg)} / ${fmtCompact(h.p99)}` : "–" });
        })));
    });
    const wasOpen = host.querySelector(".stats-all") && host.querySelector(".stats-all").open;
    const all = el("details", { class: "stats-all" }, el("summary", { text: `전체 statistics 보기 (${keys.size + hkeys.size}개)` }),
      el("div", { class: "stats-scroll" }, el("table", { class: "stats-table" },
        el("thead", {}, el("tr", {}, el("th", { text: "이름" }), ...TARGETS.map((m) => el("th", { "data-target": m, text: m })))),
        allBody)));
    all.open = !!wasOpen;

    const panel = el("div", { class: "panel" },
      el("div", { class: "panel-head" }, el("h3", { class: "panel-title", text: "RocksDB statistics" }),
        el("span", { class: "panel-hint", text: r.active ? "1초마다 갱신" : "측정 종료 시점 값" })),
      el("div", { class: "panel-body" }, el("div", { class: "stats-scroll" }, table), all));
    host.replaceChildren(panel);
  }

  renderLogs() {
    const r = this.run;
    const grid = this.$(".log-grid");
    if (!r) { grid.replaceChildren(); return; }
    if (!this.$(".logs").open) return;
    grid.replaceChildren(...TARGETS.filter((m) => r.targets[m]).map((m) => {
      const t = r.targets[m];
      return el("div", { "data-target": m }, el("h4", { text: `${m}  (CPU ${t.cpuSet || "-"})` }),
        el("pre", { text: t.log.join("\n") || "출력 없음" }));
    }));
  }
}

// ---------- app ----------
const app = {
  cards: [],
  timer: null,

  async start() {
    const host = document.getElementById("cards");
    let list;
    try {
      const res = await fetch("/api/benchmarks");
      list = await res.json();
    } catch (e) {
      host.append(el("div", { class: "empty-state", text: "서버에 연결하지 못했습니다. 앱이 실행 중인지 확인하세요." }));
      return;
    }
    settingsDialog.init();
    this.workload = await fetch("/api/workload").then((r) => r.json()).catch(() => null);
    this.cards = list.map((b) => new Card(b));
    this.cards.forEach((c) => {
      host.append(c.row);
      c.$(".logs").addEventListener("toggle", () => c.renderLogs());
    });
    await Promise.all(this.cards.map((c) => this.poll(c)));
    // "#flush" opens that card, so a link can point straight at its graphs.
    const wanted = this.cards.find((c) => c.bench.id === location.hash.slice(1));
    if (wanted) wanted.setExpanded(true);
    this.timer = setInterval(() => this.tick(), POLL_MS);
  },

  tick() {
    for (const c of this.cards) {
      if ((c.run && c.run.active) || c.expanded) this.poll(c);
    }
  },

  pollSoon(card) {
    setTimeout(() => this.poll(card), 150);
  },

  async poll(card) {
    if (card.inflight) return;
    card.inflight = true;
    try {
      const res = await fetch(`/api/benchmarks/${card.bench.id}/run`);
      if (res.status === 200) {
        const run = await res.json();
        if (card.run && card.run.id !== run.id) card.destroyCharts();
        card.run = run;
      }
      card.render();
    } catch (e) {
      // Keep the last view; the next tick retries.
    } finally {
      card.inflight = false;
    }
  },
};

app.start();
