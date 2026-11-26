import { describe, expect, it } from "bun:test"
import { setupBridge } from "../helpers/fake-context.js"

const CASES = [
  ["session_list", {}, "list"],
  ["session_send", { targetSessionID: "ses_target", text: "Hello" }, "prompt"],
  ["session_wait", { sessionID: "ses_target" }, "wait"],
  ["session_read", { sessionID: "ses_target" }, "context"],
  [
    "session_delete",
    { sessionID: "ses_target", confirmSessionID: "ses_target", reason: "Cleanup" },
    "remove",
  ],
  ["session_interrupt", { sessionID: "ses_target" }, "interrupt"],
  ["session_create", { title: "Rate limited create" }, "create"],
  ["session_cleanup_subagents", { reason: "Cleanup" }, "list"],
] as const

describe("rate limiting for every bridge tool", () => {
  it.each(CASES)("%s consumes the configured caller limiter", async (name, input, nativeMethod) => {
    const bridge = await setupBridge({
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
    })

    await bridge.execute(name, input)
    await expect(bridge.execute(name, input)).rejects.toThrow(/rate limit/i)

    expect(bridge.permission.assert).toHaveBeenCalledTimes(2)
    expect(bridge.session[nativeMethod]).toHaveBeenCalledTimes(1)
  })
})
