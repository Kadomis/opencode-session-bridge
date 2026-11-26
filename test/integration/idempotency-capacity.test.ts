import { describe, expect, it } from "bun:test"
import {
  makeAssistantMessage,
  makeUserMessage,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"

function options(overrides: Record<string, unknown> = {}) {
  let sequence = 0
  return {
    now: () => 1_000,
    newMessageID: () => `msg_bridge_${++sequence}`,
    rateLimit: { maxRequests: 20, windowMs: 60_000 },
    idempotencyTTLMs: 60_000,
    idempotencyMaxEntries: 4,
    ...overrides,
  }
}

function pendingWait() {
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const waitStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    waitStarted,
    release: () => release?.(),
    implementation: () => {
      started?.()
      return gate
    },
  }
}

function contextWithTwoAdmissions() {
  return [
    makeUserMessage("msg_bridge_1", "First request"),
    makeAssistantMessage("msg_reply_1", [{ type: "text", text: "First reply" }]),
    makeUserMessage("msg_bridge_2", "Second request"),
    makeAssistantMessage("msg_reply_2", [{ type: "text", text: "Second reply" }]),
  ]
}

describe("protected idempotency receipts", () => {
  it("does not expire an in-flight receipt while session_wait is pending", async () => {
    let now = 1_000
    const bridge = await setupBridge(
      options({ now: () => now, idempotencyTTLMs: 100 }),
    )
    const wait = pendingWait()
    bridge.session.wait.mockImplementationOnce(wait.implementation)
    bridge.session.context.mockResolvedValue(contextWithTwoAdmissions())
    const input = {
      targetSessionID: "ses_target",
      text: "Long pending reply",
      waitForReply: true,
      idempotencyKey: "pending-beyond-ttl",
    }

    const firstPromise = bridge.execute("session_send", input)
    await wait.waitStarted
    now = 1_101
    const replayPromise = bridge.execute("session_send", input)
    await Promise.resolve()
    wait.release()
    const [first, replay] = await Promise.all([firstPromise, replayPromise])
    const firstOutput = outputOf<{ messageID: string; duplicate: boolean }>(first)
    const replayOutput = outputOf<{ messageID: string; duplicate: boolean }>(replay)

    expect(firstOutput.messageID).toBe("msg_bridge_1")
    expect(replayOutput.messageID).toBe("msg_bridge_1")
    expect(replayOutput.duplicate).toBe(true)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("rejects a second key instead of evicting an in-flight receipt at capacity", async () => {
    const bridge = await setupBridge(options({ idempotencyMaxEntries: 1 }))
    const wait = pendingWait()
    bridge.session.wait.mockImplementationOnce(wait.implementation)
    bridge.session.context.mockResolvedValue(contextWithTwoAdmissions())
    const firstPromise = bridge.execute("session_send", {
      targetSessionID: "ses_target",
      text: "First pending request",
      waitForReply: true,
      idempotencyKey: "key-1",
    })
    await wait.waitStarted

    try {
      await expect(
        bridge.execute("session_send", {
          targetSessionID: "ses_target",
          text: "Second key",
          idempotencyKey: "key-2",
        }),
      ).rejects.toThrow(/capacity|full|too many/i)
      expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    } finally {
      wait.release()
      await firstPromise
    }
  })

  it("rejects a second key instead of evicting an admitted receipt without output", async () => {
    const bridge = await setupBridge(options({ idempotencyMaxEntries: 1 }))
    bridge.session.wait.mockRejectedValueOnce(new Error("reply unavailable"))

    await expect(
      bridge.execute("session_send", {
        targetSessionID: "ses_target",
        text: "Admitted request",
        waitForReply: true,
        idempotencyKey: "admitted-key",
      }),
    ).rejects.toThrow("reply unavailable")
    await expect(
      bridge.execute("session_send", {
        targetSessionID: "ses_target",
        text: "New key at capacity",
        idempotencyKey: "new-key",
      }),
    ).rejects.toThrow(/capacity|full|too many/i)

    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })
})
