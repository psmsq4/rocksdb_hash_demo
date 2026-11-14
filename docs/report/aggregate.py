"""Aggregates the five dashboard rounds (rounds/r{n}_{card}.json) into summary.json."""
import json
import statistics
import sys
from pathlib import Path

ROUNDS = Path(sys.argv[1] if len(sys.argv) > 1 else "rounds")
TARGETS = ["HEAD", "UPSTREAM", "SKIPLIST"]
METRICS = {
    "flush": ["flush_avg_ms", "flushes", "ops_per_s", "put_p50_us", "put_p99_us", "total_s"],
    "write": ["ops_per_s", "put_p50_us", "put_p99_us", "total_s", "flush_avg_ms"],
    "scan": ["scan_prefix_p50_us", "scan_prefix_p99_us", "scan_prefix_per_s",
             "scan_total_p50_us", "scan_total_p99_us", "scan_total_per_s"],
    "get": ["get_hit_p50_us", "get_hit_p99_us", "get_hit_per_s",
            "get_miss_p50_us", "get_noprefix_p50_us", "get_noprefix_per_s"],
}
VERIFY = ["verify_ok", "verify_pre_count", "verify_count", "verify_pre_sorted", "verify_sorted",
          "verify_pre_hash", "verify_hash", "verify_sst_files", "verify_sst_bytes"]

out = {"cards": {}, "verify": {}, "settings": {}}
for card, names in METRICS.items():
    runs = sorted(ROUNDS.glob(f"r*_{card}.json"))
    per = {t: {m: [] for m in names} for t in TARGETS}
    ver = []
    for f in runs:
        d = json.loads(f.read_text())
        out["settings"][card] = d["settings"]
        row = {"round": f.name.split("_")[0][1:]}
        for t in TARGETS:
            tr = d["targets"][t]
            assert tr["state"] == "DONE" and tr["exitCode"] == 0, (f, t, tr["state"])
            r = tr["result"]
            for m in names:
                per[t][m].append(float(r[m]))
            if "verify_ok" in r:
                row[t] = {k: r[k] for k in VERIFY}
        if len(row) > 1:
            ver.append(row)
    out["cards"][card] = {
        t: {m: {"mean": statistics.fmean(v), "std": statistics.stdev(v) if len(v) > 1 else 0.0,
                "min": min(v), "max": max(v), "n": len(v), "values": v}
            for m, v in per[t].items()}
        for t in TARGETS
    }
    if ver:
        out["verify"][card] = ver

Path("summary.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
for card, d in out["cards"].items():
    print(f"== {card} (n={d['HEAD'][METRICS[card][0]]['n']})")
    for m in METRICS[card]:
        print(f"  {m:22s}" + "".join(
            f"{t}: {d[t][m]['mean']:>12.2f} ±{d[t][m]['std']:<9.2f}" for t in TARGETS))
for card, rows in out["verify"].items():
    for row in rows:
        hashes = {t: (row[t]["verify_pre_hash"], row[t]["verify_hash"], row[t]["verify_count"],
                      row[t]["verify_ok"]) for t in TARGETS}
        same = len({h[0] for h in hashes.values()} | {h[1] for h in hashes.values()}) == 1
        print(card, "round", row["round"], "all equal:", same, hashes["HEAD"])
