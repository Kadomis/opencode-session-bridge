export const DEFAULT_RATE_LIMIT = Object.freeze({ maxRequests: 60, windowMs: 60_000 })

export interface RateLimitConfig {
  maxRequests: number
  windowMs: number
  maxBuckets?: number
  now?: () => number
}

export class RateLimitError extends Error {
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterMs} ms.`)
    this.name = "RateLimitError"
    this.retryAfterMs = retryAfterMs
  }
}

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private readonly config: Required<Omit<RateLimitConfig, "maxBuckets">> & { maxBuckets: number }
  private readonly buckets = new Map<string, Bucket>()

  constructor(config: Partial<RateLimitConfig>) {
    if (!Number.isInteger(config.maxRequests) || (config.maxRequests ?? 0) < 1) {
      throw new RangeError("maxRequests must be a positive integer")
    }
    if (!Number.isFinite(config.windowMs) || (config.windowMs ?? 0) <= 0) {
      throw new RangeError("windowMs must be a positive finite number")
    }
    if (
      config.maxBuckets !== undefined &&
      (!Number.isInteger(config.maxBuckets) || config.maxBuckets < 1)
    ) {
      throw new RangeError("maxBuckets must be a positive integer")
    }
    this.config = {
      maxRequests: config.maxRequests as number,
      windowMs: config.windowMs as number,
      maxBuckets: config.maxBuckets ?? 1_024,
      now: config.now ?? Date.now,
    }
  }

  get size(): number {
    return this.buckets.size
  }

  clear(): void {
    this.buckets.clear()
  }

  consume(key: string): { remaining: number; resetAt: number } {
    if (typeof key !== "string" || key.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new RangeError("bucket key must be a non-empty single-line string")
    }
    const now = this.config.now()
    this.prune(now)

    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= this.config.maxBuckets) {
        const retryAfterMs = Math.min(...[...this.buckets.values()].map((item) => item.resetAt - now))
        throw new RateLimitError(Math.max(0, retryAfterMs))
      }
      bucket = { count: 0, resetAt: now + this.config.windowMs }
      this.buckets.set(key, bucket)
    }
    if (bucket.count >= this.config.maxRequests) {
      throw new RateLimitError(Math.max(0, bucket.resetAt - now))
    }
    bucket.count += 1
    return { remaining: this.config.maxRequests - bucket.count, resetAt: bucket.resetAt }
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key)
    }
  }
}
