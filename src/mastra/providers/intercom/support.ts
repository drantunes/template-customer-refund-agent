import { z } from "zod";
import type {
  DeliveryReceipt,
  ProviderBinding,
  SupportChannelProvider,
} from "../contracts";
import { IntercomClient } from "./client";
import { type IntercomDevelopmentConfig } from "./config";
import type { VerifiedIntercomConversationWebhook } from "./webhook";

const providerId = z.union([
  z
    .string()
    .refine(
      (id) => id.trim().length > 0,
      "Intercom mutation response cannot unambiguously identify its created conversation part.",
    ),
  z.number(),
]);
const conversationResponse = z
  .object({
    id: providerId,
    conversation_parts: z
      .object({
        conversation_parts: z
          .array(z.object({ id: providerId.optional() }).passthrough())
          .optional(),
      })
      .optional(),
  })
  .passthrough();
const ticketResponse = z
  .object({
    id: z.union([z.string(), z.number()]),
    ticket_id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
const fullContactResponse = z
  .object({
    id: z.union([z.string(), z.number()]),
    email: z.string().email(),
    name: z.string().optional(),
  })
  .passthrough();
function record(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
function customerAuthor(value: unknown) {
  const author = record(value);
  const id = stringValue(author?.id);
  const type = stringValue(author?.type);
  // The signed Conversation author is the sole identity input. Intercom
  // documents user and lead authors for created events (and leads for reply
  // events); both resolve through the Contact API. A visitor reply is signed
  // but does not establish a stable Contact identity here, so we deliberately
  // reject it rather than borrowing a participant or inventing an email.
  return id && ["contact", "user", "lead"].includes(type ?? "")
    ? { id, author }
    : undefined;
}
function eventTimestamp(value: unknown, fallback: number) {
  const timestamp = Number(value ?? fallback);
  if (!Number.isFinite(timestamp) || timestamp <= 0)
    throw new Error("Intercom customer event lacks a valid occurrence time.");
  return new Date(timestamp * 1_000).toISOString();
}

/**
 * A Conversation `source` is the part which *started* the conversation, not
 * the message that caused a later `conversation.user.replied` notification.
 * The webhook snapshot is authenticated, so for replies we require its final
 * part to be an unambiguous customer-authored message.  Falling back to the
 * source would attach an old message (and potentially its owner) to a new
 * event.
 */
function inboundCustomerMessage(
  topic: string,
  item: Record<string, unknown>,
  eventCreatedAt: number,
) {
  if (topic === "conversation.user.created") {
    const source = record(item.source);
    const customer = customerAuthor(source?.author);
    const body = stringValue(source?.body);
    if (!customer || !body)
      throw new Error(
        "Intercom created conversation lacks a customer source author or body.",
      );
    return {
      contactId: customer.id,
      author: customer.author,
      body,
      id: stringValue(source?.id),
      createdAt: eventTimestamp(item.created_at, eventCreatedAt),
    };
  }

  if (topic !== "conversation.user.replied")
    throw new Error("Intercom event is not a customer conversation event.");
  const parts = record(item.conversation_parts)?.conversation_parts;
  if (!Array.isArray(parts) || parts.length === 0)
    throw new Error(
      "Intercom reply event lacks a conversation-part snapshot to identify the reply.",
    );
  // Intercom returns the Conversation part list in conversation order. The
  // notification can be safely accepted only when the final snapshot part is
  // the actual customer reply; choosing an earlier customer part would make a
  // delayed/admin-originated conversation look like a new customer message.
  const part = record(parts.at(-1));
  const customer = customerAuthor(part?.author);
  const id = stringValue(part?.id);
  const body = stringValue(part?.body);
  if (!customer || !id || !body)
    throw new Error(
      "Intercom reply event lacks an unambiguous customer reply part.",
    );
  return {
    contactId: customer.id,
    author: customer.author,
    body,
    id,
    createdAt: eventTimestamp(part?.created_at, eventCreatedAt),
  };
}

/** Maps only normalized domain fields.  Neither workflow nor domain sees a
 * vendor payload; the verified event identity remains the durable dedup key. */
export class IntercomSupportProvider implements SupportChannelProvider {
  readonly kind = "intercom" as const;
  constructor(
    private readonly config: IntercomDevelopmentConfig,
    private readonly client = new IntercomClient(config),
  ) {}
  async normalizeInbound(payload: unknown) {
    const event = payload as VerifiedIntercomConversationWebhook;
    const item = event?.data?.item;
    if (
      !item ||
      typeof item !== "object" ||
      event.binding.providerKind !== "intercom"
    )
      throw new Error(
        "Intercom inbound was not verified by the webhook boundary.",
      );
    const itemRecord = item as Record<string, unknown>;
    // Contacts are participants, not authenticated message authors. The
    // topic-specific source/part selection above is the sole owner input.
    const message = inboundCustomerMessage(
      event.topic,
      itemRecord,
      event.created_at,
    );
    const sender = fullContactResponse.safeParse(message.author).success
      ? fullContactResponse.parse(message.author)
      : await this.client.request(
          `/contacts/${encodeURIComponent(message.contactId)}`,
          { method: "GET" },
          fullContactResponse,
        );
    if (String(sender.id) !== message.contactId)
      throw new Error(
        "Intercom contact enrichment did not match the event author.",
      );
    return {
      binding: event.binding,
      externalId: event.id,
      source: "intercom-conversation" as const,
      customer: { email: sender.email, name: sender.name },
      subject: stringValue(itemRecord.title) ?? "Intercom conversation",
      message: {
        id: `intercom_part_${message.id ?? event.id}`,
        author: "customer" as const,
        authorName: sender.name,
        body: message.body,
        createdAt: message.createdAt,
      },
      // Keep a minimized reference, not the full provider request body.
      rawPayload: {
        id: event.id,
        topic: event.topic,
        created_at: event.created_at,
        contactId: message.contactId,
      },
    };
  }
  private assert(binding: ProviderBinding) {
    if (
      binding.providerKind !== "intercom" ||
      binding.tenantId !== this.config.tenantId ||
      binding.providerAccountId !== this.config.accountId
    )
      throw new Error("Intercom delivery binding is not configured.");
  }
  private receipt(
    binding: ProviderBinding,
    response: z.infer<typeof conversationResponse>,
    operation: string,
  ): DeliveryReceipt {
    if (String(response.id) !== binding.externalConversationId)
      throw new Error(
        "Intercom mutation response does not match the bound Conversation.",
      );
    // The mutation response is a Conversation, so its top-level id is the
    // immutable target binding, not a delivery receipt. A response with zero
    // or multiple parts cannot identify this POST's effect unambiguously.
    const parts = response.conversation_parts?.conversation_parts ?? [];
    if (parts.length !== 1 || parts[0]?.id === undefined)
      throw new Error(
        "Intercom mutation response cannot unambiguously identify its created conversation part.",
      );
    const id = parts[0].id;
    return {
      receiptId: `intercom:${operation}:${id}`,
      providerMessageId: String(id),
      deliveredAt: new Date().toISOString(),
    };
  }
  async deliver(
    binding: ProviderBinding,
    body: string,
    _status: string,
    _idempotencyKey?: string,
  ) {
    this.assert(binding);
    const response = await this.client.request(
      `/conversations/${encodeURIComponent(binding.externalConversationId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          message_type: "comment",
          type: "admin",
          admin_id: this.config.adminId,
          body,
        }),
      },
      conversationResponse,
    );
    return this.receipt(binding, response, "reply");
  }
  async addInternalNote(
    binding: ProviderBinding,
    body: string,
    _idempotencyKey: string,
  ) {
    this.assert(binding);
    const response = await this.client.request(
      `/conversations/${encodeURIComponent(binding.externalConversationId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          message_type: "note",
          type: "admin",
          admin_id: this.config.adminId,
          body,
        }),
      },
      conversationResponse,
    );
    return this.receipt(binding, response, "note");
  }
  async updateStatus(
    binding: ProviderBinding,
    status: string,
    _idempotencyKey: string,
  ) {
    this.assert(binding);
    const state = status === "resolved" ? "closed" : "open";
    const messageType = state === "open" ? "open" : "close";
    const response = await this.client.request(
      `/conversations/${encodeURIComponent(binding.externalConversationId)}/parts`,
      {
        method: "POST",
        body: JSON.stringify({
          message_type: messageType,
          type: "admin",
          admin_id: this.config.adminId,
          body: "",
        }),
      },
      conversationResponse,
    );
    return this.receipt(binding, response, "status");
  }
  async convertToTicket(
    binding: ProviderBinding,
    input: { title: string; description: string },
    _idempotencyKey: string,
  ) {
    this.assert(binding);
    if (!this.config.ticketTypeId)
      throw new Error("Intercom ticket conversion is not configured.");
    const response = await this.client.request(
      `/conversations/${encodeURIComponent(binding.externalConversationId)}/convert`,
      {
        method: "POST",
        body: JSON.stringify({
          ticket_type_id: this.config.ticketTypeId,
          ...(this.config.ticketStateId
            ? { ticket_state_id: this.config.ticketStateId }
            : {}),
          attributes: {
            _default_title_: input.title,
            _default_description_: input.description,
          },
        }),
      },
      ticketResponse,
    );
    // The API id, not ticket_id (display identifier), is the durable reference.
    return {
      receiptId: `intercom:ticket:${response.id}`,
      providerMessageId: String(response.id),
      deliveredAt: new Date().toISOString(),
    };
  }
}
