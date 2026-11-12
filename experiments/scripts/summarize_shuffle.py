import re
import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "ops_per_s" in kv:
        rows[(kv["order"], kv["config"], int(kv["consumers"]))].append(float(kv["ops_per_s"]))

configs = ["head_c1", "head_c0", "upstream", "skiplist_c1"]
for order in ("ordered", "shuffled"):
    print(f"== {order} ==")
    print(f"{'threads':>8} " + " ".join(f"{c:>20}" for c in configs))
    for t in (1, 4, 8):
        cells = []
        for c in configs:
            m = statistics.median(rows[(order, c, t)])
            base = statistics.median(rows[(order, c, 1)])
            cells.append(f"{m / 1000:9,.0f}K ({m / base:4.2f}x)")
        print(f"{t:>8} " + " ".join(f"{x:>20}" for x in cells))
    print("   runs (K): " + " | ".join(
        f"{c}/t{t}: " + ",".join(f"{x/1000:.0f}" for x in rows[(order, c, t)])
        for c in configs for t in (1, 4, 8)))
