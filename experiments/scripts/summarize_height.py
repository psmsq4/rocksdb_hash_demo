import re
import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "memtable" in kv:
        rows[(kv["wbs"], kv["height"], kv["memtable"])].append(kv)

print(f"{'wbs':7}{'h':>3} {'memtable':9}{'load_s (runs)':>18}{'ops/s':>12}"
      f"{'flushes':>8}{'stall_s':>8}{'put p99 us':>11}")
for wbs in ("2048MB", "64MB"):
    for h in ("4", "12"):
        for m in ("HEAD", "UPSTREAM", "SKIPLIST"):
            rs = rows.get((wbs, h, m))
            if not rs:
                continue
            loads = "/".join(f"{float(r['load_s']):.2f}" for r in rs)
            ops = statistics.median(float(r["ops_per_s"]) for r in rs)
            stall = max(float(r["stall_s"]) for r in rs)
            p99 = statistics.median(float(r["put_p99_us"]) for r in rs)
            print(f"{wbs:7}{h:>3} {m:9}{loads:>18}{ops:>12,.0f}{rs[0]['flushes']:>8}"
                  f"{stall:>8.2f}{p99:>11.2f}")
