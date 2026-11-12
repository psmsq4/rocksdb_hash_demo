import re
import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "final_flush_ms" in kv:
        rows[(int(kv["limit"]), kv["memtable"])].append(kv)

for limit in sorted({k[0] for k in rows}):
    base = statistics.median(float(r["final_flush_ms"]) for r in rows[(limit, "UPSTREAM")])
    print(f"limit={limit:,}")
    print(f"  {'memtable':9} {'median ms':>10} {'mean±sd ms':>16} {'vs upstream':>12} "
          f"{'auto flushes':>12}  runs")
    for mem in ["UPSTREAM", "HEAD", "SKIPLIST"]:
        rs = rows.get((limit, mem), [])
        if not rs:
            continue
        ms = [float(r["final_flush_ms"]) for r in rs]
        med = statistics.median(ms)
        sd = statistics.stdev(ms) if len(ms) > 1 else 0
        auto = sorted({r["flushes"] for r in rs})
        print(f"  {mem:9} {med:10.1f} {statistics.mean(ms):9.1f}±{sd:6.1f} "
              f"{med / base - 1:+12.1%} {','.join(auto):>12}  "
              + ", ".join(f"{m:.0f}" for m in ms))
