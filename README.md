# Customer Support Resolution and Refund Agent

A [Mastra](https://mastra.ai) template for a customer support agent that resolves real support cases end to end while keeping refunds and credits under human control. It combines triage, policy retrieval, order lookup, grounded response drafting, and a required human approval step before any refund is issued.

## Why we built this

Once a support agent can issue refunds, a bad policy citation or a mistaken order lookup becomes a real financial risk. This template shows a safer pattern: let the agent do the support work, but require a human to approve the one action that moves money.

It demonstrates several Mastra patterns working together in one system: multi-agent orchestration, RAG over support policy docs, workflow suspension and resume for human approval, and gated tool execution for transactional actions.

## Demo

This demo runs in Mastra Studio, but it also includes a demo UI in `web/` with a customer portal and a support admin queue. The customer portal lets you submit sample support requests. The admin queue shows the case, the retrieved policy, the draft response, and the refund approval decision.

You can also connect this workflow to your React, Next.js, or Vue app using the [Mastra Client SDK](https://mastra.ai/docs/server/mastra-client) or agentic UI libraries like [AI SDK UI](https://mastra.ai/guides/build-your-ui/ai-sdk-ui), [CopilotKit](https://mastra.ai/guides/build-your-ui/copilotkit), or [Assistant UI](https://mastra.ai/guides/build-your-ui/assistant-ui).

## Prerequisites

- Node.js 24.20.0 and npm 11.19.0 (pinned in `.nvmrc`, `package.json`, and the npm lockfile)
- An [OpenAI API key](https://platform.openai.com/api-keys) only when you want to run the live model or embedding paths. The deterministic local tests do not require one.

## Quickstart 🚀

1. **Clone the template**
   - Run `npx create-mastra@latest --template customer-refund-agent` to scaffold the project locally.
2. **Add your API keys**
   - Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
3. **Install the pinned workspace**
   - Run `npm ci`.
4. **Start the Mastra app**
   - Run `npm run dev` and open [localhost:4111](http://localhost:4111).
5. **Start the demo UI**
   - In a second terminal, run `npm run --workspace support-refund-agent-web dev`, then open [localhost:5173](http://localhost:5173).

From the customer portal, submit a sample case such as "I was charged twice". Then open the support admin queue to review the triage result, policy grounding, order lookup, and draft response. If the case recommends a refund, approve or reject it from the admin UI.

## Making it yours

This template is meant to be a starting point for real support operations.

- **Support channel scope**: the default adapter is a deterministic mock inbound email source so the demo works without external accounts. This baseline does not include an external support adapter; setting another `SUPPORT_SOURCE` returns an explicit diagnostic instead of silently using the mock.
- **Replace the mock commerce backend**: `src/mastra/lib/mock-commerce.ts` contains deterministic order, subscription, and refund fixtures. Replace it with calls to Shopify, Stripe Billing, or your internal orders system.
- **Case storage**: `src/mastra/lib/case-store.ts` persists cases to the same libSQL database as the rest of the app's Mastra storage - a local `file:./mastra.db` file by default, or Turso in production when `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are set (see `.env.example`). Swap in a different backend if you need one (e.g. a dedicated Postgres table) by reimplementing `CaseStore`.
- **Approval limitation**: `resolveSupportCaseWorkflow` preserves the existing demo suspension and resume checkpoint. Native agent tool approval, an immutable financial command, and durable idempotency are later-phase work; direct `tool.execute` does not activate `requireApproval`.
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
