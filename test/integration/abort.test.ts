import { describe, expect, it } from "bun:test"
import {
  makeAssistantMessage,
  makePromptResult,
  makeToolContext,
  makeUserMessage,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"

function abortedContext() {
  const controller = new AbortController()
  controller.abort()
  return makeToolContext({ signal: controller.signal })
}

describe("pre-aborted tool contexts", () => {
  it("prevents permission and native side effects for all eight tools", async () => {
    const bridge = await setupBridge()
    const cases = [
      ["session_list", {}],
      ["session_send", { targetSessionID: "ses_target", text: "Hello" }],
      ["session_wait", { sessionID: "ses_target" }],
      ["session_read", { sessionID: "ses_target" }],
      [
        "session_delete",
        { sessionID: "ses_target", confirmSessionID: "ses_target", reason: "Cleanup" },
      ],
      ["session_interrupt", { sessionID: "ses_target" }],
    ] as const

    for (const [name, input] of cases) {
      await expect(bridge.execute(name, input, abortedContext())).rejects.toThrow(/abort/i)
    }

    expect(bridge.permission.assert).not.toHaveBeenCalled()
    expect(bridge.session.list).not.toHaveBeenCalled()
    expect(bridge.session.prompt).not.toHaveBeenCalled()
    expect(bridge.session.wait).not.toHaveBeenCalled()
    expect(bridge.session.context).not.toHaveBeenCalled()
    expect(bridge.session.remove).not.toHaveBeenCalled()
    expect(bridge.session.interrupt).not.toHaveBeenCalled()
  })

  it("does not consume rate-limit capacity", async () => {
    const bridge = await setupBridge({
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
    })

    await expect(
      bridge.execute(
        "session_send",
        { targetSessionID: "ses_target", text: "Aborted" },
        abortedContext(),
      ),
    ).rejects.toThrow(/abort/i)
    await bridge.execute("session_send", { targetSessionID: "ses_target", text: "Allowed" })

    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })
})

describe("abort during permission", () => {
  it("does not perform a session side effect after a late permission approval", async () => {
    const bridge = await setupBridge({
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
    })
    let resolvePermission: (() => void) | undefined
    bridge.permission.assert.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePermission = resolve
        }),
    )
    const controller = new AbortController()
    const pending = bridge.execute(
      "session_send",
      { targetSessionID: "ses_target", text: "Late approval" },
      makeToolContext({ signal: controller.signal }),
    )

    expect(bridge.permission.assert).toHaveBeenCalledTimes(1)
    controller.abort()
    resolvePermission?.()
    await expect(pending).rejects.toThrow(/abort/i)

    expect(bridge.session.prompt).not.toHaveBeenCalled()
    await bridge.execute("session_send", { targetSessionID: "ses_target", text: "Fresh call" })
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })
})

describe("abort during native operations", () => {
  it("passes the tool signal to wait and rejects when it aborts", async () => {
    const bridge = await setupBridge()
    const controller = new AbortController()
    let markWaitStarted: (() => void) | undefined
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve
    })
    bridge.session.wait.mockImplementationOnce(
      (_input, options) => {
        markWaitStarted?.()
        return new Promise<void>((_resolve, reject) => {
          const signal = options?.signal
          if (!signal) {
            reject(new Error("native wait did not receive abort signal"))
            return
          }
          if (signal.aborted) {
            reject(new Error("aborted before wait"))
            return
          }
          signal?.addEventListener("abort", () => reject(new Error("aborted during wait")), {
            once: true,
          })
        })
      },
    )

    const pending = bridge.execute(
      "session_wait",
      { sessionID: "ses_target" },
      makeToolContext({ signal: controller.signal }),
    )
    await waitStarted
    controller.abort()

    await expect(pending).rejects.toThrow(/abort/i)
    expect(bridge.session.wait).toHaveBeenCalledWith(
      { sessionID: "ses_target" },
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it("records admission when an aborted native prompt later succeeds", async () => {
    let sequence = 0
    const bridge = await setupBridge({
      now: () => 6_000,
      newMessageID: () => `msg_bridge_${++sequence}`,
      rateLimit: { maxRequests: 10, windowMs: 60_000 },
    })
    let markPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve
    })
    let resolvePrompt: ((value: ReturnType<typeof makePromptResult>) => void) | undefined
    const nativePrompt = new Promise<ReturnType<typeof makePromptResult>>((resolve) => {
      resolvePrompt = resolve
    })
    bridge.session.prompt.mockImplementationOnce(() => {
      markPromptStarted?.()
      return nativePrompt
    })
    const controller = new AbortController()
    const input = {
      targetSessionID: "ses_target",
      text: "Late native admission",
      idempotencyKey: "late-prompt-success",
    }

    const pending = bridge.execute(
      "session_send",
      input,
      makeToolContext({ signal: controller.signal }),
    )
    await promptStarted
    controller.abort(new Error("caller aborted"))
    await expect(pending).rejects.toThrow(/abort/i)

    const promptInput = bridge.session.prompt.mock.calls[0]?.[0]
    if (!promptInput) throw new Error("Expected native prompt call")
    resolvePrompt?.(makePromptResult(promptInput))
    await nativePrompt
    await Promise.resolve()
    const retried = outputOf<{ messageID: string; duplicate: boolean }>(
      await bridge.execute("session_send", input),
    )

    expect(retried.messageID).toBe("msg_bridge_1")
    expect(retried.duplicate).toBe(true)
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("preserves an admitted message when abort interrupts reply waiting", async () => {
    let sequence = 0
    const bridge = await setupBridge({
      now: () => 4_000,
      newMessageID: () => `msg_bridge_${++sequence}`,
      rateLimit: { maxRequests: 10, windowMs: 60_000 },
    })
    const controller = new AbortController()
    let markWaitStarted: (() => void) | undefined
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve
    })
    bridge.session.wait.mockImplementationOnce(
      (_input, options) => {
        markWaitStarted?.()
        return new Promise<void>((_resolve, reject) => {
          if (!options?.signal) {
            reject(new Error("native wait did not receive abort signal"))
            return
          }
          if (options.signal.aborted) {
            reject(new Error("aborted during reply wait"))
            return
          }
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted during reply wait")),
            { once: true },
          )
        })
      },
    )
    bridge.session.context.mockResolvedValue([
      makeUserMessage("msg_bridge_1", "Please reply"),
      makeAssistantMessage("msg_reply", [{ type: "text", text: "Recovered reply" }]),
    ])
    const input = {
      targetSessionID: "ses_target",
      text: "Please reply",
      waitForReply: true,
      idempotencyKey: "abort-receipt",
    }

    const pending = bridge.execute(
      "session_send",
      input,
      makeToolContext({ signal: controller.signal }),
    )
    await waitStarted
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
    const retried = outputOf<{ messageID: string; duplicate: boolean }>(
      await bridge.execute("session_send", input),
    )

    expect(retried.messageID).toBe("msg_bridge_1")
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    expect(retried.duplicate).toBe(true)
  })
})
