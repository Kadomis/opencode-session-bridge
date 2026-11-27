import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const entry = readFileSync(resolve(root, "dist/index.js"), "utf8")

describe("published entry point", () => {
  it("contains the task handoff completion protocol", () => {
    // OpenCode loads dist/index.js through the package export. A stale build
    // silently disables the protocol even when src/ is correct.
    expect(entry).toContain("session_bridge_completion")
    expect(entry).toContain("completion_status")
    expect(entry).toContain("session.idle")
    expect(entry).toContain("session.execution.interrupted")
  })
})
