# Add a policy or a support action

A policy tells support what it may recommend. A tool implements what the system can actually do. Adding a knowledge document does not create a Stripe operation or grant the agent permission to execute it.

## Add knowledge to the local template

1. Create a TypeScript module under `src/mastra/knowledge/docs/` exporting a `PolicyDocument` with `title`, a stable `source`, and `text`.
2. Import that document into `src/mastra/knowledge/policy-docs.ts` and add it to `POLICY_DOCUMENTS`.
3. Restart the backend if it is not running in watch mode. Sign into the support panel as an admin and choose **Reindex knowledge**, or call authenticated `POST /support/knowledge/reindex`.
4. Ask a realistic question and check the retrieved documents and selected excerpts in **AI Analysis**.

Indexing runs through the registered `indexSupportKnowledgeWorkflow`. It publishes a new knowledge generation with provenance and document hashes. Editing a source file does not replace an already-published index: reindex it. Automatic publishing during resolution only initializes a missing index.

For example, this proposed policy describes an offer; it does not implement the offer:

```ts
import type { PolicyDocument } from "../types.ts";

export const retentionOfferPolicy: PolicyDocument = {
  title: "Retention offer policy",
  source: "retention-offer-policy",
  text: `# Retention offer policy

- When a customer requests a subscription pause, support may offer 20% off one future monthly invoice as an alternative.
- Explain that accepting the discount keeps the subscription active; it does not pause service or billing.
- Apply an offer only after the customer accepts and an authorized human approves the exact subscription and discount.
- Do not stack this offer with an existing discount or repeat a previously redeemed retention offer.
- If the customer declines, honor the pause request through the supported account process or transfer it to a specialist.`,
};
```

Choose the actual discount, eligible plans, frequency limit, and expiry for your business before publishing a policy. Include exceptions and what the customer should expect.

## Use Intercom articles instead

With `INTERCOM_KNOWLEDGE_ENABLED=true`, the configured Intercom knowledge provider reads published Articles. Publish or update the article in that development workspace, grant article read/list permission, and reindex through the same admin action. The configured provider determines the source: local files do not automatically update Intercom Articles. Draft articles are not indexed.

Cases preserve their knowledge-provider binding. Changing the environment selects the provider for new cases; it does not silently migrate existing conversations to a different knowledge source.

## Intercom close synchronization

For the development Intercom app, subscribe the existing webhook endpoint to `conversation.admin.closed` while retaining the customer-created and customer-replied topics. The endpoint verifies Intercom's signed, current, configured-account notification before it stores a close intent. A worker then performs a fresh GET of that exact Conversation and only closes the local case when no workflow, dispatch, financial command, attempt, or reconciliation is active. The webhook payload itself is never close authority, and this setup does not authorize closing a real conversation during tests.

## Implement the offer as a real action

The template currently implements refunds, subscription credits, and the supported subscription-cancellation operation. Retention coupons and subscription pauses are extension examples and are not implemented by the policy above.

Use the subscription-credit implementation as the reference for a new approved action:

| Responsibility                            | Existing reference                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Structured draft and action contracts     | `src/mastra/domain/support-case.ts` and `src/mastra/domain/subscription-credit-command.ts`    |
| Provider-neutral operation                | `src/mastra/providers/contracts.ts`                                                           |
| Local fixture behavior and Stripe adapter | `src/mastra/runtime/local-provider.ts` and `src/mastra/providers/stripe/`                     |
| Approval-required execution tool          | `src/mastra/tools/issue-subscription-credit.ts`                                               |
| Persisted proposal and native approval    | `src/mastra/workflows/resolve-support-case-request-approval.ts`                               |
| Recovery, receipts and customer status    | `src/mastra/runtime/native-approval-recovery.ts` and `src/mastra/lib/case-store-financial.ts` |

Define an explicit action such as `apply_retention_discount`, with a command containing the verified customer and subscription, the permitted coupon, its terms, policy evidence, customer consent, and an idempotency key. Validate eligibility in deterministic code immediately before the provider write; retrieved text and the model's recommendation do not replace those checks.

Implement the operation in both the local provider and Stripe adapter. Configure an allowed coupon and apply it to the selected subscription after the exact command receives native human approval. Keep an immutable decision and receipt so retries cannot apply another benefit. Register the tool and execution agent in `src/mastra/index.ts`, wire the structured proposal into the workflow and approval UI, and expose the confirmed result separately from pending approval or delivery.

Stripe distinguishes a coupon (discount terms) from a promotion code (a customer-facing redeemable code). Applying a coupon to a subscription is a different operation from creating the billing-balance credit used by this demo. See [Stripe coupons and promotion codes](https://docs.stripe.com/billing/subscriptions/coupons) and [updating a subscription](https://docs.stripe.com/api/subscriptions/update).

Also decide what “pause” means for your product. Pausing payment collection can leave invoice generation and the subscription active; pausing the subscription itself has different behavior and eligibility. Match the UI wording and implementation to the operation you choose. See [pause payment collection](https://docs.stripe.com/billing/subscriptions/pause-payment) and [pause subscriptions](https://docs.stripe.com/billing/subscriptions/pause).

Before using a new action, test approval and rejection, declined customer consent, wrong tenant/customer/subscription, ineligible plans, existing discounts, duplicate requests, concurrent decisions, timeout/restart recovery, and accurate invoice/customer status. Validate the actual operation in a Stripe sandbox through a fresh human approval.
