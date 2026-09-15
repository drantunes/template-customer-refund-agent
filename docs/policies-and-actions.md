# Policies and actions

A policy tells support what it may recommend. It does not create an action, grant permission, or change customer data.

## Configure local policy documents

1. Add a `PolicyDocument` module under `src/mastra/knowledge/docs/` with `title`, stable `source`, and `text`.
2. Register it in `src/mastra/knowledge/policy-docs.ts` through `POLICY_DOCUMENTS`.
3. In the support UI, sign in as `admin@local.test` / `local-admin` and choose **Reindex knowledge**. An authenticated admin can also call `POST /support/knowledge/reindex`.

Editing a source document does not replace an already-published index; reindex after each change. Existing cases retain their knowledge binding.

```ts
import type { PolicyDocument } from "../types.ts";

export const billingPolicy: PolicyDocument = {
  title: "Billing policy",
  source: "billing-policy",
  text: "Eligible purchases may be reviewed for a refund.",
};
```

## Optional Intercom Articles

Set `INTERCOM_KNOWLEDGE_ENABLED=true` in a configured development Intercom environment to use published Articles. Give the adapter article read/list permission, publish the Article, then reindex with the same admin action or endpoint. Local documents do not automatically update Intercom Articles.

## Supported actions

The template supports refunds, a credit for the next invoice, and end-of-period subscription cancellation. Every financial proposal still requires authenticated human approval. A policy for a coupon, pause, or another offer does not implement that action.
