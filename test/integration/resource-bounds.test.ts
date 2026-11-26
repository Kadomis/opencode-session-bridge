import { describe, expect, it } from "bun:test"
import SessionBridgePlugin from "../../src/index.js"
import {
  createFakeContext,
  makeToolContext,
  setupBridge,
} from "../helpers/fake-context.js"

function options(overrides: Record<string, unknown> = {}) {
  let sequence = 0
  return {
    now: () => 1_000,
    newMessageID: () => `msg_bridge_${++sequence}`,
    rateLimit: { maxRequests: 20, windowMs: 60_000 },
    ...overrides,
  }
}

describe("plugin option validation", () => {
  it("reads ctx.options.rateLimit and enforces maxRequests=1", async () => {
    const fake = createFakeContext({
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
    })
    await SessionBridgePlugin.setup(fake.ctx)

    await fake.execute("session_send", { targetSessionID: "ses_target", text: "First" })
    await expect(
      fake.execute("session_send", { targetSessionID: "ses_target", text: "Second" }),
    ).rejects.toThrow(/rate limit/i)

    expect(fake.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("merges default window settings for a partial ctx.options.rateLimit", async () => {
    const fake = createFakeContext({ rateLimit: { maxRequests: 5 } })
    await SessionBridgePlugin.setup(fake.ctx)

    for (let index = 0; index < 5; index += 1) {
      await fake.execute("session_send", {
        targetSessionID: "ses_target",
        text: `Allowed ${index}`,
      })
    }
    await expect(
      fake.execute("session_send", { targetSessionID: "ses_target", text: "Blocked" }),
    ).rejects.toThrow(/rate limit/i)

    expect(fake.session.prompt).toHaveBeenCalledTimes(5)
  })

  it("merges default window settings for a partial factory rateLimit", async () => {
    const bridge = await setupBridge({ rateLimit: { maxRequests: 5 } })

    for (let index = 0; index < 5; index += 1) {
      await bridge.execute("session_send", {
        targetSessionID: "ses_target",
        text: `Allowed ${index}`,
      })
    }
    await expect(
      bridge.execute("session_send", { targetSessionID: "ses_target", text: "Blocked" }),
    ).rejects.toThrow(/rate limit/i)

    expect(bridge.session.prompt).toHaveBeenCalledTimes(5)
  })

  it.each([
    null,
    "invalid",
    { maxRequests: 0 },
    { maxRequests: 1.5 },
    { windowMs: 0 },
    { maxBuckets: 0 },
  ])("rejects invalid ctx.options.rateLimit: %j", async (rateLimit) => {
    const fake = createFakeContext({ rateLimit })

    await expect(SessionBridgePlugin.setup(fake.ctx)).rejects.toThrow(/rateLimit|rate limit/i)
    expect(fake.tool.transform).not.toHaveBeenCalled()
  })
})

describe("bounded idempotency state", () => {
  it("expires entries after the configured TTL", async () => {
    let now = 1_000
    const bridge = await setupBridge(
      options({ now: () => now, idempotencyTTLMs: 100, idempotencyMaxEntries: 10 }),
    )
    const input = {
      targetSessionID: "ses_target",
      text: "TTL request",
      idempotencyKey: "ttl-key",
    }

    await bridge.execute("session_send", input)
    now = 1_101
    await bridge.execute("session_send", input)

    expect(bridge.session.prompt).toHaveBeenCalledTimes(2)
  })

  it("evicts old entries when idempotencyMaxEntries is reached", async () => {
    const bridge = await setupBridge(
      options({ idempotencyTTLMs: 60_000, idempotencyMaxEntries: 1 }),
    )

    await bridge.execute("session_send", {
      targetSessionID: "ses_target",
      text: "First key",
      idempotencyKey: "key-1",
    })
    await bridge.execute("session_send", {
      targetSessionID: "ses_target",
      text: "Second key",
      idempotencyKey: "key-2",
    })
    await bridge.execute("session_send", {
      targetSessionID: "ses_target",
      text: "First key again",
      idempotencyKey: "key-1",
    })

    expect(bridge.session.prompt).toHaveBeenCalledTimes(3)
  })

  it("consumes rate-limit capacity even when replaying a cached result", async () => {
    const bridge = await setupBridge(
      options({ rateLimit: { maxRequests: 1, windowMs: 60_000 } }),
    )
    const input = {
      targetSessionID: "ses_target",
      text: "Cached but rate limited",
      idempotencyKey: "replay-rate",
    }

    await bridge.execute("session_send", input)
    await expect(bridge.execute("session_send", input)).rejects.toThrow(/rate limit/i)

    expect(bridge.permission.assert).toHaveBeenCalledTimes(2)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })
})

describe("bounded rate-limit state", () => {
  it("rejects a new caller instead of evicting an active bucket", async () => {
    let now = 1_000
    const bridge = await setupBridge(
      options({
        now: () => now,
        rateLimit: { maxRequests: 1, windowMs: 60_000, maxBuckets: 1 },
      }),
    )

    await bridge.execute("session_send", { targetSessionID: "ses_target", text: "Caller A" })
    await expect(
      bridge.execute("session_send", { targetSessionID: "ses_target", text: "Caller A again" }),
    ).rejects.toThrow(/rate limit/i)
    await expect(
      bridge.execute(
        "session_send",
        { targetSessionID: "ses_target", text: "Caller B" },
        makeToolContext({ sessionID: "ses_other" }),
      ),
    ).rejects.toThrow(/rate limit/i)

    now = 61_000
    await bridge.execute(
      "session_send",
      { targetSessionID: "ses_target", text: "Caller B after expiry" },
      makeToolContext({ sessionID: "ses_other" }),
    )
    now = 122_000
    await bridge.execute("session_send", { targetSessionID: "ses_target", text: "Caller A fresh" })

    expect(bridge.session.prompt).toHaveBeenCalledTimes(3)
  })
})
