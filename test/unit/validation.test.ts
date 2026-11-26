import { describe, expect, it } from "bun:test"
import {
  MAX_MESSAGE_BYTES,
  MAX_REASON_LENGTH,
  MAX_SESSION_ID_LENGTH,
  ValidationError,
  parseSessionDeleteInput,
  parseSessionInterruptInput,
  parseSessionListInput,
  parseSessionReadInput,
  parseSessionSendInput,
  parseSessionWaitInput,
} from "../../src/validation.js"

describe("parseSessionSendInput", () => {
  it("accepts the required fields and applies safe defaults", () => {
    expect(
      parseSessionSendInput(
        { targetSessionID: "ses_target", text: "Review this change" },
        "ses_caller",
      ),
    ).toEqual({
      targetSessionID: "ses_target",
      text: "Review this change",
      intent: "message",
      delivery: "queue",
      waitForReply: false,
    })
  })

  it("preserves every supported caller option", () => {
    expect(
      parseSessionSendInput(
        {
          targetSessionID: "ses_target",
          text: "Please review",
          conversationID: "conv_1",
          inReplyToMessageID: "msg_1",
          intent: "handoff",
          delivery: "steer",
          idempotencyKey: "request-123",
          waitForReply: true,
        },
        "ses_caller",
      ),
    ).toEqual({
      targetSessionID: "ses_target",
      text: "Please review",
      conversationID: "conv_1",
      inReplyToMessageID: "msg_1",
      intent: "handoff",
      delivery: "steer",
      idempotencyKey: "request-123",
      waitForReply: true,
    })
  })

  it("forces steer delivery when waitForReply needs the admitted message", () => {
    expect(
      parseSessionSendInput(
        {
          targetSessionID: "ses_target",
          text: "Please reply",
          delivery: "queue",
          waitForReply: true,
        },
        "ses_caller",
      ).delivery,
    ).toBe("steer")
  })

  it("allows self-messaging when no reply wait is requested", () => {
    expect(
      parseSessionSendInput(
        { targetSessionID: "ses_caller", text: "Note to self" },
        "ses_caller",
      ).waitForReply,
    ).toBe(false)
  })

  it("rejects self-messaging with waitForReply to prevent deadlock", () => {
    expect(() =>
      parseSessionSendInput(
        {
          targetSessionID: "ses_caller",
          text: "Wait for my own reply",
          waitForReply: true,
        },
        "ses_caller",
      ),
    ).toThrow(/self.*waitForReply|waitForReply.*self/i)
  })

  it("strips unknown and server-controlled fields without mutating input", () => {
    const input = Object.freeze({
      targetSessionID: "ses_target",
      text: "Hello",
      version: 999,
      message_id: "msg_spoofed",
      from_session: "ses_spoofed",
      from_agent: "spoofed",
      to_session: "ses_spoofed",
      sent_at: 0,
      metadata: { opencode_session_bridge: {} },
      maxTurns: 1,
    })

    const parsed = parseSessionSendInput(input, "ses_caller")

    expect(parsed).not.toHaveProperty("version")
    expect(parsed).not.toHaveProperty("message_id")
    expect(parsed).not.toHaveProperty("from_session")
    expect(parsed).not.toHaveProperty("from_agent")
    expect(parsed).not.toHaveProperty("to_session")
    expect(parsed).not.toHaveProperty("sent_at")
    expect(parsed).not.toHaveProperty("metadata")
    expect(parsed).not.toHaveProperty("maxTurns")
    expect(input).toHaveProperty("message_id", "msg_spoofed")
  })

  it.each([[null], [undefined], [[]], ["text"], [42]])(
    "rejects a non-object send request: %j",
    (value) => {
      expect(() => parseSessionSendInput(value, "ses_caller")).toThrow(ValidationError)
    },
  )

  it.each([[undefined], [null], [""], ["   "], [42], [{}], [[]]])(
    "rejects invalid message text: %j",
    (text) => {
      expect(() =>
        parseSessionSendInput({ targetSessionID: "ses_target", text }, "ses_caller"),
      ).toThrow(ValidationError)
    },
  )

  it("accepts a message exactly at the byte limit", () => {
    const text = "a".repeat(MAX_MESSAGE_BYTES)

    expect(parseSessionSendInput({ targetSessionID: "ses_target", text }, "ses_caller").text)
      .toBe(text)
  })

  it("rejects a message one byte over the limit", () => {
    expect(() =>
      parseSessionSendInput(
        { targetSessionID: "ses_target", text: "a".repeat(MAX_MESSAGE_BYTES + 1) },
        "ses_caller",
      ),
    ).toThrow(/message|size|bytes/i)
  })

  it("counts UTF-8 bytes instead of UTF-16 code units", () => {
    const accepted = "😀".repeat(MAX_MESSAGE_BYTES / 4)
    const rejected = "😀".repeat(MAX_MESSAGE_BYTES / 4 + 1)

    expect(() =>
      parseSessionSendInput({ targetSessionID: "ses_target", text: accepted }, "ses_caller"),
    ).not.toThrow()
    expect(() =>
      parseSessionSendInput({ targetSessionID: "ses_target", text: rejected }, "ses_caller"),
    ).toThrow(/message|size|bytes/i)
  })

  it("preserves Unicode, emojis, and SQL-like text as data", () => {
    const text = "বাংলা 😀 '; DROP TABLE sessions; --"

    expect(parseSessionSendInput({ targetSessionID: "ses_target", text }, "ses_caller").text)
      .toBe(text)
  })

  it.each(["", " ", " ses_target", "ses_target ", "ses_target\n", "s".repeat(MAX_SESSION_ID_LENGTH + 1)])(
    "rejects an invalid target session ID: %j",
    (targetSessionID) => {
      expect(() =>
        parseSessionSendInput({ targetSessionID, text: "Hello" }, "ses_caller"),
      ).toThrow(ValidationError)
    },
  )

  it("counts bounded text fields in Unicode code points", () => {
    const parsed = parseSessionSendInput(
      {
        targetSessionID: `ses_${"a".repeat(MAX_SESSION_ID_LENGTH - 4)}`,
        text: "Unicode boundaries",
        conversationID: "😀".repeat(256),
        inReplyToMessageID: "😀".repeat(256),
        idempotencyKey: "😀".repeat(128),
        intent: "😀".repeat(64),
      },
      "ses_caller",
    )

    expect(parsed.targetSessionID).toHaveLength(MAX_SESSION_ID_LENGTH)
    expect([...parsed.conversationID ?? ""]).toHaveLength(256)
    expect([...parsed.inReplyToMessageID ?? ""]).toHaveLength(256)
    expect([...parsed.idempotencyKey ?? ""]).toHaveLength(128)
    expect([...parsed.intent]).toHaveLength(64)
  })

  it.each([
    { conversationID: "😀".repeat(257) },
    { inReplyToMessageID: "😀".repeat(257) },
    { idempotencyKey: "😀".repeat(129) },
    { intent: "😀".repeat(65) },
  ])("rejects text fields one code point over their limit: %j", (extra) => {
    expect(() =>
      parseSessionSendInput(
        { targetSessionID: "ses_target", text: "Hello", ...extra },
        "ses_caller",
      ),
    ).toThrow(ValidationError)
  })

  it.each([
    { conversationID: "" },
    { conversationID: "conv\n1" },
    { conversationID: "c".repeat(257) },
    { inReplyToMessageID: " " },
    { inReplyToMessageID: "m".repeat(257) },
    { idempotencyKey: "" },
    { idempotencyKey: "key\n1" },
    { idempotencyKey: "k".repeat(129) },
    { intent: "" },
    { intent: "   " },
    { intent: "i".repeat(65) },
    { delivery: "later" },
    { waitForReply: "yes" },
  ])("rejects invalid optional send fields: %j", (extra) => {
    expect(() =>
      parseSessionSendInput(
        { targetSessionID: "ses_target", text: "Hello", ...extra },
        "ses_caller",
      ),
    ).toThrow(ValidationError)
  })

  it("reports the invalid field in ValidationError", () => {
    try {
      parseSessionSendInput({ targetSessionID: "", text: "Hello" }, "ses_caller")
      throw new Error("Expected validation to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).field).toBe("targetSessionID")
    }
  })
})

describe("parseSessionListInput", () => {
  it("defaults to a bounded server-visible list without project filters", () => {
    expect(parseSessionListInput({})).toEqual({ limit: 50, order: "desc" })
  })

  it("passes supported filters and pagination unchanged", () => {
    expect(
      parseSessionListInput({
        limit: 10,
        order: "asc",
        search: "review",
        cursor: "cursor_1",
        directory: "/workspace/beta",
        project: "project_beta",
      }),
    ).toEqual({
      limit: 10,
      order: "asc",
      search: "review",
      cursor: "cursor_1",
      directory: "/workspace/beta",
      project: "project_beta",
    })
  })

  it("counts list search and cursor limits in Unicode code points", () => {
    const parsed = parseSessionListInput({
      search: "😀".repeat(256),
      cursor: "😀".repeat(2048),
    })

    expect([...parsed.search ?? ""]).toHaveLength(256)
    expect([...parsed.cursor ?? ""]).toHaveLength(2048)
    expect(() => parseSessionListInput({ search: "😀".repeat(257) })).toThrow(ValidationError)
    expect(() => parseSessionListInput({ cursor: "😀".repeat(2049) })).toThrow(ValidationError)
  })

  it.each([0, -1, 201, 1.5, "10", null])(
    "rejects an invalid list limit: %j",
    (limit) => {
      expect(() => parseSessionListInput({ limit })).toThrow(ValidationError)
    },
  )

  it.each([{ order: "sideways" }, { search: "s".repeat(257) }, { cursor: "c".repeat(2049) }])(
    "rejects invalid list options: %j",
    (extra) => {
      expect(() => parseSessionListInput(extra)).toThrow(ValidationError)
    },
  )
})

describe("parseSessionReadInput", () => {
  it("applies bounded read defaults", () => {
    expect(parseSessionReadInput({ sessionID: "ses_target" })).toEqual({
      sessionID: "ses_target",
      limit: 50,
      maxCharsPerMessage: 4_000,
      maxTotalChars: 16_000,
    })
  })

  it("accepts explicit read limits", () => {
    expect(
      parseSessionReadInput({
        sessionID: "ses_target",
        limit: 5,
        maxCharsPerMessage: 100,
        maxTotalChars: 300,
      }),
    ).toEqual({
      sessionID: "ses_target",
      limit: 5,
      maxCharsPerMessage: 100,
      maxTotalChars: 300,
    })
  })

  it.each([
    { limit: 0 },
    { limit: 201 },
    { limit: 1.2 },
    { maxCharsPerMessage: 0 },
    { maxCharsPerMessage: 20_001 },
    { maxTotalChars: 0 },
    { maxTotalChars: 100_001 },
  ])("rejects invalid read bounds: %j", (extra) => {
    expect(() =>
      parseSessionReadInput({ sessionID: "ses_target", ...extra }),
    ).toThrow(ValidationError)
  })
})

describe("parseSessionDeleteInput", () => {
  it("accepts an exact confirmation and a reason", () => {
    expect(
      parseSessionDeleteInput({
        sessionID: "ses_target",
        confirmSessionID: "ses_target",
        reason: "Temporary session is no longer needed",
      }),
    ).toEqual({
      sessionID: "ses_target",
      confirmSessionID: "ses_target",
      reason: "Temporary session is no longer needed",
    })
  })

  it("rejects a mismatched confirmation", () => {
    expect(() =>
      parseSessionDeleteInput({
        sessionID: "ses_target",
        confirmSessionID: "ses_other",
        reason: "Cleanup",
      }),
    ).toThrow(/confirm/i)
  })

  it.each([undefined, "", "   ", 42, "r".repeat(MAX_REASON_LENGTH + 1)])(
    "rejects an invalid delete reason: %j",
    (reason) => {
      expect(() =>
        parseSessionDeleteInput({
          sessionID: "ses_target",
          confirmSessionID: "ses_target",
          reason,
        }),
      ).toThrow(ValidationError)
    },
  )

  it("counts the reason limit in Unicode code points", () => {
    expect(() =>
      parseSessionDeleteInput({
        sessionID: "ses_target",
        confirmSessionID: "ses_target",
        reason: "😀".repeat(MAX_REASON_LENGTH),
      }),
    ).not.toThrow()
  })
})

describe("parseSessionInterruptInput", () => {
  it("defaults resume to false", () => {
    expect(parseSessionInterruptInput({ sessionID: "ses_target" })).toEqual({
      sessionID: "ses_target",
      resume: false,
    })
  })

  it("preserves resume true", () => {
    expect(parseSessionInterruptInput({ sessionID: "ses_target", resume: true })).toEqual({
      sessionID: "ses_target",
      resume: true,
    })
  })

  it("rejects a non-boolean resume value", () => {
    expect(() =>
      parseSessionInterruptInput({ sessionID: "ses_target", resume: "true" }),
    ).toThrow(ValidationError)
  })
})

describe("parseSessionWaitInput", () => {
  it("waits natively without adding turn or retry limits", () => {
    expect(
      parseSessionWaitInput({
        sessionID: "ses_target",
        maxTurns: 1,
        maxRetries: 2,
        timeoutMS: 10,
      }),
    ).toEqual({ sessionID: "ses_target" })
  })
})
