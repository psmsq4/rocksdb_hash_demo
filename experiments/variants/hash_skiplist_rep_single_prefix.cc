//  Copyright (c) 2011-present, Facebook, Inc.  All rights reserved.
//  This source code is licensed under both the GPLv2 (found in the
//  COPYING file in the root directory) and Apache 2.0 License
//  (found in the LICENSE.Apache file in the root directory).
//

#include <algorithm>
#include <atomic>

#include "db/memtable.h"
#include "memory/arena.h"
#include "memtable/inlineskiplist.h"
#include "port/port.h"
#include "rocksdb/comparator.h"
#include "rocksdb/memtablerep.h"
#include "rocksdb/slice.h"
#include "rocksdb/slice_transform.h"
#include "rocksdb/utilities/options_type.h"
#include "util/murmurhash.h"

namespace ROCKSDB_NAMESPACE {
namespace {

// Compares the entries of HashSkipListRep's prefix list, each a
// length-prefixed prefix, with the column family's user comparator.
class PrefixComparator : public MemTableRep::KeyComparator {
 public:
  explicit PrefixComparator(const Comparator* ucmp) : ucmp_(ucmp) {}

  const Comparator* user_comparator() const override { return ucmp_; }

  int operator()(const char* prefix_len_key1,
                 const char* prefix_len_key2) const override {
    return ucmp_->Compare(GetLengthPrefixedSlice(prefix_len_key1),
                          GetLengthPrefixedSlice(prefix_len_key2));
  }

  int operator()(const char* prefix_len_key,
                 const DecodedType& key) const override {
    return ucmp_->Compare(GetLengthPrefixedSlice(prefix_len_key), key);
  }

 private:
  const Comparator* const ucmp_;
};

class HashSkipListRep : public MemTableRep {
 public:
  HashSkipListRep(const MemTableRep::KeyComparator& compare,
                  Allocator* allocator, const SliceTransform* transform,
                  size_t bucket_size, int32_t skiplist_height,
                  int32_t skiplist_branching_factor);

  KeyHandle Allocate(const size_t len, char** buf) override;

  void Insert(KeyHandle handle) override;

  void InsertConcurrently(KeyHandle handle) override;

  bool Contains(const char* key) const override;

  size_t ApproximateMemoryUsage() override;

  void Get(const LookupKey& k, void* callback_args,
           bool (*callback_func)(void* arg, const char* entry)) override;

  ~HashSkipListRep() override;

  MemTableRep::Iterator* GetIterator(Arena* arena = nullptr) override;

  MemTableRep::Iterator* GetDynamicPrefixIterator(
      Arena* arena = nullptr) override;

 private:
  friend class DynamicIterator;
  using Bucket = InlineSkipList<const MemTableRep::KeyComparator&>;
  using PrefixList = InlineSkipList<const PrefixComparator&>;

  // A bucket and what is known about the prefixes of its keys. Most buckets
  // hold a single prefix, the one of the key that created the bucket. Then
  // inserts need not search prefix_list_, and the total order iterator need
  // not compare the prefix of every entry to find where the group ends.
  struct HashBucket {
    HashBucket(const MemTableRep::KeyComparator& compare, Allocator* allocator,
               int32_t height, int32_t branching_factor, const char* owner)
        : list(compare, allocator, height, branching_factor),
          owner_prefix(owner) {}

    Bucket list;
    // prefix_list_ entry of the prefix of the key that created the bucket,
    // added to prefix_list_ before the bucket is published.
    const char* const owner_prefix;
    // Set before the first key with another prefix goes into the bucket.
    std::atomic<bool> mixed{false};
    // prefix_list_ entry of the non-owner prefix last added for the bucket.
    // Set only after the prefix is in prefix_list_.
    std::atomic<const char*> known_prefix{nullptr};
  };

  size_t bucket_size_;

  const int32_t skiplist_height_;
  const int32_t skiplist_branching_factor_;

  // Maps slices (which are transformed user keys) to buckets of keys sharing
  // the same transform.
  std::atomic<HashBucket*>* buckets_;

  // The user-supplied transform whose domain is the user keys.
  const SliceTransform* transform_;

  const MemTableRep::KeyComparator& compare_;
  // immutable after construction
  Allocator* const allocator_;

  // InlineSkipList stores each key inline with its node, so an entry has to be
  // allocated as a node before MemTable encodes it. The bucket is not known at
  // that point because it depends on the key. The node layout only depends on
  // the allocator and the height settings, which all buckets share, so nodes
  // are allocated through this list and later inserted into their bucket.
  // Nothing is ever inserted into this list itself.
  Bucket key_allocator_;

  // Orders prefix_list_ with the user comparator, so that the order of the
  // prefixes is the order of the key groups sharing them.
  const PrefixComparator prefix_compare_;

  // Lower bound on the max height of prefix_list_. skiplist_height is sized
  // for the keys of one bucket, but prefix_list_ holds every prefix in the
  // memtable, and a skiplist whose height is capped too low degrades to a
  // linear search as it grows. 12 is the skiplist memtable's default.
  static constexpr int32_t kMinPrefixListHeight = 12;

  // Every distinct prefix in the memtable, each stored length-prefixed. Lets
  // the total order iterator visit the buckets prefix by prefix instead of
  // merging all of them.
  PrefixList prefix_list_;

  inline size_t GetHash(const Slice& slice) const {
    return MurmurHash(slice.data(), static_cast<int>(slice.size()), 0) %
           bucket_size_;
  }
  inline HashBucket* GetHashBucket(const Slice& slice) const {
    return buckets_[GetHash(slice)].load(std::memory_order_acquire);
  }
  inline Bucket* GetBucket(const Slice& slice) const {
    HashBucket* bucket = GetHashBucket(slice);
    return bucket == nullptr ? nullptr : &bucket->list;
  }
  // Get a bucket from buckets_. If the bucket hasn't been initialized yet,
  // initialize it, with transformed as its owner prefix, before returning.
  HashBucket* GetInitializedBucket(const Slice& transformed, bool concurrently);

  // Makes sure prefix is in prefix_list_ before a key with it goes into
  // bucket.
  void RegisterPrefix(HashBucket* bucket, const Slice& prefix,
                      bool concurrently);

  // Adds prefix to prefix_list_ if it is not there yet. Returns its entry.
  const char* AddPrefix(const Slice& prefix, bool concurrently);

  class Iterator : public MemTableRep::Iterator {
   public:
    explicit Iterator(Bucket* list, bool own_list = true,
                      Arena* arena = nullptr)
        : list_(list), iter_(list), own_list_(own_list), arena_(arena) {}
    // No copying allowed
    Iterator(const Iterator&) = delete;
    Iterator& operator=(const Iterator&) = delete;
    Iterator(Iterator&&) = delete;
    Iterator& operator=(Iterator&&) = delete;

    ~Iterator() override {
      // if we own the list, we should also delete it
      if (own_list_) {
        assert(list_ != nullptr);
        delete list_;
      }
    }

    // Returns true iff the iterator is positioned at a valid node.
    bool Valid() const override { return list_ != nullptr && iter_.Valid(); }

    // Returns the key at the current position.
    // REQUIRES: Valid()
    const char* key() const override {
      assert(Valid());
      return iter_.key();
    }

    // Advances to the next position.
    // REQUIRES: Valid()
    void Next() override {
      assert(Valid());
      iter_.Next();
    }

    // Advances to the previous position.
    // REQUIRES: Valid()
    void Prev() override {
      assert(Valid());
      iter_.Prev();
    }

    // Advance to the first entry with a key >= target
    void Seek(const Slice& internal_key, const char* memtable_key) override {
      if (list_ != nullptr) {
        const char* encoded_key = (memtable_key != nullptr)
                                      ? memtable_key
                                      : EncodeKey(&tmp_, internal_key);
        iter_.Seek(encoded_key);
      }
    }

    // Retreat to the last entry with a key <= target
    void SeekForPrev(const Slice& /*internal_key*/,
                     const char* /*memtable_key*/) override {
      // not supported
      assert(false);
    }

    // Position at the first entry in collection.
    // Final state of iterator is Valid() iff collection is not empty.
    void SeekToFirst() override {
      if (list_ != nullptr) {
        iter_.SeekToFirst();
      }
    }

    // Position at the last entry in collection.
    // Final state of iterator is Valid() iff collection is not empty.
    void SeekToLast() override {
      if (list_ != nullptr) {
        iter_.SeekToLast();
      }
    }

   protected:
    void Reset(Bucket* list) {
      if (own_list_) {
        assert(list_ != nullptr);
        delete list_;
      }
      list_ = list;
      iter_.SetList(list);
      own_list_ = false;
    }

   private:
    // if list_ is nullptr, we should NEVER call any methods on iter_
    // if list_ is nullptr, this Iterator is not Valid()
    Bucket* list_;
    Bucket::Iterator iter_;
    // here we track if we own list_. If we own it, we are also
    // responsible for it's cleaning. This is a poor man's std::shared_ptr
    bool own_list_;
    std::unique_ptr<Arena> arena_;
    std::string tmp_;  // For passing to EncodeKey
  };

  class DynamicIterator : public HashSkipListRep::Iterator {
   public:
    explicit DynamicIterator(const HashSkipListRep& memtable_rep)
        : HashSkipListRep::Iterator(nullptr, false),
          memtable_rep_(memtable_rep) {}

    // Advance to the first entry with a key >= target
    void Seek(const Slice& k, const char* memtable_key) override {
      auto transformed = memtable_rep_.transform_->Transform(ExtractUserKey(k));
      Reset(memtable_rep_.GetBucket(transformed));
      HashSkipListRep::Iterator::Seek(k, memtable_key);
    }

    // Position at the first entry in collection.
    // Final state of iterator is Valid() iff collection is not empty.
    void SeekToFirst() override {
      // Prefix iterator does not support total order.
      // We simply set the iterator to invalid state
      Reset(nullptr);
    }

    // Position at the last entry in collection.
    // Final state of iterator is Valid() iff collection is not empty.
    void SeekToLast() override {
      // Prefix iterator does not support total order.
      // We simply set the iterator to invalid state
      Reset(nullptr);
    }

   private:
    // the underlying memtable
    const HashSkipListRep& memtable_rep_;
  };

  // Total order iterator. Walks prefix_list_ and, for each prefix, the range
  // of that prefix in its bucket. A bucket may hold several prefixes because
  // of hash collisions, so in such a bucket the iterator moves on where the
  // prefix of the bucket entries changes. A bucket that holds only the
  // current prefix is the whole group, which saves comparing prefixes.
  //
  // Relies on the prefix_extractor contract (see include/rocksdb/options.h):
  // keys sharing a prefix are contiguous in comparator order, with no key
  // outside the domain between them, and prefixes preserve ordering
  // (a <= b implies T(a) <= T(b)), so the order of prefix_list_ is the order
  // of the key groups. The prefix does not have to sort before the keys of its
  // group: the first and last entries of a group are found by searching the
  // bucket for where the prefix changes, which also works with e.g.
  // ReverseBytewiseComparator. User-defined timestamps are not supported,
  // since prefixes, which carry no timestamp, cannot be compared then.
  class PrefixOrderedIterator : public MemTableRep::Iterator {
   public:
    explicit PrefixOrderedIterator(const HashSkipListRep& memtable_rep)
        : memtable_rep_(memtable_rep),
          prefix_iter_(&memtable_rep.prefix_list_),
          bucket_iter_(nullptr) {}

    bool Valid() const override { return valid_; }

    const char* key() const override {
      assert(Valid());
      return bucket_iter_.key();
    }

    void Next() override {
      assert(Valid());
      bucket_iter_.Next();
      if (bucket_iter_.Valid() &&
          (BucketHoldsOnlyCurPrefix() || CompareToCurPrefix() == 0)) {
        return;
      }
      prefix_iter_.Next();
      SettleForward(nullptr);
    }

    void Prev() override {
      assert(Valid());
      bucket_iter_.Prev();
      if (bucket_iter_.Valid() &&
          (BucketHoldsOnlyCurPrefix() || AtCurPrefix())) {
        return;
      }
      prefix_iter_.Prev();
      SettleBackward(nullptr);
    }

    // Advance to the first entry with a key >= target
    void Seek(const Slice& internal_key, const char* memtable_key) override {
      bool in_domain;
      Slice prefix = SeekPrefix(internal_key, &in_domain);
      prefix_iter_.Seek(EncodePrefixListKey(prefix));
      // Seek to the target within the bucket only if the target's own prefix
      // is in the list. Every key of a later prefix is after the target, so
      // there the first key of the prefix is the answer.
      const char* target = nullptr;
      if (!in_domain) {
        BackUpForOutOfDomainSeek(internal_key);
      } else if (prefix_iter_.Valid() && IsCurListPrefix(prefix)) {
        target = (memtable_key != nullptr) ? memtable_key
                                           : EncodeKey(&tmp_, internal_key);
      }
      SettleForward(target);
    }

    // Retreat to the last entry with a key <= target
    void SeekForPrev(const Slice& internal_key,
                     const char* memtable_key) override {
      bool in_domain;
      Slice prefix = SeekPrefix(internal_key, &in_domain);
      prefix_iter_.SeekForPrev(EncodePrefixListKey(prefix));
      const char* target = nullptr;
      if (!in_domain) {
        BackUpForOutOfDomainSeekForPrev(internal_key);
      } else if (prefix_iter_.Valid() && IsCurListPrefix(prefix)) {
        target = (memtable_key != nullptr) ? memtable_key
                                           : EncodeKey(&tmp_, internal_key);
      }
      SettleBackward(target);
    }

    void SeekToFirst() override {
      prefix_iter_.SeekToFirst();
      SettleForward(nullptr);
    }

    void SeekToLast() override {
      prefix_iter_.SeekToLast();
      SettleBackward(nullptr);
    }

   private:
    const Comparator* ucmp() const {
      return memtable_rep_.prefix_compare_.user_comparator();
    }

    Slice CurListPrefix() const {
      return GetLengthPrefixedSlice(prefix_iter_.key());
    }

    // Returns what to search prefix_list_ with for a seek to internal_key.
    // Examples use a 4-byte prefix and prefix_list_ = {"o999", "p001"}.
    //
    // In domain, e.g. Seek("p001x5"): returns the prefix "p001". The "p001"
    // group has keys on both sides of the target, so the caller seeks to the
    // target within the bucket of that prefix.
    //
    // Out of domain, e.g. Seek("p0") in a total order seek: no 4-byte prefix
    // can be extracted, so "p0" itself is returned. No prefix group has keys
    // on both sides of "p0", so the answer is the first key of a group, and
    // with bytewise ordering it is the group prefix_list_.Seek("p0") stops at
    // ("p001"). With other comparators a group whose prefix is less than the
    // target may still be entirely after it, so BackUpForOutOfDomainSeek*()
    // check the first key of the neighboring groups.
    Slice SeekPrefix(const Slice& internal_key, bool* in_domain) const {
      Slice user_key = ExtractUserKey(internal_key);
      *in_domain = memtable_rep_.transform_->InDomain(user_key);
      return *in_domain ? memtable_rep_.transform_->Transform(user_key)
                        : user_key;
    }

    bool IsCurListPrefix(const Slice& prefix) const {
      return ucmp()->Compare(CurListPrefix(), prefix) == 0;
    }

    // Compares the first entry of the group of the prefix at `it` with
    // internal_key and stores the result in *cmp. Returns false if the group
    // has no entry.
    bool CompareGroupFirstKey(const PrefixList::Iterator& it,
                              const Slice& internal_key, int* cmp) const {
      Slice prefix = GetLengthPrefixedSlice(it.key());
      Bucket* bucket = memtable_rep_.GetBucket(prefix);
      if (bucket == nullptr) {
        return false;
      }
      Bucket::Iterator first(bucket);
      first.SeekToFirstNotMatching(
          [&](const char* e) { return ComparePrefixOf(e, prefix) < 0; });
      if (!first.Valid() || ComparePrefixOf(first.key(), prefix) != 0) {
        return false;
      }
      *cmp = memtable_rep_.compare_(first.key(), internal_key);
      return true;
    }

    // Out-of-domain Seek(k): moves prefix_iter_ back over the preceding groups
    // that are entirely >= k. Since no group has keys on both sides of k, the
    // first key of a group tells which side it is on.
    void BackUpForOutOfDomainSeek(const Slice& internal_key) {
      PrefixList::Iterator prev = prefix_iter_;
      if (prev.Valid()) {
        prev.Prev();
      } else {
        prev.SeekToLast();
      }
      int cmp;
      while (prev.Valid()) {
        if (CompareGroupFirstKey(prev, internal_key, &cmp) && cmp < 0) {
          break;  // This group and all before it are < k.
        }
        prefix_iter_ = prev;  // The whole group is >= k (or it is empty).
        prev.Prev();
      }
    }

    // Out-of-domain SeekForPrev(k): moves prefix_iter_ back while its group is
    // entirely > k.
    void BackUpForOutOfDomainSeekForPrev(const Slice& internal_key) {
      int cmp;
      while (prefix_iter_.Valid() &&
             (!CompareGroupFirstKey(prefix_iter_, internal_key, &cmp) ||
              cmp > 0)) {
        prefix_iter_.Prev();
      }
    }

    // Compares the prefix of a bucket entry with prefix.
    int ComparePrefixOf(const char* entry, const Slice& prefix) const {
      Slice user_key = ExtractUserKey(GetLengthPrefixedSlice(entry));
      return ucmp()->Compare(memtable_rep_.transform_->Transform(user_key),
                             prefix);
    }

    int CompareToCurPrefix() const {
      return ComparePrefixOf(bucket_iter_.key(), cur_prefix_);
    }

    // Returns whether bucket_iter_ is at an entry of cur_prefix_. Only used
    // after moving backward from inside the group or after SeekForPrev() to a
    // target in the group, which never land on a later prefix.
    bool AtCurPrefix() const {
      if (!bucket_iter_.Valid()) {
        return false;
      }
      int cmp = CompareToCurPrefix();
      assert(cmp <= 0);
      return cmp == 0;
    }

    // Returns whether every entry of the current bucket has cur_prefix_, so
    // that the group is the whole bucket. Call it after moving bucket_iter_:
    // a key of another prefix goes into the bucket only after the bucket is
    // marked mixed, so if bucket_iter_ reached such a key, the mark is
    // visible here.
    bool BucketHoldsOnlyCurPrefix() const {
      return cur_is_owner_ &&
             !cur_bucket_->mixed.load(std::memory_order_acquire);
    }

    // Makes the prefix at prefix_iter_ the current prefix and points
    // bucket_iter_ to its bucket. Returns false if there is no bucket.
    bool LoadCurPrefixBucket() {
      cur_prefix_ = CurListPrefix();
      cur_bucket_ = memtable_rep_.GetHashBucket(cur_prefix_);
      if (cur_bucket_ == nullptr) {
        return false;
      }
      // prefix_list_ holds one entry per prefix, so the owner prefix is
      // recognized by its entry.
      cur_is_owner_ = prefix_iter_.key() == cur_bucket_->owner_prefix;
      bucket_iter_.SetList(&cur_bucket_->list);
      return true;
    }

    // Starting at prefix_iter_ and moving forward, positions at the first
    // entry of the first prefix that has one. target, if set, applies to the
    // first prefix only.
    void SettleForward(const char* target) {
      for (; prefix_iter_.Valid(); prefix_iter_.Next(), target = nullptr) {
        if (!LoadCurPrefixBucket()) {
          continue;
        }
        if (target != nullptr) {
          bucket_iter_.Seek(target);
        } else {
          bool whole_bucket = false;
          if (cur_is_owner_) {
            bucket_iter_.SeekToFirst();
            whole_bucket = BucketHoldsOnlyCurPrefix();
          }
          if (!whole_bucket) {
            // Prefixes are non-decreasing along the bucket, so
            // "prefix < cur_prefix_" is true for a leading run of entries and
            // false after it. The first entry where it is false starts the
            // group. Searching by the prefix itself would not find it for
            // comparators that sort the prefix after the keys of its group.
            bucket_iter_.SeekToFirstNotMatching([this](const char* e) {
              return ComparePrefixOf(e, cur_prefix_) < 0;
            });
          }
        }
        if (bucket_iter_.Valid() &&
            (BucketHoldsOnlyCurPrefix() || CompareToCurPrefix() == 0)) {
          valid_ = true;
          return;
        }
        // The group is contiguous, so reaching another prefix means it has
        // no entry >= target.
      }
      valid_ = false;
    }

    // Starting at prefix_iter_ and moving backward, positions at the last
    // entry of the first prefix that has one. target, if set, applies to the
    // first prefix only.
    void SettleBackward(const char* target) {
      for (; prefix_iter_.Valid(); prefix_iter_.Prev(), target = nullptr) {
        if (!LoadCurPrefixBucket()) {
          continue;
        }
        if (target != nullptr) {
          bucket_iter_.SeekForPrev(target);
        } else {
          bool whole_bucket = false;
          if (cur_is_owner_) {
            bucket_iter_.SeekToLast();
            whole_bucket = BucketHoldsOnlyCurPrefix();
          }
          if (!whole_bucket) {
            // The last entry with "prefix <= cur_prefix_" ends the group.
            bucket_iter_.SeekToLastMatching([this](const char* e) {
              return ComparePrefixOf(e, cur_prefix_) <= 0;
            });
          }
        }
        if (bucket_iter_.Valid() &&
            (BucketHoldsOnlyCurPrefix() || AtCurPrefix())) {
          valid_ = true;
          return;
        }
      }
      valid_ = false;
    }

    // Encodes prefix the way prefix_list_ stores it: length-prefixed.
    const char* EncodePrefixListKey(const Slice& prefix) {
      prefix_buf_.clear();
      PutLengthPrefixedSlice(&prefix_buf_, prefix);
      return prefix_buf_.data();
    }

    const HashSkipListRep& memtable_rep_;
    PrefixList::Iterator prefix_iter_;
    Bucket::Iterator bucket_iter_;
    // Points into a prefix_list_ node, valid as long as the memtable.
    Slice cur_prefix_;
    // Bucket of cur_prefix_, and whether cur_prefix_ is its owner prefix.
    const HashBucket* cur_bucket_ = nullptr;
    bool cur_is_owner_ = false;
    bool valid_ = false;
    std::string tmp_;         // For passing to EncodeKey
    std::string prefix_buf_;  // For passing to EncodePrefixListKey
  };
};

HashSkipListRep::HashSkipListRep(const MemTableRep::KeyComparator& compare,
                                 Allocator* allocator,
                                 const SliceTransform* transform,
                                 size_t bucket_size, int32_t skiplist_height,
                                 int32_t skiplist_branching_factor)
    : MemTableRep(allocator),
      bucket_size_(bucket_size),
      skiplist_height_(skiplist_height),
      skiplist_branching_factor_(skiplist_branching_factor),
      transform_(transform),
      compare_(compare),
      allocator_(allocator),
      key_allocator_(compare_, allocator_, skiplist_height_,
                     skiplist_branching_factor_),
      prefix_compare_(compare.user_comparator() != nullptr
                          ? compare.user_comparator()
                          : BytewiseComparator()),
      prefix_list_(prefix_compare_, allocator_,
                   std::max(skiplist_height_, kMinPrefixListHeight),
                   skiplist_branching_factor_) {
  // A comparator with user-defined timestamps cannot compare prefixes, which
  // carry no timestamp.
  assert(prefix_compare_.user_comparator()->timestamp_size() == 0);

  auto mem =
      allocator->AllocateAligned(sizeof(std::atomic<void*>) * bucket_size);
  buckets_ = new (mem) std::atomic<HashBucket*>[bucket_size];

  for (size_t i = 0; i < bucket_size_; ++i) {
    buckets_[i].store(nullptr, std::memory_order_relaxed);
  }
}

HashSkipListRep::~HashSkipListRep() = default;

HashSkipListRep::HashBucket* HashSkipListRep::GetInitializedBucket(
    const Slice& transformed, bool concurrently) {
  size_t hash = GetHash(transformed);
  auto bucket = buckets_[hash].load(std::memory_order_acquire);
  if (bucket == nullptr) {
    // The owner prefix is in prefix_list_ before anyone can see the bucket.
    const char* owner = AddPrefix(transformed, concurrently);
    auto addr = allocator_->AllocateAligned(sizeof(HashBucket));
    auto new_bucket =
        new (addr) HashBucket(compare_, allocator_, skiplist_height_,
                              skiplist_branching_factor_, owner);
    // With concurrent inserts another writer may have installed a bucket in
    // the meantime. Use that one, leaving the new bucket unused in the arena.
    // The prefix stays in prefix_list_, which is harmless: the key goes into
    // the installed bucket, as a key of its owner or of another prefix.
    if (buckets_[hash].compare_exchange_strong(bucket, new_bucket,
                                               std::memory_order_acq_rel,
                                               std::memory_order_acquire)) {
      bucket = new_bucket;
    }
  }
  return bucket;
}

KeyHandle HashSkipListRep::Allocate(const size_t len, char** buf) {
  *buf = key_allocator_.AllocateKey(len);
  return static_cast<KeyHandle>(*buf);
}

void HashSkipListRep::RegisterPrefix(HashBucket* bucket, const Slice& prefix,
                                     bool concurrently) {
  // Equal bytes mean an equal prefix under any comparator, so a match proves
  // the prefix is in prefix_list_.
  if (GetLengthPrefixedSlice(bucket->owner_prefix) == prefix) {
    return;
  }
  // The iterator reads the flag after reaching a key, and the release orders
  // it before this key is inserted, so an iterator that reaches a key of
  // another prefix sees the flag. Writers that skip ahead on known_prefix
  // below see it too, since known_prefix is stored after it.
  if (!bucket->mixed.load(std::memory_order_relaxed)) {
    bucket->mixed.store(true, std::memory_order_release);
  }
  // The acquire pairs with the release below, which comes after the prefix
  // was added.
  const char* known = bucket->known_prefix.load(std::memory_order_acquire);
  if (known != nullptr && GetLengthPrefixedSlice(known) == prefix) {
    return;
  }
  bucket->known_prefix.store(AddPrefix(prefix, concurrently),
                             std::memory_order_release);
}

const char* HashSkipListRep::AddPrefix(const Slice& prefix,
                                       bool concurrently) {
  const size_t encoded_len = VarintLength(prefix.size()) + prefix.size();
  char stack_buf[64];
  std::string heap_buf;
  char* buf = stack_buf;
  if (encoded_len > sizeof(stack_buf)) {
    heap_buf.resize(encoded_len);
    buf = heap_buf.data();
  }
  char* p = EncodeVarint32(buf, static_cast<uint32_t>(prefix.size()));
  memcpy(p, prefix.data(), prefix.size());
  // Look the prefix up first, since a node from AllocateKey() stays in the
  // arena even if it is not inserted.
  PrefixList::Iterator iter(&prefix_list_);
  iter.Seek(buf);
  if (iter.Valid() && prefix_compare_(iter.key(), buf) == 0) {
    return iter.key();
  }
  char* key = prefix_list_.AllocateKey(encoded_len);
  memcpy(key, buf, encoded_len);
  if (concurrently) {
    if (!prefix_list_.InsertConcurrently(key)) {
      // Another writer added the prefix in the meantime, leaving the node
      // unused in the arena.
      iter.Seek(buf);
      assert(iter.Valid() && prefix_compare_(iter.key(), buf) == 0);
      return iter.key();
    }
  } else {
    prefix_list_.Insert(key);
  }
  return key;
}

void HashSkipListRep::Insert(KeyHandle handle) {
  auto* key = static_cast<char*>(handle);
  assert(!Contains(key));
  auto transformed = transform_->Transform(UserKey(key));
  auto bucket = GetInitializedBucket(transformed, /*concurrently=*/false);
  // Register the prefix first, so that an iterator that finds the key in its
  // bucket also finds the prefix in prefix_list_.
  RegisterPrefix(bucket, transformed, /*concurrently=*/false);
  bucket->list.Insert(key);
}

void HashSkipListRep::InsertConcurrently(KeyHandle handle) {
  auto* key = static_cast<char*>(handle);
  auto transformed = transform_->Transform(UserKey(key));
  auto bucket = GetInitializedBucket(transformed, /*concurrently=*/true);
  RegisterPrefix(bucket, transformed, /*concurrently=*/true);
  bucket->list.InsertConcurrently(key);
}

bool HashSkipListRep::Contains(const char* key) const {
  auto transformed = transform_->Transform(UserKey(key));
  auto bucket = GetBucket(transformed);
  if (bucket == nullptr) {
    return false;
  }
  return bucket->Contains(key);
}

size_t HashSkipListRep::ApproximateMemoryUsage() { return 0; }

void HashSkipListRep::Get(const LookupKey& k, void* callback_args,
                          bool (*callback_func)(void* arg, const char* entry)) {
  auto transformed = transform_->Transform(k.user_key());
  auto bucket = GetBucket(transformed);
  if (bucket != nullptr) {
    Bucket::Iterator iter(bucket);
    for (iter.Seek(k.memtable_key().data());
         iter.Valid() && callback_func(callback_args, iter.key());
         iter.Next()) {
    }
  }
}

MemTableRep::Iterator* HashSkipListRep::GetIterator(Arena* arena) {
  if (arena == nullptr) {
    return new PrefixOrderedIterator(*this);
  } else {
    auto mem = arena->AllocateAligned(sizeof(PrefixOrderedIterator));
    return new (mem) PrefixOrderedIterator(*this);
  }
}

MemTableRep::Iterator* HashSkipListRep::GetDynamicPrefixIterator(Arena* arena) {
  if (arena == nullptr) {
    return new DynamicIterator(*this);
  } else {
    auto mem = arena->AllocateAligned(sizeof(DynamicIterator));
    return new (mem) DynamicIterator(*this);
  }
}

struct HashSkipListRepOptions {
  static const char* kName() { return "HashSkipListRepFactoryOptions"; }
  size_t bucket_count;
  int32_t skiplist_height;
  int32_t skiplist_branching_factor;
};

static std::unordered_map<std::string, OptionTypeInfo> hash_skiplist_info = {
    {"bucket_count",
     {offsetof(struct HashSkipListRepOptions, bucket_count), OptionType::kSizeT,
      OptionVerificationType::kNormal, OptionTypeFlags::kNone}},
    {"skiplist_height",
     {offsetof(struct HashSkipListRepOptions, skiplist_height),
      OptionType::kInt32T, OptionVerificationType::kNormal,
      OptionTypeFlags::kNone}},
    {"branching_factor",
     {offsetof(struct HashSkipListRepOptions, skiplist_branching_factor),
      OptionType::kInt32T, OptionVerificationType::kNormal,
      OptionTypeFlags::kNone}},
};

class HashSkipListRepFactory : public MemTableRepFactory {
 public:
  explicit HashSkipListRepFactory(size_t bucket_count, int32_t skiplist_height,
                                  int32_t skiplist_branching_factor) {
    options_.bucket_count = bucket_count;
    options_.skiplist_height = skiplist_height;
    options_.skiplist_branching_factor = skiplist_branching_factor;
    RegisterOptions(&options_, &hash_skiplist_info);
  }

  bool IsInsertConcurrentlySupported() const override { return true; }

  using MemTableRepFactory::CreateMemTableRep;
  MemTableRep* CreateMemTableRep(const MemTableRep::KeyComparator& compare,
                                 Allocator* allocator,
                                 const SliceTransform* transform,
                                 Logger* logger) override;

  static const char* kClassName() { return "HashSkipListRepFactory"; }
  static const char* kNickName() { return "prefix_hash"; }

  const char* Name() const override { return kClassName(); }
  const char* NickName() const override { return kNickName(); }

 private:
  HashSkipListRepOptions options_;
};

}  // namespace

MemTableRep* HashSkipListRepFactory::CreateMemTableRep(
    const MemTableRep::KeyComparator& compare, Allocator* allocator,
    const SliceTransform* transform, Logger* /*logger*/) {
  return new HashSkipListRep(compare, allocator, transform,
                             options_.bucket_count, options_.skiplist_height,
                             options_.skiplist_branching_factor);
}

MemTableRepFactory* NewHashSkipListRepFactory(
    size_t bucket_count, int32_t skiplist_height,
    int32_t skiplist_branching_factor) {
  return new HashSkipListRepFactory(bucket_count, skiplist_height,
                                    skiplist_branching_factor);
}

}  // namespace ROCKSDB_NAMESPACE
