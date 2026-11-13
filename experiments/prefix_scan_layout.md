# prefix scan에서 UPSTREAM이 느린 이유: Arena 배치

작성: 2026-11-13. 측정: i9-12900K 서버, `op_trade_bench`(main `30d717c` 이후 작업본), RocksDB `hash_skiplist_improvements`(`2561b92b7`).

## 요약

- Range query 카드에서 prefix scan p50은 HEAD 18.6µs, SKIPLIST 19.1µs, UPSTREAM 29.3µs다. UPSTREAM만 약 57% 느리다.
- 세 memtable의 명령어 수는 같다. 차이는 전부 메모리 대기다.
- 주원인은 **UPSTREAM에서 skiplist 노드와 그 key+value가 Arena 블록의 반대편에 놓이는 배치**다.
  - entry 하나를 읽을 때 UPSTREAM은 서로 다른 4KB 페이지 두 곳을 건드린다. HEAD와 SKIPLIST는 한 곳만 건드린다.
  - 그래서 dTLB 미스가 entry당 약 1.2번에서 2.2번으로 늘어난다.
- **검증:** UPSTREAM의 key 버퍼 할당 위치 한 줄만 바꾸자 p50이 28.6µs에서 19.9µs가 됐다. **격차의 약 85%가 사라졌다.**
- 남은 약 8%(19.9 대 18.2µs)가 "key를 포인터로 한 번 더 따라가는" 순수한 key 인라인 효과다.

## 배경: prefix scan이 하는 일

- 대시보드 세 번째 카드 "Range query (범위 조회)"의 첫 단계다. 200만 건, 512MB memtable(flush 없음), 시간순 key `trade_종목|t_id`, bucket 높이 12다.
- scan마다 iterator를 새로 열고 `prefix_same_as_start=true`로 적재한 key 하나에 Seek한 뒤, 같은 종목 안에서 최대 100개를 `Next()`로 읽는다. 종목 끝에서 멈추므로 평균 91개다.
- Seek은 bucket 하나(종목당 약 580개) 안의 짧은 탐색이다. 비용 대부분은 그 뒤 약 91번의 `Next()`, 즉 노드를 하나씩 따라가며 key와 value를 읽는 데서 나온다.
- 같은 종목의 entry들은 서로 다른 시각에 들어왔다. 그 사이에 다른 3,400여 종목의 KV가 끼어들었으므로, bucket 안에서 이웃한 노드들은 Arena에서 멀리 떨어져 있다. 따라서 `Next()`마다 새 캐시 라인과 새 페이지를 읽는 것은 세 memtable 모두 같다.

## 코드: 무엇이 다른가

### prefix iterator 코드는 같다
`HashSkipListRep::DynamicIterator::Seek`은 HEAD(`memtable/hash_skiplist_rep.cc`)와 UPSTREAM(`op_trade_bench/upstream_hash_skiplist_rep.cc`)이 같은 코드다. prefix로 bucket을 찾고 그 bucket의 skiplist iterator로 Seek한다. 다른 것은 bucket 자료구조뿐이다.

| | bucket 자료구조 | 노드와 key+value 할당 |
|---|---|---|
| HEAD | `InlineSkipList` | `AllocateKey()`가 노드와 key+value를 **한 덩어리로** `AllocateAligned` |
| SKIPLIST | `InlineSkipList`(전역 하나) | HEAD와 같음 |
| UPSTREAM | `SkipList<const char*>` | key+value는 `MemTableRep::Allocate` 기본 구현 → `Arena::Allocate`, 노드는 `NewNode()` → `Arena::AllocateAligned`. **따로 두 번** |

### Arena는 양 끝에서 할당한다
- `memory/arena.h:124` `Arena::Allocate`(정렬 불필요)는 `unaligned_alloc_ptr_ -= bytes`로 블록 **끝에서 앞쪽으로** 떼어 준다.
- `memory/arena.cc:85-91` `AllocateAligned`는 `aligned_alloc_ptr_`에서 블록 **앞에서 뒤쪽으로** 떼어 준다.
- memtable은 `ConcurrentArena`를 쓴다. 쓰기 스레드가 하나면 `memory/concurrent_arena.h:138` 경로로 공유 Arena를 그대로 쓰므로 위 규칙이 그대로 적용된다.
- Arena 블록 크기는 `db/column_family.cc:243`의 `min(1MB, write_buffer_size / 8)`이다. 512MB memtable이면 1MB다.

결과적으로 UPSTREAM에서는 한 entry의 key+value가 1MB 블록의 뒤쪽, 그 노드는 앞쪽에 놓인다. 둘 사이는 블록이 찰수록 줄어들지만 대체로 수백 KB이고, 서로 다른 4KB 페이지다. prefix scan은 entry마다 노드(다음 포인터)와 key+value(비교와 반환)를 모두 읽으므로, UPSTREAM은 entry마다 먼 페이지 두 곳을 오간다.

## 측정 1: prefix scan 구간의 하드웨어 카운터

- **조건:** 각 memtable 단독 실행, `taskset -c 2-5`(P코어), 2M 건, 512MB, 시간순 key, preload, WAL 끔, 높이 12, `--scan_seconds=6`. 대시보드가 측정 중이 아닌지 매번 확인했다.
- **구간 자르기:** `perf stat -I 1000`(1초 간격)으로 찍고, 적재가 끝난 시점(`total_s`)에서 1.5초~5.5초 사이 구간만 썼다. 이어지는 total-order 단계는 UPSTREAM이 memtable을 복사하므로 빼야 한다.
- **단위:** 구간 합을 그 구간의 scan 수로 나눴다. scan 1회는 entry 약 91개다.

| memtable | p50 (3라운드) | 사이클/scan | 명령어/scan | IPC | L1 미스/scan | dTLB 미스/scan |
|---|---|---|---|---|---|---|
| HEAD | 18.30 / 18.30 / 18.05µs | 84,083 | 116,809 | 1.39 | 330 | 107 |
| UPSTREAM | 28.54 / 28.80 / 28.54µs | 131,020 | 116,380 | 0.89 | 563 | 201 |
| SKIPLIST | 18.6 / 18.8µs (2라운드) | 87,282 | 120,082 | 1.38 | 430 | 121 |

- 명령어 수는 HEAD와 UPSTREAM이 0.4% 안쪽으로 같다. 비교 횟수와 코드 경로가 같다는 뜻이다.
- UPSTREAM은 사이클이 56% 많고 IPC가 1.39에서 0.89로 떨어진다. 같은 일을 하며 메모리를 더 기다린다.
- dTLB 미스는 entry당 HEAD 약 1.2번, UPSTREAM 약 2.2번이다. **entry마다 정확히 페이지 하나를 더 건드린다.**

## 측정 2: 한 변수만 바꾼 실험

UPSTREAM 코드에서 key 버퍼 할당 위치만 바꿨다. key+value 버퍼도 `AllocateAligned`로 받으면, 바로 이어서 할당되는 노드가 key 바로 뒤에 붙는다. 나머지(`SkipList`, 포인터로 key를 가리키는 구조)는 그대로다.

```diff
 // op_trade_bench/upstream_hash_skiplist_rep.cc, class HashSkipListRep
+  // EXPERIMENT: take the key buffer from the aligned (front) end of the
+  // arena, like the node allocated right after it, so a node sits next to
+  // its key instead of at the other end of the arena block.
+  KeyHandle Allocate(const size_t len, char** buf) override {
+    *buf = allocator_->AllocateAligned(len);
+    return static_cast<KeyHandle>(*buf);
+  }
```

같은 조건으로 HEAD, UPSTREAM 원래, UPSTREAM 실험판을 번갈아 3라운드씩 돌렸다(순서는 라운드마다 바꿈).

| 구성 | prefix scan p50 | 초당 scan | 사이클/scan | 명령어/scan | IPC | L1 미스/scan | dTLB 미스/scan |
|---|---|---|---|---|---|---|---|
| HEAD | 18.30 / 18.30 / 18.05µs | 약 5.8만 | 84,083 | 116,809 | 1.39 | 330 | 107 |
| UPSTREAM 원래 (key 뒤쪽, 노드 앞쪽) | 28.54 / 28.80 / 28.54µs | 약 3.7만 | 131,020 | 116,380 | 0.89 | 563 | 201 |
| **UPSTREAM 실험** (노드가 key 바로 뒤) | **19.58 / 20.35 / 19.58µs** | 약 5.3만 | 91,403 | 116,336 | 1.27 | 394 | **110** |

- key 할당 위치 하나로 p50이 28.6µs에서 19.9µs로 줄었다. HEAD와의 격차 10.4µs 중 8.7µs(약 85%)가 사라졌다.
- dTLB 미스가 201에서 110으로 HEAD(107) 수준이 됐다. 페이지를 하나 더 건드리던 것이 없어졌다.
- 남은 차이는 약 1.7µs(약 8%), L1 미스 394 대 330이다. 노드와 key가 붙어 있어도 `SkipList`는 노드에서 key 포인터를 한 번 더 따라가야 한다. 대개 바로 옆 캐시 라인이라 비용이 작지만 0은 아니다. 이것이 key를 노드 안에 넣는 InlineSkipList 고유의 효과다.

## 해석

- InlineSkipList의 이득은 "key를 노드 안에 넣어 캐시 미스 하나를 줄인다"로 흔히 설명한다. 그런데 RocksDB에서는 그보다 **노드와 key+value를 한 번에 할당해, Arena 양끝 할당 때문에 생기는 페이지 분리를 없애는 효과**가 훨씬 컸다.
- prefix scan은 탐색이 짧고 entry를 많이 따라가는 작업이라 이 차이가 57%로 크게 드러났다.
- **다른 측정과의 관계:**
  - 시간순 key 삽입(fast-path로 탐색 생략): HEAD와 UPSTREAM이 같았다. 방금 넣은 노드만 건드리므로 페이지가 떨어져 있어도 캐시에 있다.
  - 계좌 key 삽입(14%)과 큰 데이터의 Get(9~16%): 탐색 중 노드마다 key를 비교하므로 같은 배치 효과가 섞여 있을 가능성이 크다. 이 비율은 따로 확인하지 않았다.
  - SKIPLIST도 InlineSkipList라 HEAD와 같은 배치를 갖는다. 그래서 prefix scan에서 HEAD와 비슷하다(18.6 대 18.2µs).

## 한계

- 단일 쓰기 스레드 기준이다. 여러 스레드가 동시에 쓰면 `ConcurrentArena`가 코어별 shard(최대 128KB)에서 할당해 거리가 달라진다. 이 경우는 재지 않았다.
- `cache-misses`(LLC)는 하드웨어 prefetch까지 세어서 판단에 쓰지 않았다. L1과 dTLB 미스로 판단했다.
- 실험판은 원인 확인용이다. 저장소의 UPSTREAM 비교 대상은 원래 코드 그대로 둔다(upstream을 그대로 재현하는 것이 비교 대상의 목적).

## 재현

```bash
# 측정 1: prefix scan 구간 카운터 (memtable마다)
taskset -c 2-5 perf stat -I 1000 -x, -o pp.csv \
  -e cpu_core/cycles/u,cpu_core/instructions/u,cpu_core/L1-dcache-load-misses/u,cpu_core/dTLB-load-misses/u \
  op_trade_bench/out/op_trade_bench --memtable=UPSTREAM --limit=2000000 --write_buffer_size=512MB \
  --key_format=symb_tid --preload --disable_wal --hash_height=12 --scan_seconds=6 --progress_ms=0 --db=/tmp/otb_work/pp
# RESULT의 total_s(적재 끝) 이후 1.5~5.5초 구간의 합을 scan_prefix_per_s × 구간 수로 나눈다.

# 측정 2: 위 diff를 upstream_hash_skiplist_rep.cc에 넣어 따로 빌드한 측정기로 같은 명령을 돌린다.
```

- 대시보드(8181)는 같은 코어(2-13)를 쓰므로, 측정 전후로 `GET /api/benchmarks/<id>/run`의 `active`가 false인지 확인한다.
