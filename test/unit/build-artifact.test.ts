import { describe, expect, it } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const source = resolve(root, "src/index.ts")
const entry = resolve(root, "dist/index.js")
const built = readFileSync(entry, "utf8")

describe("published entry point", () => {
  it("is at least as new as the source", () => {
    // OpenCode loads dist/index.js through the package export. A stale build
    // silently disables the protocol even when src/ is correct.
    expect(statSync(entry).mtimeMs).toBeGreaterThanOrEqual(statSync(source).mtimeMs)
  })

  it("contains the task handoff completion protocol", () => {
    expect(built).toContain("session_bridge_completion")
    expect(built).toContain("completion_status")
    expect(built).toContain("session.idle")
    expect(built).toContain("session.execution.interrupted")
  })
})
