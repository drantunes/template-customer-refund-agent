# Contributing

This is the standalone repository for the Customer support resolution and refund agent template. Please open issues and pull requests in this repository.

Before opening a pull request, use Node.js 24.20.0 and npm 11.19.0, then install with `npm ci`. Do not commit `.env`, provider credentials, real customer data, or sandbox receipts containing identifiers that have not been redacted.

Changes to provider adapters must remain opt-in and must not make remote provider calls in the ordinary test suite. Keep fixture cases synthetic, preserve the authenticated approval boundary, and document any user-visible operational change.

The optional local loopback HTTP façade is an advanced provider conformance
harness in `src/mastra/providers/advanced/loopback-http.ts`. It is exercised
only by its deterministic integration tests; it is not selected by normal
local runtime composition.

Local development installs its own SIGINT/SIGTERM handler so recovery workers
finish before Mastra and SQLite close. This uses Mastra's documented
`handleShutdownSignals: false` option; the generated CLI therefore cannot
drain active HTTP connections before shutdown. Durable work is recovered on
the next local start.

## Local verification

Run these check-only commands from the repository root with synthetic environment values. `check:env` defaults to interactive mode and requires a non-empty `OPENAI_API_KEY`; the README covers that preflight for a local interactive run. Use `--mode=deterministic` for credential-free tests and smoke checks.

```bash
npm run check:runtime
npm run check:env -- --profile=local --mode=deterministic
npm run check:docs
npm run format:check
npm run lint && npm run lint:web
npm run typecheck && npm run typecheck:web
npm run test
npm run build && npm run build:web
```

`npm run test` runs unit, integration, contract, and eval suites in both workspaces. `npm run test:e2e` is a separate browser check using deterministic models, synthetic identities, a temporary SQLite file, and mock provider selection. `npm run smoke:clean` validates a clean clone with deterministic environment validation; it needs the package registry and Playwright browser already available and never calls Intercom, Stripe, or a paid model.

`CAPTURE_LOCAL_DEMO_SCREENSHOTS=1 npm run test:e2e` refreshes the two committed synthetic screenshots. Ordinary E2E runs do not write documentation assets.
