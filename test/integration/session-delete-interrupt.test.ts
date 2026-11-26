import { describe, expect, it } from "bun:test"
import {
  expectPermissionAssert,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"
import { MAX_REASON_LENGTH } from "../../src/validation.js"

describe("session_delete", () => {
  it("requires and records an exact confirmation plus a reason", async () => {
    const bridge = await setupBridge()

    const result = await bridge.execute("session_delete", {
      sessionID: "ses_target",
      confirmSessionID: "ses_target",
      reason: "Temporary session is no longer needed",
    })

    expect(bridge.session.remove).toHaveBeenCalledWith(
      { sessionID: "ses_target" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(outputOf(result)).toEqual({ sessionID: "ses_target", deleted: true })
    expectPermissionAssert(bridge, "session_delete", "session:ses_target")
    expect(bridge.permission.assert.mock.calls[0]?.[0].metadata).toEqual(
      expect.objectContaining({ reason: "Temporary session is no longer needed" }),
    )
  })

  it("redacts sensitive delete reasons in the permission preview", async () => {
    const bridge = await setupBridge()
    const secret = "delete-secret-value"

    await bridge.execute("session_delete", {
      sessionID: "ses_target",
      confirmSessionID: "ses_target",
      reason: `Cleanup OPENCODE_API_KEY=${secret}`,
    })

    const metadata = bridge.permission.assert.mock.calls[0]?.[0].metadata
    expect(metadata).toEqual(
      expect.objectContaining({ preview: expect.stringContaining("[REDACTED]") }),
    )
    expect(JSON.stringify(metadata)).not.toContain(secret)
  })

  it("rejects a mismatched confirmation without deleting", async () => {
    const bridge = await setupBridge()

    await expect(
      bridge.execute("session_delete", {
        sessionID: "ses_target",
        confirmSessionID: "ses_other",
        reason: "Cleanup",
      }),
    ).rejects.toThrow(/confirm/i)
    expect(bridge.session.remove).not.toHaveBeenCalled()
    expect(bridge.permission.assert).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    "",
    "   ",
    42,
    "r".repeat(MAX_REASON_LENGTH + 1),
  ])("rejects a missing or invalid reason: %j", async (reason) => {
    const bridge = await setupBridge()

    await expect(
      bridge.execute("session_delete", {
        sessionID: "ses_target",
        confirmSessionID: "ses_target",
        reason,
      }),
    ).rejects.toThrow()
    expect(bridge.session.remove).not.toHaveBeenCalled()
    expect(bridge.permission.assert).not.toHaveBeenCalled()
  })

  it("does not accept a boolean confirmation instead of the session ID", async () => {
    const bridge = await setupBridge()

    await expect(
      bridge.execute("session_delete", {
        sessionID: "ses_target",
        confirmSessionID: true,
        confirm: true,
        reason: "Cleanup",
      }),
    ).rejects.toThrow()
    expect(bridge.session.remove).not.toHaveBeenCalled()
  })

  it("allows confirmed deletion of the calling session", async () => {
    const bridge = await setupBridge()

    await bridge.execute("session_delete", {
      sessionID: "ses_caller",
      confirmSessionID: "ses_caller",
      reason: "This temporary task is complete",
    })

    expect(bridge.session.remove).toHaveBeenCalledWith(
      { sessionID: "ses_caller" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
  })

  it("propagates native deletion failures", async () => {
    const bridge = await setupBridge()
    bridge.session.remove.mockRejectedValueOnce(new Error("session is busy"))

    await expect(
      bridge.execute("session_delete", {
        sessionID: "ses_target",
        confirmSessionID: "ses_target",
        reason: "Cleanup",
      }),
    ).rejects.toThrow("session is busy")
  })

  it("does not delete when permission is denied", async () => {
    const bridge = await setupBridge()
    const denial = new Error("permission denied")
    bridge.permission.assert.mockRejectedValueOnce(denial)

    await expect(
      bridge.execute("session_delete", {
        sessionID: "ses_target",
        confirmSessionID: "ses_target",
        reason: "Cleanup",
      }),
    ).rejects.toBe(denial)
    expect(bridge.session.remove).not.toHaveBeenCalled()
  })
})

describe("session_interrupt", () => {
  it("interrupts without resuming by default", async () => {
    const bridge = await setupBridge()

    const result = await bridge.execute("session_interrupt", { sessionID: "ses_target" })

    expect(bridge.session.interrupt).toHaveBeenCalledWith(
      {
        sessionID: "ses_target",
        resume: false,
      },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(outputOf(result)).toEqual({ sessionID: "ses_target", interrupted: true })
    expectPermissionAssert(bridge, "session_interrupt", "session:ses_target")
  })

  it("supports resume after interruption", async () => {
    const bridge = await setupBridge()
    bridge.session.interrupt.mockResolvedValueOnce({ interrupted: true })

    const result = await bridge.execute("session_interrupt", {
      sessionID: "ses_target",
      resume: true,
    })

    expect(bridge.session.interrupt).toHaveBeenCalledWith(
      {
        sessionID: "ses_target",
        resume: true,
      },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(outputOf(result)).toEqual({ sessionID: "ses_target", interrupted: true })
  })

  it("preserves a native not-interrupted result", async () => {
    const bridge = await setupBridge()
    bridge.session.interrupt.mockResolvedValueOnce({ interrupted: false })

    const output = outputOf<{ interrupted: boolean }>(
      await bridge.execute("session_interrupt", { sessionID: "ses_idle" }),
    )

    expect(output.interrupted).toBe(false)
  })

  it("rejects a non-boolean resume value", async () => {
    const bridge = await setupBridge()

    await expect(
      bridge.execute("session_interrupt", { sessionID: "ses_target", resume: "true" }),
    ).rejects.toThrow()
    expect(bridge.session.interrupt).not.toHaveBeenCalled()
    expect(bridge.permission.assert).not.toHaveBeenCalled()
  })

  it("propagates native interrupt failures", async () => {
    const bridge = await setupBridge()
    bridge.session.interrupt.mockRejectedValueOnce(new Error("interrupt failed"))

    await expect(
      bridge.execute("session_interrupt", { sessionID: "ses_target" }),
    ).rejects.toThrow("interrupt failed")
  })

  it("does not interrupt when permission is denied", async () => {
    const bridge = await setupBridge()
    const denial = new Error("permission denied")
    bridge.permission.assert.mockRejectedValueOnce(denial)

    await expect(
      bridge.execute("session_interrupt", { sessionID: "ses_target" }),
    ).rejects.toBe(denial)
    expect(bridge.session.interrupt).not.toHaveBeenCalled()
  })
})
