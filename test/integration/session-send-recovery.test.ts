import { describe, expect, it } from "bun:test"
import {
  makeAssistantMessage,
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
    now: () => 3_000,
    newMessageID: () => `msg_bridge_${++sequence}`,
    rateLimit: { maxRequests: 20, windowMs: 60_000 },
  }
}

function replyContext(messageID = "msg_bridge_1") {
  return [
    makeUserMessage("msg_old", "Old conversation text"),
    makeUserMessage(messageID, "Please reply"),
    makeAssistantMessage("msg_reply", [{ type: "text", text: "Reply text" }]),
  ]
}

describe("session_send admission receipts", () => {
  it("does not prompt again when wait fails and reply retrieval resumes", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.wait.mockRejectedValueOnce(new Error("wait transport failed"))
    bridge.session.context.mockResolvedValue(replyContext())
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "wait-retry",
    }

    await expect(bridge.execute("session_send", input)).rejects.toThrow("wait transport failed")
    const retried = outputOf<SendOutput>(await bridge.execute("session_send", input))

    expect(retried.duplicate).toBe(true)
    expect(retried.messageID).toBe("msg_bridge_1")
    expect(retried.reply?.messages[0]?.text).toBe("Reply text")
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("does not prompt again when context fails and reply retrieval resumes", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.context.mockRejectedValueOnce(new Error("context transport failed"))
    bridge.session.context.mockResolvedValue(replyContext())
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "context-retry",
    }

    await expect(bridge.execute("session_send", input)).rejects.toThrow("context transport failed")
    const retried = outputOf<SendOutput>(await bridge.execute("session_send", input))

    expect(retried.duplicate).toBe(true)
    expect(retried.reply?.messages[0]?.text).toBe("Reply text")
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("fails clearly on repeated reply retrieval failure without re-admitting", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.wait.mockRejectedValue(new Error("offline"))
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "persistent-reply-failure",
    }

    await expect(bridge.execute("session_send", input)).rejects.toThrow("offline")
    await expect(bridge.execute("session_send", input)).rejects.toThrow(/reply|admission/i)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("fails closed when the admitted message anchor is missing", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.context.mockResolvedValue([
      makeUserMessage("msg_old", "OLD_HISTORY_MUST_NOT_LEAK"),
      makeAssistantMessage("msg_old_reply", [{ type: "text", text: "OLD_REPLY_MUST_NOT_LEAK" }]),
    ])

    await expect(
      bridge.execute("session_send", {
        targetSessionID: "ses_target",
        text: "Please reply",
        waitForReply: true,
      }),
    ).rejects.toThrow(/anchor|admitted|sent message/i)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("returns no reply when the anchor exists but no later text exists", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.context.mockResolvedValue([makeUserMessage("msg_bridge_1", "Please reply")])

    const output = outputOf<SendOutput>(
      await bridge.execute("session_send", {
        targetSessionID: "ses_target",
        text: "Please reply",
        waitForReply: true,
      }),
    )

    expect(output.reply).toEqual({ messages: [], truncated: false })
  })
})

describe("session_send replay authorization", () => {
  it("calls permission.assert again on an idempotent replay", async () => {
    const bridge = await setupBridge(bridgeOptions())
    const input = {
      targetSessionID: "ses_target",
      text: "Replay request",
      idempotencyKey: "permission-replay",
    }

    await bridge.execute("session_send", input)
    await bridge.execute("session_send", input)

    expect(bridge.permission.assert).toHaveBeenCalledTimes(2)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("does not return a cached result when replay permission is denied", async () => {
    const bridge = await setupBridge(bridgeOptions())
    const input = {
      targetSessionID: "ses_target",
      text: "Cached request",
      idempotencyKey: "denied-replay",
    }
    await bridge.execute("session_send", input)
    const denial = new Error("replay denied")
    bridge.permission.assert.mockRejectedValueOnce(denial)

    await expect(bridge.execute("session_send", input)).rejects.toBe(denial)
    expect(bridge.permission.assert).toHaveBeenCalledTimes(2)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("includes the calling agent in idempotency scope", async () => {
    const bridge = await setupBridge(bridgeOptions())
    const input = {
      targetSessionID: "ses_target",
      text: "Same key from two agents",
      idempotencyKey: "agent-scope",
    }

    const first = outputOf<SendOutput>(await bridge.execute("session_send", input))
    const second = outputOf<SendOutput>(
      await bridge.execute("session_send", input, makeToolContext({ agent: "plan" })),
    )

    expect(first.messageID).not.toBe(second.messageID)
    expect(first.provenance.from_agent).toBe("build")
    expect(second.provenance.from_agent).toBe("plan")
    expect(bridge.session.prompt).toHaveBeenCalledTimes(2)
  })
})

describe("session_send reply authorization", () => {
  it("asserts session_read before context on the initial reply retrieval", async () => {
    const bridge = await setupBridge(bridgeOptions())
    const events: string[] = []
    bridge.permission.assert.mockImplementation(async (input) => {
      events.push(input.action)
    })
    bridge.session.context.mockImplementation(async () => {
      events.push("context")
      return replyContext()
    })

    await bridge.execute("session_send", {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
    })

    expect(events).toEqual([
      "session_bridge.session_send",
      "session_bridge.session_read",
      "context",
    ])
  })

  it("asserts send and read permission before returning cached reply text", async () => {
    const bridge = await setupBridge(bridgeOptions())
    const events: string[] = []
    bridge.permission.assert.mockImplementation(async (input) => {
      events.push(input.action)
    })
    bridge.session.context.mockResolvedValue(replyContext())
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "cached-reply-permission",
    }

    await bridge.execute("session_send", input)
    events.length = 0
    await bridge.execute("session_send", input)

    expect(events).toEqual(["session_bridge.session_send", "session_bridge.session_read"])
    expect(bridge.session.context).toHaveBeenCalledTimes(1)
  })

  it("preserves the admission when reply-read permission is denied", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.permission.assert
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("read denied"))
    bridge.session.context.mockResolvedValue(replyContext())
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "read-permission-retry",
    }

    await expect(bridge.execute("session_send", input)).rejects.toThrow("read denied")
    const retried = outputOf<SendOutput>(await bridge.execute("session_send", input))

    expect(retried.reply?.messages[0]?.text).toBe("Reply text")
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    expect(bridge.session.context).toHaveBeenCalledTimes(1)
  })
})

describe("session_send effective delivery", () => {
  it("forces steer in the prompt, provenance, and output when waiting for a reply", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.context.mockResolvedValue(replyContext())

    const output = outputOf<SendOutput>(
      await bridge.execute("session_send", {
        targetSessionID: "ses_target",
        text: "Please reply",
        delivery: "queue",
        waitForReply: true,
      }),
    )

    expect(bridge.session.prompt.mock.calls[0]?.[0].delivery).toBe("steer")
    expect(output.delivery).toBe("steer")
    expect(output.provenance.delivery).toBe("steer")
  })

  it("treats queue and steer as the same idempotent request when waiting", async () => {
    const bridge = await setupBridge(bridgeOptions())
    bridge.session.context.mockResolvedValue(replyContext())
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "normalized-delivery",
    }

    await bridge.execute("session_send", { ...input, delivery: "queue" })
    const replay = outputOf<SendOutput>(
      await bridge.execute("session_send", { ...input, delivery: "steer" }),
    )

    expect(replay.duplicate).toBe(true)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })
})
