# Local troubleshooting

Use Node.js 24.20.0 and npm 11.19.0. `npm run check:runtime` reports a version mismatch before the application starts.

`npm run check:env -- --profile=local` uses interactive mode and requires both a non-empty `OPENAI_API_KEY` and a unique `LOCAL_AUTH_SIGNING_KEY` of at least 32 characters in `.env`. For a credential-free test or smoke validation, use `npm run check:env -- --profile=local --mode=deterministic`. Keep `SUPPORT_SOURCE=mock` and `COMMERCE_SOURCE=mock` for the local demo. Provider profiles validate every enabled provider, so selecting a named profile cannot hide incomplete Intercom or Stripe configuration.

`npm run local:seed`, `npm run local:reset`, and `npm run local:retention` accept only `TURSO_DATABASE_URL=file:...`. Seed is repeatable. Reset leaves Mastra tables and unrelated fixtures untouched, but refuses to erase a fixture binding containing refund, idempotency, or delivery effects. Use a new local database for a fresh demonstration when reset refuses.

The local admin UI is served on `http://localhost:5173/admin` and proxies `/support/*` to the backend on `http://localhost:4111`. Start `npm run dev` first, then `npm run --workspace support-demo-ui dev`. The browser E2E suite chooses an isolated temporary database and mock providers; it requires the Playwright Chromium runtime already installed.

In Mastra Studio, a signed local support agent or admin can open a registered workflow and use **Recent runs** to inspect tenant-authorized history. SQLite keeps that history across restarts; inbound snapshots expire after seven days and case-linked workflow history after 90 days. Provider failures show only a safe HTTP status, error code/type, request ID, and operation stage for staff review. Refund writes still require a fresh authenticated application approval.

External provider calls are not part of ordinary local verification. Follow the [external adapter guide](external-adapters.md) only after the required human sandbox authorization is available.
