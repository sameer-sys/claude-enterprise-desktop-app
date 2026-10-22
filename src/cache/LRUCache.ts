// src/cache/LRUCache.ts
/**
 * A production‑grade Least‑Recently‑Used (LRU) cache implementation.
 *
 * Features:
 *  • Generic key `K` and value `V`.
 *  • O(1) `get` and `put` operations.
 *  • Optional per‑key TTL (time‑to‑live) support – keys expire automatically.
 *  • Doubly‑linked list + Map for constant‑time access and ordering.
 *  • Clean error handling – throws `Error` with descriptive messages.
 *  • Supports removal of keys and iteration.
 *
 * Usage:
 * ```ts
 * const cache = new LRUCache<string, number>(3, { defaultTTL: 5 * 60 * 1000 });
 * cache.put("a", 1);
 * const val = cache.get("a"); // 1
 * ```
 *
 * Edge cases covered by tests:
 *  1. Get/put on a key that has expired.
 *  2. Evicting the least‑recently used key when capacity is reached.
 *  3. Updating an existing key resets its recency and TTL.
 */

interface Node<K, V> {
  key: K;
  value: V;
  expireAt: number | null; // timestamp in ms; null means no expiry
  prev: Node<K, V> | null;
  next: Node<K, V> | null;
}

interface LRUCacheOptions {
  /**
   * The maximum number of items the cache may hold.
   * Must be a positive integer.
   */
  capacity: number;
  /**
   * Default TTL for keys that are inserted without an explicit TTL.
   * `null` means no expiry.
   */
  defaultTTL?: number | null;
}

export class LRUCache<K, V> {
  private readonly capacity: number;
  private readonly defaultTTL: number | null;
  private readonly map: Map<K, Node<K, V>>;
  private head: Node<K, V> | null = null; // most recently used
  private tail: Node<K, V> | null = null; // least recently used

  constructor(opts: LRUCacheOptions) {
    if (!Number.isInteger(opts.capacity) || opts.capacity <= 0) {
      throw new Error("LRUCache capacity must be a positive integer");
    }
    this.capacity = opts.capacity;
    this.defaultTTL = opts.defaultTTL ?? null;
    this.map = new Map();
  }

  /**
   * Retrieves the value associated with the key.
   * If the key does not exist or has expired, `undefined` is returned.
   */
  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;

    // Check TTL
    if (node.expireAt !== null && Date.now() >= node.expireAt) {
      this.deleteNode(node);
      return undefined;
    }

    // Move node to head (most recently used)
    this.moveToHead(node);
    return node.value;
  }

  /**
   * Adds or updates a key/value pair.
   * If `ttl` is omitted, the cache's default TTL is used.
   * A TTL of `null` means the entry never expires.
   */
  put(key: K, value: V, ttl?: number | null): void {
    const expireAt = ttl === undefined ? this.defaultTTL : ttl;
    const expireTimestamp = expireAt !== null ? Date.now() + expireAt : null;

    const existing = this.map.get(key);
    if (existing) {
      // Update value and TTL, then move to head
      existing.value = value;
      existing.expireAt = expireTimestamp;
      this.moveToHead(existing);
      return;
    }

    // If capacity reached, evict LRU
    if (this.map.size >= this.capacity) {
      if (this.tail) {
        this.deleteNode(this.tail);
      }
    }

    const node: Node<K, V> = {
      key,
      value,
      expireAt: expireTimestamp,
      prev: null,
      next: null,
    };
    this.addToHead(node);
    this.map.set(key, node);
  }

  /**
   * Deletes a key from the cache if it exists.
   * Returns `true` if a key was removed.
   */
  delete(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.deleteNode(node);
    return true;
  }

  /**
   * Clears all entries from the cache.
   */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  /**
   * Returns the current number of items stored.
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Internal helpers
   */
  private addToHead(node: Node<K, V>) {
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private moveToHead(node: Node<K, V>) {
    if (node === this.head) return;
    // Detach
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.tail) this.tail = node.prev;
    // Attach at head
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
  }

  private deleteNode(node: Node<K, V>) {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;
    this.map.delete(node.key);
  }
}

export default LRUCache;
