export const PROVENANCE_VERSION = 1 as const
export const PROVENANCE_METADATA_KEY = "opencode_session_bridge" as const

export interface ProvenanceInput {
  messageID: string
  fromSessionID: string
  fromAgent: string
  toSessionID: string
  conversationID?: string
  inReplyToMessageID?: string
  intent: string
  delivery: "steer" | "queue"
}

export interface Provenance {
  readonly version: typeof PROVENANCE_VERSION
  readonly message_id: string
  readonly from_session: string
  readonly from_agent: string
  readonly to_session: string
  readonly conversation_id: string
  readonly sent_at: number
  readonly in_reply_to: string | null
  readonly intent: string
  readonly delivery: "steer" | "queue"
  readonly [key: string]: string | number | null
}

export function createProvenance(input: ProvenanceInput, now = Date.now()): Provenance {
  return Object.freeze({
    version: PROVENANCE_VERSION,
    message_id: input.messageID,
    from_session: input.fromSessionID,
    from_agent: input.fromAgent,
    to_session: input.toSessionID,
    conversation_id: input.conversationID ?? input.messageID,
    sent_at: now,
    in_reply_to: input.inReplyToMessageID ?? null,
    intent: input.intent,
    delivery: input.delivery,
  })
}

export function createProvenanceMetadata(provenance: Provenance): Readonly<Record<string, Provenance>> {
  return Object.freeze({ [PROVENANCE_METADATA_KEY]: provenance })
}

export function isProvenance(value: unknown): value is Provenance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    item.version === PROVENANCE_VERSION &&
    typeof item.message_id === "string" &&
    typeof item.from_session === "string" &&
    typeof item.from_agent === "string" &&
    typeof item.to_session === "string" &&
    typeof item.conversation_id === "string" &&
    typeof item.sent_at === "number" &&
    Number.isFinite(item.sent_at) &&
    (item.in_reply_to === null || typeof item.in_reply_to === "string") &&
    typeof item.intent === "string" &&
    (item.delivery === "steer" || item.delivery === "queue")
  )
}
