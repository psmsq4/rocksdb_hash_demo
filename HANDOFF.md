# HashSkipList 개선 작업 인수인계

작성: 2026-11-12. 이 문서와 두 저장소(`~/rocksdb/rocksdb_hash`, `~/rocksdb/rocksdb_hash_demo`)만으로 작업을 이어갈 수 있도록
설계, 측정 결과, 도구 사용법, 남은 일을 정리했습니다. 측정 수치는 모두 아래 "측정 환경"의 WSL
머신에서 나온 값이므로, 서버로 옮기면 같은 스크립트로 다시 측정해야 합니다.

## 0. 요약

RocksDB `HashSkipListRep`(prefix hash memtable)의 두 결격 사유를 없앴다.

1. **total-order iteration이 매우 느림**: iterator를 만들 때마다(flush 포함) memtable 전체를 새
   skiplist로 복사했다. → 정렬된 `prefix_list_`와 `PrefixOrderedIterator`로 복사 없이 순회.
2. **동시 쓰기 불가**: `allow_concurrent_memtable_write`(RocksDB 기본값)를 켜면 DB가 열리지 않았다.
   → bucket을 InlineSkipList로 바꾸고 CAS로 bucket을 설치해 `InsertConcurrently` 지원.

| 항목 | HEAD 대 upstream HashSkipList |
|---|---|
| total-order seek | 0.33~1.9초 → 7.5~12.9µs (seek+10) |
| iterator 메모리 | entry당 약 20B → 0 |
| flush | 64MB 약 23%, 512MB 약 21%, 1GB 약 50% 빠름 (upstream은 memtable이 클수록 느려짐) |
| 단일 스레드 쓰기 | 동등 (편차 범위) |
| 멀티 스레드 쓰기 | key가 prefix 안에서 흩어질 때 8스레드 1.9배. 시간순 key에서는 동시 쓰기를 끄는 게 빠르고, 끄면 동등 |
| 메모리 | prefix당 key 16개 이상이면 +1~11%, prefix당 key 1개면 +50% |

## 1. 위치

| 무엇 | 경로 | 상태 |
|---|---|---|
| 작업 브랜치 | `~/rocksdb/rocksdb_hash`, 브랜치 `hash_skiplist_improvements` | 커밋 4개 + base. **push 안 됨** (origin은 facebook/rocksdb) |
| base | `e591f5f1a` (2026-11-08 기준 facebook/rocksdb main) | |
| 시연 앱, 벤치, 실험 | `~/rocksdb/rocksdb_hash_demo` (이 저장소) | |
| TPC-E 데이터 | `~/tpc-e/flat_out/*.txt` (5.7GB, Trade.txt 3.2GB, 28,664,881행) | EGen 5000 customers, scale factor 500, initial trade days 300 (`~/tpc-e/bin/EGenLoaderFrom1To5000.log`) |
| 과거 과제 보고서 | `~/rocksdb_report/*.pdf` (14팀 1~4차 발표) | 일부 주장은 아래 4절에서 정정 |
| 연구용 저장소 | `~/oss_bigdata/rocksdb`, 브랜치 `prefix_layer` | 로그, 계측 코드로 오염됨. **쓰지 말 것** |
| Claude 작업 메모 | `~/.claude/projects/-home-psmsq4-oss-bigdata-rocksdb/memory/` | 서버의 Claude Code에서도 쓰려면 복사 |

## 2. 커밋 (`~/rocksdb/rocksdb_hash`, 오래된 순)

| 커밋 | 제목 | 핵심 |
|---|---|---|
| efcdab406 | Use InlineSkipList for HashSkipListRep buckets | bucket을 `SkipList`에서 `InlineSkipList`로 교체. key가 node 안에 있어야 하므로 `Allocate()`를 override해 `key_allocator_`(삽입은 하지 않는 InlineSkipList)로 node를 할당하고 나중에 bucket에 연결 (zero-copy) |
| fd1587399 | Support concurrent writes in HashSkipListRep | `InsertConcurrently()` 구현, bucket 설치를 `compare_exchange_strong`으로, factory가 동시 쓰기 지원을 보고 |
| aaa3f6e4e | Iterate HashSkipListRep in total order without copying | `prefix_list_`(user comparator로 정렬된 prefix InlineSkipList) + `PrefixOrderedIterator`. 그룹 경계는 `InlineSkipList::Iterator::SeekToFirstNotMatching/SeekToLastMatching`(predicate 탐색, 새로 추가)으로 찾음. `MemTableRep::KeyComparator::user_comparator()` 추가(public API 변경) |
| 9d92aecc1 | Give HashSkipListRep's prefix list its own minimum height | `prefix_list_` 높이를 `max(skiplist_height, 12)`로. 기본 높이 4는 prefix가 많으면 선형 탐색이 됨 |
| 2561b92b7 | Skip the prefix list lookup on HashSkipListRep inserts | bucket마다 마지막 등록 prefix의 `prefix_list_` 항목을 기억(`HashBucket::known_prefix`, release/acquire). insert마다 하던 `prefix_list_` 탐색 제거. `TotalOrderIterator` 테스트에 bucket 1000개 조합 추가 |

release note는 `unreleased_history/`에 4개(앞 3개 커밋분).

### 설계에서 꼭 알아야 할 불변식
- **prefix를 bucket보다 먼저 등록한다.** iterator가 bucket에서 key를 찾으면 그 prefix도 `prefix_list_`에 있어야 한다. 메모(`known_prefix`)는 prefix 등록 후 release로 저장, acquire로 읽는다.
- **prefix 순서가 key 순서를 따라야 한다**(options.h의 "권장" 조건). `prefix_list_` 순서가 곧 출력 순서이기 때문. fixed, capped, noop, "구분자 포함" 추출기는 만족한다. "구분자 앞까지(구분자 제외)"는 깨진다(예: `a!.b` < `a.z`인데 prefix는 `a` < `a!`).
- prefix가 그룹의 시작일 필요는 없다(predicate 탐색으로 경계를 찾음). ReverseBytewiseComparator 테스트 통과.
- user-defined timestamp comparator는 지원하지 않는다(debug assert).
- 도메인 밖 key를 insert하면 upstream과 마찬가지로 처리하지 않는다. `FixedPrefixTransform::Transform`은 release 빌드에서 key 뒤 footer까지 읽는다. capped와 noop은 모든 key가 도메인 안이라 안전.

## 3. 측정 결과

### 측정 환경
Intel Core Ultra 7 155H(논리 22코어, L3 24MB), RAM 7.6GB, WSL2(5.15) Ubuntu 22.04, g++ 11.4,
cmake 3.22, Release 빌드(-O3 -march=native -fno-rtti). VSCode 등이 메모리를 4~5GB 써서
사용 가능 메모리가 2~4GB였다.

**편차 주의:** 같은 조건에서도 실행마다 ±10%, 세션 간 기준선이 최대 40% 움직였다. 비교는 같은
세션에서 구성을 번갈아(라운드마다 순서를 바꿔) 5~7회 돌린 중앙값만 믿을 것. 1회 측정으로 잘못된
결론을 두 번 냈다(아래 4절).

### 3.1 memtable 메모리 (entry당 바이트, 1M key, flush 없음, bucket 1M개)

| prefix당 key | value | upstream | step1 | HEAD(3커밋) | SkipList |
|---|---|---|---|---|---|
| 1 | 16B | 151.3 | 194.5 | 227.6 (+50%) | 65.2 |
| 16 | 16B | 78.1 | 84.7 | 86.7 (+11%) | 65.2 |
| 16 | 128B | 191.2 | 196.9 | 199.0 (+4%) | 177.4 |
| 1024 | 128B | 183.6 | 185.4 | 185.5 (+1%) | 177.4 |

원인: Arena가 aligned 할당을 16B로 정렬(entry당 +2.8B), InlineSkipList bucket마다 `seq_splice_`
(bucket당 +63B), `prefix_list_` node(prefix당 약 33B). total-order iterator 1개 생성 시 RSS는
upstream +19.8MB(1M key), HEAD 0.

### 3.2 skiplist 높이 (bucket 하나에 random insert, value 16B)

| 높이 | n | SkipList | InlineSkipList |
|---|---|---|---|
| 4 | 50K / 100K | 0.174s / 0.686s | 0.181s / 0.700s |
| 12 | 50K / 100K | 0.057s / 0.116s | 0.054s / 0.114s |
| 12 | 1M | 2.63s | 2.25s (-14%) |

높이 4에서는 둘 다 O(n²). InlineSkipList 고유 이득은 key inline과 소프트웨어 PREFETCH로 5~14%.

### 3.3 쓰기 회귀와 수정 (op_trade_bench, 512MB, 1.5M 거래, flush 없음, WAL 끔)
- 메모 이전 HEAD: upstream 대비 -25~31% (`AddPrefix`를 뺀 빌드는 동등 → `prefix_list_` 탐색이 원인)
- 메모 이후(7라운드 중앙값): upstream 408,779 / HEAD 401,396 (-1.8%) / 탐색 제거판 400,171 (-2.1%)

### 3.4 flush (memtable 하나를 거의 채운 뒤 `DB::Flush()`, 5~7라운드 중앙값)

| 조건 | upstream | HEAD | SkipList |
|---|---|---|---|
| 40만 건(64MB급), 거래 로그 key | 350.8 ms | 242.7 ms (-30.8%) | 238.4 ms |
| 300만 건(512MB급), 거래 로그 key | 3,205 ms | 2,230 ms (-30.4%) | 2,250 ms |
| 512MB, 280만 건, 계좌 key | 2,584 ms | 2,031 ms (-21.4%) | 1,803 ms |
| 1GB, 560만 건, 계좌 key | 7,896 ms | 3,963 ms (-49.8%) | 4,802 ms |

HEAD는 초당 약 140만 건으로 일정, upstream은 크기가 클수록 느려짐(정렬용 복사가 O(n log n)).
자동 flush(64MB 기본, 단일 스레드)에서도 평균 flush 시간이 22~24% 짧았다. 단, flush는
백그라운드라 stall이 없으면 처리량 숫자에는 드러나지 않는다.

### 3.5 단일 스레드 쓰기 (기본 64MB, 200만 거래, 5라운드 중앙값, ops/s)

| 모드 | key | HEAD | upstream | SkipList |
|---|---|---|---|---|
| 큐 + WAL 켬 | 거래 로그 `trade_종목\|t_id` | 91,601 | 93,282 | 62,179 |
| 큐 + WAL 켬 | 계좌 `trade_종목\|계좌\|t_id` | 73,387 | 73,780 | 64,282 |
| preload + WAL 끔 | 거래 로그 | 963,267 | 976,852 | 448,622 |
| preload + WAL 끔 | 계좌 | 495,326 | 494,448 | 416,196 |

### 3.6 멀티 스레드 쓰기 (preload, 512MB, 200만, WAL 끔, key 하나씩, 3라운드 중앙값, ops/s)

| key | 스레드 | HEAD 동시 켬 | HEAD 끔 | upstream | SkipList 켬 |
|---|---|---|---|---|---|
| 거래 로그 | 1 / 4 / 8 | 947K / 525K / 453K | 946K / 817K / 654K | 987K / 830K / 655K | 297K / 417K / 380K |
| 계좌 | 1 / 4 / 8 | 306K / **433K / 427K** | 312K / 301K / 248K | 266K / 276K / 225K | 265K / 348K / 335K |

- 시간순 key: 여러 스레드가 같은 bucket 끝에 몰리고 단일 스레드 insert가 이미 싸서(splice 재사용)
  동시 쓰기가 손해. 끄면 upstream과 같다.
- 계좌 key: bucket 안 삽입 위치가 흩어져 동시 쓰기가 확장. 8스레드에서 upstream의 1.9배.
- 입력을 무작위로 섞어도 같은 경향(8스레드 HEAD 520K vs upstream 226K).
- WriteBatch(16/64/256)로 묶어도 hash 계열은 1스레드에서 이미 약 200만 ops/s라 확장되지 않음.
  SkipList만 최대 2.57배 확장.
- 큐 모드에서 소비자를 늘리면 큐 lock이 먼저 병목(4소비자 약 10만 ops/s). 확장성은 `--preload`로 잴 것.

### 3.7 bucket 높이 (서버, 세 개 동시 실행, 1천만 건, 계좌 key, preload, WAL 끔, 2라운드)
`experiments/scripts/run_height.sh` → `experiments/results/server/height.txt`

| memtable | 높이 | HEAD | UPSTREAM | SKIPLIST(12) |
|---|---|---|---|---|
| 2048MB (flush 0회) | 4 | 35.5초 | 37.9초 | 29.7초 |
| 2048MB (flush 0회) | 12 | **26.1초** | 30.6초 | 29.7초 |
| 64MB (flush 30회) | 4 | 13.1초 | 12.0초 | 16.5초 |
| 64MB (flush 30회) | 12 | 13.9초 | 11.7초 | 17.0초 |

- 높이 4(RocksDB 기본)는 bucket당 약 256개(4^4)까지만 로그 탐색이다. 2048MB에서는 memtable 하나에 1천만 건이 들어가 bucket(종목)당 평균 약 2,900개, 최대 약 6,800개라 맨 위 레벨을 선형으로 훑는다. 그래서 hash 계열이 SKIPLIST보다 느렸다.
- 높이 12로 맞추면 HEAD가 SKIPLIST보다 12% 빠르다(put p99 10.0 → 5.9µs). 64MB에서는 bucket당 약 100개라 높이와 무관하게 hash 계열이 빠르다.
- 그래서 대시보드 기본 높이를 12로 바꿨다. 이전 측정(3.1~3.6절, 서버 재측정 포함)은 모두 높이 4다.

### 3.8 InlineSkipList는 언제 이득인가 (서버, 단독 실행, perf stat, 2048MB, preload, WAL 끔, 높이 12, 2라운드)
`experiments/scripts/run_fastpath.sh` → `experiments/results/server/fastpath.txt`

| key | memtable | 적재 시간 | 명령어/KV | IPC | L1 미스/KV |
|---|---|---|---|---|---|
| 시간순 `trade_종목\|t_id` | HEAD | 6.33 / 6.43초 | 11,079 | 2.07 | 25.4 |
| 시간순 | UPSTREAM | 6.24 / 6.38초 | 11,191 | 1.88 | 32.1 |
| 계좌 `trade_종목\|계좌\|t_id` | HEAD | 23.6 / 24.3초 | 13,413 | 0.96 | 86.6 |
| 계좌 | UPSTREAM | 27.2 / 28.9초 | 13,415 | 0.81 | 136.0 |

- 같은 조건에서 SKIPLIST는 시간순 약 20초, 계좌 약 27.5초다. 시간순 key는 연속 key가 서로 다른 종목이라 전역 리스트에서는 fast-path를 못 탄다.
- **시간순 key에서는 HEAD = UPSTREAM.** 새 KV가 거의 항상 bucket 끝에 붙어 두 skiplist 모두 순차 삽입 fast-path로 탐색을 건너뛴다(`SkipList`의 `prev_` 재사용, `skiplist.h` "fast path for sequential insertion" / `InlineSkipList`의 `seq_splice_`). 건드리는 노드는 방금 넣은 꼬리 노드라 캐시에 있으므로 key 인라인이 아낄 미스가 없다.
- **계좌 key에서는 HEAD가 14% 빠르다.** 매 삽입이 bucket을 탐색하며 오래된 노드를 따라가는데, InlineSkipList는 key가 노드 안에 있어 노드당 미스가 한 번이다(L1 미스 −36%, IPC 0.81 → 0.96, 명령어 수는 같다).
- 종목 안에서 t_id가 줄어드는 행이 3%(앞 200만 행 기준) 있지만 영향은 없다. 항상 증가하는 행 번호 key로 바꿔도 결과가 같았다.
- 64MB에서는 시간순 key에서도 HEAD가 약 16% 빠르다(5.6 대 6.7초). 하지만 이건 flush 몫이다. 적재 중 flush 28회가 같은 코어를 쓰고, UPSTREAM은 flush가 느리고(평균 186 대 143 ms) stall이 0.34초 생긴다.

### 3.9 점 조회 (서버, 단독 실행, 종류별 3초, preload, WAL 끔, flush 없음)
`experiments/scripts/run_get.sh` → `experiments/results/server/get.txt`

| 데이터 | 높이 | hit p50: HEAD / UPSTREAM / SKIPLIST | 없는 종목 p50 (hash / SKIPLIST) |
|---|---|---|---|
| 20만 건 (캐시에 다 들어감, 3라운드) | 12 | 0.88 / **0.82** / 1.17µs | – |
| 200만 건, 512MB | 12 | **2.01** / 2.22 / 2.32µs | 0.29 / 1.32µs |
| 1천만 건, 2048MB, 시간순 key | 12 | **2.77** / 3.28 / 3.15µs | 0.29 / 1.83µs |
| 1천만 건, 2048MB, 계좌 key | 12 | **2.86** / 3.41 / 3.12µs | 0.29 / 2.01µs |
| 1천만 건, 2048MB, 계좌 key | 4 | 4.70 / 4.83 / **3.12µs** | 0.30 / 1.99µs |

- Get은 순차 삽입 fast-path가 없어 매번 bucket을 위에서부터 탐색한다. 그래서 데이터가 캐시를 넘으면 InlineSkipList(key 인라인)가 노드당 미스를 줄여 HEAD가 UPSTREAM보다 9~16% 빠르다. 계좌 key 삽입의 14%와 같은 원리다.
- 캐시에 다 들어가는 작은 데이터에서는 UPSTREAM이 약 7% 빠르다. 미스가 없으면 InlineSkipList의 추가 작업이 드러나는 것으로 보지만 카운터로 확인하지는 않았다. 빌드 옵션은 librocksdb와 측정기 모두 `-O3 -march=native -fno-rtti`로 같다.
- 없는 종목 조회는 hash 계열이 빈 bucket에서 바로 끝나 0.29µs, SKIPLIST는 전체를 탐색해 1.3~2.0µs다. miss(있는 종목 안의 없는 key)는 hit와 거의 같다.
- 높이 4에서는 hash 계열이 SKIPLIST보다 50% 느리다(3.7절과 같은 이유).

### 3.10 정확도: 내용 해시 (서버)
`experiments/results/server/verify.txt`

- SST 파일 자체의 sha256은 데이터가 같아도 memtable마다 다르다. 같은 100만 건을 flush하면 세 파일 모두 128,948,408바이트로 같은 크기지만, 약 4KB마다 4바이트(블록 체크섬, format_version 6이 파일마다 다른 값을 섞음)와 속성(DB identity, session identity)이 다르다. 데이터 블록 내용은 같다. 자동 flush 시점에 따라 파일 수와 크기도 달라질 수 있다.
- 그래서 내용으로 비교한다(`--verify`). 모든 조건에서 세 memtable의 KV 개수, 정렬, 내용 해시가 같았고 flush 전후도 같았다.
  - 2M 64MB 큐(자동 flush 여러 번): `5fbdca3b5202d4d1`
  - 2M 512MB 소비자 4개 계좌 key(쓰는 순서가 실행마다 다름): `de9cb1a65871ffe1`
  - 대시보드 flush 카드 1천만 건: `75e19f8a94ce3bc9`(SST 22~24개)
  - 대시보드 멀티 스레드 카드 800만 건: `7e2d76fb9a1bf3dc`
- HEAD에서 바뀐 total-order iterator를 flush가 쓰므로, flush 후 SST 내용이 SKIPLIST와 같다는 것이 그 iterator가 맞다는 직접 증거다.

## 4. 정정된 가설 (발표 때 주의)

| 이전 주장 | 실제 |
|---|---|
| InlineSkipList로 바꿔 선형 성능 저하가 사라졌다 (보고서 3차) | 같은 커밋(연구 브랜치 867c686cf)에서 skiplist 높이 기본값을 4→12로 바꾼 효과. 높이가 같으면 둘 다 같다 |
| 노드 인접 할당 + L3 PREFETCH가 성능을 지배한다 (보고서 4차 7쪽) | 실재하지만 5~14%, 하드웨어가 아닌 소프트웨어 PREFETCH |
| 보고서 3차 prefix 3~5 비교 | db_bench key(앞 8바이트 big-endian)라 prefix 3~5는 bucket 하나. bucket 구조·높이·memtable 크기(64MB vs 1GB) 세 변수가 동시에 다름 |
| 보고서 4차 동시성 실험의 lock 경합 해석 | fixed:7 + 7자리 미만 key(약 1/3)가 도메인 밖이라 footer까지 prefix로 읽음. 결과가 오염됐을 수 있음 |
| (이번 작업 중) HEAD flush가 upstream보다 느리다 | 1회 측정의 편차. 반복 측정에서는 HEAD가 30% 빠름 |
| (이번 작업 중) 메모 후에도 13% 느리다 | 3라운드 편차. 7라운드에서는 동등 |
| (서버 작업 중) 큰 memtable에서 hash 계열이 SKIPLIST보다 느리다 | bucket 높이 4(RocksDB 기본) 때문. 12로 맞추면 HEAD가 12% 빠르다 (3.7절) |
| (서버 작업 중) 시간순 key에서도 2048MB면 HEAD가 UPSTREAM보다 44% 빠르다 | 대시보드 측정과 같은 코어에서 겹친 오측정. 다시 재면 같다 (3.8절) |
| (서버 작업 중) t_id 3% 역순 때문에 fast-path 복구 비용이 갈린다 | 항상 증가하는 key로 바꿔도 같아서 기각 |

## 5. 도구

### 5.1 op_trade_bench (`op_trade_bench/`)
TPC-E Trade.txt를 생산자 → 큐 → 소비자로 RocksDB에 Put한다. 요구사항 원문은 `op_trade_bench/CLAUDE.md`.

```bash
op_trade_bench/build.sh          # ~/rocksdb/rocksdb_hash/build-rel/librocksdb.so에 링크, -fno-rtti 필수
op_trade_bench/out/op_trade_bench --memtable=HEAD|UPSTREAM|SKIPLIST [옵션]
```

| 옵션 | 의미 |
|---|---|
| `--limit=N` | 생산 건수(기본 1M). 파일보다 많으면 처음부터 다시 돌며 key에 `#회차`를 붙임 |
| `--key_format=symb_tid\|symb_acct_tid` | `trade_종목\|t_id`(기본, 시간순) 또는 `trade_종목\|계좌\|t_id`(흩어짐) |
| `--write_buffer_size=512MB` | memtable 크기(K/M/G 접미사) |
| `--disable_wal` | WAL 끔 |
| `--consumers=N` | 쓰기 스레드 수 |
| `--preload` | KV를 먼저 메모리에 만들고 큐 없이 쓰기만 측정 |
| `--batch=N` | WriteBatch 크기(`--preload` 필요) |
| `--concurrent=0\|1` | `allow_concurrent_memtable_write` 강제. 지원 안 하는 memtable에 1이면 오류 |
| `--shuffle` | preload한 KV 순서를 섞음(seed 42) |
| `--flush_at_end` | 적재 후 `DB::Flush()` 시간을 측정 (`final_flush_ms`) |
| `--queue=N`, `--progress_ms=N`, `--input=`, `--db=` | 큐 크기, 진행 출력 주기, 입력, DB 경로 |
| `--metrics_port=N` | `127.0.0.1:N/metrics`에 Prometheus 지표 노출(0이면 빈 포트, `METRICS_PORT=<n>` 출력). flush 이벤트, memtable과 DB 속성, CPU와 RSS, 0이 아닌 RocksDB statistics |
| `--metrics_dump=PATH` | 적재와 최종 flush 후 같은 지표를 파일로 남김(종료 후에도 최종값을 읽기 위함) |
| `--print_samples=N` | 만든 KV 중 N개를 고른 간격으로 `SAMPLE <순번> <key>\t<value>` 줄로 출력(대시보드의 KV 샘플 패널용) |
| `--hash_height=N` | HEAD, UPSTREAM bucket skiplist 높이(기본 4 = RocksDB 기본, SKIPLIST는 항상 12). 대시보드 기본은 12 |
| `--scan_seconds=S`, `--scan_length=N` | 적재 후 flush 없이 prefix scan(`prefix_same_as_start`)을 S초, total-order scan(`total_order_seek`)을 S초. scan마다 iterator를 새로 열고 적재한 key 약 6.5만 개 중 하나로 seek한 뒤 최대 N개(기본 100)를 읽는다. RESULT에 `scan_prefix_*`, `scan_total_*`(횟수, 초당, 평균/p50/p99 µs) |
| `--get_seconds=S` | 적재(와 scan) 후 DB::Get을 S초씩 세 종류: hit(적재한 key), miss(적재한 key 뒤에 한 바이트 붙인 없는 key, 같은 종목), noprefix(`trade_종목~\|`처럼 한 번도 쓰지 않은 종목, key 순서상 실제 종목 바로 뒤). RESULT에 `get_hit_*`, `get_miss_*`, `get_noprefix_*`(횟수, 초당, 평균/p50/p99 µs, 찾은 수) |
| `--verify` | 마지막에 flush 전 DB 전체를 key 순서대로 읽고, 전량 flush 후 SST에서 다시 읽어 KV 개수, key 엄격 증가 여부, (key 길이, key, value 길이, value)의 64비트 FNV-1a 해시를 낸다. RESULT에 `verify_*` |

- prefix 추출기: 첫 `|`까지(구분자 포함). key 끝은 길이로 정해지므로 t_id 뒤에 구분자가 필요 없다.
- UPSTREAM은 `e591f5f1a`의 `hash_skiplist_rep.cc`를 이름만 바꿔 내장(`upstream_hash_skiplist_rep.cc`, `gen_upstream.sh`로 재생성). 그래서 한 바이너리로 세 memtable을 비교한다.
- 다른 커밋의 HEAD를 쓰려면 `LD_LIBRARY_PATH=$WORK/libs/<이름>`(RUNPATH보다 우선).
- 마지막 줄 `RESULT key=value ...`를 스크립트가 파싱한다. "queue+put latency"는 큐가 늘 가득 차 있어 의미가 없다(큐 길이 ÷ 처리량).

### 5.2 웹 대시보드 (Spring Boot 3.5.9, Java 21, Gradle 8.10 wrapper)
```bash
op_trade_bench/build.sh                                            # 측정기 먼저
./gradlew build && ~/java21/bin/java -jar build/libs/rocksdb-demo-0.1.0.jar   # http://127.0.0.1:8181/#flush
```
- 서버에는 JDK 21이 `~/java21`에만 있다. Gradle toolchain은 `~/.gradle/gradle.properties`의 `org.gradle.java.installations.paths`로 찾고, jar는 `~/java21/bin/java`로 실행한다.
- 저장소 루트에서 실행할 것. 측정기 경로(`demo.bench-binary`)가 실행 위치 기준이다.
- 카드 하나가 벤치마크 하나다(`bench/BenchmarkCatalog.java`). 시작 버튼을 누르면 HEAD, UPSTREAM, SKIPLIST를 동시에 띄우고 `demo.cpu-sets`(기본 2-5, 6-9, 10-13)로 코어를 나눈다. 백엔드(`bench/RunService.java`)가 각 프로세스의 `/metrics`를 1초마다 긁어 시계열로 쌓고, 페이지가 1초마다 `GET /api/benchmarks/{id}/run`으로 받아 그린다(uPlot, `static/vendor`). 측정은 한 번에 하나다.
- 첫 카드는 flush: 1,000만 건, 64MB memtable, WAL 끔, 마지막에 `DB::Flush`. 세 개를 동시에 돌려 가장 느린 SKIPLIST가 약 22초.
- 두 번째 카드는 멀티 스레드 쓰기: 800만 건, preload, 소비자 4개, 512MB, 계좌 key, WAL 끔, 높이 12, 동시 memtable 쓰기 켬. HEAD와 SKIPLIST는 memtable에 동시에 넣고, UPSTREAM은 지원하지 않아 쓰기 그룹 리더 한 스레드가 넣는다. 가장 느린 UPSTREAM이 약 25초. 서버에서 HEAD 약 63만, SKIPLIST 약 44만, UPSTREAM 약 37만 ops/s, Put p99 9.9 / 11.1 / 20.1µs. UPSTREAM도 CPU를 약 400% 쓰는데, 리더를 기다리며 도는 시간이다.
- 카드 종류(`Benchmark.kind`)에 따라 화면이 다르다. flush는 평균 flush 시간과 flush 그래프를, write는 처리량, Put 지연, CPU를 앞에 둔다(`app.js`의 `VIEWS`).
- 세 번째 카드 "Range query (범위 조회)": 200만 건, 512MB(flush 없이 memtable에 다 들어감), 시간순 key, preload, 높이 12, prefix scan 8초 + total-order scan 8초, scan 길이 100. 약 21초. 서버에서 p50은 prefix scan HEAD 18.6 / SKIPLIST 19.1 / UPSTREAM 29.3µs, total-order scan HEAD 19.6 / SKIPLIST 19.1µs / UPSTREAM 308ms(약 15,700배, 8초에 26회). UPSTREAM은 total-order iterator를 열 때마다 memtable 200만 건을 새 skiplist로 복사한다. 지연 그래프는 로그 눈금이다.
- 네 번째 카드 "Point query (점 조회)": 500만 건, 2048MB(flush 없음), 계좌 key, preload, 높이 12, hit / miss / 없는 종목을 4초씩. 약 29초(DB를 닫을 때 2GB memtable flush가 있어 예상보다 길다). 서버에서 hit p50 HEAD 2.70 / SKIPLIST 2.96 / UPSTREAM 3.22µs, 없는 종목 p50 hash 0.31~0.36 / SKIPLIST 1.99µs. 없는 종목 패널은 SKIPLIST와 비교한다.
- flush 카드와 멀티 스레드 카드는 "정확도 검증"이 기본으로 켜져 있다(설정 모달에서 끌 수 있음). 끝나면 펼친 화면의 "정확도" 패널에 세 memtable의 KV 개수, key 순서, flush 전후 내용 해시, SST 파일 수와 크기를 나란히 보여주고 일치 여부를 판정한다. 검증 때문에 flush 카드 약 28초, 멀티 스레드 카드 약 31초.
- 헤더 왼쪽 햄버거 아이콘에 마우스를 올리면(키보드는 포커스) 왼쪽에서 메뉴가 페이지 위로 나오고 페이지는 서서히 어두워진다. 떼면 닫히며 다시 밝아진다(CSS만, `app.css`의 `.nav`). 메뉴는 "벤치마크"(`/`)와 "아키텍처"(`/architecture.html`).
- 아키텍처 페이지(`architecture.html`, `arch.js`, `arch.css`)는 HEAD(왼쪽)와 UPSTREAM(오른쪽)을 같은 장면으로 나란히 애니메이션한다. 장면은 1) 새 종목 삽입(Allocate, Transform, bucket miss와 HashBucket CAS 설치, RegisterPrefix로 prefix_list_ 정렬 삽입과 known_prefix 캐싱, bucket 삽입. UPSTREAM은 key와 노드를 Arena 양 끝에서 따로 할당) 2) 같은 종목 삽입(bucket hit, known_prefix 캐시 적중으로 prefix_list_ 건너뜀) 3) FLUSH(HEAD는 PrefixOrderedIterator가 prefix_list_ 순서로 bucket 경계를 넘으며 출력, UPSTREAM은 GetIterator가 모든 bucket을 새 SkipList로 복사한 뒤 출력) 4) Range query(Put 생략. prefix scan은 둘 다 hash로 bucket을 찾지만 entry마다 HEAD는 노드 한 곳, UPSTREAM은 노드와 멀리 떨어진 key 두 곳을 읽음. total-order scan은 HEAD가 prefix_list_로 Seek해 경계를 넘고, UPSTREAM은 iterator를 열 때 전체 복사) 5) 멀티 스레드 쓰기(HEAD는 LaunchParallelMemTableWriters로 T1~T3가 동시에 InsertConcurrently, UPSTREAM은 동시 쓰기가 꺼져 쓰기 그룹 리더 T1이 하나씩 넣고 T2·T3는 대기). 28단계, 캡션에 서버 실측값을 붙임, 재생/일시정지/단계 이동/속도, 키보드 ←→와 Space. 각 단계 상태를 미리 계산해 key별 SVG 그룹을 옮기는 방식이다.
- 카드의 톱니 버튼이 설정 모달을 연다. KV 개수(100,000 단위, 최대 3,000만), memtable 크기(64MB 또는 128MB 단위, 최대 2GB), key 형식(하나만 선택), bucket 높이(4 또는 12, 기본 12), preload, WAL, 동시 memtable 쓰기(HEAD/SKIPLIST, 기본 켬), 소비자 개수(1~8, 프로세스마다 CPU 4개라 4 이하 권장). 설정은 서버 메모리에 카드별로 저장되고(재시작하면 기본값) 다음 측정부터 적용된다. 검증과 인자 변환은 `bench/RunSettings.java`.
- 측정을 시작하면 카드 오른쪽에 KV 샘플 패널이 열리고, 카드와 패널이 한 블록으로 가운데 정렬된다. 샘플은 측정기가 실제로 만든 KV 8개(`--print_samples=8`)이고, 워크로드 특성은 `bench/WorkloadProfile.java`가 Trade.txt 앞 200만 행에서 구한 값(종목 3,425개, 종목별 거래 수, key/value 평균 크기)으로 쓴다. 화면 폭 1100px 이하에서는 패널이 카드 아래로 내려간다.
- 각 프로세스는 `perf stat`(카운팅만, `demo.perf-counters`)으로 감싸 실행하고, 측정이 끝나면 펼친 화면의 "하드웨어 카운터"에 KV당 사이클, 명령어, IPC, L1/dTLB/LLC 미스를 보여준다(`bench/PerfStat.java`). 하이브리드 CPU라 `cpu_core/<event>/u`를 쓰고 P코어에 고정해야 읽힌다. 시작할 때 P코어에서 한 번 시험해 안 되면 카운터 없이 측정만 한다. 중단 버튼은 perf의 자식(측정기)까지 끈다.
- 모달의 예상 소요 시간은 세 개 동시 실행에서 잰 SKIPLIST 속도로 계산한다(큐 47만/s, 큐+WAL 30만/s, preload 64만/s, preload+WAL 38만/s, 계좌 key는 0.87배, 고정 1초). 제한 시간은 없다. 측정은 끝날 때까지 돌고, 멈추려면 측정 중인 다이얼을 누른다.
- localhost에만 바인딩된다. 다른 PC에서 보려면 `ssh -L 8181:127.0.0.1:8181 <서버>`.
- 글꼴은 Meslo LG S DZ for Powerline(`static/fonts`, powerline/fonts)이다.

### 5.3 실험 스크립트
`experiments/README.md` 참고. 라이브러리 빌드는 `experiments/scripts/build_libs.sh`.

### 5.4 RocksDB 빌드와 테스트 (`~/rocksdb/rocksdb_hash`)
```bash
# Debug(테스트): 기존 build/ 디렉터리, WITH_TESTS, FAIL_ON_WARNINGS
cd build && make -j3 db_memtable_test prefix_test inlineskiplist_test
./db_memtable_test --gtest_filter='*HashSkipList*'
# Release 공유 라이브러리
cd build-rel && cmake .. -DCMAKE_BUILD_TYPE=Release -DWITH_TESTS=OFF -DWITH_BENCHMARK_TOOLS=OFF \
  -DWITH_TOOLS=OFF -DWITH_CORE_TOOLS=OFF -DWITH_GFLAGS=OFF -DFAIL_ON_WARNINGS=OFF -DROCKSDB_BUILD_SHARED=ON
make -j3 rocksdb-shared
# 포맷
git clang-format   # clang-format 23.1.5가 ~/.local/bin에 있음
```
- WSL 7GB에서 `-j20`은 OOM. `-j3`~`-j6`.
- `inlineskiplist_test`는 Debug에서 약 4분 걸린다.
- 테스트 바이너리는 `librocksdb.so`에 RUNPATH로 링크된다.

## 6. 측정 방법론 (지킬 것)
1. 비교할 구성을 **같은 세션에서 번갈아**, 라운드마다 순서를 바꿔 돌린다.
2. 5~7라운드, **중앙값**과 각 실행 값을 함께 기록한다. 실행 범위가 겹치면 "차이 없음"으로 본다.
3. `taskset`으로 코어를 고정한다.
4. 자동 flush가 끼면 안 되는 측정은 결과의 `flushes=0`을 확인한다.
5. 큰 memtable이나 preload는 사용 가능 메모리를 먼저 본다. swap이 끼면 무효다.
6. 쉘 스크립트는 bash로 돌린다(zsh는 `$VAR`에 담은 인자를 나누지 않음).
7. 가설이 맞는지 **통제 실험으로 한 변수만 바꿔** 확인한다(높이 오귀속 사례).
8. 웹 대시보드(8181)는 코어 2-13을 쓴다. 스크립트로 측정할 때는 대시보드가 측정 중이 아닌지 먼저 보고(`GET /api/benchmarks/flush/run`의 `active`), 끝난 뒤에도 겹치지 않았는지 확인한다. 한 번 겹쳐서 44% 차이로 오측정했다.
9. HEAD/UPSTREAM과 SKIPLIST를 비교할 때는 bucket 높이(`--hash_height`)를 SKIPLIST와 같은 12로 맞췄는지 확인한다.

## 7. 남은 일 (우선순위 순)
1. **회귀 테스트 묶음 재실행**: 9d92aecc1, 2561b92b7 이후 db_test, db_iterator_test, db_bloom_filter_test, db_tailing_iter_test, perf_context_test, options_test를 아직 돌리지 않았다(3커밋 시점에는 모두 통과).
2. **서버에서 3절 전체 재측정** 후 이 문서의 표 갱신.
3. **읽기 측정**: range scan(`--scan_seconds`, 세 번째 카드)과 점 조회(`--get_seconds`, 네 번째 카드, 3.9절)를 넣었다. 남은 것은 SST까지 내려간 상태(flush 후)의 읽기와 여러 스레드 동시 읽기다. 시나리오 2의 "prefix 그룹 분석 쿼리"와 "랜덤 점/범위 조회"를 op_trade_bench에 추가해야 한다(현재는 쓰기와 flush만).
4. **실시간 지표**: op_trade_bench `--metrics_port`와 웹 대시보드(5.2절)로 구현했다. 남은 것은 Prometheus/Grafana 연동(선택)이다. 원래 설계: op_trade_bench에 `--metrics_port`로 `/metrics` 노출(RocksDB `EventListener`의 `OnFlushBegin/OnFlushCompleted`로 flush 시간, Put 카운터와 지연, memtable 크기, write stall, `/proc/self` 기반 CPU와 RSS), `monitoring/`에 docker compose(Prometheus 1초 수집, Grafana 대시보드). flush를 이벤트 단위로 보여주려면 Spring이 stdout을 받아 SSE로 미는 방식이 더 맞다.
5. **시연 시나리오 2의 나머지**: session/login/event 생산자(무작위 ID → 동시 쓰기 켬 시연), 7GB에서는 memtable 512MB 이하.
6. **웹 대시보드 카드 추가**: flush, 멀티 스레드 쓰기, range scan, 점 조회까지 있다. 다음 후보는 flush 후 SST 읽기, 동시 읽기 카드.
7. (선택) HashSkipListRepFactory 주석에 "prefix 안에서 key가 증가하는 워크로드는 `allow_concurrent_memtable_write=false` 권장" 추가.
8. (선택) 도메인 밖 key insert 처리(예: key 전체를 prefix로). upstream에서 물려받은 문제.
9. (선택) upstream PR. `KeyComparator::user_comparator()` public API 추가가 리뷰 쟁점. 대안은 prefix를 internal key 형식으로 저장해 기존 comparator를 재사용(비교 시 복사 비용).

## 8. 서버 이전 체크리스트
서버 경로: RocksDB 브랜치 `~/rocksdb/rocksdb_hash`, 이 저장소 `~/rocksdb/rocksdb_hash_demo`, TPC-E `~/tpc-e`, JDK 21 `~/java21`.

- [x] `~/rocksdb/rocksdb_hash` 브랜치 이동 (`hash_skiplist_improvements`, 끝 2561b92b7).
- [x] `~/rocksdb/rocksdb_hash_demo` 이동(이 저장소).
- [x] TPC-E 데이터: `~/tpc-e/flat_out` (Trade.txt 28,664,881행 확인).
- [x] 경로 하드코딩 제거.
  - 실험 스크립트는 바이너리를 스크립트 위치 기준으로 찾는다(`OTB_BIN`으로 덮어쓰기 가능).
  - 빌드 스크립트의 `ROCKSDB_ROOT` 기본값은 `$HOME/rocksdb/rocksdb_hash`다.
  - `op_trade_bench`의 기본 입력은 실행 시 `$TPCE_DIR/flat_out/Trade.txt`로 정해진다(`TPCE_DIR` 기본값 `$HOME/tpc-e`).
- [ ] RocksDB 빌드: `build/`(Debug, 테스트)와 `build-rel/`(Release 공유 라이브러리) 모두 없음. 5.4절 참고. 서버는 RAM이 넉넉해 `-j`를 크게 잡아도 된다.
- [ ] 도구: g++ 14.3, cmake 3.31, docker, python3 있음. JDK 21은 `~/java21`(5.2절).
- [ ] `taskset` 코어 번호 확인. i9-12900K는 0-15가 P코어(하이퍼스레드 포함), 16-23이 E코어다. 기존 `2-13`은 P코어 범위 안이다.
- [ ] (선택) Claude 작업 메모 디렉터리 복사. 서버의 프로젝트 경로에 맞는 디렉터리 이름으로 옮겨야 한다.
