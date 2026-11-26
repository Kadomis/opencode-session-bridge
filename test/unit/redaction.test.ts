import { describe, expect, it } from "bun:test"
import {
  extractReadableText,
  redactSecrets,
  truncateText,
  type ReadableMessage,
} from "../../src/redaction.js"

const READ_OPTIONS = Object.freeze({
  limit: 50,
  maxCharsPerMessage: 4_000,
  maxTotalChars: 16_000,
})

describe("redactSecrets", () => {
  it.each([
    ["OpenAI key", "sk-abcdefghijklmnopqrstuvwxyz123456"],
    ["Anthropic key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"],
    [
      "GitHub fine-grained token",
      "github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ],
    ["AWS access key", "AKIAIOSFODNN7EXAMPLE"],
    ["AWS session key", "ASIAIOSFODNN7EXAMPLE"],
    ["GitLab token", "glpat-abcdefghijklmnopqrstuvwxyz"],
    ["npm token", "npm_abcdefghijklmnopqrstuvwxyz1234567890"],
    ["Slack token", ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-")],
    ["Google API key", "AIzaSyA1234567890123456789012345678901234"],
    ["Stripe key", ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_")],
  ])("redacts a %s", (_label, secret) => {
    const redacted = redactSecrets(`before ${secret} after`)

    expect(redacted).not.toContain(secret)
    expect(redacted).toContain("[REDACTED]")
    expect(redacted).toContain("before")
    expect(redacted).toContain("after")
  })

  it("redacts bearer authorization values", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-ghi_jkl.mno"))
      .toBe("Authorization: Bearer [REDACTED]")
  })

  it("redacts Basic authorization values", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA=="))
      .toBe("Authorization: Basic [REDACTED]")
  })

  it("redacts Token authorization values", () => {
    expect(redactSecrets("Authorization: Token token-secret"))
      .toBe("Authorization: Token [REDACTED]")
  })

  it("redacts SECRET_KEY assignments", () => {
    expect(redactSecrets("SECRET_KEY=secret-key-value"))
      .toBe("SECRET_KEY=[REDACTED]")
  })

  it.each([
    ["API_KEY=alpha,beta;gamma", "API_KEY=[REDACTED]"],
    ["password=alpha;beta,gamma trailing", "password=[REDACTED] trailing"],
  ])("redacts complete unquoted assignment values: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it("redacts session Cookie values without changing other cookies", () => {
    expect(redactSecrets("Cookie: session=abc123; theme=dark"))
      .toBe("Cookie: session=[REDACTED]; theme=dark")
  })

  it.each([
    ['{"api_key": "json-secret"}', '{"api_key": "[REDACTED]"}'],
    ['"api_key": "yaml-secret"', '"api_key": "[REDACTED]"'],
  ])("redacts quoted JSON and YAML api_key values: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it.each([
    [
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "AWS_SECRET_ACCESS_KEY=[REDACTED]",
    ],
    ["OPENCODE_API_KEY=opencode-secret", "OPENCODE_API_KEY=[REDACTED]"],
  ])("redacts cloud API key assignments: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature"

    expect(redactSecrets(`token=${jwt}`)).not.toContain(jwt)
    expect(redactSecrets(`token=${jwt}`)).toContain("[REDACTED]")
  })

  it("redacts complete private key blocks", () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "c2VjcmV0IGtleSBib2R5",
      "-----END PRIVATE KEY-----",
    ].join("\n")

    expect(redactSecrets(privateKey)).not.toContain("c2VjcmV0IGtleSBib2R5")
    expect(redactSecrets(privateKey)).toContain("[REDACTED]")
  })

  it("fails closed for many unterminated PEM headers", () => {
    const input = "-----BEGIN PRIVATE KEY-----\n".repeat(500)

    expect(redactSecrets(input) === "[REDACTED]").toBe(true)
  })

  it("redacts from a malformed PEM header onward when the header has no closing dashes", () => {
    const input = "before -----BEGIN PRIVATE KEY secret-body after"

    expect(redactSecrets(input)).toBe("before [REDACTED]")
  })

  it("redacts credentials embedded in connection URLs", () => {
    expect(redactSecrets("postgres://alice:supersecret@db.example/app"))
      .toBe("postgres://alice:[REDACTED]@db.example/app")
  })

  it.each([
    "API_KEY=abc123",
    "api-key: abc123",
    "password=hunter2",
    'client_secret: "quoted-secret"',
    "ACCESS_TOKEN=bearer-value",
    "refresh_token=refresh-value",
  ])("redacts sensitive assignments: %s", (input) => {
    const redacted = redactSecrets(input)

    expect(redacted).toContain("[REDACTED]")
    expect(redacted).not.toContain("abc123")
    expect(redacted).not.toContain("hunter2")
    expect(redacted).not.toContain("quoted-secret")
    expect(redacted).not.toContain("bearer-value")
    expect(redacted).not.toContain("refresh-value")
  })

  it("redacts multiple secrets in one message", () => {
    const result = redactSecrets(
      "key sk-abcdefghijklmnopqrstuvwxyz123456 and password=hunter2",
    )

    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2)
  })

  it("is idempotent", () => {
    const once = redactSecrets("Bearer abc.def and API_KEY=abc123")
    const twice = redactSecrets(once)

    expect(twice).toBe(once)
  })

  it("preserves ordinary prose and non-secret paths", () => {
    const text = "The token economy uses a password manager. See /secrets/config.md."

    expect(redactSecrets(text)).toBe(text)
  })
})

describe("truncateText", () => {
  it("returns short text unchanged", () => {
    expect(truncateText("hello", 10)).toEqual({ text: "hello", truncated: false })
  })

  it("truncates to the exact character budget", () => {
    expect(truncateText("abcdefghij", 4)).toEqual({ text: "abcd", truncated: true })
  })

  it("does not split Unicode surrogate pairs", () => {
    expect(truncateText("a😀b", 2)).toEqual({ text: "a😀", truncated: true })
  })

  it("supports a zero character budget", () => {
    expect(truncateText("hello", 0)).toEqual({ text: "", truncated: true })
  })

  it.each([-1, 1.5, Number.NaN])("rejects an invalid budget: %j", (maxChars) => {
    expect(() => truncateText("hello", maxChars)).toThrow(RangeError)
  })
})

describe("extractReadableText", () => {
  it("returns only user and assistant text with stable message metadata", () => {
    const messages: ReadableMessage[] = [
      {
        id: "msg_user",
        type: "user",
        text: "Please review",
        files: [{ data: "FILE_CONTENT_MUST_NOT_LEAK" }],
      },
      {
        id: "msg_assistant",
        type: "assistant",
        content: [
          { type: "reasoning", text: "REASONING_MUST_NOT_LEAK" },
          { type: "text", text: "First part" },
          { type: "tool", state: { content: "TOOL_MUST_NOT_LEAK" } },
          { type: "text", text: "Second part" },
        ],
      },
      { id: "msg_system", type: "system", text: "SYSTEM_MUST_NOT_LEAK" },
      { id: "msg_synthetic", type: "synthetic", text: "SYNTHETIC_MUST_NOT_LEAK" },
    ]

    const result = extractReadableText(messages, READ_OPTIONS)

    expect(result).toEqual({
      messages: [
        { messageID: "msg_user", role: "user", text: "Please review", truncated: false },
        {
          messageID: "msg_assistant",
          role: "assistant",
          text: "First part\nSecond part",
          truncated: false,
        },
      ],
      truncated: false,
    })
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_LEAK")
  })

  it("redacts secrets before returning text", () => {
    const result = extractReadableText(
      [
        {
          id: "msg_user",
          type: "user",
          text: "Use sk-abcdefghijklmnopqrstuvwxyz123456 to connect",
        },
        {
          id: "msg_assistant",
          type: "assistant",
          content: [{ type: "text", text: "Authorization: Bearer abc.def.ghi" }],
        },
      ],
      READ_OPTIONS,
    )

    expect(result.messages[0]?.text).toBe("Use [REDACTED] to connect")
    expect(result.messages[1]?.text).toBe("Authorization: Bearer [REDACTED]")
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(JSON.stringify(result)).not.toContain("abc.def.ghi")
  })

  it("selects the latest text messages after filtering non-text records", () => {
    const result = extractReadableText(
      [
        { id: "msg_old", type: "user", text: "old" },
        { id: "msg_noise", type: "assistant", content: [{ type: "tool" }] },
        { id: "msg_new", type: "assistant", content: [{ type: "text", text: "new" }] },
      ],
      { ...READ_OPTIONS, limit: 1 },
    )

    expect(result.messages).toEqual([
      { messageID: "msg_new", role: "assistant", text: "new", truncated: false },
    ])
  })

  it("truncates each message without splitting emojis", () => {
    const result = extractReadableText(
      [{ id: "msg_emoji", type: "user", text: "😀".repeat(20) }],
      { ...READ_OPTIONS, maxCharsPerMessage: 12 },
    )

    expect(result.messages[0]?.text).toBe("😀".repeat(12))
    expect(result.messages[0]?.truncated).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it("enforces the total budget while preserving the newest text", () => {
    const result = extractReadableText(
      [
        { id: "msg_old", type: "user", text: "a".repeat(10) },
        { id: "msg_new", type: "assistant", content: [{ type: "text", text: "b".repeat(10) }] },
      ],
      { ...READ_OPTIONS, maxTotalChars: 12 },
    )

    expect(result.messages).toEqual([
      { messageID: "msg_old", role: "user", text: "aa", truncated: true },
      { messageID: "msg_new", role: "assistant", text: "b".repeat(10), truncated: false },
    ])
    expect(result.truncated).toBe(true)
    expect([...result.messages].reduce((total, message) => total + [...message.text].length, 0))
      .toBe(12)
  })

  it("marks omitted messages as truncated", () => {
    const result = extractReadableText(
      [
        { id: "msg_old", type: "user", text: "old" },
        { id: "msg_new", type: "user", text: "new" },
      ],
      { ...READ_OPTIONS, maxTotalChars: 3 },
    )

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.messageID).toBe("msg_new")
    expect(result.truncated).toBe(true)
  })

  it("skips malformed and empty text records", () => {
    const result = extractReadableText(
      [
        { type: "user", text: "missing id" },
        { id: "msg_empty", type: "user", text: "" },
        { id: "msg_wrong", type: "user", text: 42 },
        { id: "msg_unknown", type: "file", text: "file text" },
        { id: "msg_valid", type: "user", text: "valid" },
      ],
      READ_OPTIONS,
    )

    expect(result.messages).toEqual([
      { messageID: "msg_valid", role: "user", text: "valid", truncated: false },
    ])
  })

  it("returns an empty result for no readable messages", () => {
    expect(extractReadableText([], READ_OPTIONS)).toEqual({ messages: [], truncated: false })
  })

  it("handles 10,000 messages while returning only the requested latest text", () => {
    const messages: ReadableMessage[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `msg_${index}`,
      type: "user",
      text: `message ${index}`,
    }))

    const result = extractReadableText(messages, READ_OPTIONS)

    expect(result.messages).toHaveLength(50)
    expect(result.messages[0]?.messageID).toBe("msg_9950")
    expect(result.messages[49]?.messageID).toBe("msg_9999")
    expect(result.truncated).toBe(false)
  })

  it("does not mutate frozen source messages", () => {
    const content = Object.freeze([Object.freeze({ type: "text", text: "Bearer abc.def" })])
    const messages = Object.freeze([
      Object.freeze({ id: "msg_frozen", type: "assistant", content }),
    ])

    const result = extractReadableText(messages, READ_OPTIONS)

    expect(result.messages[0]?.text).toBe("Bearer [REDACTED]")
    expect(content[0]?.text).toBe("Bearer abc.def")
  })

  it.each([
    { limit: 0 },
    { maxCharsPerMessage: -1 },
    { maxTotalChars: 1.5 },
  ])("rejects invalid extraction bounds: %j", (options) => {
    expect(() => extractReadableText([], { ...READ_OPTIONS, ...options })).toThrow(RangeError)
  })
})
