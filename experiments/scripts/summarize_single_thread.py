import re
import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "ops_per_s" in kv:
        rows[(kv["mode"], kv["key_format"], kv["memtable"])].append(kv)

mems = ["HEAD", "UPSTREAM", "SKIPLIST"]
for mode in ("queue_wal", "preload_nowal"):
    print(f"== {mode} ==")
    for fmt in ("symb_tid", "symb_acct_tid"):
        base = statistics.median(float(r["ops_per_s"]) for r in rows[(mode, fmt, "UPSTREAM")])
        print(f"  key_format={fmt}")
        print(f"    {'memtable':9} {'ops/s':>10} {'vs up':>7} {'p50us':>6} {'p99us':>7} "
              f"{'p999us':>7} {'flushes':>8} {'flush ms':>9} {'stall s':>8}  runs (K)")
        for m in mems:
            rs = rows[(mode, fmt, m)]
            def md(k):
                return statistics.median(float(r[k]) for r in rs)
            ops = md("ops_per_s")
            print(f"    {m:9} {ops:10,.0f} {ops / base - 1:+7.1%} {md('put_p50_us'):6.2f} "
                  f"{md('put_p99_us'):7.2f} {md('put_p999_us'):7.2f} {md('flushes'):8.0f} "
                  f"{md('flush_avg_ms'):9.1f} {md('stall_s'):8.3f}  "
                  + ",".join(f"{float(r['ops_per_s'])/1000:.0f}" for r in rs))
