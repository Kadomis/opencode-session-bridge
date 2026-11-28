import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface CoreProcess {
  write: (line: string) => void
}

let child: ChildProcessWithoutNullStreams | undefined
let activeProcess: CoreProcess | undefined
let unavailable = false
let nextID = 0
let buffer = ""
const pending = new Map<number, PendingCall>()

function binaryPath(): string | undefined {
  const configured = globalThis.process?.env?.OPENCODE_BRIDGE_CORE
  const candidates = [
    configured,
    fileURLToPath(new URL("../rust/target/release/session-bridge-core", import.meta.url)),
    fileURLToPath(new URL("../rust/target/debug/session-bridge-core", import.meta.url)),
  ].filter((value): value is string => typeof value === "string" && value.length > 0)
  return candidates.find((candidate) => existsSync(candidate))
}

function drain(line: string): void {
  if (line.trim().length === 0) return
  let response: { id: number; ok: boolean; result?: unknown; error?: string }
  try {
    response = JSON.parse(line) as typeof response
  } catch {
    return
  }
  const call = pending.get(response.id)
  if (!call) return
  pending.delete(response.id)
  if (response.ok) call.resolve(response.result)
  else call.reject(new Error(response.error ?? "Rust core error"))
}

function ensureChild(): CoreProcess | undefined {
  if (unavailable) return undefined
  if (activeProcess && child && child.exitCode === null) return activeProcess
  const path = binaryPath()
  if (!path) {
    unavailable = true
    return undefined
  }
  const spawned = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] })
  child = spawned
  activeProcess = {
    write: (line) => spawned.stdin.write(line),
  }
  spawned.stdout.setEncoding("utf8")
  spawned.stdout.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) drain(line)
  })
  spawned.on("error", () => {
    for (const call of pending.values()) call.reject(new Error("Rust core process failed"))
    pending.clear()
    child = undefined
    activeProcess = undefined
  })
  spawned.on("close", () => {
    for (const call of pending.values()) call.reject(new Error("Rust core process exited"))
    pending.clear()
    child = undefined
    activeProcess = undefined
  })
  return activeProcess
}

export function isCoreAvailable(): boolean {
  if (unavailable) return false
  return binaryPath() !== undefined
}

let bridgeID = ""

export function setBridgeCoreID(id: string): void {
  bridgeID = id
}

export function getBridgeCoreID(): string {
  return bridgeID
}

export async function coreCall<T>(command: string, payload: unknown = {}): Promise<T> {
  const core = ensureChild()
  if (!core) throw new Error("Rust core is unavailable")
  const id = ++nextID
  return new Promise<T>((resolvePromise, rejectPromise) => {
    pending.set(id, {
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
    })
    try {
      const scoped = typeof payload === "object" && payload !== null
        ? { ...payload, bridgeID }
        : payload
      core.write(`${JSON.stringify({ id, command, payload: scoped })}\n`)
    } catch (error) {
      pending.delete(id)
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function shutdownCore(): Promise<void> {
  if (child && child.exitCode === null) child.kill()
  child = undefined
  activeProcess = undefined
  for (const call of pending.values()) call.reject(new Error("Rust core shut down"))
  pending.clear()
}
