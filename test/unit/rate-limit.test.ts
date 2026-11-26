import { describe, expect, it } from "bun:test"
import {
  DEFAULT_RATE_LIMIT,
  RateLimitError,
  RateLimiter,
} from "../../src/rate-limit.js"

describe("DEFAULT_RATE_LIMIT", () => {
  it("defines a bounded one-minute window", () => {
    expect(DEFAULT_RATE_LIMIT).toEqual({ maxRequests: 60, windowMs: 60_000 })
    expect(Object.isFrozen(DEFAULT_RATE_LIMIT)).toBe(true)
  })
})

describe("RateLimiter", () => {
  it("allows requests through the configured boundary", () => {
    let now = 1_000
    const limiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 100,
      now: () => now,
    })

    expect(limiter.consume("ses_caller")).toEqual({ remaining: 1, resetAt: 1_100 })
    expect(limiter.consume("ses_caller")).toEqual({ remaining: 0, resetAt: 1_100 })
    expect(() => limiter.consume("ses_caller")).toThrow(RateLimitError)
  })

  it("reports the exact retry delay", () => {
    let now = 1_000
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 100,
      now: () => now,
    })
    limiter.consume("ses_caller")
    now = 1_025

    try {
      limiter.consume("ses_caller")
      throw new Error("Expected rate limiting")
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError)
      expect((error as RateLimitError).retryAfterMs).toBe(75)
      expect((error as Error).message).toMatch(/rate limit/i)
    }
  })

  it("starts a fresh window at the reset boundary", () => {
    let now = 1_000
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 100,
      now: () => now,
    })
    limiter.consume("ses_caller")
    now = 1_100

    expect(limiter.consume("ses_caller")).toEqual({ remaining: 0, resetAt: 1_200 })
  })

  it("keeps independent caller buckets", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100, now: () => 1_000 })

    expect(limiter.consume("ses_caller").remaining).toBe(0)
    expect(limiter.consume("ses_other").remaining).toBe(0)
  })

  it("does not extend the window when a request is rejected", () => {
    let now = 1_000
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100, now: () => now })
    limiter.consume("ses_caller")
    now = 1_090

    expect(() => limiter.consume("ses_caller")).toThrow(RateLimitError)
    now = 1_100
    expect(limiter.consume("ses_caller").resetAt).toBe(1_200)
  })

  it("expires stale buckets so they do not consume bounded capacity", () => {
    let now = 1_000
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 100,
      maxBuckets: 2,
      now: () => now,
    })

    limiter.consume("ses_old")
    expect(limiter.size).toBe(1)
    now = 1_100
    limiter.consume("ses_new")

    expect(limiter.size).toBe(1)
  })

  it("rejects a new caller instead of evicting active buckets at capacity", () => {
    let now = 1_000
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 100,
      maxBuckets: 2,
      now: () => now,
    })

    limiter.consume("ses_oldest")
    limiter.consume("ses_middle")
    expect(() => limiter.consume("ses_newest")).toThrow(RateLimitError)
    expect(() => limiter.consume("ses_oldest")).toThrow(RateLimitError)
    expect(limiter.size).toBe(2)

    now = 1_100
    expect(limiter.consume("ses_newest")).toEqual({ remaining: 0, resetAt: 1_200 })
    expect(limiter.size).toBe(1)
  })

  it.each([
    { maxRequests: 0 },
    { maxRequests: 1.5 },
    { windowMs: 0 },
    { windowMs: Number.NaN },
    { maxBuckets: 0 },
    { maxBuckets: 1.5 },
  ])("rejects invalid limiter configuration: %j", (options) => {
    expect(() => new RateLimiter(options)).toThrow(RangeError)
  })

  it.each(["", " ", "ses\ncaller"])("rejects an invalid bucket key: %j", (key) => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100 })

    expect(() => limiter.consume(key)).toThrow(RangeError)
  })
})
