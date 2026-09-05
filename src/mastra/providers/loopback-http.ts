import type {
  CommerceOrder,
  CommerceProvider,
  CommerceRefund,
  CommerceSubscription,
  DeliveryReceipt,
  KnowledgeEvidence,
  KnowledgeProvider,
  ProviderBinding,
  ProviderRegistry,
  RefundCommand,
  RefundEffect,
  RefundQuote,
  SupportChannelProvider,
  TransactionalActionProvider,
} from "./contracts";
import { sameBinding } from "./contracts";
import { z } from "zod";

const bindingSchema = z
  .object({
    tenantId: z.string().min(1),
    providerKind: z.literal("local"),
    providerAccountId: z.string().min(1),
    externalConversationId: z.string().min(1),
  })
  .strict();
const moneySchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    minor: z.number().int().safe().nonnegative(),
  })
  .strict();
const receiptSchema = z
  .object({
    receiptId: z.string().min(1),
    deliveredAt: z.iso.datetime(),
    providerMessageId: z.string().min(1),
  })
  .strict();
const effectSchema = z
  .object({
    refundId: z.string().min(1),
    orderId: z.string().min(1),
    amount: moneySchema,
    idempotencyKey: z.string().min(1),
    executedAt: z.iso.datetime(),
    replayed: z.boolean(),
  })
  .strict();
const quoteSchema = z
  .object({
    approvedAmount: moneySchema,
    remainingAmount: moneySchema,
    commandFingerprint: z.string().min(1),
  })
  .strict();
const orderSchema = z
  .object({
    orderId: z.string().min(1),
    customerEmail: z.string().min(1),
    product: z.string().min(1),
    amount: moneySchema,
    status: z.enum([
      "fulfilled",
      "shipped",
      "processing",
      "cancelled",
      "refunded",
    ]),
    chargeCount: z.number().int().nonnegative(),
    placedAt: z.iso.datetime(),
  })
  .strict();
const subscriptionSchema = z
  .object({
    subscriptionId: z.string().min(1),
    customerEmail: z.string().min(1),
    plan: z.string().min(1),
    amount: moneySchema,
    status: z.enum(["active", "cancelled", "past_due"]),
    renewsAt: z.iso.datetime(),
  })
  .strict();
const refundSchema = z
  .object({
    refundId: z.string().min(1),
    orderId: z.string().min(1),
    amount: moneySchema,
    reason: z.string().min(1),
    issuedAt: z.iso.datetime(),
  })
  .strict();
const evidenceSchema = z
  .object({
    title: z.string(),
    text: z.string(),
    source: z.string(),
    score: z.number().finite(),
    version: z.string(),
  })
  .strict();
const commandSchema = z
  .object({
    approvalCaseId: z.string().min(1),
    binding: bindingSchema,
    orderId: z.string().min(1),
    amount: moneySchema,
    reason: z.string().min(1),
    idempotencyKey: z.string().min(1),
    fingerprint: z.string().min(1),
  })
  .strict();

export type LoopbackFailure = "timeout" | "429" | "500" | "drop-after-commit";
export type LoopbackFetch = (request: Request) => Promise<Response>;

/** Optional in-process HTTP boundary used to prove the local port contract. */
export function createLocalLoopbackFacade(
  provider: ProviderRegistry,
  failure?: () => LoopbackFailure | undefined,
): LoopbackFetch {
  return async (request) => {
    try {
      const injected = failure?.();
      if (injected === "timeout") return new Promise(() => undefined);
      if (injected === "429")
        return Response.json({ error: "rate limited" }, { status: 429 });
      if (injected === "500")
        return Response.json({ error: "synthetic failure" }, { status: 500 });
      const body = (await request.json()) as Record<string, unknown> & {
        binding: ProviderBinding;
        email?: string;
        orderId?: string;
      };
      if (!bindingSchema.safeParse(body?.binding).success)
        return Response.json(
          { error: "invalid provider binding" },
          { status: 400 },
        );
      if (request.url.endsWith("/commerce/orders")) {
        const order = await provider
          .commerce(body.binding)
          .findOrder(body.binding, body.email ?? "", body.orderId);
        if (injected === "drop-after-commit")
          return new Promise(() => undefined);
        return Response.json(order ?? null);
      }
      if (request.url.endsWith("/commerce/subscriptions")) {
        const subscription = await provider
          .commerce(body.binding)
          .findSubscription(body.binding, body.email ?? "");
        if (injected === "drop-after-commit")
          return new Promise(() => undefined);
        return Response.json(subscription ?? null);
      }
      if (request.url.endsWith("/commerce/refunds")) {
        const refunds = await provider
          .commerce(body.binding)
          .refunds(body.binding, body.orderId ?? "");
        if (injected === "drop-after-commit")
          return new Promise(() => undefined);
        return Response.json(refunds);
      }
      if (request.url.endsWith("/support/normalize"))
        return Response.json(
          await provider.support(body.binding).normalizeInbound(body.payload),
        );
      if (request.url.endsWith("/support/deliver"))
        return Response.json(
          await provider
            .support(body.binding)
            .deliver(
              body.binding,
              String(body.body ?? ""),
              String(body.status ?? ""),
              body.idempotencyKey as string | undefined,
            ),
        );
      if (request.url.endsWith("/transactions/quote-refund")) {
        const checked = commandSchema.safeParse(body.command);
        if (!checked.success)
          return Response.json(
            { error: "invalid refund command" },
            { status: 400 },
          );
        const command = checked.data;
        if (!command?.binding || !sameBinding(body.binding, command.binding))
          return Response.json(
            {
              error:
                "transaction command binding does not match request binding",
            },
            { status: 400 },
          );
        return Response.json(
          await provider.transactions(body.binding).quoteRefund(command),
        );
      }
      if (request.url.endsWith("/transactions/issue-refund")) {
        const checked = commandSchema.safeParse(body.command);
        if (!checked.success)
          return Response.json(
            { error: "invalid refund command" },
            { status: 400 },
          );
        const command = checked.data;
        if (!command?.binding || !sameBinding(body.binding, command.binding))
          return Response.json(
            {
              error:
                "transaction command binding does not match request binding",
            },
            { status: 400 },
          );
        const effect = await provider
          .transactions(body.binding)
          .issueRefund(command);
        if (injected === "drop-after-commit")
          return new Promise(() => undefined);
        return Response.json(effect);
      }
      if (request.url.endsWith("/knowledge/search"))
        return Response.json(
          await provider
            .knowledge(body.binding)
            .search(
              body.binding,
              String(body.query ?? ""),
              Number(body.topK ?? 5),
            ),
        );
      if (request.url.endsWith("/knowledge/list-changed"))
        return Response.json(
          await provider
            .knowledge(body.binding)
            .listChanged(body.binding, body.since as string | undefined),
        );
      if (request.url.endsWith("/knowledge/fetch-document"))
        return Response.json(
          (await provider
            .knowledge(body.binding)
            .fetchDocument(body.binding, String(body.source ?? ""))) ?? null,
        );
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  };
}

/** HTTP adapters for all four local ports, kept opt-in for contract conformance. */
export class LoopbackHttpProviderRegistry implements ProviderRegistry {
  readonly kind = "local" as const;
  constructor(
    private readonly fetcher: LoopbackFetch,
    private readonly timeoutMs = 100,
  ) {}
  support(_binding: ProviderBinding): SupportChannelProvider {
    return new LoopbackHttpSupportProvider(this.fetcher, this.timeoutMs);
  }
  commerce(_binding: ProviderBinding): CommerceProvider {
    return new LoopbackHttpCommerceProvider(this.fetcher, this.timeoutMs);
  }
  transactions(_binding: ProviderBinding): TransactionalActionProvider {
    return new LoopbackHttpTransactionalProvider(this.fetcher, this.timeoutMs);
  }
  knowledge(_binding: ProviderBinding): KnowledgeProvider {
    return new LoopbackHttpKnowledgeProvider(this.fetcher, this.timeoutMs);
  }
}

export class LoopbackHttpCommerceProvider implements CommerceProvider {
  readonly kind = "local" as const;
  constructor(
    private readonly fetcher: LoopbackFetch,
    private readonly timeoutMs = 100,
  ) {}
  async call<T>(
    path: string,
    body: unknown,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = new Request(`http://loopback${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      const response = await Promise.race([
        this.fetcher(request),
        new Promise<Response>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Loopback commerce timeout."));
          }, this.timeoutMs);
        }),
      ]);
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          `Loopback commerce HTTP ${response.status}: ${error.error ?? "request failed"}`,
        );
      }
      const payload = await response.json();
      return schema ? schema.parse(payload) : (payload as T);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  findOrder(binding: ProviderBinding, email: string, orderId?: string) {
    return this.call<CommerceOrder | undefined>(
      "/commerce/orders",
      {
        binding,
        email,
        orderId,
      },
      z.union([orderSchema, z.null()]).transform((value) => value ?? undefined),
    );
  }
  findSubscription(binding: ProviderBinding, email: string) {
    return this.call<CommerceSubscription | undefined>(
      "/commerce/subscriptions",
      { binding, email },
      z
        .union([subscriptionSchema, z.null()])
        .transform((value) => value ?? undefined),
    );
  }
  refunds(binding: ProviderBinding, orderId: string) {
    return this.call<CommerceRefund[]>(
      "/commerce/refunds",
      {
        binding,
        orderId,
      },
      z.array(refundSchema),
    );
  }
}

class LoopbackHttpSupportProvider implements SupportChannelProvider {
  readonly kind = "local" as const;
  private readonly http: LoopbackHttpCommerceProvider;
  constructor(fetcher: LoopbackFetch, timeoutMs: number) {
    this.http = new LoopbackHttpCommerceProvider(fetcher, timeoutMs);
  }
  normalizeInbound(payload: unknown) {
    const binding = {
      tenantId: "local-demo",
      providerKind: "local" as const,
      providerAccountId: "local-demo",
      externalConversationId: "loopback",
    };
    return this.http.call<
      Awaited<ReturnType<SupportChannelProvider["normalizeInbound"]>>
    >("/support/normalize", { binding, payload });
  }
  deliver(
    binding: ProviderBinding,
    body: string,
    status: string,
    idempotencyKey?: string,
  ) {
    return this.http.call<DeliveryReceipt>(
      "/support/deliver",
      {
        binding,
        body,
        status,
        idempotencyKey,
      },
      receiptSchema,
    );
  }
  addInternalNote(
    binding: ProviderBinding,
    body: string,
    idempotencyKey: string,
  ) {
    return this.deliver(binding, body, "note", idempotencyKey);
  }
  updateStatus(
    binding: ProviderBinding,
    status: string,
    idempotencyKey: string,
  ) {
    return this.deliver(binding, "", status, idempotencyKey);
  }
}

class LoopbackHttpTransactionalProvider implements TransactionalActionProvider {
  readonly kind = "local" as const;
  private readonly http: LoopbackHttpCommerceProvider;
  constructor(fetcher: LoopbackFetch, timeoutMs: number) {
    this.http = new LoopbackHttpCommerceProvider(fetcher, timeoutMs);
  }
  quoteRefund(command: RefundCommand) {
    return this.http.call<RefundQuote>(
      "/transactions/quote-refund",
      {
        binding: command.binding,
        command,
      },
      quoteSchema,
    );
  }
  issueRefund(command: RefundCommand) {
    return this.http.call<RefundEffect>(
      "/transactions/issue-refund",
      {
        binding: command.binding,
        command,
      },
      effectSchema,
    );
  }
}

class LoopbackHttpKnowledgeProvider implements KnowledgeProvider {
  readonly kind = "local" as const;
  private readonly http: LoopbackHttpCommerceProvider;
  constructor(fetcher: LoopbackFetch, timeoutMs: number) {
    this.http = new LoopbackHttpCommerceProvider(fetcher, timeoutMs);
  }
  search(binding: ProviderBinding, query: string, topK: number) {
    return this.http.call<KnowledgeEvidence[]>(
      "/knowledge/search",
      {
        binding,
        query,
        topK,
      },
      z.array(evidenceSchema),
    );
  }
  listChanged(binding: ProviderBinding, since?: string) {
    return this.http.call<
      Awaited<ReturnType<KnowledgeProvider["listChanged"]>>
    >("/knowledge/list-changed", { binding, since });
  }
  fetchDocument(binding: ProviderBinding, source: string) {
    return this.http.call<KnowledgeEvidence | undefined>(
      "/knowledge/fetch-document",
      { binding, source },
      z
        .union([evidenceSchema, z.null()])
        .transform((value) => value ?? undefined),
    );
  }
}
