import re
import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
auto = defaultdict(set)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "final_flush_ms" in kv:
        key = (int(kv["write_buffer_size"]), kv["memtable"])
        rows[key].append(float(kv["final_flush_ms"]))
        auto[key].add(kv["flushes"])

for wbs in sorted({k[0] for k in rows}):
    limit = 2800000 if wbs == 512 << 20 else 5600000
    base = statistics.median(rows[(wbs, "UPSTREAM")])
    print(f"write_buffer_size={wbs >> 20}MB, {limit:,} KVs per flush")
    for m in ("HEAD", "UPSTREAM", "SKIPLIST"):
        v = rows[(wbs, m)]
        med = statistics.median(v)
        print(f"  {m:9} median {med:8.1f} ms  mean {statistics.mean(v):8.1f} ± {statistics.stdev(v):6.1f}"
              f"  vs UPSTREAM {med / base - 1:+6.1%}  {limit / med * 1000 / 1e6:5.2f}M KVs/s"
              f"  auto flushes during load={','.join(sorted(auto[(wbs, m)]))}  runs "
              + ", ".join(f"{x:.0f}" for x in v))
