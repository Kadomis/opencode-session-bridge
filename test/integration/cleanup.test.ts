import { describe, expect, it } from "bun:test"
import SessionBridgePlugin, { createSessionBridge } from "../../src/index.js"
import { createFakeContext } from "../helpers/fake-context.js"

function options() {
  let sequence = 0
  return {
    now: () => 5_000,
    newMessageID: () => `msg_bridge_${++sequence}`,
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  }
}

describe("plugin cleanup state", () => {
  it("reuses the default deterministic message ID for a keyed request after reload", async () => {
    const fake = createFakeContext()
    const cleanup = await SessionBridgePlugin.setup(fake.ctx)
    const input = {
      targetSessionID: "ses_target",
      text: "Reloaded keyed request",
      idempotencyKey: "reload-deterministic-key",
    }

    await fake.execute("session_send", input)
    if (typeof cleanup !== "function") throw new Error("Expected cleanup function")
    await cleanup()
    await SessionBridgePlugin.setup(fake.ctx)
    await fake.execute("session_send", input)

    const messageIDs = fake.session.prompt.mock.calls.map((call) => call[0].id)
    expect(messageIDs).toHaveLength(2)
    expect(messageIDs[0]).toMatch(/^msg_bridge_[a-f0-9]+$/)
    expect(messageIDs[1]).toBe(messageIDs[0])
  })

  it("clears idempotency receipts when the plugin unloads", async () => {
    const fake = createFakeContext()
    const plugin = createSessionBridge(options())
    const cleanup = await plugin.setup(fake.ctx)
    const input = {
      targetSessionID: "ses_target",
      text: "Before cleanup",
      idempotencyKey: "cleanup-key",
    }

    await fake.execute("session_send", input)
    if (typeof cleanup !== "function") throw new Error("Expected cleanup function")
    await cleanup()
    await fake.execute("session_send", input)

    expect(fake.session.prompt).toHaveBeenCalledTimes(2)
  })

  it("clears rate-limit buckets when the plugin unloads", async () => {
    const fake = createFakeContext()
    const plugin = createSessionBridge(options())
    const cleanup = await plugin.setup(fake.ctx)

    await fake.execute("session_send", { targetSessionID: "ses_target", text: "Before cleanup" })
    if (typeof cleanup !== "function") throw new Error("Expected cleanup function")
    await cleanup()
    await fake.execute("session_send", { targetSessionID: "ses_target", text: "After cleanup" })

    expect(fake.session.prompt).toHaveBeenCalledTimes(2)
  })
})
