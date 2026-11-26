import { describe, expect, it } from "bun:test"
import SessionBridgePlugin, {
  SessionBridgePlugin as NamedSessionBridgePlugin,
  TOOL_NAMES,
} from "../../src/index.js"
import { createFakeContext } from "../helpers/fake-context.js"

describe("session bridge plugin", () => {
  it("exports a native V2 plugin with a stable ID", () => {
    expect(SessionBridgePlugin.id).toBe("opencode-session-bridge")
    expect(NamedSessionBridgePlugin).toBe(SessionBridgePlugin)
    expect(TOOL_NAMES).toEqual([
      "session_list",
      "session_send",
      "session_wait",
      "session_read",
      "session_delete",
      "session_interrupt",
      "session_create",
      "session_cleanup_subagents",
    ])
  })

  it("registers all eight tools through the native tool transform", async () => {
    const fake = createFakeContext()

    await SessionBridgePlugin.setup(fake.ctx)

    expect(fake.tool.transform).toHaveBeenCalledTimes(1)
    expect([...fake.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort())
    for (const tool of fake.tools.values()) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.output).toBeDefined()
      expect(typeof tool.execute).toBe("function")
    }
  })

  it("returns a cleanup function that disposes the registration once", async () => {
    const fake = createFakeContext()
    const cleanup = await SessionBridgePlugin.setup(fake.ctx)

    expect(typeof cleanup).toBe("function")
    if (typeof cleanup !== "function") throw new Error("Expected cleanup function")
    await cleanup()
    await cleanup()

    expect(fake.registration.dispose).toHaveBeenCalledTimes(1)
  })

  it("propagates tool registration failures", async () => {
    const fake = createFakeContext()
    fake.tool.transform.mockRejectedValueOnce(new Error("transform failed"))

    await expect(SessionBridgePlugin.setup(fake.ctx)).rejects.toThrow("transform failed")
  })

  it("keeps each plugin instance state isolated", async () => {
    const first = createFakeContext()
    const second = createFakeContext()

    await SessionBridgePlugin.setup(first.ctx)
    await SessionBridgePlugin.setup(second.ctx)

    expect(first.tools).not.toBe(second.tools)
    expect(first.tools.size).toBe(8)
    expect(second.tools.size).toBe(8)
    expect(first.permission.assert).not.toBe(second.permission.assert)
  })

  it("does not call permission assertions during registration", async () => {
    const fake = createFakeContext()

    await SessionBridgePlugin.setup(fake.ctx)

    expect(fake.permission.assert).not.toHaveBeenCalled()
  })
})
