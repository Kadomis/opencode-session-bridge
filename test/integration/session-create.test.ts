import { describe, expect, it } from "bun:test"
import { TOOL_NAMES } from "../../src/index.js"
import {
  makeToolContext,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"

interface CreateOutput {
  sessionID: string
  title: string
  location: { directory: string }
  created: boolean
  prompted: boolean
}

describe("session_create", () => {
  it("registers session_create and creates a session visible through session_list", async () => {
    const bridge = await setupBridge()

    expect(TOOL_NAMES.indexOf("session_create")).toBe(6)
    expect(bridge.tools.size).toBe(8)
    expect(bridge.tools.get("session_create")).toBeDefined()

    const created = outputOf<CreateOutput>(
      await bridge.execute("session_create", { title: "Top level review" }),
    )
    const listed = outputOf<{ sessions: Array<{ id: string; title: string }> }>(
      await bridge.execute("session_list", {}),
    )

    expect(created.created).toBe(true)
    expect(created.sessionID).toMatch(/^ses_/)
    expect(listed.sessions.some((session) => session.id === created.sessionID)).toBe(true)
    expect(bridge.permission.assert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session_bridge.session_create" }),
    )
  })

  it("forwards title, resolved directory, model, agent, permissions and initial prompt", async () => {
    const bridge = await setupBridge()

    const result = await bridge.execute("session_create", {
      title: "Delegated review",
      directory: "reviews/q3",
      model: { providerID: "opencode-go", id: "hy4-flash-free", variant: "fast" },
      agent: "reviewer",
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
      initialPrompt: "Review the Q3 report",
    })
    const output = outputOf<CreateOutput>(result)

    expect(bridge.session.create).toHaveBeenCalledTimes(1)
    const createInput = bridge.session.create.mock.calls[0]?.[0]
    expect(createInput).toEqual(
      expect.objectContaining({
        title: "Delegated review",
        location: { directory: "/workspace/alpha/reviews/q3" },
        model: { providerID: "opencode-go", id: "hy4-flash-free", variant: "fast" },
        agent: "reviewer",
        permissions: expect.arrayContaining([
          { action: "read", resource: "*", effect: "allow" },
        ]),
        metadata: expect.objectContaining({ session_bridge_top_level: true }),
      }),
    )
    expect(bridge.session.prompt).toHaveBeenCalledTimes(1)
    expect(bridge.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: output.sessionID,
        text: "Review the Q3 report",
      }),
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(output).toEqual({
      sessionID: output.sessionID,
      title: "Delegated review",
      location: { directory: "/workspace/alpha/reviews/q3" },
      created: true,
      prompted: true,
    })
  })

  it("accepts the workdir alias and resolves it against the plugin directory", async () => {
    const bridge = await setupBridge()

    const output = outputOf<CreateOutput>(
      await bridge.execute("session_create", { workdir: "nested/path", title: "Workdir alias" }),
    )

    expect(bridge.session.create.mock.calls[0]?.[0]?.location).toEqual({
      directory: "/workspace/alpha/nested/path",
    })
    expect(output.location.directory).toBe("/workspace/alpha/nested/path")
    expect(output.prompted).toBe(false)
    expect(bridge.session.prompt).not.toHaveBeenCalled()
  })

  it("defaults title and directory when they are omitted", async () => {
    const bridge = await setupBridge()

    const output = outputOf<CreateOutput>(await bridge.execute("session_create", {}))

    expect(bridge.session.create.mock.calls[0]?.[0]?.location).toEqual({
      directory: "/workspace/alpha",
    })
    expect(typeof output.title).toBe("string")
    expect(output.created).toBe(true)
    expect(output.prompted).toBe(false)
  })

  it("sets an allow-all permission rule when autoApprove is true", async () => {
    const bridge = await setupBridge()

    await bridge.execute("session_create", {
      title: "Autonomous session",
      autoApprove: true,
      permissions: [{ action: "read", resource: "docs/*", effect: "allow" }],
    })

    expect(bridge.session.create.mock.calls[0]?.[0]?.permissions).toEqual(
      expect.arrayContaining([{ action: "*", resource: "*", effect: "allow" }]),
    )
  })

  it("supports bidirectional communication with a created session", async () => {
    const bridge = await setupBridge()

    const created = outputOf<CreateOutput>(
      await bridge.execute("session_create", {
        title: "Peer session",
        initialPrompt: "Start here",
      }),
    )
    const peerContext = makeToolContext({ sessionID: created.sessionID, agent: "reviewer" })

    await bridge.execute(
      "session_send",
      {
        targetSessionID: created.sessionID,
        text: "Message from caller",
        conversationID: "conv_bidirectional",
      },
      bridge.defaultToolContext,
    )
    await bridge.execute(
      "session_send",
      {
        targetSessionID: bridge.defaultToolContext.sessionID,
        text: "Reply from peer",
        conversationID: "conv_bidirectional",
        inReplyToMessageID: "msg_bridge_1",
      },
      peerContext,
    )

    const promptTexts = bridge.session.prompt.mock.calls.map(([input]) => input.text)
    expect(promptTexts.some((text) => text.includes("Message from caller"))).toBe(true)
    expect(promptTexts.some((text) => text.includes("Reply from peer"))).toBe(true)
    expect(bridge.session.prompt.mock.calls.some(([input]) => input.sessionID === created.sessionID)).toBe(
      true,
    )
    expect(
      bridge.session.prompt.mock.calls.some(
        ([input]) => input.sessionID === bridge.defaultToolContext.sessionID,
      ),
    ).toBe(true)
  })

  it.each([
    ["model", { model: { providerID: 42, id: "test" } }],
    ["model", { model: { providerID: "opencode" } }],
    ["model", { model: [] }],
    ["permissions", { permissions: [{ action: "read", resource: "*", effect: "bogus" }] }],
    ["permissions", { permissions: "allow all" }],
    ["directory", { directory: "/absolute/path" }],
    ["directory", { directory: "../escape" }],
    ["directory", { directory: 42 }],
    ["workdir", { workdir: ["nested"] }],
    ["initialPrompt", { initialPrompt: "" }],
    ["initialPrompt", { initialPrompt: 42 }],
    ["initialPrompt", { initialPrompt: "x".repeat(8_193) }],
    ["autoApprove", { autoApprove: "yes" }],
  ])("rejects invalid %s input before creating a session: %j", async (_field, input) => {
    const bridge = await setupBridge()
    expect(bridge.tools.get("session_create")).toBeDefined()

    await expect(bridge.execute("session_create", input)).rejects.toThrow()
    expect(bridge.session.create).not.toHaveBeenCalled()
    expect(bridge.session.prompt).not.toHaveBeenCalled()
  })

  it("propagates native create failures without sending a prompt", async () => {
    const bridge = await setupBridge()
    bridge.session.create.mockRejectedValueOnce(new Error("server unavailable"))

    await expect(
      bridge.execute("session_create", { initialPrompt: "hello" }),
    ).rejects.toThrow("server unavailable")
    expect(bridge.session.prompt).not.toHaveBeenCalled()
  })

  it("does not create a session when permission is denied", async () => {
    const bridge = await setupBridge()
    expect(bridge.tools.get("session_create")).toBeDefined()
    const denial = new Error("permission denied")
    bridge.permission.assert.mockRejectedValueOnce(denial)

    await expect(bridge.execute("session_create", {})).rejects.toBe(denial)
    expect(bridge.session.create).not.toHaveBeenCalled()
  })
})
