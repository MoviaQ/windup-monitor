export interface RateLimitResult {
  allowed: boolean;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
}

interface Entry {
  hits: number[];
  blockedUntil: number;
  strikes: number;
}

const MAX_PENALTY_MS = 6 * 60 * 60 * 1000; // 6h cap

/**
 * In-memory fixed-window rate limiter with escalating penalty for callers that
 * keep hammering while blocked (exponential backoff, docs/security.md §2).
 *
 * Single-instance Core only (MVP) — restart clears counters. That is an
 * accepted limitation, documented in README.
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly rule: { limit: number; windowMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitResult {
    const now = this.now();
    const entry = this.entries.get(key) ?? { hits: [], blockedUntil: 0, strikes: 0 };

    if (entry.blockedUntil > now) {
      entry.strikes += 1;
      entry.blockedUntil = now + this.penalty(entry.strikes);
      this.entries.set(key, entry);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000),
        limit: this.rule.limit,
        remaining: 0,
      };
    }

    entry.hits = entry.hits.filter((at) => now - at < this.rule.windowMs);

    if (entry.hits.length >= this.rule.limit) {
      entry.strikes += 1;
      const penalty = this.penalty(entry.strikes);
      entry.blockedUntil = now + penalty;
      this.entries.set(key, entry);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(penalty / 1000),
        limit: this.rule.limit,
        remaining: 0,
      };
    }

    entry.hits.push(now);
    entry.strikes = 0;
    this.entries.set(key, entry);
    return {
      allowed: true,
      retryAfterSeconds: 0,
      limit: this.rule.limit,
      remaining: this.rule.limit - entry.hits.length,
    };
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private penalty(strikes: number): number {
    return Math.min(this.rule.windowMs * 2 ** Math.min(strikes, 6), MAX_PENALTY_MS);
  }
}
