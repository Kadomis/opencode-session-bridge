import { createHash } from "node:crypto"
import type { SessionSendInput } from "./validation.js"

export function stableMessageID(sessionID: string, agent: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${sessionID}\u0000${agent}\u0000${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32)
  return `msg_bridge_${digest}`
}

export function fingerprintSendRequest(input: SessionSendInput): string {
  const semantic = {
    targetSessionID: input.targetSessionID,
    text: input.text,
    conversationID: input.conversationID ?? null,
    inReplyToMessageID: input.inReplyToMessageID ?? null,
    intent: input.intent,
    delivery: input.waitForReply ? "steer" : input.delivery,
    waitForReply: input.waitForReply,
  }
  return createHash("sha256").update(JSON.stringify(semantic), "utf8").digest("hex")
}
