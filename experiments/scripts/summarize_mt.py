import re
import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
flushes = defaultdict(set)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "ops_per_s" not in kv:
        continue
    key = (kv["memtable"], int(kv["consumers"]))
    rows[key].append(kv)
    flushes[key].add(kv["flushes"])

mems = ["HEAD", "UPSTREAM", "SKIPLIST"]
threads = sorted({k[1] for k in rows})
print("median ops/s (x = speedup over 1 thread of the same memtable)")
print(f"{'threads':>8} " + " ".join(f"{m:>22}" for m in mems) + "   HEAD/UPSTREAM")
med = {}
for t in threads:
    cells = []
    for m in mems:
        v = [float(r["ops_per_s"]) for r in rows.get((m, t), [])]
        med[(m, t)] = statistics.median(v) if v else float("nan")
    for m in mems:
        base = med[(m, threads[0])]
        cells.append(f"{med[(m, t)]:>13,.0f} ({med[(m, t)] / base:4.2f}x)")
    print(f"{t:>8} " + " ".join(f"{c:>22}" for c in cells) +
          f"   {med[('HEAD', t)] / med[('UPSTREAM', t)]:6.2f}x")

print("\nput latency p50 / p99 (us, median of runs)")
for t in threads:
    cells = []
    for m in mems:
        rs = rows.get((m, t), [])
        p50 = statistics.median(float(r["put_p50_us"]) for r in rs)
        p99 = statistics.median(float(r["put_p99_us"]) for r in rs)
        cells.append(f"{p50:6.2f} / {p99:6.2f}")
    print(f"{t:>8} " + " ".join(f"{c:>22}" for c in cells))

print("\nruns (K ops/s)")
for m in mems:
    for t in threads:
        v = [float(r["ops_per_s"]) / 1000 for r in rows.get((m, t), [])]
        print(f"  {m:9} t={t}: " + ", ".join(f"{x:.0f}" for x in v) +
              f"   flushes={','.join(sorted(flushes[(m, t)]))}")
