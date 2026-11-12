import re
import statistics
import sys
from collections import defaultdict

flush = defaultdict(list)
write = defaultdict(list)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "ops_per_s" not in kv:
        continue
    if kv["phase"] == "flush":
        flush[(int(kv["limit"]), kv["config"])].append(float(kv["final_flush_ms"]))
    else:
        write[kv["config"]].append(float(kv["ops_per_s"]))

order = ["upstream", "memo", "single", "skiplist"]
for limit in sorted({k[0] for k in flush}):
    base = statistics.median(flush[(limit, "upstream")])
    print(f"flush, limit={limit:,} (ms)")
    for c in order:
        v = flush.get((limit, c))
        if not v:
            continue
        med = statistics.median(v)
        print(f"  {c:9} median {med:8.1f}  mean {statistics.mean(v):8.1f} ± {statistics.stdev(v):6.1f}"
              f"  vs upstream {med / base - 1:+6.1%}  runs " + ", ".join(f"{x:.0f}" for x in v))

base = statistics.median(write["upstream"])
print("write, 1.5M, 512MB, WAL off (ops/s)")
for c in order:
    v = write.get(c)
    if not v:
        continue
    med = statistics.median(v)
    print(f"  {c:9} median {med:9,.0f}  mean {statistics.mean(v):9,.0f} ± {statistics.stdev(v):7,.0f}"
          f"  vs upstream {med / base - 1:+6.1%}  runs " + ", ".join(f"{x/1000:.0f}K" for x in v))
