import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { intercomBinding, type IntercomDevelopmentConfig } from "./config";

export const MAX_INTERCOM_WEBHOOK_BYTES = 256 * 1024;
const MAX_EVENT_AGE_MS = 5 * 60 * 1000;
const notificationSchema = z
  .object({
    type: z.literal("notification_event"),
    id: z.string().min(1).max(200),
    app_id: z.string().min(1).max(200),
    topic: z.string().min(1).max(200),
    created_at: z.number().int(),
    data: z.object({ item: z.record(z.string(), z.unknown()) }),
  })
  .passthrough();

export type VerifiedIntercomWebhook = z.infer<typeof notificationSchema> & {
  binding: ReturnType<typeof intercomBinding>;
};

function suppliedSignature(value: string | null) {
  if (!value?.startsWith("sha1=")) return undefined;
  const hex = value.slice(5);
  return /^[a-f0-9]{40}$/i.test(hex) ? hex : undefined;
}

/** Verify raw bytes before JSON parsing.  Freshness uses the authenticated
 * notification timestamp only after the signature proves its provenance. */
export function verifyIntercomWebhook(
  rawBody: Uint8Array,
  headers: Headers,
  config: IntercomDevelopmentConfig,
  at = Date.now(),
): VerifiedIntercomWebhook {
  if (
    rawBody.byteLength === 0 ||
    rawBody.byteLength > MAX_INTERCOM_WEBHOOK_BYTES
  )
    throw new Error("Intercom webhook body is outside the accepted size.");
  const contentType = headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.toLowerCase();
  if (contentType !== "application/json")
    throw new Error("Intercom webhook must be application/json.");
  const actual = suppliedSignature(headers.get("x-hub-signature"));
  if (!actual)
    throw new Error("Intercom webhook signature is missing or invalid.");
  const expected = createHmac("sha1", config.clientSecret)
    .update(rawBody)
    .digest("hex");
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  )
    throw new Error("Intercom webhook signature is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw new Error("Intercom webhook contains invalid JSON.");
  }
  const event = notificationSchema.parse(parsed);
  if (event.app_id !== config.accountId)
    throw new Error(
      "Intercom webhook account does not match configured account.",
    );
  const age = at - event.created_at * 1_000;
  if (age > MAX_EVENT_AGE_MS || age < -MAX_EVENT_AGE_MS)
    throw new Error(
      "Intercom webhook timestamp is outside the accepted window.",
    );
  const conversationId = String(event.data.item.id ?? "");
  if (!conversationId)
    throw new Error("Intercom webhook has no conversation identity.");
  return { ...event, binding: intercomBinding(config, conversationId) };
}

export function isCustomerConversationEvent(event: VerifiedIntercomWebhook) {
  return (
    event.topic === "conversation.user.created" ||
    event.topic === "conversation.user.replied"
  );
}
