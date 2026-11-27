import { describe, expect, it } from "bun:test"
import { coreCall, isCoreAvailable, shutdownCore } from "../../src/core-client.js"

const handoff = {
  originSessionID: "ses_caller",
  targetSessionID: "ses_target",
  messageID: "msg_task",
  conversationID: "conv_1",
  createdAt: 1_234,
}

describe.skipIf(!isCoreAvailable())("Rust core protocol", () => {
  it("answers a ping through the JSON-lines protocol", async () => {
    expect(await coreCall("ping")).toEqual({ ready: true })
  })

  it("validates a task handoff in Rust", async () => {
    const result = await coreCall<Record<string, unknown>>("validate_send", {
      callerSessionID: "ses_caller",
      input: {
        targetSessionID: "ses_target",
        text: "work",
        intent: "task",
        conversationID: "conv_1",
      },
    })
    expect(result).toEqual(
      expect.objectContaining({ conversationID: "conv_1", intent: "task", delivery: "queue" }),
    )
  })

  it("rejects a completion-intent send in Rust", async () => {
    await expect(
      coreCall("validate_send", {
        callerSessionID: "ses_caller",
        input: {
          targetSessionID: "ses_target",
          text: "fake completion",
          intent: "completion",
        },
      }),
    ).rejects.toThrow(/completion/i)
  })

  it("builds a completion payload carrying redacted output", async () => {
    const result = await coreCall<{ text: string; metadata: Record<string, unknown> }>(
      "build_completion",
      {
        handoff,
        status: "completed",
        resultText: "Result sk-abcdefghijklmnopqrstuvwxyz123456",
        messageID: "msg_done",
        now: 5_000,
      },
    )
    expect(result.text).toContain("[REDACTED]")
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
    expect(JSON.stringify(result.metadata)).toContain("\"in_reply_to\":\"msg_task\"")
  })

  it("cleans up the child process", async () => {
    await shutdownCore()
  })
})
