import { describe, expect, it } from "bun:test"
import {
  expectPermissionAssert,
  makeAssistantMessage,
  makeUserMessage,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"

interface ReadOutput {
  sessionID: string
  messages: Array<{ messageID: string; role: string; text: string; truncated: boolean }>
  truncated: boolean
}

describe("session_wait", () => {
  it("delegates to the native wait operation without a turn limit", async () => {
    const bridge = await setupBridge()

    const result = await bridge.execute("session_wait", {
      sessionID: "ses_target",
      maxTurns: 1,
      timeoutMS: 10,
    })

    expect(bridge.session.wait).toHaveBeenCalledWith(
      { sessionID: "ses_target" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(outputOf(result)).toEqual({ sessionID: "ses_target", waited: true })
    expectPermissionAssert(bridge, "session_wait", "session:ses_target")
  })

  it("rejects invalid input before waiting", async () => {
    const bridge = await setupBridge()

    await expect(bridge.execute("session_wait", { sessionID: "" })).rejects.toThrow()
    expect(bridge.session.wait).not.toHaveBeenCalled()
    expect(bridge.permission.assert).not.toHaveBeenCalled()
  })

  it("propagates native wait failures", async () => {
    const bridge = await setupBridge()
    bridge.session.wait.mockRejectedValueOnce(new Error("wait failed"))

    await expect(bridge.execute("session_wait", { sessionID: "ses_target" }))
      .rejects.toThrow("wait failed")
  })

  it("does not wait when permission is denied", async () => {
    const bridge = await setupBridge()
    const denial = new Error("permission denied")
    bridge.permission.assert.mockRejectedValueOnce(denial)

    await expect(bridge.execute("session_wait", { sessionID: "ses_target" })).rejects.toBe(denial)
    expect(bridge.session.wait).not.toHaveBeenCalled()
  })
})

describe("session_read", () => {
  it("returns only user and assistant text and redacts common secrets", async () => {
    const bridge = await setupBridge()
    bridge.session.context.mockResolvedValueOnce([
      makeUserMessage("msg_user", "Use sk-abcdefghijklmnopqrstuvwxyz123456", {
        files: [{ data: "FILE_SECRET", mime: "text/plain" }],
        metadata: { opencode_session_bridge: { from_session: "ses_private" } },
      }),
      makeAssistantMessage("msg_assistant", [
        { type: "reasoning", text: "REASONING_SECRET" },
        { type: "text", text: "Authorization: Bearer abc.def.ghi" },
        { type: "tool", state: { content: "TOOL_SECRET" } },
      ]),
      { id: "msg_system", type: "system", text: "SYSTEM_SECRET" } as never,
      { id: "msg_synthetic", type: "synthetic", text: "SYNTHETIC_SECRET" } as never,
    ])

    const result = await bridge.execute("session_read", { sessionID: "ses_target" })
    const output = outputOf<ReadOutput>(result)

    expect(bridge.session.context).toHaveBeenCalledWith(
      { sessionID: "ses_target" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(output).toEqual({
      sessionID: "ses_target",
      messages: [
        { messageID: "msg_user", role: "user", text: "Use [REDACTED]", truncated: false },
        {
          messageID: "msg_assistant",
          role: "assistant",
          text: "Authorization: Bearer [REDACTED]",
          truncated: false,
        },
      ],
      truncated: false,
    })
    for (const secret of [
      "abcdefghijklmnopqrstuvwxyz",
      "FILE_SECRET",
      "REASONING_SECRET",
      "TOOL_SECRET",
      "SYSTEM_SECRET",
      "SYNTHETIC_SECRET",
      "ses_private",
      "abc.def.ghi",
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    expectPermissionAssert(bridge, "session_read", "session:ses_target")
  })

  it("returns the latest requested number of text messages", async () => {
    const bridge = await setupBridge()
    bridge.session.context.mockResolvedValueOnce([
      makeUserMessage("msg_old", "old"),
      makeAssistantMessage("msg_noise", [{ type: "tool", state: {} }]),
      makeAssistantMessage("msg_new", [{ type: "text", text: "new" }]),
    ])

    const output = outputOf<ReadOutput>(
      await bridge.execute("session_read", { sessionID: "ses_target", limit: 1 }),
    )

    expect(output.messages).toEqual([
      { messageID: "msg_new", role: "assistant", text: "new", truncated: false },
    ])
  })

  it("does not access or redact older messages when limit excludes them", async () => {
    const bridge = await setupBridge()
    const poison = {
      id: "msg_old_poison",
      type: "user",
      get text(): string {
        throw new Error("older text must not be processed")
      },
    }
    bridge.session.context.mockResolvedValueOnce([
      poison as never,
      makeUserMessage("msg_new", "newest text"),
    ])

    const output = outputOf<ReadOutput>(
      await bridge.execute("session_read", { sessionID: "ses_target", limit: 1 }),
    )

    expect(output.messages).toEqual([
      { messageID: "msg_new", role: "user", text: "newest text", truncated: false },
    ])
  })

  it("truncates long messages without splitting emojis", async () => {
    const bridge = await setupBridge()
    bridge.session.context.mockResolvedValueOnce([
      makeUserMessage("msg_emoji", "😀".repeat(50)),
    ])

    const output = outputOf<ReadOutput>(
      await bridge.execute("session_read", {
        sessionID: "ses_target",
        maxCharsPerMessage: 12,
      }),
    )

    expect(output.messages[0]?.text).toBe("😀".repeat(12))
    expect(output.messages[0]?.truncated).toBe(true)
    expect(output.truncated).toBe(true)
  })

  it("enforces the total character budget", async () => {
    const bridge = await setupBridge()
    bridge.session.context.mockResolvedValueOnce([
      makeUserMessage("msg_old", "a".repeat(20)),
      makeUserMessage("msg_new", "b".repeat(20)),
    ])

    const output = outputOf<ReadOutput>(
      await bridge.execute("session_read", {
        sessionID: "ses_target",
        maxTotalChars: 25,
      }),
    )

    expect(output.messages.map((message) => message.text).join("")).toHaveLength(25)
    expect(output.messages[1]?.text).toBe("b".repeat(20))
    expect(output.truncated).toBe(true)
  })

  it("returns an empty message list for an empty session", async () => {
    const bridge = await setupBridge()

    const output = outputOf<ReadOutput>(
      await bridge.execute("session_read", { sessionID: "ses_empty" }),
    )

    expect(output).toEqual({ sessionID: "ses_empty", messages: [], truncated: false })
  })

  it.each([
    { limit: 0 },
    { limit: 201 },
    { maxCharsPerMessage: 0 },
    { maxTotalChars: 100_001 },
  ])("rejects invalid read bounds before reading: %j", async (input) => {
    const bridge = await setupBridge()

    await expect(
      bridge.execute("session_read", { sessionID: "ses_target", ...input }),
    ).rejects.toThrow()
    expect(bridge.session.context).not.toHaveBeenCalled()
    expect(bridge.permission.assert).not.toHaveBeenCalled()
  })

  it("propagates native context failures", async () => {
    const bridge = await setupBridge()
    bridge.session.context.mockRejectedValueOnce(new Error("context unavailable"))

    await expect(bridge.execute("session_read", { sessionID: "ses_target" }))
      .rejects.toThrow("context unavailable")
  })

  it("does not read when permission is denied", async () => {
    const bridge = await setupBridge()
    const denial = new Error("permission denied")
    bridge.permission.assert.mockRejectedValueOnce(denial)

    await expect(bridge.execute("session_read", { sessionID: "ses_target" })).rejects.toBe(denial)
    expect(bridge.session.context).not.toHaveBeenCalled()
  })
})
