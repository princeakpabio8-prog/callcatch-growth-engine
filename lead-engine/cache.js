class MemoryCache {
  constructor(ttlMs = 1000 * 60 * 60 * 6) {
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expiresAt) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key, value) {
    this.items.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs
    });
  }
}

module.exports = { MemoryCache };
