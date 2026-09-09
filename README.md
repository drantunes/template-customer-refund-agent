# Customer support resolution and refund agent

This template accepts a signed-in customer's support message, gathers local policy and order evidence, and prepares a response or a human-reviewed refund decision. It includes a deterministic local demo with a customer portal and support queue, built with [Mastra](https://mastra.ai).

## Why we built this

Support teams need to resolve routine questions quickly without turning a language model into a payment authority. A duplicate charge can require policy evidence, order context, a clear customer response, and a financial decision that remains accountable to a person.

This template keeps that boundary visible. The local mock workflow lets a team evaluate the full support experience while a refund remains a single authenticated approval tied to an immutable command.

## Features

- Accepts a customer message and keeps later follow-ups in the same tenant-scoped case.
- Finds local policy and order evidence before drafting a resolution.
- Shows customers their own cases and gives staff an operational review queue.
- Requires an authenticated approver to accept or reject each proposed refund.
- Runs with synthetic local fixtures; Intercom and Stripe stay explicit development/sandbox opt-ins.

## Prerequisites

- Node.js 24.20.0 and npm 11.19.0, as pinned in `.nvmrc`, `package.json`, and the lockfile.
- An `OPENAI_API_KEY` for an interactive local agent run. Deterministic tests and the local mock browser test replace model calls and do not need one.

## Quick start

### 1. Clone the template

Run:

```bash
git clone https://github.com/drantunes/template-customer-refund-agent.git
cd template-customer-refund-agent
npm ci
```

### 2. Add your API keys

Copy the example file and set a unique `LOCAL_AUTH_SIGNING_KEY` with at least 32 characters. Set `OPENAI_API_KEY` before starting the interactive local agent; it is optional only for deterministic tests and smoke paths that replace model calls.

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put that generated value after `LOCAL_AUTH_SIGNING_KEY=` in `.env`, keep `SUPPORT_SOURCE=mock` and `COMMERCE_SOURCE=mock`, then validate the local profile:

```bash
npm run check:env -- --profile=local
```

### 3. Start the dev server

```bash
npm run local:seed
npm run dev
```

In another terminal, run `npm run --workspace support-refund-agent-web dev`, then open [the local portal](http://localhost:5173). Sign in as `alex@example.com` with `local-customer-alex`, send “I was charged twice,” and open the admin queue as `approver@local.test` / `local-approver` to review the synthetic case. The case reaches a pending refund decision; approving it records the local mock result.

Mastra Studio is available at [localhost:4111](http://localhost:4111) for its read-only registry. Use the portal and admin queue for case work, approvals, and monitoring.

## Provider setup and operational notes

The [external adapter guide](docs/external-adapters.md) describes the isolated Intercom development and Stripe test-sandbox profiles. It does not authorize or perform provider calls. The [security and privacy notes](docs/security-privacy.md) describe the local demo identities, approval boundary, redaction, retention, and secret handling. [Local troubleshooting](docs/troubleshooting.md) covers fixture safety and ports. [Synthetic example cases and tested screenshots](docs/examples.md) show the local mock flow.

## Making it yours

- Replace the mock support or commerce selection only after configuring the matching development/sandbox profile and its least-privilege credentials. Keep each persisted case bound to its original provider account.
- Adapt the local policy documents, approval policy, and evaluation datasets to the rules your support team needs to enforce.

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build with Mastra. Clone one, try it in Studio, and adapt it to your use case.

Want to contribute? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Local verification

Run the check-only commands from the repository root:

```bash
npm run check:runtime
npm run check:env -- --profile=local
npm run check:docs
npm run format:check
npm run lint && npm run lint:web
npm run typecheck && npm run typecheck:web
npm run test
npm run build && npm run build:web
```

`npm run test:e2e` uses only deterministic models, synthetic identities, a temporary SQLite file, and mock provider selection. `npm run smoke:clean` performs the reproducible clean-clone command for the checked-out commit; it needs the package registry and the Playwright browser already available to the environment. It never calls Intercom, Stripe, or a paid model.

`CAPTURE_LOCAL_DEMO_SCREENSHOTS=1 npm run test:e2e` refreshes the two committed synthetic screenshots from that same mock-flow test. Ordinary E2E runs do not write documentation assets.
