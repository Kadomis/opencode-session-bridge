import { describe, expect, it } from "bun:test"
import {
  PROVENANCE_METADATA_KEY,
  PROVENANCE_VERSION,
  createProvenance,
  createProvenanceMetadata,
  isProvenance,
  type ProvenanceInput,
} from "../../src/provenance.js"

function trustedInput(): ProvenanceInput {
  return {
    messageID: "msg_bridge_1",
    fromSessionID: "ses_caller",
    fromAgent: "build",
    toSessionID: "ses_target",
    conversationID: "conv_review",
    inReplyToMessageID: "msg_previous",
    intent: "request",
    delivery: "queue",
  }
}

describe("createProvenance", () => {
  it("creates every required server-controlled provenance field", () => {
    const provenance = createProvenance(trustedInput(), 1_234)

    expect(provenance).toEqual({
      version: 1,
      message_id: "msg_bridge_1",
      from_session: "ses_caller",
      from_agent: "build",
      to_session: "ses_target",
      conversation_id: "conv_review",
      sent_at: 1_234,
      in_reply_to: "msg_previous",
      intent: "request",
      delivery: "queue",
    })
    expect(PROVENANCE_VERSION).toBe(1)
  })

  it("starts a new conversation with the message ID and no reply parent", () => {
    const input = trustedInput()
    delete input.conversationID
    delete input.inReplyToMessageID

    const provenance = createProvenance(input, 2_000)

    expect(provenance.conversation_id).toBe("msg_bridge_1")
    expect(provenance.in_reply_to).toBeNull()
  })

  it("ignores caller-supplied snake-case and nested provenance fields", () => {
    const malicious = {
      ...trustedInput(),
      version: 999,
      message_id: "msg_spoofed",
      from_session: "ses_spoofed",
      from_agent: "spoofed-agent",
      to_session: "ses_spoofed",
      sent_at: 0,
      in_reply_to: "msg_spoofed",
      provenance: { from_session: "ses_nested_spoof" },
      metadata: { opencode_session_bridge: { from_session: "ses_metadata_spoof" } },
    } as ProvenanceInput

    const provenance = createProvenance(malicious, 3_000)

    expect(provenance.version).toBe(1)
    expect(provenance.message_id).toBe("msg_bridge_1")
    expect(provenance.from_session).toBe("ses_caller")
    expect(provenance.from_agent).toBe("build")
    expect(provenance.to_session).toBe("ses_target")
    expect(provenance.sent_at).toBe(3_000)
    expect(provenance.in_reply_to).toBe("msg_previous")
  })

  it("returns an immutable provenance record", () => {
    const provenance = createProvenance(trustedInput(), 4_000)

    expect(Object.isFrozen(provenance)).toBe(true)
    expect(() => {
      ;(provenance as { sent_at: number }).sent_at = 9_999
    }).toThrow()
  })

  it("uses the current time when no timestamp is supplied", () => {
    const before = Date.now()
    const provenance = createProvenance(trustedInput())
    const after = Date.now()

    expect(provenance.sent_at).toBeGreaterThanOrEqual(before)
    expect(provenance.sent_at).toBeLessThanOrEqual(after)
  })
})

describe("createProvenanceMetadata", () => {
  it("stores provenance under one versioned metadata key", () => {
    const provenance = createProvenance(trustedInput(), 5_000)

    expect(createProvenanceMetadata(provenance)).toEqual({
      [PROVENANCE_METADATA_KEY]: provenance,
    })
    expect(PROVENANCE_METADATA_KEY).toBe("opencode_session_bridge")
  })

  it("does not expose mutable references to the provenance record", () => {
    const provenance = createProvenance(trustedInput(), 5_000)
    const metadata = createProvenanceMetadata(provenance)

    expect(Object.isFrozen(metadata)).toBe(true)
    expect(Object.isFrozen(metadata[PROVENANCE_METADATA_KEY])).toBe(true)
  })
})

describe("isProvenance", () => {
  it("accepts a complete version 1 record", () => {
    expect(isProvenance(createProvenance(trustedInput(), 6_000))).toBe(true)
  })

  it.each([
    null,
    undefined,
    {},
    { version: 2 },
    { ...createProvenance(trustedInput(), 6_000), from_session: 123 },
    { ...createProvenance(trustedInput(), 6_000), delivery: "later" },
    { ...createProvenance(trustedInput(), 6_000), sent_at: "yesterday" },
  ])("rejects malformed provenance: %j", (value) => {
    expect(isProvenance(value)).toBe(false)
  })
})
