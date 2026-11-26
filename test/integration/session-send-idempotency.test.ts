import { describe, expect, it } from "bun:test"
import {
  makeAssistantMessage,
  makePromptResult,
  makeToolContext,
  makeUserMessage,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"

interface SendOutput {
  messageID: string
  sessionID: string
  conversationID: string
  delivery: "steer" | "queue"
  duplicate: boolean
  provenance: Record<string, unknown>
  reply?: {
    messages: Array<{ messageID: string; role: string; text: string; truncated: boolean }>
    truncated: boolean
  }
}

function bridgeOptions() {
  let sequence = 0
  return {
    now: () => 2_000,
    newMessageID: () => `msg_bridge_${++sequence}`,
    rateLimit: { maxRequests: 20, windowMs: 60_000 },
  }
}

describe("session_send idempotency", () => {
  it("replays the original result without delivering a duplicate prompt", async () => {
    const bridge = await setupBridge(bridgeOptions())
    const input = {
      targetSessionID: "ses_target",
      text: "Idempotent request",
      idempotencyKey: "request-1",
    }

    const first = outputOf<SendOutput>(await bridge.execute("session_send", input))
    const second = outputOf<SendOutput>(await bridge.execute("session_send", input))

    expect(second).toEqual({ ...first, duplicate: true })
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    expect(bridge.session.prompt.mock.calls[0]?.[0].id).toBe(first.messageID)
  })

  it("coalesces concurrent requests with the same idempotency key", async () => {
    const bridge = await setupBridge(bridgeOptions())
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    bridge.session.prompt.mockImplementationOnce(async (input) => {
      await gate
      return makePromptResult(input)
    })
    const input = {
      targetSessionID: "ses_target",
      text: "Concurrent request",
      idempotencyKey: "request-concurrent",
    }

    const firstPromise = bridge.execute("session_send", input)
    const secondPromise = bridge.execute("session_send", input)
    release?.()
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    const firstOutput = outputOf<SendOutput>(first)
    const secondOutput = outputOf<SendOutput>(second)

    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    expect(firstOutput.messageID).toBe(secondOutput.messageID)
    expect([firstOutput.duplicate, secondOutput.duplicate].sort()).toEqual([false, true])
  })

  it("rejects reuse of a key with a different semantic request", async () => {
    const bridge = await setupBridge(bridgeOptions())

    await bridge.execute("session_send", {
      targetSessionID: "ses_target",
      text: "Original request",
      idempotencyKey: "request-1",
    })
    await expect(
      bridge.execute("session_send", {
        targetSessionID: "ses_target",
        text: "Different request",
        idempotencyKey: "request-1",
      }),
    ).rejects.toThrow(/idempotency/i)

    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("allows a retry after the native prompt fails", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.prompt.mockRejectedValueOnce(new Error("temporary failure"))
    const input = {
      targetSessionID: "ses_target",
      text: "Retryable request",
      idempotencyKey: "request-retry",
    }

    await expect(bridge.execute("session_send", input)).rejects.toThrow("temporary failure")
    const retried = outputOf<SendOutput>(await bridge.execute("session_send", input))

    expect(retried.duplicate).toBe(false)
    expect(retried.messageID).toBe("msg_bridge_1")
    expect(bridge.session.prompt).toHaveBeenCalledTimes(2)
  })

  it("scopes idempotency keys to the calling session", async () => {
    const bridge = await setupBridge(bridgeOptions())
    const input = {
      targetSessionID: "ses_target",
      text: "Same key from two callers",
      idempotencyKey: "shared-key",
    }

    const first = outputOf<SendOutput>(await bridge.execute("session_send", input))
    const second = outputOf<SendOutput>(
      await bridge.execute("session_send", input, makeToolContext({ sessionID: "ses_other" })),
    )

    expect(first.messageID).not.toBe(second.messageID)
    expect(first.provenance.from_session).toBe("ses_caller")
    expect(second.provenance.from_session).toBe("ses_other")
    expect(bridge.session.prompt).toHaveBeenCalledTimes(2)
  })

  it("sends independently when no idempotency key is supplied", async () => {
    const bridge = await setupBridge(bridgeOptions())
    const input = { targetSessionID: "ses_target", text: "Repeated request" }

    const first = outputOf<SendOutput>(await bridge.execute("session_send", input))
    const second = outputOf<SendOutput>(await bridge.execute("session_send", input))

    expect(first.messageID).not.toBe(second.messageID)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(2)
  })
})

describe("session_send waitForReply", () => {
  it("waits for the target and returns only redacted reply text", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.context.mockResolvedValueOnce([
      makeUserMessage("msg_old", "Old conversation text"),
      makeUserMessage("msg_bridge_1", "Please reply"),
      makeAssistantMessage("msg_reply", [
        { type: "reasoning", text: "REASONING_SECRET" },
        { type: "text", text: "Authorization: Bearer abc.def.ghi" },
        { type: "tool", state: { content: "TOOL_SECRET" } },
      ]),
    ])

    const result = await bridge.execute("session_send", {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
    })
    const output = outputOf<SendOutput>(result)

    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    expect(bridge.session.wait).toHaveBeenCalledWith(
      { sessionID: "ses_target" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(bridge.session.context).toHaveBeenCalledWith(
      { sessionID: "ses_target" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(output.reply).toEqual({
      messages: [
        {
          messageID: "msg_reply",
          role: "assistant",
          text: "Authorization: Bearer [REDACTED]",
          truncated: false,
        },
      ],
      truncated: false,
    })
    expect(JSON.stringify(output)).not.toContain("REASONING_SECRET")
    expect(JSON.stringify(output)).not.toContain("TOOL_SECRET")
    expect(JSON.stringify(output)).not.toContain("abc.def.ghi")
  })

  it("does not wait or read again when replaying a completed send", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.context.mockResolvedValue([
      makeUserMessage("msg_bridge_1", "Please reply"),
      makeAssistantMessage("msg_reply", [{ type: "text", text: "Reply" }]),
    ])
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "request-with-reply",
    }

    await bridge.execute("session_send", input)
    await bridge.execute("session_send", input)

    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    expect(bridge.session.wait).toHaveBeenCalledTimes(1)
    expect(bridge.session.context).toHaveBeenCalledTimes(1)
  })

  it("does not wait when waitForReply is omitted", async () => {
    const bridge = await setupBridge(bridgeOptions())

    await bridge.execute("session_send", { targetSessionID: "ses_target", text: "Fire and forget" })

    expect(bridge.session.wait).not.toHaveBeenCalled()
    expect(bridge.session.context).not.toHaveBeenCalled()
  })
})
