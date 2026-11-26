import { describe, expect, it } from "bun:test"
import {
  makeAssistantMessage,
  makeUserMessage,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"

describe("concurrent idempotent replay", () => {
  it("keeps the captured task when it settles during replay read permission", async () => {
    let sequence = 0
    const bridge = await setupBridge({
      now: () => 7_000,
      newMessageID: () => `msg_bridge_${++sequence}`,
      rateLimit: { maxRequests: 10, windowMs: 60_000 },
    })
    let firstWaitStarted: (() => void) | undefined
    const waitStarted = new Promise<void>((resolve) => {
      firstWaitStarted = resolve
    })
    let releaseFirstWait: (() => void) | undefined
    const firstWaitGate = new Promise<void>((resolve) => {
      releaseFirstWait = resolve
    })
    bridge.session.wait.mockImplementationOnce(() => {
      firstWaitStarted?.()
      return firstWaitGate
    })
    bridge.session.context.mockResolvedValue([
      makeUserMessage("msg_bridge_1", "Please reply"),
      makeAssistantMessage("msg_reply", [{ type: "text", text: "Reply" }]),
    ])

    let readPermissionCalls = 0
    let replayReadStarted: (() => void) | undefined
    const replayReadGateStarted = new Promise<void>((resolve) => {
      replayReadStarted = resolve
    })
    let releaseReplayRead: (() => void) | undefined
    const replayReadGate = new Promise<void>((resolve) => {
      releaseReplayRead = resolve
    })
    bridge.permission.assert.mockImplementation(async (input) => {
      if (input.action !== "session_bridge.session_read") return
      readPermissionCalls += 1
      if (readPermissionCalls === 2) {
        replayReadStarted?.()
        await replayReadGate
      }
    })
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "settle-during-permission",
    }

    const firstPromise = bridge.execute("session_send", input)
    await waitStarted
    const replayPromise = bridge.execute("session_send", input)
    await replayReadGateStarted
    releaseFirstWait?.()
    const first = outputOf<{ messageID: string }>(await firstPromise)
    releaseReplayRead?.()
    const replay = outputOf<{ messageID: string; duplicate: boolean }>(await replayPromise)

    expect(replay.messageID).toBe(first.messageID)
    expect(replay.duplicate).toBe(true)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    expect(bridge.session.wait).toHaveBeenCalledTimes(1)
    expect(bridge.session.context).toHaveBeenCalledTimes(1)
  })
})
