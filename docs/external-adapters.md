# External adapter setup

The default local profile uses `SUPPORT_SOURCE=mock` and `COMMERCE_SOURCE=mock`. It has no provider account requirement and is the only profile used by the ordinary test suite.

## Intercom development workspace

Use a separate development workspace and set `SUPPORT_SOURCE=intercom` plus `INTERCOM_DEVELOPMENT_ENABLED=true`. Supply `INTERCOM_TENANT_ID=local-demo`, `INTERCOM_APP_ID`, `INTERCOM_ACCESS_TOKEN`, `INTERCOM_CLIENT_SECRET`, and `INTERCOM_ADMIN_ID`, then run:

```bash
npm run check:env -- --profile=intercom
```

The adapter pins `Intercom-Version: 2.16` and accepts `https://api.intercom.io` or `https://api.eu.intercom.io` outside tests. Request conversation read/write and contact read permission. Add ticket read/write when `INTERCOM_TICKET_TYPE_ID` is set; `INTERCOM_TICKET_STATE_ID` is optional and cannot be set without the ticket type. Add article read/list permission only when `INTERCOM_KNOWLEDGE_ENABLED=true`.

Expose `POST /support/webhooks/intercom` over HTTPS. It accepts only bounded raw `application/json` bytes, verifies the `X-Hub-Signature` HMAC-SHA1 before parsing, and checks the authenticated event timestamp. Subscribe only to `conversation.user.created` and `conversation.user.replied`; admin, note, and operator events are acknowledged but cannot loop into replies.

A Conversation remains the durable canonical reference. Replies, escalation notes, status changes, and configured ticket conversion are fenced, ordered outbox operations. A timeout, connection loss, HTTP 408/5xx, malformed POST response, or crash after a send starts is stored as uncertain and escalated for manual reconciliation; it is never blindly replayed because Intercom does not document an idempotency header for these operations. Switching back to mock affects new local ingress only: existing Intercom bindings must be reconciled against their original development account.

## Stripe test sandbox

Use a test restricted key only. Set `COMMERCE_SOURCE=stripe`, `STRIPE_SANDBOX_ENABLED=true`, `STRIPE_TENANT_ID=local-demo`, `STRIPE_ACCOUNT_ID`, `STRIPE_RESTRICTED_API_KEY`, and `STRIPE_WEBHOOK_SECRET`, then run:

```bash
npm run check:env -- --profile=stripe
```

The adapter pins Stripe API `2026-08-26.dahlia`, uses `https://api.stripe.com` outside tests, rejects live resources, and requires an `rk_test_` restricted key. Grant read access to Account, Customers, Checkout Sessions, PaymentIntents, Subscriptions, Invoices, Invoice Payments, and Refunds. Grant write access only to Refunds and Subscriptions. Subscription writes are limited to a verified owner's `cancel_at_period_end=true` request; immediate cancellation, proration, credits, and invoice changes are not performed.

Expose `POST /support/webhooks/stripe` for `refund.created`, `refund.updated`, and `refund.failed`. The route verifies bounded raw JSON, Stripe HMAC/timestamp, test mode, configured account, and the pinned API version before parsing. An approved refund writes a leased attempt using a stable Stripe idempotency key. A created refund remains pending until a terminal webhook or retrieval result; an unknown POST outcome is not retried with a fresh key after Stripe's 24-hour idempotency window. Reconciliation retrieves the refund again, so a late failure can correct an earlier observation and escalate once.

A sandbox test requires separate human authorization and redacted evidence; this repository does not run it automatically.
