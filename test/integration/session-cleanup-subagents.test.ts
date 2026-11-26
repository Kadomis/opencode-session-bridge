import { describe, expect, it } from "bun:test"
import { TOOL_NAMES } from "../../src/index.js"
import {
  makeSessionInfo,
  outputOf,
  setupBridge,
} from "../helpers/fake-context.js"

type SessionInfo = Awaited<ReturnType<Awaited<ReturnType<typeof setupBridge>>["session"]["get"]>>

interface CleanupOutput {
  deleted: string[]
  skipped: string[]
  candidates: string[]
  dryRun: boolean
}

function child(
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): SessionInfo {
  return makeSessionInfo(id, "project_alpha", "/workspace/alpha", id, {
    parentID: "ses_caller",
    status,
    time: { created: 100, updated: 200, idle: 300 },
    ...extra,
  }) as SessionInfo
}

function topLevel(id: string, extra: Record<string, unknown> = {}): SessionInfo {
  return makeSessionInfo(id, "project_alpha", "/workspace/alpha", id, {
    metadata: { session_bridge_top_level: true },
    status: "idle",
    time: { created: 100, updated: 200, idle: 300 },
    ...extra,
  }) as SessionInfo
}

function wireDiscovery(bridge: Awaited<ReturnType<typeof setupBridge>>, sessions: SessionInfo[]) {
  bridge.session.list.mockResolvedValue({ data: sessions, cursor: {} })
  bridge.session.get.mockImplementation(async ({ sessionID }) => {
    const found = sessions.find((session) => session.id === sessionID)
    if (!found) throw new Error(`unknown session ${sessionID}`)
    return found as never
  })
}

describe("session_cleanup_subagents", () => {
  it("registers as the eighth bridge tool", async () => {
    const bridge = await setupBridge()

    expect(TOOL_NAMES).toContain("session_cleanup_subagents")
    expect(TOOL_NAMES.length).toBe(8)
    expect(bridge.tools.get("session_cleanup_subagents")).toBeDefined()
    expect(bridge.tools.size).toBe(8)
  })

  it("deletes a completed child subagent and does not delete a top-level session", async () => {
    const bridge = await setupBridge()
    const completedChild = child("ses_child_done", "completed")
    const top = topLevel("ses_top")
    wireDiscovery(bridge, [completedChild, top])

    const output = outputOf<CleanupOutput>(
      await bridge.execute("session_cleanup_subagents", { reason: "Cleanup finished subagents" }),
    )

    expect(bridge.session.remove).toHaveBeenCalledWith(
      { sessionID: "ses_child_done" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(bridge.session.remove).not.toHaveBeenCalledWith(
      { sessionID: "ses_top" },
      expect.anything(),
    )
    expect(output.deleted).toEqual(["ses_child_done"])
    expect(output.skipped).toContain("ses_top")
    expect(bridge.permission.assert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session_bridge.session_cleanup_subagents" }),
    )
  })

  it("treats cancelled, stale and idle child sessions as cleanup candidates", async () => {
    const bridge = await setupBridge()
    wireDiscovery(bridge, [
      child("ses_child_cancelled", "cancelled"),
      child("ses_child_stale", "stale"),
      child("ses_child_idle", "idle"),
      child("ses_child_running", "running"),
    ])

    const output = outputOf<CleanupOutput>(
      await bridge.execute("session_cleanup_subagents", { reason: "Cleanup stale subagents" }),
    )

    expect(output.candidates).toEqual(
      expect.arrayContaining(["ses_child_cancelled", "ses_child_stale", "ses_child_idle"]),
    )
    expect(output.candidates).not.toContain("ses_child_running")
    expect(output.deleted).toEqual(
      expect.arrayContaining(["ses_child_cancelled", "ses_child_stale", "ses_child_idle"]),
    )
    expect(bridge.session.remove).not.toHaveBeenCalledWith(
      { sessionID: "ses_child_running" },
      expect.anything(),
    )
  })

  it("preserves sessions created through session_create even when discovery reports them as children", async () => {
    const bridge = await setupBridge()
    await bridge.execute("session_create", { title: "Keep me" })

    const createInput = bridge.session.create.mock.calls[0]?.[0]
    expect(createInput?.metadata).toEqual(
      expect.objectContaining({ session_bridge_top_level: true }),
    )

    // Simulate discovery after a plugin reload: the session has a parentID and
    // looks idle, but its persisted metadata marks it as top-level.
    const reloadedTop = makeSessionInfo("ses_created", "project_alpha", "/workspace/alpha", "Keep me", {
      parentID: "ses_caller",
      status: "idle",
      metadata: { session_bridge_top_level: true },
    }) as SessionInfo
    const realChild = child("ses_child", "completed")
    wireDiscovery(bridge, [reloadedTop, realChild])

    const output = outputOf<CleanupOutput>(
      await bridge.execute("session_cleanup_subagents", { reason: "Cleanup subagents" }),
    )

    expect(bridge.session.remove).toHaveBeenCalledTimes(1)
    expect(bridge.session.remove).toHaveBeenCalledWith(
      { sessionID: "ses_child" },
      expect.anything(),
    )
    expect(bridge.session.remove).not.toHaveBeenCalledWith(
      { sessionID: "ses_created" },
      expect.anything(),
    )
    expect(output.skipped).toContain("ses_created")
    expect(output.deleted).toEqual(["ses_child"])
  })

  it("re-checks metadata with session.get before removing a discovered child", async () => {
    const bridge = await setupBridge()
    wireDiscovery(bridge, [child("ses_looks_like_child", "completed")])
    bridge.session.get.mockResolvedValueOnce(
      makeSessionInfo("ses_looks_like_child", "project_alpha", "/workspace/alpha", "Protected", {
        parentID: "ses_caller",
        status: "completed",
        metadata: { session_bridge_top_level: true },
      }) as never,
    )

    const output = outputOf<CleanupOutput>(
      await bridge.execute("session_cleanup_subagents", { reason: "Cleanup subagents" }),
    )

    expect(bridge.session.get).toHaveBeenCalledWith(
      { sessionID: "ses_looks_like_child" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
    expect(bridge.session.remove).not.toHaveBeenCalled()
    expect(output.deleted).toEqual([])
    expect(output.skipped).toContain("ses_looks_like_child")
  })

  it("uses explicit session IDs when provided instead of discovery", async () => {
    const bridge = await setupBridge()
    wireDiscovery(bridge, [child("ses_child_a", "completed"), child("ses_child_b", "completed")])

    await bridge.execute("session_cleanup_subagents", {
      sessionIDs: ["ses_child_a"],
      reason: "Cleanup one subagent",
    })

    expect(bridge.session.remove).toHaveBeenCalledTimes(1)
    expect(bridge.session.remove).toHaveBeenCalledWith(
      { sessionID: "ses_child_a" },
      expect.anything(),
    )
  })

  it("returns candidates without removing anything on a dry run", async () => {
    const bridge = await setupBridge()
    wireDiscovery(bridge, [child("ses_child_a", "completed"), child("ses_child_b", "cancelled")])

    const output = outputOf<CleanupOutput>(
      await bridge.execute("session_cleanup_subagents", {
        dryRun: true,
        reason: "Preview subagent cleanup",
      }),
    )

    expect(output.dryRun).toBe(true)
    expect(output.candidates).toEqual(expect.arrayContaining(["ses_child_a", "ses_child_b"]))
    expect(output.deleted).toEqual([])
    expect(bridge.session.remove).not.toHaveBeenCalled()
  })

  it("filters discovered subagents by maxAgeMs", async () => {
    const bridge = await setupBridge()
    const now = Date.now()
    wireDiscovery(bridge, [
      makeSessionInfo("ses_recent", "project_alpha", "/workspace/alpha", "recent", {
        parentID: "ses_caller",
        status: "completed",
        time: { created: now - 10, updated: now - 10, idle: now - 10 },
      }) as SessionInfo,
      makeSessionInfo("ses_old", "project_alpha", "/workspace/alpha", "old", {
        parentID: "ses_caller",
        status: "completed",
        time: { created: now - 100_000, updated: now - 100_000, idle: now - 100_000 },
      }) as SessionInfo,
    ])

    const output = outputOf<CleanupOutput>(
      await bridge.execute("session_cleanup_subagents", {
        dryRun: true,
        maxAgeMs: 60_000,
        reason: "Cleanup old subagents",
      }),
    )

    expect(output.candidates).toContain("ses_old")
    expect(output.candidates).not.toContain("ses_recent")
  })

  it.each([
    { reason: "" },
    { reason: "Cleanup", sessionIDs: "ses_child" },
    { reason: "Cleanup", sessionIDs: ["not-a-session"] },
    { reason: "Cleanup", dryRun: "true" },
    { reason: "Cleanup", maxAgeMs: 0 },
    { reason: "Cleanup", maxAgeMs: -1 },
  ])("rejects invalid cleanup input before removing sessions: %j", async (input) => {
    const bridge = await setupBridge()
    expect(bridge.tools.get("session_cleanup_subagents")).toBeDefined()

    await expect(bridge.execute("session_cleanup_subagents", input)).rejects.toThrow()
    expect(bridge.session.remove).not.toHaveBeenCalled()
  })

  it("propagates native removal failures", async () => {
    const bridge = await setupBridge()
    wireDiscovery(bridge, [child("ses_child", "completed")])
    bridge.session.remove.mockRejectedValueOnce(new Error("session is busy"))

    await expect(
      bridge.execute("session_cleanup_subagents", { reason: "Cleanup" }),
    ).rejects.toThrow("session is busy")
  })

  it("does not remove sessions when permission is denied", async () => {
    const bridge = await setupBridge()
    expect(bridge.tools.get("session_cleanup_subagents")).toBeDefined()
    wireDiscovery(bridge, [child("ses_child", "completed")])
    const denial = new Error("permission denied")
    bridge.permission.assert.mockRejectedValueOnce(denial)

    await expect(
      bridge.execute("session_cleanup_subagents", { reason: "Cleanup" }),
    ).rejects.toBe(denial)
    expect(bridge.session.remove).not.toHaveBeenCalled()
  })
})

describe("explicit session_delete protection for top-level sessions", () => {
  it("still deletes a top-level session when the caller supplies an exact confirmation", async () => {
    const bridge = await setupBridge()

    await bridge.execute("session_delete", {
      sessionID: "ses_top",
      confirmSessionID: "ses_top",
      reason: "The user asked to delete this session",
    })

    expect(bridge.session.remove).toHaveBeenCalledWith(
      { sessionID: "ses_top" },
      expect.objectContaining({ signal: bridge.defaultToolContext.signal }),
    )
  })

  it("rejects a mismatched confirmation for a top-level session", async () => {
    const bridge = await setupBridge()

    await expect(
      bridge.execute("session_delete", {
        sessionID: "ses_top",
        confirmSessionID: "ses_other",
        reason: "The user asked to delete this session",
      }),
    ).rejects.toThrow(/confirm/i)
    expect(bridge.session.remove).not.toHaveBeenCalled()
  })
})
