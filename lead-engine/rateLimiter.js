class RateLimiter {
  constructor({ intervalMs = 1000, concurrency = 1 } = {}) {
    this.intervalMs = intervalMs;
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.lastRun = 0;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    if (this.active >= this.concurrency || this.queue.length === 0) return;
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastRun));
    setTimeout(async () => {
      const item = this.queue.shift();
      if (!item) return;
      this.active += 1;
      this.lastRun = Date.now();
      try {
        item.resolve(await item.task());
      } catch (error) {
        item.reject(error);
      } finally {
        this.active -= 1;
        this.drain();
      }
    }, wait);
  }
}

module.exports = { RateLimiter };
