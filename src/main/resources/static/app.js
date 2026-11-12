const STATUS_LABEL = { runnable: "실행 가능", recorded: "기록", planned: "계획" };
const RUN_LABEL = { RUNNING: "실행 중", PASSED: "통과", FAILED: "실패", TIMED_OUT: "시간 초과" };
const pollers = new Map();

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function renderTable(t) {
  const head = el("tr", {}, ...t.headers.map(h => el("th", {}, h)));
  const body = t.rows.map(r => el("tr", {}, ...r.map(c => el("td", {}, c))));
  return el("div", { class: "table-wrap" },
    el("table", {}, el("caption", {}, t.caption), el("thead", {}, head), el("tbody", {}, ...body)));
}

function renderRun(panel, run) {
  panel.replaceChildren();
  if (!run) return;
  const secs = run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : "";
  panel.append(
    el("div", { class: "run-meta" },
      el("span", { class: `badge ${run.state}` }, RUN_LABEL[run.state] ?? run.state),
      ` ${new Date(run.startedAt).toLocaleString()}${secs} · ${run.summary ?? ""}`),
    el("pre", { class: "log" }, run.output || "(출력 없음)"));
  const log = panel.querySelector("pre");
  log.scrollTop = log.scrollHeight;
}

async function fetchRun(id) {
  const res = await fetch(`api/tests/${encodeURIComponent(id)}/run`);
  return res.status === 200 ? res.json() : null;
}

function poll(id, panel, button) {
  if (pollers.has(id)) return;
  const tick = async () => {
    const run = await fetchRun(id);
    renderRun(panel, run);
    if (run && run.state === "RUNNING") {
      pollers.set(id, setTimeout(tick, 1000));
    } else {
      pollers.delete(id);
      button.disabled = false;
    }
  };
  pollers.set(id, setTimeout(tick, 0));
}

async function startRun(test, panel, button) {
  button.disabled = true;
  const res = await fetch(`api/tests/${encodeURIComponent(test.id)}/run`, { method: "POST" });
  if (!res.ok && res.status !== 409) {
    const msg = await res.text();
    panel.replaceChildren(el("div", { class: "run-meta" }, `실행 요청 실패 (${res.status}): ${msg}`));
    button.disabled = false;
    return;
  }
  poll(test.id, panel, button);
}

function renderCard(test) {
  const card = el("article", { class: "card", "data-status": test.status });
  const head = el("div", { class: "card-head" },
    el("h3", {}, test.title),
    el("span", { class: `badge ${test.status}` }, STATUS_LABEL[test.status] ?? test.status));
  card.append(head, el("p", { class: "desc" }, test.description));

  for (const t of test.results ?? []) card.append(renderTable(t));
  if (test.notes?.length) card.append(el("ul", { class: "notes" }, ...test.notes.map(n => el("li", {}, n))));

  if (test.commands?.length) {
    card.append(el("div", { class: "cmd" }, ...test.commands.map(c => el("div", {}, el("code", {}, c.join(" "))))));
    const panel = el("div", { class: "run-panel" });
    const button = el("button", { class: "run-btn", type: "button" }, "실행");
    button.addEventListener("click", () => startRun(test, panel, button));
    head.append(button);
    card.append(panel);
    fetchRun(test.id).then(run => {
      renderRun(panel, run);
      if (run && run.state === "RUNNING") {
        button.disabled = true;
        poll(test.id, panel, button);
      }
    });
  }
  return card;
}

function applyFilter(filter) {
  for (const b of document.querySelectorAll("#filters button")) {
    b.classList.toggle("active", b.dataset.filter === filter);
  }
  for (const card of document.querySelectorAll(".card")) {
    card.classList.toggle("hidden", filter !== "all" && card.dataset.status !== filter);
  }
  for (const section of document.querySelectorAll("section")) {
    const visible = section.querySelectorAll(".card:not(.hidden)").length > 0;
    section.classList.toggle("hidden", !visible);
  }
}

async function main() {
  const root = document.getElementById("catalog");
  let tests;
  try {
    const res = await fetch("api/tests");
    tests = await res.json();
  } catch (e) {
    root.replaceChildren(el("p", { class: "muted" }, `목록을 불러오지 못했습니다: ${e}`));
    return;
  }
  const byCategory = new Map();
  for (const t of tests) {
    if (!byCategory.has(t.category)) byCategory.set(t.category, []);
    byCategory.get(t.category).push(t);
  }
  root.replaceChildren(...[...byCategory].map(([cat, items]) =>
    el("section", {}, el("h2", {}, `${cat} (${items.length})`), ...items.map(renderCard))));

  for (const b of document.querySelectorAll("#filters button")) {
    b.addEventListener("click", () => applyFilter(b.dataset.filter));
  }
}

main();
