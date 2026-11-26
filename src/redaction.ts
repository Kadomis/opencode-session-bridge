export interface ReadableMessage {
  id?: unknown
  type?: unknown
  text?: unknown
  content?: unknown
  files?: unknown
  metadata?: unknown
}

export interface ReadOptions {
  limit: number
  maxCharsPerMessage: number
  maxTotalChars: number
}

export interface ReadableResult {
  messages: Array<{
    messageID: string
    role: "user" | "assistant"
    text: string
    truncated: boolean
  }>
  truncated: boolean
}

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s]+)(@)/gi
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi
const BASIC = /\bBasic\s+([A-Za-z0-9+/=]+)/gi
const SESSION_COOKIE = /(\bsession=)([^;\s]+)/gi
const TOKEN_AUTH = /(\bAuthorization:\s*)Token\s+([A-Za-z0-9._~+/-]+=*)/gi
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const KNOWN_SECRET =
  /(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xoxb-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|sk_live_[A-Za-z0-9]{16,})\b/g
const QUOTED_ASSIGNMENT =
  /(("?(?:aws_secret_access_key|opencode_api_key|secret_key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)"?)\s*[:=]\s*)(["'])(.*?)\3/gi
const ASSIGNMENT =
  /((?:aws_secret_access_key|opencode_api_key|secret_key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)|"(?:aws_secret_access_key|opencode_api_key|secret_key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)"|'(?:aws_secret_access_key|opencode_api_key|secret_key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)')(\s*[:=]\s*)(?!\[REDACTED\]|"\[REDACTED\]"|'\[REDACTED\]')(?:"[^"]*"|'[^']*'|[^\s]+)/gi

function redactPrivateKeys(input: string): string {
  const begin = "-----BEGIN "
  let cursor = 0
  let output = ""
  while (cursor < input.length) {
    const start = input.indexOf(begin, cursor)
    if (start < 0) break
    const headerEnd = input.indexOf("-----", start + begin.length)
    if (headerEnd < 0) return output + input.slice(cursor, start) + "[REDACTED]"
    const header = input.slice(start, headerEnd + 5)
    if (!header.includes("PRIVATE KEY")) {
      cursor = start + begin.length
      continue
    }
    const endMarker = header.replace("BEGIN", "END")
    const end = input.indexOf(endMarker, headerEnd + 5)
    output += input.slice(cursor, start) + "[REDACTED]"
    if (end < 0) return output
    cursor = end + endMarker.length
  }
  return output + input.slice(cursor)
}

export function redactSecrets(input: string): string {
  return redactPrivateKeys(input)
    .replace(URL_CREDENTIALS, "$1[REDACTED]$3")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(BASIC, "Basic [REDACTED]")
    .replace(TOKEN_AUTH, "$1Token [REDACTED]")
    .replace(SESSION_COOKIE, "$1[REDACTED]")
    .replace(JWT, "[REDACTED]")
    .replace(KNOWN_SECRET, "[REDACTED]")
    .replace(QUOTED_ASSIGNMENT, "$1$3[REDACTED]$3")
    .replace(ASSIGNMENT, "$1$2[REDACTED]")
}

export function truncateText(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative integer")
  }
  const characters = Array.from(input)
  if (characters.length <= maxChars) return { text: input, truncated: false }
  return { text: characters.slice(0, maxChars).join(""), truncated: true }
}

function readableText(message: ReadableMessage): string | undefined {
  if (typeof message.id !== "string" || message.id.length === 0) return undefined
  if (message.type === "user" && typeof message.text === "string") return message.text
  if (message.type === "assistant" && Array.isArray(message.content)) {
    const parts = message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
    if (parts.length > 0) return parts.join("\n")
  }
  return undefined
}

export function extractReadableText(messages: readonly ReadableMessage[], options: ReadOptions): ReadableResult {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    !Number.isInteger(options.maxCharsPerMessage) ||
    options.maxCharsPerMessage < 1 ||
    !Number.isInteger(options.maxTotalChars) ||
    options.maxTotalChars < 1
  ) {
    throw new RangeError("read bounds must be positive integers")
  }

  const latest: Array<{ messageID: string; role: "user" | "assistant"; text: string }> = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || (message.type !== "user" && message.type !== "assistant")) continue
    const text = readableText(message)
    if (text === undefined || text.length === 0) continue
    latest.push({
      messageID: message.id as string,
      role: message.type,
      text: redactSecrets(text),
    })
    if (latest.length === options.limit) break
  }
  latest.reverse()

  let remaining = options.maxTotalChars
  let truncated = false
  const selected: ReadableResult["messages"] = []

  for (let index = latest.length - 1; index >= 0; index -= 1) {
    const message = latest[index]
    if (!message || remaining <= 0) {
      truncated = true
      continue
    }
    const perMessage = truncateText(message.text, options.maxCharsPerMessage)
    const total = truncateText(perMessage.text, remaining)
    selected.push({
      messageID: message.messageID,
      role: message.role,
      text: total.text,
      truncated: perMessage.truncated || total.truncated,
    })
    remaining -= Array.from(total.text).length
    if (perMessage.truncated || total.truncated) truncated = true
  }

  selected.reverse()
  return { messages: selected, truncated }
}
