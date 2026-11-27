import { describe, expect, it } from "bun:test"
import {
  makeAssistantMessage,
  makeToolContext,
  makeUserMessage,
  outputOf,
  setupBridge,
  type FakeBridgeEvent,
} from "../helpers/fake-context.js"

/**
 * CONTRACT UNDER TEST — task handoff completion callback protocol.
 *
 * 1. session_send with intent "task" registers a pending handoff and returns
 *    immediately with an admission receipt (`admitted: true`). It must never
 *    call session.wait or session.context.
 * 2. The pending handoff record is exposed in the trusted permission metadata as
 *    `metadata.handoff` with server-controlled originSessionID (tool context
 *    sessionID), targetSessionID, messageID, conversationID, createdAt.
 * 3. The plugin subscribes with ctx.event.subscribe({ types }) including
 *    session.idle, session.deleted, session.execution.failed and
 *    session.execution.interrupted.
 * 4. On a target terminal event the plugin prompts the ORIGIN session with
 *    ctx.session.prompt and metadata:
 *      { session_bridge_completion: true,
 *        opencode_session_bridge: { intent: "completion",
 *          conversation_id: <same as task>, in_reply_to: <task message id>,
 *          from_session: <target>, to_session: <origin>,
 *          completion_status: "completed"|"failed"|"cancelled"|"stale" } }
 * 5. After one callback the pending handoff is removed. Completion prompts and
 *    repeat/unrelated events never create another handoff or callback.
 * 6. Task handoffs require a non-empty conversationID. Tool callers may not
 *    send intent "completion" (loop prevention).
 */

interface TaskOutput {
  messageID: string
  sessionID: string
  conversationID: string
  delivery: string
  duplicate: boolean
  admitted?: boolean
  handoff?: boolean
  receipt?: unknown
}

type PromptInput = {
  sessionID?: string
  id?: string
  text?: string
  metadata?: Record<string, unknown> & {
    opencode_session_bridge?: Record<string, unknown>
  }
  delivery?: string
}

type Bridge = Awaited<ReturnType<typeof setupBridge>>

function bridgeOptions(maxRequests = 20) {
  let sequence = 0
  return {
    now: () => 1_234,
    newMessageID: () => `msg_bridge_${++sequence}`,
    rateLimit: { maxRequests, windowMs: 60_000 },
  }
}

function makeEvent(type: string, sessionID: string, extra: Record<string, unknown> = {}): FakeBridgeEvent {
  return { type, data: { sessionID, ...extra } }
}

function promptInputs(bridge: Bridge): PromptInput[] {
  return bridge.session.prompt.mock.calls.map(
    ([input]) => input as unknown as PromptInput,
  )
}

function completionInputs(bridge: Bridge): PromptInput[] {
  return promptInputs(bridge).filter((input) => {
    const provenance = input.metadata?.opencode_session_bridge
    return input.metadata?.session_bridge_completion === true || provenance?.intent === "completion"
  })
}

function pendingHandoffMetadata(bridge: Bridge): Record<string, unknown> {
  const metadata = bridge.permission.assert.mock.calls[0]?.[0].metadata
  return (metadata?.handoff ?? metadata?.pendingHandoff ?? {}) as Record<string, unknown>
}

async function eventually<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = read()
  while (!predicate(last) && Date.now() < deadline) {
    await Bun.sleep(1)
    last = read()
  }
  if (!predicate(last)) throw new Error(`Timed out waiting for ${label}`)
  return last
}

async function sendTask(
  bridge: Bridge,
  overrides: Record<string, unknown> = {},
): Promise<TaskOutput> {
  return outputOf<TaskOutput>(
    await bridge.execute(
      "session_send",
      {
        targetSessionID: "ses_target",
        text: "Do the work and report back",
        conversationID: "conv_task",
        intent: "task",
        delivery: "queue",
        ...overrides,
      },
      makeToolContext({ sessionID: "ses_caller", messageID: "msg_tool_call" }),
    ),
  )
}

describe("task handoff completion callbacks", () => {
  it("registers a server-controlled pending handoff and returns an immediate receipt", async () => {
    const bridge = await setupBridge(bridgeOptions())

    const output = await sendTask(bridge, {
      // Caller-supplied origin fields must never enter the trusted record.
      originSessionID: "ses_spoofed",
      from_session: "ses_spoofed",
      targetSessionID: "ses_target",
      createdAt: 0,
    })

    expect(output).toEqual(
      expect.objectContaining({
        messageID: "msg_bridge_1",
        sessionID: "ses_target",
        conversationID: "conv_task",
        delivery: "queue",
        duplicate: false,
        admitted: true,
      }),
    )
    expect(promptInputs(bridge)).toHaveLength(1)
    expect(promptInputs(bridge)[0]?.sessionID).toBe("ses_target")
    expect(promptInputs(bridge)[0]?.metadata?.opencode_session_bridge).toEqual(
      expect.objectContaining({ intent: "task", conversation_id: "conv_task" }),
    )
    expect(bridge.session.wait).not.toHaveBeenCalled()
    expect(bridge.session.context).not.toHaveBeenCalled()

    expect(pendingHandoffMetadata(bridge)).toEqual(
      expect.objectContaining({
        originSessionID: "ses_caller",
        targetSessionID: "ses_target",
        messageID: "msg_bridge_1",
        conversationID: "conv_task",
        createdAt: 1_234,
      }),
    )
    expect(bridge.event.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        types: expect.arrayContaining([
          "session.idle",
          "session.deleted",
          "session.execution.failed",
          "session.execution.interrupted",
        ]),
      }),
    )
  })

  it("sends a completion callback to the origin when the target becomes idle", async () => {
    const bridge = await setupBridge(bridgeOptions())
    await sendTask(bridge)

    bridge.event.emit(makeEvent("session.idle", "ses_target"))
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "completion callback")

    const completion = completionInputs(bridge)[0]
    expect(completion?.sessionID).toBe("ses_caller")
    expect(completion?.id).toBeDefined()
    expect(typeof completion?.text).toBe("string")
    expect((completion?.text ?? "").length).toBeGreaterThan(0)
    expect(completion?.metadata).toEqual(
      expect.objectContaining({
        session_bridge_completion: true,
        opencode_session_bridge: expect.objectContaining({
          intent: "completion",
          conversation_id: "conv_task",
          in_reply_to: "msg_bridge_1",
          from_session: "ses_target",
          to_session: "ses_caller",
          completion_status: "completed",
          sent_at: expect.any(Number),
        }),
      }),
    )
  })

  it("never waits on the target during the handoff lifecycle", async () => {
    const bridge = await setupBridge(bridgeOptions())
    await sendTask(bridge)
    expect(bridge.session.context).not.toHaveBeenCalled()

    bridge.event.emit(makeEvent("session.idle", "ses_target"))
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "completion callback")

    expect(bridge.session.wait).not.toHaveBeenCalled()
    // The plugin reads target context once to collect the result for the
    // origin. The origin performs no polling or read of its own.
    expect(bridge.session.context).toHaveBeenCalledTimes(1)
  })

  it("does not create another handoff or a callback storm from completion traffic", async () => {
    const bridge = await setupBridge(bridgeOptions())
    await sendTask(bridge)
    bridge.event.emit(makeEvent("session.idle", "ses_target"))
    await eventually(() => completionInputs(bridge).length, (count) => count === 1, "first callback")

    // The completion lands in the origin session; repeat and unrelated events
    // must not feed back into the protocol.
    bridge.event.emit(makeEvent("session.idle", "ses_caller"))
    bridge.event.emit(makeEvent("session.idle", "ses_target"))
    bridge.event.emit(makeEvent("session.idle", "ses_unrelated"))
    await Bun.sleep(10)

    expect(completionInputs(bridge)).toHaveLength(1)
    expect(promptInputs(bridge)).toHaveLength(2)
    expect(bridge.permission.assert).toHaveBeenCalledTimes(1)
  })

  it("reports a failed target once and then forgets the handoff", async () => {
    const bridge = await setupBridge(bridgeOptions())
    await sendTask(bridge)

    bridge.event.emit(
      makeEvent("session.execution.failed", "ses_target", { error: { message: "boom" } }),
    )
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "failure callback")

    expect(completionInputs(bridge)[0]?.metadata?.opencode_session_bridge).toEqual(
      expect.objectContaining({
        intent: "completion",
        in_reply_to: "msg_bridge_1",
        completion_status: "failed",
      }),
    )
    bridge.event.emit(makeEvent("session.idle", "ses_target"))
    await Bun.sleep(10)
    expect(completionInputs(bridge)).toHaveLength(1)
  })

  it("reports a cancelled target once and then forgets the handoff", async () => {
    const bridge = await setupBridge(bridgeOptions())
    await sendTask(bridge)

    bridge.event.emit(
      makeEvent("session.execution.interrupted", "ses_target", { reason: "user" }),
    )
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "cancel callback")

    expect(completionInputs(bridge)[0]?.metadata?.opencode_session_bridge).toEqual(
      expect.objectContaining({
        intent: "completion",
        in_reply_to: "msg_bridge_1",
        completion_status: "cancelled",
      }),
    )
    bridge.event.emit(makeEvent("session.idle", "ses_target"))
    await Bun.sleep(10)
    expect(completionInputs(bridge)).toHaveLength(1)
  })

  it("reports a stale/deleted target once and then forgets the handoff", async () => {
    const bridge = await setupBridge(bridgeOptions())
    await sendTask(bridge)

    bridge.event.emit(makeEvent("session.deleted", "ses_target"))
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "stale callback")

    expect(completionInputs(bridge)[0]?.metadata?.opencode_session_bridge).toEqual(
      expect.objectContaining({
        intent: "completion",
        in_reply_to: "msg_bridge_1",
        completion_status: "stale",
      }),
    )
    bridge.event.emit(makeEvent("session.idle", "ses_target"))
    await Bun.sleep(10)
    expect(completionInputs(bridge)).toHaveLength(1)
  })

  it("cleans up each pending handoff independently after its callback", async () => {
    const bridge = await setupBridge(bridgeOptions())
    await sendTask(bridge, { conversationID: "conv_one", targetSessionID: "ses_one" })
    await sendTask(bridge, { conversationID: "conv_two", targetSessionID: "ses_two" })

    bridge.event.emit(makeEvent("session.idle", "ses_two"))
    await eventually(() => completionInputs(bridge).length, (count) => count === 1, "second callback")
    expect(completionInputs(bridge)[0]?.metadata?.opencode_session_bridge).toEqual(
      expect.objectContaining({ conversation_id: "conv_two", in_reply_to: "msg_bridge_2" }),
    )

    bridge.event.emit(makeEvent("session.idle", "ses_one"))
    await eventually(() => completionInputs(bridge).length, (count) => count === 2, "first callback")
    expect(completionInputs(bridge)[1]?.metadata?.opencode_session_bridge).toEqual(
      expect.objectContaining({ conversation_id: "conv_one", in_reply_to: "msg_bridge_1" }),
    )

    bridge.event.emit(makeEvent("session.idle", "ses_one"))
    bridge.event.emit(makeEvent("session.idle", "ses_two"))
    await Bun.sleep(10)
    expect(completionInputs(bridge)).toHaveLength(2)
  })

  it("sends a completion callback when the target idle hook fires", async () => {
    const bridge = await setupBridge(bridgeOptions(), { sessionHook: true })
    await sendTask(bridge)

    await bridge.emitSessionIdle("ses_target")
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "idle hook callback")

    expect(completionInputs(bridge)[0]?.sessionID).toBe("ses_caller")
    expect(completionInputs(bridge)[0]?.metadata).toEqual(
      expect.objectContaining({
        session_bridge_completion: true,
        opencode_session_bridge: expect.objectContaining({
          intent: "completion",
          conversation_id: "conv_task",
          in_reply_to: "msg_bridge_1",
          from_session: "ses_target",
          to_session: "ses_caller",
          completion_status: "completed",
        }),
      }),
    )
    expect(bridge.session.wait).not.toHaveBeenCalled()
    expect(bridge.session.context).toHaveBeenCalledTimes(1)
    expect(bridge.sessionHook).toHaveBeenCalledWith("experimental.idle", expect.any(Function))
  })

  it("carries the target's final output to the origin", async () => {
    const bridge = await setupBridge(bridgeOptions(), { sessionHook: true })
    bridge.setContextMessages([
      makeAssistantMessage("msg_answer", [{ type: "text", text: "RESULT_FROM_TARGET" }]),
    ])
    await sendTask(bridge)

    await bridge.emitSessionIdle("ses_target")
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "result callback")

    expect(completionInputs(bridge)[0]?.text).toContain("RESULT_FROM_TARGET")
    expect(completionInputs(bridge)[0]?.metadata?.opencode_session_bridge).toEqual(
      expect.objectContaining({ has_result: true, result_preview: "RESULT_FROM_TARGET" }),
    )
  })

  it("redacts secrets in the carried result", async () => {
    const bridge = await setupBridge(bridgeOptions(), { sessionHook: true })
    bridge.setContextMessages([
      makeAssistantMessage("msg_secret", [
        { type: "text", text: "Use sk-abcdefghijklmnopqrstuvwxyz123456 for access" },
      ]),
    ])
    await sendTask(bridge)

    await bridge.emitSessionIdle("ses_target")
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "redacted result")

    const text = completionInputs(bridge)[0]?.text ?? ""
    expect(text).toContain("[REDACTED]")
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
  })

  it("returns the last answer after an upstream completion in a multi-hop handoff", async () => {
    const bridge = await setupBridge(bridgeOptions(), { sessionHook: true })
    bridge.setContextMessages([
      makeUserMessage("msg_upstream_callback", "Earlier completion callback"),
      makeAssistantMessage("msg_final_answer", [{ type: "text", text: "FINAL_MULTIHOP_ANSWER" }]),
    ])
    await sendTask(bridge)

    await bridge.emitSessionIdle("ses_target")
    await eventually(() => completionInputs(bridge).length, (count) => count > 0, "multi-hop callback")

    expect(completionInputs(bridge)[0]?.text).toContain("FINAL_MULTIHOP_ANSWER")
    expect(completionInputs(bridge)[0]?.text).not.toContain("Earlier completion callback")
  })

  it("does not emit extra callbacks from repeated or unrelated idle hooks", async () => {
    const bridge = await setupBridge(bridgeOptions(), { sessionHook: true })
    await sendTask(bridge)

    await bridge.emitSessionIdle("ses_target")
    await eventually(() => completionInputs(bridge).length, (count) => count === 1, "first idle callback")
    await bridge.emitSessionIdle("ses_target")
    await bridge.emitSessionIdle("ses_unrelated")
    await Bun.sleep(10)

    expect(completionInputs(bridge)).toHaveLength(1)
    expect(promptInputs(bridge)).toHaveLength(2)
    expect(bridge.permission.assert).toHaveBeenCalledTimes(1)
  })

  it("validates task handoff fields and rejects completion-intent sends", async () => {
    const invalid = await setupBridge(bridgeOptions())
    await expect(
      invalid.execute(
        "session_send",
        {
          targetSessionID: "ses_target",
          text: "Invalid handoff",
          intent: "task",
          conversationID: "line\u0000separator",
        },
        makeToolContext({ sessionID: "ses_caller" }),
      ),
    ).rejects.toThrow()
    expect(invalid.session.prompt).not.toHaveBeenCalled()

    const missing = await setupBridge(bridgeOptions())
    await expect(
      missing.execute(
        "session_send",
        { targetSessionID: "ses_target", text: "No conversation", intent: "task" },
        makeToolContext({ sessionID: "ses_caller" }),
      ),
    ).rejects.toThrow()
    expect(missing.session.prompt).not.toHaveBeenCalled()

    const loop = await setupBridge(bridgeOptions())
    await expect(
      loop.execute(
        "session_send",
        {
          targetSessionID: "ses_target",
          text: "Pretend to be a completion",
          intent: "completion",
          conversationID: "conv_task",
          inReplyToMessageID: "msg_bridge_1",
        },
        makeToolContext({ sessionID: "ses_caller" }),
      ),
    ).rejects.toThrow(/completion/i)
    expect(loop.session.prompt).not.toHaveBeenCalled()
    loop.event.emit(makeEvent("session.idle", "ses_target"))
    await Bun.sleep(10)
    expect(completionInputs(loop)).toHaveLength(0)
  })
})
