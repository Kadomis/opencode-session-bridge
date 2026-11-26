import { describe, expect, it } from "bun:test"
import {
  createFakeContext,
  type FakeContextOptions,
  setupBridge,
} from "../helpers/fake-context.js"

const ROUTING_PHRASES = [
  "new session",
  "separate session",
  "top-level session",
  "another session to communicate with",
  "subagent",
  "child agent",
  "delegate",
]

function normalized(text: string): string {
  return text.toLowerCase().replace(/top[\s-]+level/g, "top-level").replace(/\s+/g, " ")
}

describe("session routing descriptions", () => {
  it("session_create describes when to use it instead of the built-in subagent", async () => {
    const bridge = await setupBridge()
    const description = normalized(bridge.tools.get("session_create")?.description ?? "")

    for (const phrase of ROUTING_PHRASES) {
      expect(description).toContain(phrase)
    }
    expect(description).toContain("must use session_create")
    expect(description).toContain("not the built-in subagent")
  })

  it("session_send describes when to use session_create instead of the built-in subagent", async () => {
    const bridge = await setupBridge()
    const description = normalized(bridge.tools.get("session_send")?.description ?? "")

    expect(description).toContain("top-level session")
    expect(description).toContain("session_create")
    expect(description).toContain("must use session_create")
    expect(description).toContain("not the built-in subagent")
    expect(description).toContain("subagent")
    expect(description).toContain("child agent")
    expect(description).toContain("delegate")
  })
})

describe("built-in subagent description", () => {
  it("is updated with a routing warning when the tool editor exposes it", async () => {
    const fakeOptions: FakeContextOptions = {
      builtinSubagent: "Launch a new agent to handle complex tasks.",
    }
    const bridge = await setupBridge(undefined, fakeOptions)

    const subagent = bridge.editor.get("subagent")
    expect(subagent).toBeDefined()
    const description = normalized(subagent?.description ?? "")
    expect(description).toContain("warning")
    expect(description).toContain("session_create")
    expect(description).toContain("top-level session")
    expect(description).toContain("subagent")
  })

  it("does not fail when the built-in subagent tool is absent", async () => {
    const bridge = await setupBridge()

    expect(bridge.editor.get("subagent")).toBeUndefined()
    expect(bridge.tools.size).toBe(8)
  })
})

describe("context routing hook", () => {
  it("registers a context hook with a concise routing rule when available", async () => {
    const bridge = await setupBridge(undefined, { sessionHook: true })

    expect(bridge.sessionHook).toHaveBeenCalledWith("context", expect.any(Function))

    const callback = bridge.sessionHook.mock.calls[0]?.[1]
    if (!callback) throw new Error("Expected a context hook callback")
    const input = { system: [] as Array<{ type: "text"; text: string }> }
    await callback(input as never)

    const rule = input.system.map((part) => part.text).join("\n")
    expect(normalized(rule)).toContain("session_create")
    expect(normalized(rule)).toContain("subagent")
    expect(rule.length).toBeLessThan(500)
  })

  it("does not require a context hook when the runtime does not expose one", async () => {
    const fake = createFakeContext()
    expect(fake.ctx.session).not.toHaveProperty("hook")

    const { createSessionBridge } = await import("../../src/index.js")
    await expect(createSessionBridge().setup(fake.ctx)).resolves.toBeDefined()
  })
})
