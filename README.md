# Customer Support Resolution and Refund Agent

A [Mastra](https://mastra.ai) template for a customer support agent that resolves real support cases end to end while keeping refunds and credits under human control. It combines triage, policy retrieval, order lookup, grounded response drafting, and a required human approval step before any refund is issued.

## Why we built this

Once a support agent can issue refunds, a bad policy citation or a mistaken order lookup becomes a real financial risk. This template shows a safer pattern: let the agent do the support work, but require a human to approve the one action that moves money.

It demonstrates several Mastra patterns working together in one system: multi-agent orchestration, RAG over support policy docs, workflow suspension and resume for human approval, and gated tool execution for transactional actions.

## Demo

The local app includes a demo UI in `web/` with a customer portal and a support admin queue. The customer portal lets you submit sample support requests. The admin queue shows the case, the retrieved policy, the draft response, and the refund approval decision.

You can also connect this workflow to your React, Next.js, or Vue app using the [Mastra Client SDK](https://mastra.ai/docs/server/mastra-client) or agentic UI libraries like [AI SDK UI](https://mastra.ai/guides/build-your-ui/ai-sdk-ui), [CopilotKit](https://mastra.ai/guides/build-your-ui/copilotkit), or [Assistant UI](https://mastra.ai/guides/build-your-ui/assistant-ui).

## Prerequisites

- Node.js 24.20.0 and npm 11.19.0 (pinned in `.nvmrc`, `package.json`, and the npm lockfile)
- An [OpenAI API key](https://platform.openai.com/api-keys) only when you want to run the live model or embedding paths. The deterministic local tests do not require one.

## Quickstart 🚀

1. **Clone the template**
   - Run `npx create-mastra@latest --template customer-refund-agent` to scaffold the project locally.
2. **Configure the local app**
   - Copy `.env.example` to `.env`, set a unique `LOCAL_AUTH_SIGNING_KEY` of at least 32 characters, and set `OPENAI_API_KEY` only when using live model or embedding paths.
3. **Install the pinned workspace**
   - Run `npm ci`.
4. **Seed and start the Mastra app**
   - Set `TURSO_DATABASE_URL=file:./support-local.db`, run `npm run local:seed`, then run `npm run dev`. Startup performs bounded recovery for durable dispatches and deliveries, then repeats it in the local process.
5. **Start the demo UI**
   - In a second terminal, run `npm run --workspace support-refund-agent-web dev`, then open [localhost:5173](http://localhost:5173).

From the customer portal, submit a sample case such as "I was charged twice". Then open the support admin queue to review the triage result, policy grounding, order lookup, and draft response. If the case recommends a refund, approve or reject it from the admin UI.

The local UI starts with `alex@example.com` / `local-customer-alex` in the customer portal and `approver@local.test` / `local-approver` in the approval queue. These are fixed synthetic accounts for a local demo only. Sessions are signed, expire after eight hours, and their server-side tenant and role are checked on every request.

Mastra Studio may still expose its own metadata interface, but built-in agent, workflow, approval, memory, storage, and trace endpoints are denied for every local identity. Operate cases only through the authenticated `/support/*` routes and demo UI, which apply tenant, owner, and role checks.

## Making it yours

This template is meant to be a starting point for real support operations.

- **Support channel scope**: the default adapter is a deterministic mock inbound email source so the demo works without external accounts. This baseline does not include an external support adapter; setting another `SUPPORT_SOURCE` returns an explicit diagnostic instead of silently using the mock.
- **Local providers**: `src/mastra/providers/contracts.ts` defines separate support, commerce, transaction, and knowledge ports. `src/mastra/runtime/local-runtime.ts` supplies persistent SQLite fixtures; `LocalRuntime.seed(binding)` is repeatable and `reset(binding)` deletes only that tenant/account fixture scope.
- **Safe fixture commands**: `TURSO_DATABASE_URL=file:./support-local.db npm run local:seed` is repeatable. `TURSO_DATABASE_URL=file:./support-local.db npm run local:reset` only clears the selected fixture scope and refuses if it contains durable refund/idempotency effects. Both commands reject non-`file:` database URLs and leave Mastra tables and unrelated tenant/account data untouched.
- **Recovery lifecycle**: Use `npm run dev` for Studio or `npm run start` for the built server. Both load `src/mastra/index.ts`, which seeds the local default fixture and runs bounded dispatch/outbox recovery. Existing `suspended`, `waiting`, and `paused` Mastra runs remain suspended; only pending work is started and active runs are restarted with their stable persisted run ID.
- **Case storage**: `src/mastra/lib/case-store.ts` owns versioned app tables for cases, messages, events, dispatch, actions, idempotency, and outbox records. Its migrations do not alter Mastra tables and refuse a downgrade that would discard durable records.
- **Approval boundary**: each displayed refund command has an immutable fingerprint. The approver must submit that exact fingerprint; the server records one authenticated durable decision, fences resume ownership, and invokes Mastra's native tool approval. A later recovery sweep can resume a committed decision without issuing another effect.
- **Retention**: DEC-015 redacts inbound raw payloads after 7 days, case content and Mastra memory after 90 days, and observability spans after 30 days. Financial audit records remain for 365 days and idempotency/effect records remain for replay safety. A pending case reaching 90 days is minimized and failed closed without a financial decision. The sweep then removes workflow snapshots belonging to that expired case through Mastra's supported workflow-storage API; active cases remain recoverable before the case window ends. Runtime sweeps are bounded and run at `SUPPORT_RETENTION_SWEEP_MS`; `npm run local:retention` runs one sweep against a `file:` database only. All retention values are observable in `.env` and may only shorten these windows.
- **Extend the agent system**: `triageAgent`, `responseAgent`, and `supportSupervisorAgent` live in `src/mastra/agents/`. Add more specialist agents or evals in `src/mastra/index.ts` as your workflow grows.
- **Customize the knowledge base**: support policy docs live in `src/mastra/knowledge/docs/` and are indexed for `search_support_knowledge`. Replace them with your own refund, shipping, subscription, and escalation policies.

## About Mastra templates

[Mastra templates](https://mastra.ai/templates) are ready-to-use projects that show off what you can build. Clone one, poke around, and make it yours. They live in the [Mastra monorepo](https://github.com/mastra-ai/mastra) and are automatically synced to standalone repositories for easier cloning.

Want to contribute? See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Local verification

Run the check-only commands from the repository root:

```bash
npm run format:check
npm run lint && npm run lint:web
npm run typecheck && npm run typecheck:web
npm run test:unit && npm run test:integration && npm run test:contract && npm run test:eval
npm run build && npm run build:web
```

`test:e2e` runs the browser-backed local demo journey after Playwright's Chromium runtime is installed. The package does not perform browser downloads during `npm ci`.
