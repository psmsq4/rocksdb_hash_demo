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
function fmtDelta(v, base) {
  if (!isNum(v) || !isNum(base) || base === 0) return "";
  const d = (v / base - 1) * 100;
  if (Math.abs(d) < 0.05) return "UPSTREAM과 같음";
  return `UPSTREAM 대비 ${d > 0 ? "+" : "−"}${nf1.format(Math.abs(d))}%`;
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
  { kind: "ticker", key: "rocksdb.bytes.written", label: "쓴 바이트", fmt: fmtBytes,
    desc: "Put으로 넘긴 key와 value의 총량." },
  { kind: "hist", key: "rocksdb.db.write.micros", label: "쓰기 1회 소요 시간", fmt: fmtMicros,
    desc: "DB::Put 한 번이 끝날 때까지의 시간. 평균과 p99." },
  { kind: "ticker", key: "rocksdb.stall.micros", label: "쓰기 정지 시간", fmt: fmtMicros,
    desc: "flush나 컴팩션이 밀려 쓰기가 멈춘 누적 시간. 0이면 flush가 쓰기를 막지 않았습니다." },
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
      y: { range: (u, lo, hi) => [0, hi > 0 ? hi * 1.12 : 1] },
    },
    axes: [
      { ...axis, values: (u, vals) => vals.map((v) => `${v}s`) },
      { ...axis, size: 56, values: (u, vals) => vals.map((v) => fmtCompact(v)) },
    ],
    series,
    plugins: [tooltipPlugin(chart)],
  }, data, host);
}

// ---------- card ----------
class Card {
  constructor(bench) {
    this.bench = bench;
    this.run = null;
    this.expanded = false;
    this.charts = new Map();
    this.root = document.getElementById("card-template").content.firstElementChild.cloneNode(true);
    this.root.dataset.state = "idle";
    this.$ = (sel) => this.root.querySelector(sel);
    this.build();
  }

  build() {
    const b = this.bench;
    this.$(".card-title").textContent = b.title;
    this.$(".summary").textContent = b.summary;
    const specs = this.$(".specs");
    b.specs.forEach((s) => specs.append(el("li", {}, s.label, el("b", { text: s.value }))));

    const targets = this.$(".targets");
    this.tiles = {};
    b.targets.forEach((m) => {
      const tile = el("div", { class: "target", "data-target": m });
      const top = el("div", { class: "target-top" },
        el("span", { class: "target-name", text: m }),
        el("span", { class: "target-state", text: "대기" }));
      const value = el("div", { class: "target-value" },
        el("strong", { text: "–" }), el("span", { text: "평균 flush" }));
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
    this.compare = [
      { title: "평균 flush 시간", hint: "자동 flush", get: avgFlushMs, fmt: fmtMs },
      { title: "마지막 flush 시간", hint: "적재 후 DB::Flush", get: finalFlushMs, fmt: fmtMs },
      { title: "적재 소요 시간", hint: "첫 Put부터 마지막 Put까지", get: loadSeconds, fmt: fmtSec },
      { title: "쓰기 처리량", hint: "적재 구간 평균", get: throughput, fmt: (v) => (isNum(v) ? fmtCompact(v) + " ops/s" : "–") },
    ].map((c) => {
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
    this.chartPanels = CHARTS.map((c) => {
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
      arc.style.strokeDashoffset = `${c * (1 - progressOf(t))}`;
    });

    // Tiles
    for (const m of this.bench.targets) {
      const tile = this.tiles[m];
      const t = r && r.targets[m];
      tile.dataset.state = t ? t.state : "IDLE";
      const p = progressOf(t);
      tile.querySelector(".target-state").textContent = !t ? "대기"
        : t.state === "RUNNING" ? `측정 중 ${nf0.format(p * 100)}%` : STATE_TEXT[t.state];
      const avg = avgFlushMs(t);
      tile.querySelector(".target-value strong").textContent = isNum(avg) ? nf1.format(avg) : "–";
      tile.querySelector(".target-value span").textContent = isNum(avg) ? "ms 평균 flush" : "평균 flush";
      const n = autoFlushes(t).length;
      const secs = t ? (t.endedAt ?? (lastSample(t) ? lastSample(t).t : null)) : null;
      tile.querySelector(".target-sub").textContent = !t ? "아직 측정하지 않았습니다"
        : t.error ? t.error : `flush ${n}회, ${fmtSec(secs)}`;
      tile.querySelector(".target-bar i").style.width = `${(t ? p : 0) * 100}%`;
    }

    if (r) {
      const errors = Object.values(r.targets).filter((t) => t.error).map((t) => `${t.memtable}: ${t.error}`);
      if (errors.length && state !== "running") this.showNotice(errors.join("\n"));
    }

    if (this.expanded) this.renderDetail();
  }

  renderDetail() {
    const r = this.run;
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
      }
      const d = fmtDelta(vals.HEAD, vals.UPSTREAM);
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

    this.renderStats();
    this.renderLogs();
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
    for (const row of STAT_ROWS) {
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
    this.cards = list.map((b) => new Card(b));
    this.cards.forEach((c) => {
      host.append(c.root);
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
