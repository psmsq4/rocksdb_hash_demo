"""Draws the report charts from summary.json (mean of 5 rounds, whiskers = min..max)."""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.ticker import FuncFormatter

FONT_DIR = os.path.expanduser("~/.local/share/fonts/NanumSquare")
for f in ("NanumSquareR.ttf", "NanumSquareB.ttf"):
    font_manager.fontManager.addfont(os.path.join(FONT_DIR, f))
# The web-font build lacks a few glyphs (space, µ); fall back to Noto for those.
REG = ["NanumSquareOTFR00", "Noto Sans CJK KR"]
BOLD = ["NanumSquareOTFB00", "Noto Sans CJK KR"]

plt.rcParams.update({
    "font.family": REG, "font.size": 10, "axes.edgecolor": "#c3c9d1", "axes.linewidth": 0.8,
    "axes.labelcolor": "#4a5564", "xtick.color": "#4a5564", "ytick.color": "#4a5564",
    "axes.spines.top": False, "axes.spines.right": False, "axes.unicode_minus": False,
    "savefig.dpi": 220, "figure.dpi": 110,
})
INK = "#1d2430"
INK2 = "#4a5564"
GRID = "#e6e9ee"
TARGETS = ["HEAD", "UPSTREAM", "SKIPLIST"]
COLOR = {"HEAD": "#3987e5", "UPSTREAM": "#d95926", "SKIPLIST": "#199e70"}

S = json.load(open("summary.json"))["cards"]


def stat(card, t, m):
    return S[card][t][m]


def style(ax, title, unit, better):
    ax.set_title(title, loc="left", fontsize=11.5, color=INK, fontfamily=BOLD, pad=14)
    ax.text(0, 1.015, f"{unit} · {better}", transform=ax.transAxes, fontsize=8.5, color=INK2,
            va="bottom")
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.tick_params(axis="x", length=0, labelsize=10)
    ax.tick_params(axis="y", labelsize=8.5, length=0)


def bars(ax, card, metric, fmt, log=False, scale=1.0):
    xs = range(len(TARGETS))
    means = [stat(card, t, metric)["mean"] * scale for t in TARGETS]
    lo = [m - stat(card, t, metric)["min"] * scale for m, t in zip(means, TARGETS)]
    hi = [stat(card, t, metric)["max"] * scale - m for m, t in zip(means, TARGETS)]
    ax.bar(xs, means, width=0.56, color=[COLOR[t] for t in TARGETS], edgecolor="white",
           linewidth=2, zorder=2)
    ax.errorbar(xs, means, yerr=[lo, hi], fmt="none", ecolor="#3d4652", elinewidth=1,
                capsize=4, capthick=1, zorder=3)
    ax.set_xticks(list(xs), TARGETS)
    if log:
        ax.set_yscale("log")
    top = max(m + h for m, h in zip(means, hi))
    for x, m, h in zip(xs, means, hi):
        y = (m + h) * (1.35 if log else 1) + (0 if log else top * 0.03)
        ax.text(x, y, fmt(m), ha="center", va="bottom", fontsize=9.5, color=INK,
                fontfamily=BOLD)
    if not log:
        ax.set_ylim(0, top * 1.18)
    else:
        ax.set_ylim(min(means) * 0.5, top * 8)


def save(fig, name):
    fig.tight_layout()
    fig.savefig(name, facecolor="white")
    plt.close(fig)
    print("saved", name)


num = lambda v: f"{v:,.0f}"

# 1. Flush
fig, axes = plt.subplots(1, 2, figsize=(7.2, 2.9))
bars(axes[0], "flush", "flush_avg_ms", lambda v: f"{v:.1f} ms")
style(axes[0], "평균 flush 시간", "ms", "낮을수록 좋음")
bars(axes[1], "flush", "ops_per_s", lambda v: f"{v/1e4:.1f}만", scale=1)
axes[1].yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v/1e4:.0f}만"))
style(axes[1], "쓰기 처리량", "ops/s", "높을수록 좋음")
save(fig, "figures/fig_flush.png")

# 2. Multi-thread write
fig, axes = plt.subplots(1, 2, figsize=(7.2, 2.9))
bars(axes[0], "write", "ops_per_s", lambda v: f"{v/1e4:.1f}만")
axes[0].yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v/1e4:.0f}만"))
style(axes[0], "쓰기 처리량 (스레드 4개)", "ops/s", "높을수록 좋음")
bars(axes[1], "write", "put_p99_us", lambda v: f"{v:.1f} µs")
style(axes[1], "Put 지연 p99", "µs", "낮을수록 좋음")
save(fig, "figures/fig_write.png")

# 3. Range query
fig, axes = plt.subplots(1, 2, figsize=(7.2, 2.9))
bars(axes[0], "scan", "scan_prefix_p50_us", lambda v: f"{v:.1f} µs")
style(axes[0], "Prefix scan 지연 p50", "µs", "낮을수록 좋음")
bars(axes[1], "scan", "scan_total_p50_us", lambda v: f"{v:,.1f} µs" if v < 1000 else f"{v/1000:,.1f} ms",
     log=True)
axes[1].yaxis.set_major_formatter(FuncFormatter(
    lambda v, _: (f"{v:g} µs" if v < 1000 else f"{v/1000:g} ms")))
style(axes[1], "Total-order scan 지연 p50", "로그 눈금", "낮을수록 좋음")
save(fig, "figures/fig_scan.png")

# 4. Point query: grouped by query kind
fig, ax = plt.subplots(figsize=(7.2, 3.0))
kinds = [("get_hit_p50_us", "있는 key"), ("get_miss_p50_us", "있는 종목의 없는 key"),
         ("get_noprefix_p50_us", "없는 종목")]
w = 0.24
for i, t in enumerate(TARGETS):
    xs = [k + (i - 1) * (w + 0.03) for k in range(len(kinds))]
    means = [stat("get", t, m)["mean"] for m, _ in kinds]
    lo = [mm - stat("get", t, m)["min"] for mm, (m, _) in zip(means, kinds)]
    hi = [stat("get", t, m)["max"] - mm for mm, (m, _) in zip(means, kinds)]
    ax.bar(xs, means, width=w, color=COLOR[t], label=t, edgecolor="white", linewidth=1.5, zorder=2)
    ax.errorbar(xs, means, yerr=[lo, hi], fmt="none", ecolor="#3d4652", elinewidth=1, capsize=3,
                zorder=3)
    for x, m, h in zip(xs, means, hi):
        ax.text(x, m + h + 0.06, f"{m:.2f}", ha="center", va="bottom", fontsize=8.5, color=INK,
                fontfamily=BOLD)
ax.set_xticks(range(len(kinds)), [k for _, k in kinds])
ax.set_ylim(0, max(stat("get", t, m)["max"] for t in TARGETS for m, _ in kinds) * 1.2)
style(ax, "Get 지연 p50", "µs", "낮을수록 좋음")
ax.legend(frameon=False, ncol=3, loc="upper right", fontsize=9, handlelength=1.2,
          bbox_to_anchor=(1.0, 1.18))
save(fig, "figures/fig_get.png")
