export class FixedWindowLimiter {
  constructor({ limit, windowMs, now = Date.now }) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) throw new RangeError("Invalid limiter settings");
    this.limit = limit; this.windowMs = windowMs; this.now = now; this.entries = new Map();
  }
  consume(key, cost = 1) {
    if (!key || !Number.isFinite(cost) || cost <= 0) throw new TypeError("A key and positive cost are required");
    const time = this.now(); let entry = this.entries.get(key);
    if (!entry || time >= entry.resetAt) entry = { count: 0, resetAt: time + this.windowMs };
    entry.count += cost; this.entries.set(key, entry);
    const remaining = Math.max(0, this.limit - entry.count);
    return { allowed: entry.count <= this.limit, limit: this.limit, remaining, resetAt: entry.resetAt, retryAfterMs: entry.count > this.limit ? Math.max(0, entry.resetAt - time) : 0 };
  }
  prune() { const time = this.now(); for (const [key, value] of this.entries) if (time >= value.resetAt) this.entries.delete(key); }
}
export class TokenBucketLimiter {
  constructor({ capacity, refillPerSecond, now = Date.now }) {
    if (!(capacity > 0) || !(refillPerSecond > 0)) throw new RangeError("capacity and refillPerSecond must be positive");
    this.capacity = capacity; this.refillPerMs = refillPerSecond / 1000; this.now = now; this.buckets = new Map();
  }
  consume(key, cost = 1) {
    if (!key || !(cost > 0) || cost > this.capacity) throw new RangeError("Invalid key or token cost");
    const time = this.now(); const old = this.buckets.get(key) ?? { tokens: this.capacity, at: time };
    const tokens = Math.min(this.capacity, old.tokens + Math.max(0, time - old.at) * this.refillPerMs);
    const allowed = tokens >= cost; const next = allowed ? tokens - cost : tokens;
    this.buckets.set(key, { tokens: next, at: time });
    return { allowed, remaining: Math.floor(next), retryAfterMs: allowed ? 0 : Math.ceil((cost - next) / this.refillPerMs) };
  }
  prune(maxIdleMs) { const time = this.now(); for (const [key, value] of this.buckets) if (time - value.at > maxIdleMs) this.buckets.delete(key); }
}
export function rateLimitMiddleware(limiter, keyFor = (req) => req.ip ?? req.socket?.remoteAddress ?? "unknown") {
  return (req, res, next) => {
    const result = limiter.consume(keyFor(req));
    res.setHeader("RateLimit-Limit", String(result.limit ?? limiter.limit ?? limiter.capacity));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      return res.status(429).json({ error: "rate_limit_exceeded", retryAfterMs: result.retryAfterMs });
    }
    return next();
  };
}