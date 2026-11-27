import { expect, mock } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createSessionBridge } from "../../src/index.js"

type ToolEditor = Parameters<Plugin.Context["tool"]["transform"]>[0] extends (
  callback: infer Editor,
) => unknown
  ? Editor
  : never
type ToolInfo = Parameters<ToolEditor["add"]>[0]
type RegisteredTool = ToolInfo & { readonly id: string }
type ToolContext = Parameters<ToolInfo["execute"]>[1]
type ToolContextOverrides = Partial<
  Omit<ToolContext, "sessionID" | "agent" | "messageID" | "id">
> & {
  sessionID?: string
  agent?: string
  messageID?: string
  id?: string
}
type ToolResult = Awaited<ReturnType<ToolInfo["execute"]>>
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type SessionMessageInfo = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]
type SessionListPage = Awaited<ReturnType<Plugin.Context["session"]["list"]>>
type SessionPromptInput = Parameters<Plugin.Context["session"]["prompt"]>[0]
type SessionPromptResult = Awaited<ReturnType<Plugin.Context["session"]["prompt"]>>
type SessionCreateInput = NonNullable<Parameters<Plugin.Context["session"]["create"]>[0]>
type PermissionAssertInput = Parameters<Plugin.Context["permission"]["assert"]>[0]
type MutableTool = Parameters<ToolEditor["update"]>[1] extends (tool: infer T) => unknown
  ? T
  : never
type SessionHookCallback = (
  input: Parameters<Parameters<Plugin.Context["session"]["hook"]>[1]>[0],
) => Promise<void> | void

export interface FakeContextOptions {
  /** Seed a built-in subagent tool so description rewrites can be verified. */
  readonly builtinSubagent?: string | boolean
  /** Make ctx.session.hook available so context-rule registration can be verified. */
  readonly sessionHook?: boolean
}

/** Minimal shape of an OpenCode event used by the handoff callback protocol. */
export interface FakeBridgeEvent {
  readonly type: string
  readonly data?: Record<string, unknown>
  readonly properties?: Record<string, unknown>
  readonly [key: string]: unknown
}

interface EventSubscriber {
  readonly types?: ReadonlyArray<string>
  readonly signal?: AbortSignal
  readonly queue: FakeBridgeEvent[]
  wake?: () => void
}

export function makeSessionInfo(
  id: string,
  projectID: string,
  directory: string,
  title?: string,
  extra: Record<string, unknown> = {},
): SessionInfo {
  return {
    id,
    projectID,
    title,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 100, updated: 200 },
    location: { directory },
    ...extra,
  } as SessionInfo
}

export function makeUserMessage(
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
): SessionMessageInfo {
  return {
    id,
    type: "user",
    text,
    time: { created: 100 },
    ...extra,
  } as SessionMessageInfo
}

export function makeAssistantMessage(
  id: string,
  content: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode", id: "test-model" },
    content,
    time: { created: 200 },
    ...extra,
  } as SessionMessageInfo
}

export function makePromptResult(input: SessionPromptInput): SessionPromptResult {
  return {
    id: input.id ?? "msg_admitted",
    sessionID: input.sessionID,
    time: { created: 1_000 },
    type: "user",
    payload: { text: input.text },
    delivery: input.delivery ?? "steer",
  } as SessionPromptResult
}

export function makeToolContext(
  overrides: ToolContextOverrides = {},
): ToolContext {
  return {
    sessionID: "ses_caller",
    agent: "build",
    messageID: "msg_tool_call",
    id: "call_bridge",
    signal: new AbortController().signal,
    progress: mock(async () => {}),
    ...overrides,
  } as ToolContext
}

export function outputOf<T>(result: ToolResult): T {
  return result.output as T
}

export function createFakeContext(
  pluginOptions: Record<string, unknown> = {},
  fakeOptions: FakeContextOptions = {},
) {
  const sessions: SessionInfo[] = [
    makeSessionInfo("ses_alpha", "project_alpha", "/workspace/alpha", "Alpha"),
    makeSessionInfo("ses_beta", "project_beta", "/workspace/beta", "Beta"),
  ]

  const list = mock(
    async (
      _input?: Parameters<Plugin.Context["session"]["list"]>[0],
      _options?: Parameters<Plugin.Context["session"]["list"]>[1],
    ): Promise<SessionListPage> => ({ data: [...sessions], cursor: {} }),
  )
  const get = mock(
    async (
      input: Parameters<Plugin.Context["session"]["get"]>[0],
      _options?: Parameters<Plugin.Context["session"]["get"]>[1],
    ) =>
      sessions.find((session) => session.id === input.sessionID) ??
      makeSessionInfo(input.sessionID, "project_alpha", "/workspace/alpha"),
  )
  const create = mock(
    async (
      input?: SessionCreateInput,
      _options?: Parameters<Plugin.Context["session"]["create"]>[1],
    ) => {
      const session = makeSessionInfo(
        "ses_created",
        "project_alpha",
        input?.location?.directory ?? "/workspace/alpha",
        input?.title ?? undefined,
        {
          ...(input?.agent === undefined ? {} : { agent: input.agent }),
          ...(input?.model === undefined ? {} : { model: input.model }),
          ...(input?.metadata === undefined ? {} : { metadata: input.metadata }),
          ...(input?.permissions === undefined ? {} : { permissions: input.permissions }),
        },
      )
      sessions.push(session)
      return session
    },
  )
  const prompt = mock(
    async (
      input: SessionPromptInput,
      _options?: Parameters<Plugin.Context["session"]["prompt"]>[1],
    ) => makePromptResult(input),
  )
  const wait = mock(
    async (
      _input: Parameters<Plugin.Context["session"]["wait"]>[0],
      _options?: Parameters<Plugin.Context["session"]["wait"]>[1],
    ) => {},
  )
  let contextMessages: SessionMessageInfo[] = []
  const context = mock(
    async (
      _input: Parameters<Plugin.Context["session"]["context"]>[0],
      _options?: Parameters<Plugin.Context["session"]["context"]>[1],
    ) => [...contextMessages] as SessionMessageInfo[],
  )
  const setContextMessages = (messages: SessionMessageInfo[]) => {
    contextMessages = [...messages]
  }
  const remove = mock(
    async (
      input: Parameters<Plugin.Context["session"]["remove"]>[0],
      _options?: Parameters<Plugin.Context["session"]["remove"]>[1],
    ) => {
      const index = sessions.findIndex((session) => session.id === input.sessionID)
      if (index >= 0) sessions.splice(index, 1)
    },
  )
  const interrupt = mock(
    async (
      _input: Parameters<Plugin.Context["session"]["interrupt"]>[0],
      _options?: Parameters<Plugin.Context["session"]["interrupt"]>[1],
    ) => ({ interrupted: true }),
  )
  const assertPermission = mock(async (_input: PermissionAssertInput) => {})
  const sessionHooks = new Map<string, SessionHookCallback>()
  const sessionHook = mock(
    async (name: string, callback: SessionHookCallback) => {
      sessionHooks.set(name, callback)
      return {
        dispose: mock(async () => {
          sessionHooks.delete(name)
        }),
      }
    },
  )
  const emitSessionIdle = async (sessionID: string) => {
    const callback = sessionHooks.get("experimental.idle")
    if (!callback) throw new Error("experimental.idle hook is not registered")
    await callback({ sessionID } as unknown as Parameters<SessionHookCallback>[0])
  }

  // Fake ctx.event.subscribe({ types }) as an async iterable. emitEvent() wakes
  // active subscribers so tests can drive completion/idle/failure events.
  const eventSubscribers = new Set<EventSubscriber>()
  const eventHistory: FakeBridgeEvent[] = []
  const eventSubscribe = mock(
    (input?: { types?: ReadonlyArray<string>; signal?: AbortSignal }) => {
      const subscriber: EventSubscriber = {
        ...(input?.types === undefined ? {} : { types: input.types }),
        ...(input?.signal === undefined ? {} : { signal: input.signal }),
        queue: [],
      }
      eventSubscribers.add(subscriber)
      input?.signal?.addEventListener("abort", () => {
        subscriber.wake?.()
        subscriber.wake = undefined
      }, { once: true })
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!subscriber.signal?.aborted) {
              if (subscriber.queue.length > 0) {
                const event = subscriber.queue.shift()
                if (!event) break
                eventHistory.push(event)
                yield event
                continue
              }
              await new Promise<void>((resolve) => {
                subscriber.wake = resolve
              })
            }
          } finally {
            eventSubscribers.delete(subscriber)
          }
        },
      }
    },
  )
  const emitEvent = (event: FakeBridgeEvent) => {
    for (const subscriber of eventSubscribers) {
      if (subscriber.types && !subscriber.types.includes(event.type)) continue
      subscriber.queue.push(event)
      subscriber.wake?.()
      subscriber.wake = undefined
    }
  }

  const tools = new Map<string, RegisteredTool>()
  if (fakeOptions.builtinSubagent !== undefined) {
    const description =
      typeof fakeOptions.builtinSubagent === "string"
        ? fakeOptions.builtinSubagent
        : "Launch a new agent to handle complex tasks."
    tools.set("subagent", {
      name: "subagent",
      description,
      input: { type: "object", additionalProperties: false, properties: {} },
      output: { type: "object", additionalProperties: true },
      options: { codemode: true },
      execute: mock(async () => ({ output: {} })),
      id: "subagent",
    } as unknown as RegisteredTool)
  }
  const editor: ToolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace: mock(() => {}),
    add: mock((tool: ToolInfo) => {
      tools.set(tool.name, { ...tool, id: tool.name })
    }),
    update: mock((id: string, updater: Parameters<ToolEditor["update"]>[1]) => {
      const existing = tools.get(id)
      if (!existing) return
      const mutable = { ...existing } as unknown as MutableTool
      updater(mutable)
      tools.set(id, { ...(mutable as unknown as ToolInfo), id })
    }),
    remove: mock((id: string) => {
      tools.delete(id)
    }),
  }
  const registration = { dispose: mock(async () => {}) }
  const transform = mock(
    async (callback: Parameters<Plugin.Context["tool"]["transform"]>[0]) => {
      callback(editor)
      return registration
    },
  )

  const session: Record<string, unknown> = {
    list,
    get,
    create,
    prompt,
    wait,
    context,
    remove,
    interrupt,
  }
  if (fakeOptions.sessionHook) session.hook = sessionHook

  const ctx = {
    options: pluginOptions,
    location: {
      directory: "/workspace/alpha",
      project: {
        id: "project_alpha",
        directory: "/workspace/alpha",
        canonical: "/workspace/alpha",
      },
    },
    session,
    event: { subscribe: eventSubscribe },
    permission: { assert: assertPermission },
    tool: { transform },
  } as unknown as Plugin.Context

  const defaultToolContext = makeToolContext()

  async function execute(
    name: string,
    input: unknown,
    toolContext: ToolContext = defaultToolContext,
  ): Promise<ToolResult> {
    const tool = tools.get(name)
    if (!tool) throw new Error(`Tool not registered: ${name}`)
    return tool.execute(input, toolContext)
  }

  return {
    ctx,
    session: { list, get, create, prompt, wait, context, remove, interrupt, hook: sessionHook },
    event: { subscribe: eventSubscribe, emit: emitEvent, history: eventHistory, subscribers: eventSubscribers },
    emitSessionIdle,
    sessionHooks,
    setContextMessages,
    permission: { assert: assertPermission },
    tool: { transform },
    registration,
    tools,
    editor,
    execute,
    defaultToolContext,
    sessionHook,
  }
}

export async function setupBridge(
  options?: Parameters<typeof createSessionBridge>[0],
  fakeOptions?: FakeContextOptions,
) {
  const fake = createFakeContext({}, fakeOptions)
  const plugin = createSessionBridge(options)
  const cleanup = await plugin.setup(fake.ctx)
  return {
    ...fake,
    plugin,
    cleanup: typeof cleanup === "function" ? cleanup : () => {},
  }
}

export function expectPermissionAssert(
  fake: ReturnType<typeof createFakeContext>,
  toolName: string,
  resource: string,
): void {
  expect(fake.permission.assert).toHaveBeenCalledTimes(1)
  expect(fake.permission.assert).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionID: fake.defaultToolContext.sessionID,
      agent: fake.defaultToolContext.agent,
      source: {
        type: "tool",
        messageID: fake.defaultToolContext.messageID,
        id: fake.defaultToolContext.id,
      },
      action: `session_bridge.${toolName}`,
      resources: [resource],
    }),
  )
}
