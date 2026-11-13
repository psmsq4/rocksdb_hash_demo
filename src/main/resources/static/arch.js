"use strict";

// Animated comparison of HEAD and UPSTREAM HashSkipListRep. Every step is a
// full state for both sides; rendering keeps one SVG group per key and only
// moves it, so a KV visibly travels from the input lane into its bucket and
// from there to the flush output.

const SVGNS = "http://www.w3.org/2000/svg";
const BASE_STEP_MS = 2800;

// ---------- layout (viewBox 640 x 520) ----------
const STAGE = {
  alloc: { x: 24, y: 78, w: 184, h: 44, t1: "Allocate" },
  transform: { x: 228, y: 78, w: 184, h: 44, t1: "Transform", t2: "첫 | 까지 = prefix" },
  hash: { x: 432, y: 78, w: 184, h: 44, t1: "hash(prefix) % N", t2: "bucket 번호" },
};
const ROW = { lane: 22, under: 136, chain: 186, wait: 219, slots: 258, card: 304, out: 478 };
const SLOT_W = 64;
const slotX = (i) => 24 + i * 76;
const cardX = (i) => slotX(i) - 22;
const CARD_W = 108;
const HEAD_CHIP_W = 96;
const UP_KEY_W = 78;
const CHAIN_X = (i) => 92 + i * 112;
const LIST_X = (i) => 24 + i * 120;

const sideCopy = (o) => JSON.parse(JSON.stringify(o));

// ---------- scenario ----------
function initialSide(isHead) {
  return {
    isHead,
    stage: null,
    token: null,             // { kv, at: {x, y}, from? }
    tokens: [],              // several at once: { kv, at, from?, label }
    entryCls: {},            // kv -> class of its bucket entry
    slot: {},                // idx -> class
    cards: {                 // bucket idx -> { known, entries[], cls }
      1: { known: "MME|", entries: ["MME|1002", "MME|1009"], cls: "" },
      4: { known: "IDBE|", entries: ["IDBE|1003"], cls: "" },
    },
    upNodes: {},             // UPSTREAM: kv -> class of its separate node
    prefixes: isHead ? ["IDBE|", "MME|"] : [],
    prefixCls: {},
    chainDim: false,
    copy: [],                // UPSTREAM flush copy
    copyVisible: false,
    copyCls: "",
    counter: null,
    out: [],
    ringP: null,             // HEAD: prefix node under the cursor ("head" or prefix)
    ringE: null,             // entry under the cursor { where: "bucket"|"copy", kv }
    ringSlot: null,
    cap: { title: "", body: "", code: "" },
  };
}

const bucketOf = { "EBKR|": 6, "IDBE|": 4, "MME|": 1 };
const prefixOf = (kv) => kv.slice(0, kv.indexOf("|") + 1);

function sortedInsert(list, item) {
  const out = [...list, item];
  out.sort();
  return out;
}

// Each step edits a copy of the previous world: { head, up, scene }.
const SCENES = [
  { id: "new", title: "1. 새 종목 삽입" },
  { id: "same", title: "2. 같은 종목 삽입" },
  { id: "flush", title: "3. FLUSH" },
  { id: "range", title: "4. Range query" },
  { id: "mt", title: "5. 멀티 스레드 쓰기" },
];

function buildSteps() {
  const steps = [];
  let w = { head: initialSide(true), up: initialSide(false) };
  const push = (scene, fn) => {
    w = sideCopy(w);
    for (const s of [w.head, w.up]) {
      s.slot = {};
      s.stage = null;
      s.prefixCls = {};
      s.chainDim = false;
      for (const c of Object.values(s.cards)) c.cls = "";
      s.ringSlot = null;
      s.entryCls = {};
      for (const k of Object.keys(s.upNodes)) s.upNodes[k] = "";
    }
    fn(w.head, w.up);
    steps.push({ scene, world: sideCopy(w) });
  };
  const under = (box, isHead) => ({
    x: STAGE[box].x + (STAGE[box].w - (isHead ? HEAD_CHIP_W : UP_KEY_W)) / 2,
    y: ROW.under,
  });
  const wait = (idx, isHead) => ({ x: cardX(idx) + (isHead ? 6 : 24), y: ROW.wait });

  // --- Scene 1: a symbol not seen yet ---
  let kv = "EBKR|1004";
  push("new", (h, u) => {
    for (const s of [h, u]) {
      s.token = { kv, at: under("alloc", s.isHead), from: { x: -140, y: ROW.lane } };
      s.stage = "alloc";
    }
    h.cap = {
      title: "KV가 들어옵니다",
      body: "MemTable::Add가 Allocate()로 공간을 받습니다. HEAD는 InlineSkipList::AllocateKey()로 skiplist 노드와 key+value를 한 덩어리로 받습니다. 빛나는 점이 key 앞에 붙은 노드입니다.",
      code: "HashSkipListRep::Allocate → key_allocator_.AllocateKey()",
    };
    u.cap = {
      title: "KV가 들어옵니다",
      body: "key+value 버퍼만 받습니다. MemTableRep 기본 Allocate()라 Arena 블록의 뒤쪽 끝에서 떼어 옵니다. skiplist 노드는 나중에 따로 받습니다.",
      code: "MemTableRep::Allocate → Arena::Allocate()",
    };
  });
  push("new", (h, u) => {
    for (const s of [h, u]) {
      s.token.at = under("transform", s.isHead);
      s.stage = "transform";
      s.cap = {
        title: "prefix를 잘라냅니다",
        body: "Transform()이 key에서 첫 | 까지를 잘라 prefix EBKR|를 얻습니다. 같은 종목의 거래는 모두 같은 prefix입니다.",
        code: "transform_->Transform(UserKey(key))",
      };
    }
  });
  push("new", (h, u) => {
    for (const s of [h, u]) {
      s.token.at = under("hash", s.isHead);
      s.stage = "hash";
      s.slot[6] = "new";
      s.cap = {
        title: "bucket miss",
        body: "hash(EBKR|) % N = 6. buckets_[6]이 비어 있습니다. 실제 N은 100만이고, 그림은 8칸만 그렸습니다.",
        code: "GetInitializedBucket(): buckets_[hash].load()",
      };
    }
  });
  push("new", (h, u) => {
    for (const s of [h, u]) {
      s.token.at = wait(6, s.isHead);
      s.slot[6] = "new";
      s.cards[6] = { known: null, entries: [], cls: "new" };
    }
    h.cap = {
      title: "새 HashBucket을 설치합니다",
      body: "Arena에 HashBucket을 만들고 compare_exchange_strong으로 buckets_[6]에 설치합니다. 여러 스레드가 동시에 넣어도 bucket이 하나만 남습니다. 안에는 InlineSkipList와 아직 빈 known_prefix가 있습니다.",
      code: "new HashBucket(...) + compare_exchange_strong",
    };
    u.cap = {
      title: "새 SkipList bucket을 만듭니다",
      body: "Arena에 SkipList를 만들어 buckets_[6]에 저장합니다. 동시 삽입을 지원하지 않아 CAS가 필요 없습니다.",
      code: "new Bucket(compare_, allocator_)",
    };
  });
  push("new", (h, u) => {
    h.prefixes = sortedInsert(h.prefixes, "EBKR|");
    h.prefixCls["EBKR|"] = "new";
    h.cards[6].known = "EBKR|";
    h.cards[6].cls = "new";
    h.cap = {
      title: "prefix를 정렬해 등록하고 캐싱합니다",
      body: "known_prefix가 비어 있어 prefix_list_에서 EBKR|를 찾습니다. 없으므로 정렬 위치(맨 앞)에 넣고, 그 노드를 bucket의 known_prefix에 저장합니다. key보다 prefix를 먼저 등록하므로 iterator가 key를 찾으면 prefix도 반드시 보입니다.",
      code: "RegisterPrefix() → AddPrefix() → known_prefix.store()",
    };
    u.upNodes[kv] = "new";
    u.cards[6].cls = "new";
    u.cap = {
      title: "노드를 따로 받습니다",
      body: "SkipList 노드는 AllocateAligned()로 Arena 블록의 앞쪽에서 받습니다. key 버퍼는 뒤쪽에 있으니 노드와 key가 서로 다른 페이지에 놓입니다. 점선이 노드가 key를 가리키는 포인터입니다.",
      code: "SkipList::NewNode → Arena::AllocateAligned()",
    };
  });
  push("new", (h, u) => {
    h.cards[6].entries = [kv];
    u.cards[6].entries = [kv];
    u.upNodes[kv] = "";
    h.token = null;
    u.token = null;
    h.cap = {
      title: "bucket에 넣습니다",
      body: "bucket 6의 InlineSkipList에 넣습니다. key가 노드 안에 있어 탐색 중 비교할 때 노드 하나만 읽으면 됩니다.",
      code: "bucket->list.Insert(key)",
    };
    u.cap = {
      title: "bucket에 넣습니다",
      body: "bucket 6의 SkipList에 넣습니다. 비교할 때마다 노드에서 포인터를 따라 멀리 떨어진 key를 한 번 더 읽어야 합니다.",
      code: "bucket->Insert(key)",
    };
  });

  // --- Scene 2: the same symbol again ---
  kv = "IDBE|1007";
  push("same", (h, u) => {
    for (const s of [h, u]) {
      s.token = { kv, at: under("alloc", s.isHead), from: { x: -140, y: ROW.lane } };
      s.stage = "alloc";
    }
    h.cap = {
      title: "같은 종목의 다음 거래",
      body: "IDBE|1007이 들어옵니다. 앞과 같이 노드와 key+value를 한 덩어리로 받습니다.",
      code: "key_allocator_.AllocateKey()",
    };
    u.cap = {
      title: "같은 종목의 다음 거래",
      body: "IDBE|1007이 들어옵니다. key+value 버퍼만 Arena 뒤쪽에서 받습니다.",
      code: "Arena::Allocate()",
    };
  });
  push("same", (h, u) => {
    for (const s of [h, u]) {
      s.token.at = under("hash", s.isHead);
      s.stage = "hash";
      s.slot[4] = "hit";
      s.cards[4].cls = "hit";
      s.cap = {
        title: "bucket hit",
        body: "prefix IDBE| → hash = 4. buckets_[4]에 이미 bucket이 있어 그대로 씁니다.",
        code: "GetInitializedBucket()",
      };
    }
  });
  push("same", (h, u) => {
    h.token.at = wait(4, true);
    h.cards[4].cls = "hit";
    h.slot[4] = "hit";
    h.chainDim = true;
    h.cap = {
      title: "known_prefix 캐시 적중",
      body: "bucket 4의 known_prefix가 IDBE|와 같습니다. prefix_list_를 찾지 않고 바로 bucket으로 갑니다. 같은 종목이 이어서 들어오는 거래 로그에서는 거의 항상 이 경로라, prefix 목록을 유지하는 비용이 삽입마다 붙지 않습니다.",
      code: "RegisterPrefix(): known_prefix == prefix → return",
    };
    u.token.at = wait(4, false);
    u.slot[4] = "hit";
    u.upNodes[kv] = "new";
    u.cap = {
      title: "노드를 따로 받습니다",
      body: "prefix 목록이 없어 확인할 것도 없습니다. 노드를 Arena 앞쪽에서 따로 받습니다.",
      code: "SkipList::NewNode()",
    };
  });
  push("same", (h, u) => {
    h.cards[4].entries = ["IDBE|1003", kv];
    u.cards[4].entries = ["IDBE|1003", kv];
    u.upNodes[kv] = "";
    h.token = null;
    u.token = null;
    h.cards[4].cls = "on";
    u.cards[4].cls = "on";
    h.cap = {
      title: "bucket 안에서 자리를 찾아 넣습니다",
      body: "IDBE|1003 바로 뒤입니다. 직전 삽입 위치(seq_splice_)가 그대로 맞아 탐색을 거의 하지 않습니다.",
      code: "InlineSkipList::Insert (seq_splice_)",
    };
    u.cap = {
      title: "bucket 안에서 자리를 찾아 넣습니다",
      body: "IDBE|1003 바로 뒤입니다. 직전 위치(prev_)를 다시 쓰는 fast-path라 탐색을 거의 하지 않습니다.",
      code: "SkipList::Insert (prev_ fast path)",
    };
  });

  // --- Scene 3: flush reads everything in key order ---
  push("flush", (h, u) => {
    h.ringP = "head";
    h.cap = {
      title: "flush가 total-order iterator를 엽니다",
      body: "PrefixOrderedIterator는 prefix_list_를 가리키는 커서와 bucket을 가리키는 커서 두 개뿐입니다. 아무것도 복사하지 않습니다.",
      code: "GetIterator() → PrefixOrderedIterator",
    };
    u.copyVisible = true;
    u.copyCls = "new";
    u.counter = "복사 0 / 5";
    u.cap = {
      title: "flush가 total-order iterator를 엽니다",
      body: "GetIterator()가 새 Arena와 빈 SkipList를 만듭니다. key 순서로 읽으려면 memtable의 모든 entry를 여기에 다시 넣어야 합니다.",
      code: "GetIterator(): new Arena, new Bucket",
    };
  });
  const emit = (h, prefix, kvName, title, body, code) => {
    h.ringP = prefix;
    h.prefixCls[prefix] = "on";
    h.cards[bucketOf[prefix]].cls = "on";
    h.ringE = { where: "bucket", kv: kvName };
    h.out = [...h.out, kvName];
    h.cap = { title, body, code };
  };
  const copyBucket = (u, idx, title, body) => {
    u.ringSlot = idx;
    u.slot[idx] = "copy";
    u.cards[idx].cls = "copy";
    for (const e of u.cards[idx].entries) u.copy = sortedInsert(u.copy, e);
    u.counter = `복사 ${u.copy.length} / 5`;
    u.copyCls = "copy";
    u.cap = { title, body, code: "for (i = 0; i < bucket_size_; ++i) list->Insert(itr.key())" };
  };
  push("flush", (h, u) => {
    emit(h, "EBKR|", "EBKR|1004", "첫 prefix의 bucket으로",
      "SeekToFirst(): prefix_list_의 첫 prefix EBKR|를 보고 그 bucket(6)으로 가서 첫 entry를 내보냅니다.",
      "prefix_iter_.SeekToFirst() → bucket_iter_");
    copyBucket(u, 1, "bucket을 0번부터 전부 훑습니다",
      "buckets_를 0번부터 끝까지 봅니다(실제로는 100만 칸). bucket 1의 MME| entry를 새 SkipList에 하나씩 정렬 삽입합니다.");
  });
  push("flush", (h, u) => {
    emit(h, "IDBE|", "IDBE|1003", "bucket 경계를 넘습니다",
      "bucket 6에 EBKR|가 더 없으면 prefix_iter_.Next()로 다음 prefix IDBE|로 넘어가 bucket 4를 읽습니다. hash 순서가 아니라 prefix_list_ 순서로 bucket을 옮겨 다닙니다.",
      "Next(): bucket_iter_.Next() → prefix_iter_.Next()");
    copyBucket(u, 4, "정렬 위치에 끼워 넣습니다",
      "bucket 4의 IDBE| entry는 MME|보다 앞이라 그 앞자리에 들어갑니다. 넣을 때마다 새 SkipList를 탐색하므로 전체가 O(n log n)입니다.");
  });
  push("flush", (h, u) => {
    emit(h, "IDBE|", "IDBE|1007", "같은 prefix 안에서는 그대로 다음",
      "아직 IDBE| 그룹이라 bucket_iter_.Next()만 합니다.",
      "bucket_iter_.Next()");
    copyBucket(u, 6, "memtable 전체가 한 벌 더 생깁니다",
      "bucket 6까지 복사하면 5개 entry가 모두 두 번 저장됩니다. 200만 건이면 이 복사에만 약 0.3초가 걸리고 메모리도 그만큼 더 씁니다.");
  });
  push("flush", (h, u) => {
    emit(h, "MME|", "MME|1002", "다시 경계를 넘습니다",
      "hash 순서로는 bucket 1이 가장 앞이지만 prefix_list_ 순서대로 MME|를 마지막에 읽습니다. 그래서 출력이 key 순서입니다.",
      "prefix_iter_.Next()");
    u.ringSlot = null;
    u.copyCls = "copy";
    u.ringE = { where: "copy", kv: u.copy[0] };
    u.out = u.copy.slice(0, 4);
    u.cap = {
      title: "이제서야 복사본을 읽습니다",
      body: "복사가 끝나야 처음부터 순서대로 내보낼 수 있습니다. 여기까지 온 시간이 range scan마다, flush마다 그대로 듭니다.",
      code: "Iterator(list).SeekToFirst(); Next()",
    };
  });
  push("flush", (h, u) => {
    emit(h, "MME|", "MME|1009", "끝: 복사 없이 key 순서",
      "5개 entry를 key 순서대로 내보냈습니다. prefix_list_와 bucket을 오가기만 하고 추가 메모리를 쓰지 않았습니다.",
      "Valid() == false");
    u.out = [...u.copy];
    u.ringE = { where: "copy", kv: u.copy[4] };
    u.copyCls = "dim";
    u.cap = {
      title: "끝: 복사본은 버립니다",
      body: "iterator를 닫으면 복사본과 새 Arena를 버립니다. 결과 순서는 HEAD와 같지만, iterator를 열 때마다 이 복사를 처음부터 다시 합니다.",
      code: "~Iterator(): delete list, delete arena",
    };
  });

  // --- Scene 4: range queries on the loaded memtable (puts skipped) ---
  const resetReads = (s) => {
    s.out = [];
    s.copy = [];
    s.copyVisible = false;
    s.copyCls = "";
    s.counter = null;
    s.ringP = null;
    s.ringE = null;
    s.tokens = [];
  };
  const readEntry = (s, kv) => {
    s.ringE = { where: "bucket", kv };
    s.entryCls[kv] = "on";
    if (!s.isHead) s.upNodes[kv] = "on";
    s.out = [...s.out, kv];
  };
  push("range", (h, u) => {
    for (const s of [h, u]) {
      resetReads(s);
      s.tokens = [{ kv: "IDBE|1000", at: under("hash", s.isHead), from: { x: -140, y: ROW.lane }, label: "Seek" }];
      s.stage = "hash";
      s.slot[4] = "hit";
      s.cards[4].cls = "on";
      s.cap = {
        title: "prefix scan: Seek(IDBE|1000)",
        body: "prefix_same_as_start로 IDBE| 종목 안만 읽습니다. 같은 prefix만 보면 되므로 prefix_list_를 쓰지 않고 Transform과 hash로 bucket 4를 바로 찾습니다. 여기까지는 두 구현이 같습니다.",
        code: "DynamicIterator::Seek → GetBucket(prefix) → bucket Seek",
      };
    }
  });
  push("range", (h, u) => {
    for (const s of [h, u]) {
      s.tokens = [];
      s.cards[4].cls = "on";
      readEntry(s, "IDBE|1003");
    }
    h.cap = {
      title: "entry 하나 = 한 곳",
      body: "노드 안에 key와 value가 붙어 있어, 노드를 읽으면 비교하고 값을 돌려줄 것이 이미 손에 있습니다.",
      code: "InlineSkipList::Iterator::Seek / key()",
    };
    u.cap = {
      title: "entry 하나 = 멀리 떨어진 두 곳",
      body: "노드를 읽고, 포인터를 따라 Arena 블록 반대편의 key+value를 또 읽습니다. 노드와 key가 다른 4KB 페이지라 entry마다 TLB와 캐시 미스가 한 번씩 더 납니다.",
      code: "SkipList::Iterator::key() → *node->key",
    };
  });
  push("range", (h, u) => {
    for (const s of [h, u]) {
      s.cards[4].cls = "on";
      readEntry(s, "IDBE|1007");
    }
    h.cap = {
      title: "prefix가 끝나면 멈춥니다",
      body: "IDBE| 다음 entry가 없어 scan이 끝납니다. 서버 실측(200만 건, scan마다 약 91개): p50 18.2µs, dTLB 미스 entry당 약 1.2번.",
      code: "Next() → prefix 경계에서 Valid() == false",
    };
    u.cap = {
      title: "prefix가 끝나면 멈춥니다",
      body: "결과는 같지만 서버 실측 p50은 28.6µs로 57% 느립니다. 명령어 수는 같고 dTLB 미스가 entry당 약 2.2번입니다. key 할당 위치만 노드 옆으로 옮기면 19.9µs까지 줄었습니다.",
      code: "experiments/prefix_scan_layout.md",
    };
  });
  push("range", (h, u) => {
    for (const s of [h, u]) {
      resetReads(s);
      s.tokens = [{ kv: "IDBE|1005", at: under("transform", s.isHead), from: { x: -140, y: ROW.lane }, label: "Seek" }];
      s.stage = "transform";
    }
    h.ringP = "IDBE|";
    h.prefixCls["IDBE|"] = "on";
    h.cap = {
      title: "total-order scan: Seek(IDBE|1005)",
      body: "total_order_seek로 종목을 넘어 key 순서대로 3개를 읽습니다. PrefixOrderedIterator가 prefix_list_에서 IDBE|를 찾아 그 bucket으로 갑니다. 복사는 없습니다.",
      code: "PrefixOrderedIterator::Seek → prefix_iter_.Seek(IDBE|)",
    };
    u.copyVisible = true;
    u.copyCls = "copy";
    u.copy = ["EBKR|1004", "IDBE|1003", "IDBE|1007", "MME|1002", "MME|1009"];
    u.counter = "복사 5 / 5";
    u.cap = {
      title: "total-order scan: 먼저 전부 복사",
      body: "iterator를 여는 순간 GetIterator()가 memtable 전체를 새 SkipList로 복사합니다. 3개만 읽을 건데도 모든 entry를 옮깁니다. 200만 건이면 scan 한 번에 약 0.3초입니다.",
      code: "GetIterator(): new Bucket + 전체 Insert",
    };
  });
  push("range", (h, u) => {
    h.tokens = [];
    h.ringP = "IDBE|";
    h.prefixCls["IDBE|"] = "on";
    h.cards[4].cls = "on";
    readEntry(h, "IDBE|1007");
    h.cap = {
      title: "bucket 안에서 Seek",
      body: "bucket 4에서 IDBE|1005 이상인 첫 entry인 IDBE|1007에 섭니다.",
      code: "bucket_iter_.Seek(IDBE|1005)",
    };
    u.tokens = [];
    u.copyCls = "copy";
    u.ringE = { where: "copy", kv: "IDBE|1007" };
    u.out = ["IDBE|1007"];
    u.cap = {
      title: "복사본에서 Seek",
      body: "복사가 끝난 뒤에야 새 SkipList에서 IDBE|1005를 찾습니다.",
      code: "Iterator(list).Seek(IDBE|1005)",
    };
  });
  push("range", (h, u) => {
    h.ringP = "MME|";
    h.prefixCls["MME|"] = "on";
    h.cards[1].cls = "on";
    readEntry(h, "MME|1002");
    h.cap = {
      title: "bucket 경계를 넘습니다",
      body: "IDBE| 그룹이 끝나면 prefix_iter_.Next()로 MME|로 넘어가 bucket 1을 읽습니다. 종목을 넘는 range query도 복사 없이 이어집니다.",
      code: "Next(): prefix_iter_.Next() → bucket_iter_",
    };
    u.copyCls = "copy";
    u.ringE = { where: "copy", kv: "MME|1002" };
    u.out = ["IDBE|1007", "MME|1002"];
    u.cap = {
      title: "복사본을 따라 읽습니다",
      body: "복사본은 하나의 정렬된 리스트라 경계 없이 다음으로 갑니다. 대신 그 리스트를 만드는 데 이미 전체 복사를 치렀습니다.",
      code: "Next()",
    };
  });
  push("range", (h, u) => {
    h.ringP = "MME|";
    h.prefixCls["MME|"] = "on";
    h.cards[1].cls = "on";
    readEntry(h, "MME|1009");
    h.cap = {
      title: "3개 읽고 끝",
      body: "서버 실측(200만 건, scan마다 100개): total-order scan p50 19.6µs. SKIPLIST(19.1µs)와 같은 수준입니다.",
      code: "3 entries, 복사 0",
    };
    u.ringE = { where: "copy", kv: "MME|1009" };
    u.out = ["IDBE|1007", "MME|1002", "MME|1009"];
    u.copyCls = "dim";
    u.cap = {
      title: "3개 읽고 복사본은 버립니다",
      body: "서버 실측 p50 308ms, HEAD보다 약 15,700배 느립니다. 8초 동안 26번밖에 못 했습니다. 다음 scan도 처음부터 다시 복사합니다.",
      code: "~Iterator(): delete list, delete arena",
    };
  });

  // --- Scene 5: three writer threads at once ---
  const threads = [
    { label: "T1", kv: "MME|1011", idx: 1 },
    { label: "T2", kv: "EBKR|1012", idx: 6 },
    { label: "T3", kv: "EBKR|1013", idx: 6 },
  ];
  const lanePos = (i, isHead) => ({ x: 24 + i * (isHead ? 112 : 92), y: ROW.under });
  push("mt", (h, u) => {
    for (const s of [h, u]) {
      resetReads(s);
      s.stage = "alloc";
      s.tokens = threads.map((t, i) => ({ kv: t.kv, at: lanePos(i, s.isHead), from: { x: -140, y: ROW.lane }, label: t.label }));
      s.cap = {
        title: "스레드 3개가 동시에 Put",
        body: "T1은 MME|, T2와 T3는 둘 다 EBKR|입니다. RocksDB는 동시에 들어온 쓰기를 쓰기 그룹으로 묶고 sequence 번호를 나눠 줍니다.",
        code: "WriteThread::JoinBatchGroup",
      };
    }
    h.cap.body += " HEAD는 IsInsertConcurrentlySupported()가 true라 allow_concurrent_memtable_write가 켜집니다.";
    u.cap.body += " UPSTREAM은 동시 삽입을 지원하지 않아 이 옵션이 꺼집니다.";
  });
  push("mt", (h, u) => {
    h.tokens = threads.map((t, i) => ({
      kv: t.kv, label: t.label,
      at: { x: t.idx === 1 ? cardX(1) + 6 : (i === 1 ? 410 : 520), y: ROW.under },
    }));
    h.slot[1] = "hit";
    h.slot[6] = "hit";
    h.cap = {
      title: "각 스레드가 자기 KV를 직접 넣으러 갑니다",
      body: "쓰기 그룹이 둘 이상이면 LaunchParallelMemTableWriters로 모든 스레드가 동시에 memtable에 씁니다. 세 토큰이 함께 움직입니다.",
      code: "LaunchParallelMemTableWriters → InsertConcurrently()",
    };
    u.tokens = threads.map((t, i) => ({
      kv: t.kv, label: i === 0 ? "T1 리더" : `${t.label} 대기`,
      at: { x: i === 0 ? 330 : 330 - i * 92, y: ROW.under },
    }));
    u.stage = "hash";
    u.cap = {
      title: "리더 한 스레드가 모두 넣습니다",
      body: "동시 쓰기가 꺼져 있으면 쓰기 그룹의 리더(T1)가 T2와 T3의 batch까지 모아 혼자 차례로 넣습니다. T2와 T3는 끝날 때까지 기다립니다.",
      code: "WriteBatchInternal::InsertInto(write_group) (리더 혼자)",
    };
  });
  push("mt", (h, u) => {
    h.tokens = [];
    h.cards[1].entries = [...h.cards[1].entries, "MME|1011"];
    h.cards[6].entries = [...h.cards[6].entries, "EBKR|1012", "EBKR|1013"];
    for (const t of threads) h.entryCls[t.kv] = "new";
    h.cards[1].cls = "on";
    h.cards[6].cls = "on";
    h.cap = {
      title: "세 개가 한 번에 들어갑니다",
      body: "다른 bucket(1, 6)은 서로 부딪히지 않습니다. 같은 bucket 6에 들어가는 T2와 T3는 InlineSkipList::InsertConcurrently()가 레벨마다 CAS로 링크를 겁니다. 실패하면 그 레벨만 다시 찾습니다.",
      code: "bucket->list.InsertConcurrently(key)",
    };
    u.tokens = threads.slice(1).map((t, i) => ({ kv: t.kv, label: `${t.label} 대기`, at: { x: 330 - (i + 1) * 92, y: ROW.under } }));
    u.cards[1].entries = [...u.cards[1].entries, "MME|1011"];
    u.entryCls["MME|1011"] = "new";
    u.upNodes["MME|1011"] = "new";
    u.cards[1].cls = "on";
    u.cap = {
      title: "리더가 첫 번째를 넣습니다",
      body: "T1이 자기 KV를 bucket 1에 넣습니다. T2와 T3는 아직 기다립니다.",
      code: "bucket->Insert(key)  (T1)",
    };
  });
  push("mt", (h, u) => {
    h.cap = {
      title: "그 사이 다음 쓰기를 받습니다",
      body: "HEAD의 세 스레드는 이미 끝나 다음 Put을 받습니다. 서버 실측(소비자 4개, 계좌 key, 800만 건): 62.9만 ops/s, Put p99 9.9µs.",
      code: "62.9만 ops/s",
    };
    u.tokens = [{ kv: "EBKR|1013", label: "T3 대기", at: { x: 330 - 92, y: ROW.under } }];
    u.cards[6].entries = [...u.cards[6].entries, "EBKR|1012"];
    u.entryCls["EBKR|1012"] = "new";
    u.upNodes["EBKR|1012"] = "new";
    u.cards[6].cls = "on";
    u.cap = {
      title: "리더가 T2 몫을 넣습니다",
      body: "T1이 T2의 KV를 대신 넣습니다. 삽입은 한 번에 하나뿐입니다.",
      code: "bucket->Insert(key)  (T1이 T2 대신)",
    };
  });
  push("mt", (h, u) => {
    h.cap = {
      title: "동시 쓰기가 처리량으로 이어집니다",
      body: "같은 조건에서 UPSTREAM보다 처리량이 71% 높고 p99 지연은 절반입니다. 동시 삽입은 SkipList에 없고 InlineSkipList에만 있는 기능이라, bucket을 InlineSkipList로 바꾼 것이 이 결과의 바탕입니다.",
      code: "+71% ops/s",
    };
    u.tokens = [];
    u.cards[6].entries = [...u.cards[6].entries, "EBKR|1013"];
    u.entryCls["EBKR|1013"] = "new";
    u.upNodes["EBKR|1013"] = "new";
    u.cards[6].cls = "on";
    u.cap = {
      title: "이제야 셋 다 끝났습니다",
      body: "서버 실측: 36.8만 ops/s, Put p99 20.1µs. 기다리는 스레드도 리더를 기다리며 돌기 때문에 CPU는 400%를 다 쓰지만 처리량은 늘지 않습니다.",
      code: "36.8만 ops/s",
    };
  });
  return steps;
}

// ---------- rendering ----------
function specsFor(s) {
  const out = [];
  const add = (o) => out.push(o);
  const head = s.isHead;

  // labels
  add({ key: "lbl-lane", layer: 0, kind: "text", x: 24, y: 16, text: "들어오는 KV", cls: "lbl" });
  add({ key: "lbl-chain", layer: 0, kind: "text", x: 24, y: ROW.chain - 10,
    text: head ? "prefix_list_  정렬된 InlineSkipList" : (s.copyVisible ? "flush용 복사본 SkipList  (flush 때마다 새로 만듦)" : "prefix 목록 없음"),
    cls: "lbl" });
  add({ key: "lbl-slots", layer: 0, kind: "text", x: 24, y: ROW.slots - 8, text: "buckets_  hash 순서 (실제 N = 100만)", cls: "lbl" });
  add({ key: "lbl-out", layer: 0, kind: "text", x: 24, y: ROW.out - 10, text: "flush 출력  SST에 쓰는 순서", cls: "lbl" });

  for (const [id, b] of Object.entries(STAGE)) {
    add({
      key: `stage-${id}`, layer: 0, kind: "box", x: b.x, y: b.y, w: b.w, h: b.h,
      text: b.t1,
      text2: id === "alloc" ? (head ? "노드+key 한 덩어리" : "key 버퍼만 (뒤쪽)") : b.t2,
      cls: s.stage === id ? "on" : "",
    });
  }
  for (let i = 0; i < 8; i++) {
    add({ key: `slot-${i}`, layer: 0, kind: "slot", x: slotX(i), y: ROW.slots, w: SLOT_W, h: 28,
      text: String(i), cls: s.slot[i] || "" });
  }

  // buckets
  for (const [idxStr, c] of Object.entries(s.cards)) {
    const idx = Number(idxStr);
    const waiting = !head && s.token && s.upNodes[s.token.kv] !== undefined
      && bucketOf[prefixOf(s.token.kv)] === idx && !c.entries.includes(s.token.kv) ? 1 : 0;
    const h = 32 + Math.max(1, c.entries.length + waiting) * 34 + 4;
    add({
      key: `card-${idx}`, layer: 0, kind: "card", x: cardX(idx), y: ROW.card, w: CARD_W, h,
      text: head ? `known: ${c.known || "—"}` : "SkipList",
      cls: c.cls,
      wire: { x: slotX(idx) + SLOT_W / 2 - cardX(idx), y1: -(ROW.card - ROW.slots - 28), y2: 0 },
    });
    c.entries.forEach((kv, i) => {
      const y = ROW.card + 32 + i * 34;
      if (head) {
        add({ key: `kv-${kv}`, layer: 1, kind: "chip", x: cardX(idx) + 6, y, w: HEAD_CHIP_W, h: 28, text: kv, dot: true,
          cls: `chip ${s.entryCls[kv] || ""}` });
      } else {
        add({ key: `kv-${kv}`, layer: 1, kind: "chip", x: cardX(idx) + 24, y, w: UP_KEY_W, h: 28, text: kv, small: true,
          cls: `chip ${s.entryCls[kv] || ""}` });
      }
    });
  }
  if (!head) {
    for (const [idxStr, c] of Object.entries(s.cards)) {
      const idx = Number(idxStr);
      const pending = s.token && s.upNodes[s.token.kv] !== undefined && bucketOf[prefixOf(s.token.kv)] === idx
        ? [s.token.kv] : [];
      [...c.entries, ...pending.filter((k) => !c.entries.includes(k))].forEach((kv, i) => {
        if (!c.entries.includes(kv) && s.upNodes[kv] === undefined) return;
        add({ key: `node-${kv}`, layer: 1, kind: "upnode", x: cardX(idx) + 6, y: ROW.card + 40 + i * 34,
          cls: s.upNodes[kv] || "", far: c.entries.includes(kv) ? 18 : null });
      });
    }
  }

  // HEAD prefix_list_
  if (head) {
    add({ key: "pl-head", layer: 0, kind: "box", x: 24, y: ROW.chain, w: 52, h: 30, text: "head",
      cls: s.chainDim ? "dim" : "" });
    s.prefixes.forEach((p, i) => {
      add({ key: `pl-${p}`, layer: 0, kind: "chip", x: CHAIN_X(i), y: ROW.chain, w: 100, h: 30, text: p, arrow: true,
        cls: `${s.prefixCls[p] || ""} ${s.chainDim ? "dim" : ""}` });
    });
  } else if (s.copyVisible) {
    if (!s.copy.length) {
      add({ key: "copy-empty", layer: 0, kind: "box", x: 24, y: ROW.chain, w: 160, h: 30, text: "빈 SkipList", cls: "new" });
    }
    s.copy.forEach((kv, i) => {
      const src = Object.entries(s.cards).find(([, c]) => c.entries.includes(kv));
      const srcIdx = src ? Number(src[0]) : 0;
      const srcI = src ? src[1].entries.indexOf(kv) : 0;
      add({ key: `copy-${kv}`, layer: 1, kind: "chip", x: LIST_X(i), y: ROW.chain, w: 108, h: 30, text: kv, arrow: i > 0,
        cls: `chip ${s.copyCls}`, from: { x: cardX(srcIdx) + 24, y: ROW.card + 32 + srcI * 34 } });
    });
    if (s.counter) add({ key: "counter", layer: 2, kind: "text", x: 616, y: ROW.chain - 10, text: s.counter, cls: "counter", anchor: "end" });
  }

  // flush output
  s.out.forEach((kv, i) => {
    let from;
    if (!head && s.copy.includes(kv)) {
      from = { x: LIST_X(s.copy.indexOf(kv)), y: ROW.chain };
    } else {
      // Read straight from its bucket (HEAD always, UPSTREAM prefix scans).
      const idx = bucketOf[prefixOf(kv)];
      const j = s.cards[idx].entries.indexOf(kv);
      from = { x: cardX(idx) + (head ? 6 : 24), y: ROW.card + 32 + j * 34 };
    }
    add({ key: `out-${kv}`, layer: 1, kind: "chip", x: LIST_X(i), y: ROW.out, w: 108, h: 30, text: kv, arrow: i > 0,
      cls: "chip on", from });
  });

  // cursors
  if (s.ringP) {
    const i = s.ringP === "head" ? -1 : s.prefixes.indexOf(s.ringP);
    const x = i < 0 ? 24 : CHAIN_X(i);
    const w = i < 0 ? 52 : 100;
    add({ key: "ring-p", layer: 2, kind: "ring", x: x - 4, y: ROW.chain - 4, w: w + 8, h: 38, cls: "pulse" });
  }
  if (s.ringE) {
    let x; let y; let w;
    if (s.ringE.where === "bucket") {
      const idx = bucketOf[prefixOf(s.ringE.kv)];
      const j = s.cards[idx].entries.indexOf(s.ringE.kv);
      x = cardX(idx) + 6; y = ROW.card + 32 + j * 34; w = HEAD_CHIP_W;
    } else {
      x = LIST_X(s.copy.indexOf(s.ringE.kv)); y = ROW.chain; w = 108;
    }
    add({ key: "ring-e", layer: 2, kind: "ring", x: x - 4, y: y - 4, w: w + 8, h: 36, cls: "" });
  }
  if (s.ringSlot != null) {
    add({ key: "ring-slot", layer: 2, kind: "ring", x: slotX(s.ringSlot) - 4, y: ROW.slots - 4, w: SLOT_W + 8, h: 36, cls: "pulse copyring" });
  }

  // several travelling tokens, each with a small label above it
  for (const t of s.tokens || []) {
    add({
      key: `kv-${t.kv}`, layer: 3, kind: "chip", x: t.at.x, y: t.at.y,
      w: head ? HEAD_CHIP_W : UP_KEY_W, h: 28, text: t.kv, dot: head, small: !head,
      cls: "chip token", from: t.from,
    });
    if (t.label) {
      add({ key: `tl-${t.kv}`, layer: 3, kind: "text", x: t.at.x + 2, y: t.at.y - 5, text: t.label, cls: "thread",
        from: t.from ? { x: t.from.x + 2, y: t.from.y - 5 } : undefined });
    }
  }

  // travelling token
  if (s.token) {
    add({
      key: `kv-${s.token.kv}`, layer: 3, kind: "chip", x: s.token.at.x, y: s.token.at.y,
      w: head ? HEAD_CHIP_W : UP_KEY_W, h: 28, text: s.token.kv, dot: head, small: !head,
      cls: "chip token", from: s.token.from,
    });
  }
  return out;
}

function el(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function build(spec) {
  const g = el("g");
  g.dataset.kind = spec.kind;
  if (spec.kind === "text") {
    const t = el("text", { x: 0, y: 0 });
    if (spec.anchor) t.setAttribute("text-anchor", spec.anchor);
    g.append(t);
    return g;
  }
  if (spec.kind === "ring") {
    g.append(el("rect", { rx: 9 }));
    return g;
  }
  if (spec.kind === "upnode") {
    g.classList.add("upnode");
    g.append(el("rect", { x: 0, y: 0, width: 12, height: 12, rx: 2 }));
    g.append(el("line", { class: "upline", x1: 12, y1: 6, x2: 18, y2: 6 }));
    return g;
  }
  const r = el("rect", { class: "box", rx: spec.kind === "slot" ? 5 : 8 });
  g.append(r);
  if (spec.kind === "card") {
    g.append(el("line", { class: "wire" }));
    g.append(el("text", { class: "known", x: 8, y: 18 }));
    return g;
  }
  if (spec.kind === "chip") {
    g.append(el("line", { class: "wire", x1: -12, x2: -2 }));
    g.append(el("path", { class: "wire", d: "" }));
  }
  if (spec.dot) g.append(el("circle", { class: "node", r: 4 }));
  g.append(el("text", { class: "t1" }));
  if (spec.kind === "box") g.append(el("text", { class: "t2 lbl" }));
  return g;
}

function update(g, s) {
  g.setAttribute("class", `k ${s.kind} ${s.cls || ""}`.trim());
  if (s.kind === "upnode") g.classList.add("upnode");
  if (s.kind === "text") {
    const t = g.querySelector("text");
    t.textContent = s.text;
    t.setAttribute("class", s.cls || "");
    return;
  }
  if (s.kind === "ring") {
    const r = g.querySelector("rect");
    r.setAttribute("width", s.w);
    r.setAttribute("height", s.h);
    return;
  }
  if (s.kind === "upnode") {
    const line = g.querySelector("line");
    line.setAttribute("x2", s.far != null ? s.far : 12);
    return;
  }
  const r = g.querySelector("rect.box");
  r.setAttribute("width", s.w);
  r.style.height = `${s.h}px`;
  if (!r.getAttribute("height")) r.setAttribute("height", s.h);
  if (s.kind === "card") {
    const wire = g.querySelector("line.wire");
    wire.setAttribute("x1", s.wire.x);
    wire.setAttribute("x2", s.wire.x);
    wire.setAttribute("y1", s.wire.y1);
    wire.setAttribute("y2", s.wire.y2);
    g.querySelector("text.known").textContent = s.text;
    return;
  }
  const lines = g.querySelectorAll(".wire");
  if (lines.length) {
    lines[0].setAttribute("y1", s.h / 2);
    lines[0].setAttribute("y2", s.h / 2);
    lines[1].setAttribute("d", `M-6 ${s.h / 2 - 4} L-2 ${s.h / 2} L-6 ${s.h / 2 + 4}`);
    for (const l of lines) l.style.display = s.arrow ? "" : "none";
  }
  const dot = g.querySelector("circle.node");
  if (dot) { dot.setAttribute("cx", 11); dot.setAttribute("cy", s.h / 2); }
  const t1 = g.querySelector("text.t1");
  t1.textContent = s.text;
  if (s.kind === "slot") {
    t1.setAttribute("x", s.w / 2);
    t1.setAttribute("text-anchor", "middle");
    t1.setAttribute("y", s.h / 2 + 4);
  } else if (s.kind === "box") {
    t1.setAttribute("x", 12);
    t1.setAttribute("y", s.text2 ? s.h / 2 - 3 : s.h / 2 + 4);
    const t2 = g.querySelector("text.t2");
    t2.textContent = s.text2 || "";
    t2.setAttribute("x", 12);
    t2.setAttribute("y", s.h / 2 + 13);
  } else {
    t1.setAttribute("x", s.dot ? 22 : 10);
    t1.setAttribute("y", s.h / 2 + 4);
    t1.style.fontSize = s.small ? "11px" : "";
  }
}

const place = (g, x, y) => { g.style.transform = `translate(${x}px, ${y}px)`; };

class Diagram {
  constructor(svg) {
    this.svg = svg;
    this.layers = [0, 1, 2, 3].map(() => {
      const g = el("g");
      svg.append(g);
      return g;
    });
    this.nodes = new Map();
  }

  render(specs) {
    const seen = new Set();
    for (const s of specs) {
      seen.add(s.key);
      let g = this.nodes.get(s.key);
      if (g && g.dataset.kind !== s.kind) {
        g.remove();
        g = null;
      }
      if (!g) {
        g = build(s);
        update(g, s);
        const from = s.from || { x: s.x, y: s.y };
        g.classList.add("enter");
        g.style.transition = "none";
        place(g, from.x, from.y);
        this.layers[s.layer || 0].append(g);
        this.nodes.set(s.key, g);
        g.getBoundingClientRect();
        g.style.transition = "";
        requestAnimationFrame(() => g.classList.remove("enter"));
      }
      update(g, s);
      // The token keeps its layer while it travels; entries it becomes move up.
      if (g.parentNode !== this.layers[s.layer || 0] && s.layer === 3) this.layers[3].append(g);
      place(g, s.x, s.y);
    }
    for (const [key, g] of this.nodes) {
      if (seen.has(key)) continue;
      this.nodes.delete(key);
      g.classList.add("leave");
      setTimeout(() => g.remove(), 450);
    }
  }
}

// ---------- player ----------
const steps = buildSteps();
const sides = {
  head: { diagram: new Diagram(document.querySelector('[data-side="head"] svg')), root: document.querySelector('[data-side="head"]') },
  up: { diagram: new Diagram(document.querySelector('[data-side="up"] svg')), root: document.querySelector('[data-side="up"]') },
};
const player = document.querySelector(".player");
const stepno = document.querySelector(".stepno");
const timeline = document.querySelector(".timeline");
const scenesBox = document.querySelector(".scenes");
let current = 0;
let playing = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let speed = 1;
let timer = null;

const sceneStart = (id) => steps.findIndex((s) => s.scene === id);

SCENES.forEach((sc) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "scene";
  b.setAttribute("role", "tab");
  b.dataset.scene = sc.id;
  b.textContent = sc.title;
  b.addEventListener("click", () => go(sceneStart(sc.id), true));
  scenesBox.append(b);
});
steps.forEach((st, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.title = `${i + 1}단계`;
  if (i === 0 || steps[i - 1].scene !== st.scene) b.classList.add("scene-start");
  b.addEventListener("click", () => go(i, true));
  timeline.append(b);
});

function show(i) {
  const st = steps[i];
  for (const key of ["head", "up"]) {
    const s = st.world[key];
    sides[key].diagram.render(specsFor(s));
    const cap = sides[key].root.querySelector(".caption");
    cap.querySelector(".cap-title").textContent = s.cap.title;
    cap.querySelector(".cap-body").textContent = s.cap.body;
    cap.querySelector(".cap-code").textContent = s.cap.code;
  }
  const scene = SCENES.find((x) => x.id === st.scene);
  const inScene = steps.filter((x) => x.scene === st.scene);
  const pos = inScene.indexOf(st) + 1;
  stepno.textContent = `${scene.title}  ${pos} / ${inScene.length}단계  (전체 ${i + 1} / ${steps.length})`;
  scenesBox.querySelectorAll(".scene").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.scene === st.scene)));
  [...timeline.children].forEach((b, j) => {
    b.classList.toggle("now", j === i);
    b.classList.toggle("done", j < i);
  });
}

function schedule() {
  clearTimeout(timer);
  if (!playing) return;
  const last = current === steps.length - 1;
  timer = setTimeout(() => {
    // After the last step, start over from the initial memtable.
    go(last ? 0 : current + 1, false, last);
  }, (last ? 2 : 1) * BASE_STEP_MS / speed);
}

function go(i, user = false, restart = false) {
  const target = Math.max(0, Math.min(steps.length - 1, i));
  // Jumping backwards past a scene start or restarting redraws from scratch,
  // so removed KVs do not fly back in from odd places.
  if (restart || target < current - 1) {
    for (const s of Object.values(sides)) {
      s.diagram.nodes.forEach((g) => g.remove());
      s.diagram.nodes.clear();
    }
  }
  current = target;
  show(current);
  if (user) clearTimeout(timer);
  schedule();
}

function setPlaying(on) {
  playing = on;
  player.classList.toggle("paused", !on);
  player.querySelector(".ctl-play").setAttribute("aria-label", on ? "일시정지" : "재생");
  schedule();
}

player.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (act) {
    const a = act.dataset.act;
    if (a === "play") setPlaying(!playing);
    if (a === "next") go(current + 1, true);
    if (a === "prev") go(current - 1, true);
    if (a === "restart") go(0, true, true);
    return;
  }
  const sp = e.target.closest("[data-speed]");
  if (sp) {
    speed = Number(sp.dataset.speed);
    player.querySelectorAll("[data-speed]").forEach((b) => b.setAttribute("aria-pressed", String(b === sp)));
    document.querySelector(".arch-page").style.setProperty("--step-ms", `${900 / speed}ms`);
    schedule();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea")) return;
  if (e.key === "ArrowRight") go(current + 1, true);
  if (e.key === "ArrowLeft") go(current - 1, true);
  if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
});

setPlaying(playing);
go(0);
