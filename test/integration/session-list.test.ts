import { describe, expect, it } from "bun:test"
import {
  expectPermissionAssert,
  makeSessionInfo,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"

describe("session_list", () => {
  it("lists server-visible sessions across projects by default", async () => {
    const bridge = await setupBridge()

    const result = await bridge.execute("session_list", {})
    const output = outputOf<{
      sessions: Array<{ id: string; projectID: string; title?: string }>
      cursor: Record<string, unknown>
    }>(result)

    expect(bridge.session.list).toHaveBeenCalledWith(
      { limit: 50, order: "desc" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(output.sessions.map((session) => session.id)).toEqual(["ses_alpha", "ses_beta"])
    expect(output.sessions.map((session) => session.projectID)).toEqual([
      "project_alpha",
      "project_beta",
    ])
    expect(output.cursor).toEqual({})
    expectPermissionAssert(bridge, "session_list", "session:*")
  })

  it("forwards filters and cursors without narrowing to the caller project", async () => {
    const bridge = await setupBridge()
    bridge.session.list.mockResolvedValueOnce({
      data: [],
      cursor: { next: "next_cursor" },
    })

    const result = await bridge.execute("session_list", {
      limit: 10,
      order: "asc",
      search: "review",
      cursor: "cursor_1",
      directory: "/workspace/beta",
      project: "project_beta",
    })
    const output = outputOf<{ cursor: { next?: string } }>(result)

    expect(bridge.session.list).toHaveBeenCalledWith(
      {
        limit: 10,
        order: "asc",
        search: "review",
        cursor: "cursor_1",
        directory: "/workspace/beta",
        project: "project_beta",
      },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(output.cursor.next).toBe("next_cursor")
  })

  it("returns a minimal DTO without sensitive or arbitrary session state", async () => {
    const bridge = await setupBridge()
    bridge.session.list.mockResolvedValueOnce({
      data: [
        {
          ...makeSessionInfo(
            "ses_alpha",
            "project_alpha",
            "/workspace/alpha",
            "Alpha sk-abcdefghijklmnopqrstuvwxyz123456",
          ),
          parentID: "ses_parent",
          agent: "build",
          outcome: "succeeded",
          model: { providerID: "opencode", id: "private-model" },
          tokens: { input: 999, output: 999, reasoning: 999, cache: { read: 999, write: 999 } },
          cost: 123,
          metadata: { arbitrary_secret: "METADATA_SECRET" },
          permissions: [{ action: "edit", resource: "*", effect: "allow" }],
          revert: { messageID: "msg_revert", files: [] },
          subpath: "private/subpath",
          location: { directory: "/workspace/alpha", workspaceID: "WORKSPACE_SECRET" },
        } as never,
      ],
      cursor: {},
    })

    const output = outputOf<{
      sessions: Array<Record<string, unknown>>
    }>(await bridge.execute("session_list", {}))
    const session = output.sessions[0]

    expect(session).toEqual({
      id: "ses_alpha",
      title: "Alpha [REDACTED]",
      projectID: "project_alpha",
    })
    for (const field of ["directory", "time", "parentID", "agent", "outcome"]) {
      expect(session).not.toHaveProperty(field)
    }
    for (const secret of [
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      "METADATA_SECRET",
      "WORKSPACE_SECRET",
      "private-model",
      "private/subpath",
      "msg_revert",
    ]) {
      expect(JSON.stringify(output)).not.toContain(secret)
    }
  })

  it.each([{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { order: "sideways" }])(
    "rejects invalid list input before calling the server: %j",
    async (input) => {
      const bridge = await setupBridge()

      await expect(bridge.execute("session_list", input)).rejects.toThrow()
      expect(bridge.session.list).not.toHaveBeenCalled()
      expect(bridge.permission.assert).not.toHaveBeenCalled()
    },
  )

  it("propagates native list failures", async () => {
    const bridge = await setupBridge()
    bridge.session.list.mockRejectedValueOnce(new Error("server unavailable"))

    await expect(bridge.execute("session_list", {})).rejects.toThrow("server unavailable")
  })

  it("does not list sessions when permission is denied", async () => {
    const bridge = await setupBridge()
    const denial = new Error("permission denied")
    bridge.permission.assert.mockRejectedValueOnce(denial)

    await expect(bridge.execute("session_list", {})).rejects.toBe(denial)
    expect(bridge.session.list).not.toHaveBeenCalled()
  })
})
