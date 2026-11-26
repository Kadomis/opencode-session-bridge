import { describe, expect, it } from "bun:test"
import { fingerprintSendRequest } from "../../src/idempotency.js"
import type { SessionSendInput } from "../../src/validation.js"

function request(): SessionSendInput {
  return {
    targetSessionID: "ses_target",
    text: "Review this change",
    conversationID: "conv_1",
    inReplyToMessageID: "msg_1",
    intent: "request",
    delivery: "queue",
    idempotencyKey: "key_1",
    waitForReply: false,
  }
}

describe("fingerprintSendRequest", () => {
  it("returns a stable SHA-256 hex fingerprint", () => {
    const fingerprint = fingerprintSendRequest(request())

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(fingerprintSendRequest(request())).toBe(fingerprint)
  })

  it("is independent of object property order", () => {
    const input = request()
    const reordered = {
      waitForReply: input.waitForReply,
      delivery: input.delivery,
      intent: input.intent,
      inReplyToMessageID: input.inReplyToMessageID,
      conversationID: input.conversationID,
      text: input.text,
      targetSessionID: input.targetSessionID,
      idempotencyKey: input.idempotencyKey,
    }

    expect(fingerprintSendRequest(reordered)).toBe(fingerprintSendRequest(input))
  })

  it("excludes the idempotency key from the request fingerprint", () => {
    expect(fingerprintSendRequest({ ...request(), idempotencyKey: "different-key" }))
      .toBe(fingerprintSendRequest(request()))
  })

  it("ignores unknown and server-controlled spoof fields", () => {
    const malicious = {
      ...request(),
      version: 999,
      message_id: "msg_spoofed",
      from_session: "ses_spoofed",
      from_agent: "spoofed",
      to_session: "ses_spoofed",
      sent_at: 0,
      metadata: { opencode_session_bridge: {} },
    } as SessionSendInput

    expect(fingerprintSendRequest(malicious)).toBe(fingerprintSendRequest(request()))
  })

  it("normalizes queue to steer when waitForReply forces immediate admission", () => {
    const queuedWait = { ...request(), waitForReply: true, delivery: "queue" as const }
    const steeredWait = { ...request(), waitForReply: true, delivery: "steer" as const }

    expect(fingerprintSendRequest(queuedWait)).toBe(fingerprintSendRequest(steeredWait))
  })

  it.each([
    { targetSessionID: "ses_other" },
    { text: "Review that change" },
    { conversationID: "conv_2" },
    { inReplyToMessageID: "msg_2" },
    { intent: "handoff" },
    { delivery: "steer" },
    { waitForReply: true },
  ])("changes when a semantic field changes: %j", (override) => {
    expect(fingerprintSendRequest({ ...request(), ...override }))
      .not.toBe(fingerprintSendRequest(request()))
  })

  it("distinguishes an omitted conversation from an explicit conversation", () => {
    const input = request()
    delete input.conversationID

    expect(fingerprintSendRequest(input)).not.toBe(fingerprintSendRequest(request()))
  })

  it("handles Unicode, emojis, quotes, and SQL-like text deterministically", () => {
    const input = { ...request(), text: "বাংলা 😀 '; DROP TABLE sessions; --" }

    expect(fingerprintSendRequest(input)).toMatch(/^[a-f0-9]{64}$/)
    expect(fingerprintSendRequest({ ...input })).toBe(fingerprintSendRequest(input))
  })

  it("does not mutate a frozen request", () => {
    const input = Object.freeze({ ...request() })

    expect(() => fingerprintSendRequest(input)).not.toThrow()
    expect(input.text).toBe("Review this change")
  })
})
