import re
import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "config" in kv and "ops_per_s" in kv:
        rows[kv["config"]].append(kv)

order = ["upstream", "step1", "step2", "head", "head_memo", "head_noprefix", "skiplist"]
base = statistics.median(float(r["ops_per_s"]) for r in rows["upstream"])
print(f"{'config':14} {'ops/s (median)':>15} {'runs':>28} {'vs upstream':>12} "
      f"{'p50 us':>7} {'p99 us':>7} {'flushes':>7}")
for c in order:
    rs = rows.get(c)
    if not rs:
        continue
    ops = [float(r["ops_per_s"]) for r in rs]
    med = statistics.median(ops)
    p50 = statistics.median(float(r["put_p50_us"]) for r in rs)
    p99 = statistics.median(float(r["put_p99_us"]) for r in rs)
    fl = ",".join(r["flushes"] for r in rs)
    runs = ", ".join(f"{o/1000:.0f}K" for o in ops)
    print(f"{c:14} {med:15,.0f} {runs:>28} {med/base-1:+12.1%} {p50:7.2f} {p99:7.2f} {fl:>7}")
