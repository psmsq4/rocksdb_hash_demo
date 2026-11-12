import re
import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
for line in open(sys.argv[1]):
    kv = dict(re.findall(r"(\w+)=(\S+)", line))
    if "ops_per_s" not in kv:
        continue
    rows[(kv["exp"], int(kv["batch"]), kv["config"], int(kv["consumers"]))].append(
        float(kv["ops_per_s"]))


def med(key):
    v = rows.get(key)
    return statistics.median(v) if v else float("nan")


def table(exp, batch, configs):
    threads = sorted({k[3] for k in rows if k[0] == exp and k[1] == batch})
    print(f"{'threads':>8} " + " ".join(f"{c:>20}" for c in configs))
    for t in threads:
        cells = []
        for c in configs:
            m = med((exp, batch, c, t))
            base = med((exp, batch, c, threads[0]))
            cells.append(f"{m / 1000:9,.0f}K ({m / base:4.2f}x)")
        print(f"{t:>8} " + " ".join(f"{x:>20}" for x in cells))
    spread = []
    for c in configs:
        for t in threads:
            v = rows.get((exp, batch, c, t), [])
            if v:
                spread.append(f"{c}/t{t}: " + ",".join(f"{x/1000:.0f}" for x in v))
    print("   runs (K): " + " | ".join(spread))


print("== Experiment 1: single-key writes, concurrent memtable writes on/off ==")
table("1", 1, ["head_c1", "head_c0", "upstream", "skiplist_c1", "skiplist_c0"])
for b in (16, 64, 256):
    print(f"\n== Experiment 2: batch={b} ==")
    table("2", b, ["head_c1", "head_c0", "upstream", "skiplist_c1"])
