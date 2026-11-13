# experiments

`op_trade_bench`로 돌린 측정의 스크립트, 원시 결과, 되돌린 코드 변형입니다.
결론과 수치 요약은 저장소 루트의 `HANDOFF.md`에 있습니다.

## 준비

```bash
# 비교용 librocksdb.so를 커밋별로 빌드 ($WORK/libs/<이름>/librocksdb.so.11)
WORK=/tmp/otb_work JOBS=8 experiments/scripts/build_libs.sh
# op_trade_bench 빌드 (~/rocksdb/rocksdb_hash/build-rel/librocksdb.so에 링크)
op_trade_bench/build.sh
```

스크립트는 `$WORK`(기본 `/tmp/otb_work`)에 DB와 라이브러리를 둡니다. `taskset -c 2-13`
(또는 `2-5`)으로 코어를 고정하므로, 서버에서는 코어 번호를 맞게 바꾸세요.
측정은 모두 bash로 실행하세요. zsh는 변수에 담은 인자를 단어로 나누지 않습니다.

## 라이브러리 이름

| 이름 | 커밋 | 내용 |
|---|---|---|
| step1 | 91549bab9 | bucket을 InlineSkipList로 교체 |
| step2 | 4f8df92bc | + 동시 쓰기 |
| head | 42ac47a08 | + total-order iterator, prefix_list_ 최소 높이 (메모 이전) |
| head_noprefix | 42ac47a08 변형 | AddPrefix 제거. **쓰기 시간 측정 전용** (iterator/flush 결과가 틀림) |
| head_memo | 1888cce21 | + bucket별 prefix 메모 (현재 브랜치 끝) |
| head_single | 1888cce21 + variants | 되돌린 "단일 prefix bucket 비교 생략" 변형 |

UPSTREAM은 `op_trade_bench`에 내장(`upstream_hash_skiplist_rep.cc`)되어 있어 어느 라이브러리로든 실행됩니다.

## 스크립트 → 결과

| 스크립트 | 결과 파일 | 질문 | 요약 |
|---|---|---|---|
| (수동 실행) | otb_512.txt | 512MB memtable, 1M/10M, WAL 켬 | HEAD가 UPSTREAM보다 13~30% 느림 (메모 이전, 1회) |
| run_isolate.sh | isolate.txt, isolate2.txt | 어느 커밋에서 쓰기가 느려졌나 | prefix_list_ 탐색(AddPrefix)이 원인 |
| run_isolate.sh | isolate3.txt | 메모 효과 (3라운드) | -31% → -13% (편차 큼) |
| run_repeat.sh | repeat.txt | 7라운드 재확인 | 메모 -1.8%, 탐색 제거 -2.1%: 편차 범위 |
| run_flush.sh | flush.txt | flush 하나의 시간 (40만/300만 건) | HEAD 약 30% 빠름, SkipList와 동등 |
| run_single.sh | single.txt | 단일 prefix 생략 변형의 효과 | 이득 없음 → 되돌림 |
| run_mt.sh | mt.txt | 소비자 N개 (시간순 key) | HEAD 동시 쓰기는 확장되지 않음 |
| run_exp.sh | exp.txt | 동시 쓰기 켜기/끄기, WriteBatch 크기 | HEAD 끔 = UPSTREAM, batch에서도 HEAD 켬은 손해 |
| run_shuffle.sh | shuffle.txt | 입력 순서를 섞으면? | HEAD 켬이 8스레드에서 UPSTREAM의 2.3배 |
| run_keyfmt.sh | keyfmt.txt | key에 계좌를 넣으면? (섞지 않음) | HEAD 켬이 8스레드에서 UPSTREAM의 1.9배 |
| run_single_thread.sh | st.txt | 기본 64MB, 단일 스레드, 두 key 형식 | 쓰기 HEAD = UPSTREAM, flush 22~24% 빠름 |
| run_bigflush.sh | bigflush.txt | 512MB/1GB memtable flush | HEAD -21% / -50% |
| run_height.sh | server/height.txt | bucket 높이 4 vs 12 (2048MB/64MB, 계좌 key, 동시 실행) | 2048MB에서 높이 4면 hash가 SKIPLIST보다 느림, 12면 HEAD가 12% 빠름 |
| run_fastpath.sh | server/fastpath.txt | 시간순 vs 계좌 key에서 HEAD와 UPSTREAM (2048MB, 높이 12, 단독, perf) | 시간순은 fast-path로 같음, 계좌는 HEAD 14% 빠름(L1 미스 −36%) |
| run_get.sh | server/get.txt | 점 조회 hit / miss / 없는 종목 (20만~1천만 건, 높이 12와 4, 단독) | 큰 데이터에서 HEAD가 UPSTREAM보다 9~16% 빠름, 없는 종목은 hash 0.29µs 대 SKIPLIST 1.3~2.0µs |

각 `summarize_*.py`에 결과 파일을 넘기면 표가 나옵니다.

```bash
python3 experiments/scripts/summarize_keyfmt.py experiments/results/keyfmt.txt
```

## variants

`hash_skiplist_rep_single_prefix.cc`: 1888cce21 위에 "bucket에 prefix가 하나뿐이면 iterator가
entry마다 prefix를 비교하지 않는" 최적화를 더한 `memtable/hash_skiplist_rep.cc`.
테스트와 mutation 테스트는 통과했지만 flush·쓰기 모두 측정상 이득이 없어 커밋하지 않았습니다.
