import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import { RateLimiter } from './lib/rate-limit.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  now: () => number;
  loginLimiter: RateLimiter;
  bootstrapLimiter: RateLimiter;
  enrollLimiter: RateLimiter;
}

export function createContext(config: AppConfig, db: Db, now: () => number = Date.now): AppContext {
  return {
    config,
    db,
    now,
    loginLimiter: new RateLimiter(config.loginRateLimit, now),
    bootstrapLimiter: new RateLimiter(config.bootstrapRateLimit, now),
    enrollLimiter: new RateLimiter(config.enrollRateLimit, now),
  };
}
