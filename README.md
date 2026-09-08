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

### Local Studio inspection

Mastra Studio uses the same local credentials as the demo. Its supported credential handshake is `POST /api/auth/credentials/sign-in`; a signed, expiring bearer token then identifies the session to `GET /api/auth/capabilities` and Studio API requests. The only built-in Studio scope in this phase is read-only registry metadata: local `support-agent` and `admin` identities may list or inspect the explicitly registered agents, workflows, and tools. Customers, approvers, other-tenant identities, and every non-GET request are denied.

Studio does not expose workflow runs or snapshots, traces/logs, memory/storage, native approvals, or tool/agent/workflow execution. Those routes can carry tenant-qualified case content or bypass the application's approval boundary, so operational work remains on the authenticated `/support/*` routes and demo UI. Application observability redacts customer prose, email/credential values, payloads, and error text before storage or export while retaining identifiers, status, and timing diagnostics.

## Making it yours

This template is meant to be a starting point for real support operations.

- **Support channel scope**: the default adapter is deterministic local inbound email, so the demo works without external accounts. The optional Intercom development adapter is enabled only with `SUPPORT_SOURCE=intercom` and `INTERCOM_DEVELOPMENT_ENABLED=true`; incomplete configuration fails at startup and never falls back to mock. It pins `Intercom-Version: 2.16`, accepts public signed notifications only at `POST /support/webhooks/intercom`, validates bounded raw `application/json` bytes with `X-Hub-Signature` HMAC-SHA1 before parsing, then checks the authenticated event timestamp. Subscribe only to `conversation.user.created` and `conversation.user.replied`; admin/note/operator events are acknowledged but cannot loop back into replies.
- **Intercom development setup**: use a development workspace and a non-production app/token. This template retains its existing authenticated tenant mapping, so `INTERCOM_TENANT_ID` must be `local-demo`; another external tenant fails explicitly rather than accessing local-demo commerce data. Set `INTERCOM_APP_ID`, `INTERCOM_ACCESS_TOKEN`, `INTERCOM_CLIENT_SECRET`, and `INTERCOM_ADMIN_ID` from the development app. Request least privilege: read/write conversations and read contacts; add read/write tickets only with `INTERCOM_TICKET_TYPE_ID`; add read/list articles only with `INTERCOM_KNOWLEDGE_ENABLED=true`. The externally reachable webhook must be HTTPS. Outside tests the API destination is restricted to approved Intercom API origins. No credentials, external mutations, or sandbox calls are performed by this repository's local test suite.
- **Intercom delivery and recovery**: a Conversation is the durable canonical reference. Replies, escalation notes, status changes, and configured ticket conversion are separate immutable outbox operations, fenced and ordered per case. The ticket conversion uses `POST /conversations/{id}/convert` with `ticket_type_id` and optional attributes; the returned `id` is persisted as the API identifier, not display `ticket_id`. Every `429` pauses only that tenant/account using numeric/date `Retry-After`, `X-RateLimit-Reset`, or bounded fallback. A durable pre-send marker means a timeout, connection loss, HTTP 408/5xx, malformed POST response, or crash after send start is stored as **uncertain**, escalated for manual reconciliation, and is never blindly retried because Intercom does not document an idempotency header for these operations. Switching back to `SUPPORT_SOURCE=mock` only affects new local ingress; existing Intercom cases/outbox rows retain their binding and must be reconciled or drained against their original development account.
- **Intercom knowledge**: article sync is disabled by default. When enabled, the adapter reads Articles through the existing candidate/publication/rollback lifecycle and preserves tenant, account, source version, effective timestamp, and provenance. Local fixture knowledge remains the selected authority unless the accepted Intercom case persisted an enabled knowledge binding.
- **Local providers**: `src/mastra/providers/contracts.ts` defines separate support, commerce, transaction, and knowledge ports. `src/mastra/runtime/local-runtime.ts` supplies persistent SQLite fixtures; `LocalRuntime.seed(binding)` is repeatable and `reset(binding)` deletes only that tenant/account fixture scope.
- **Safe fixture commands**: `TURSO_DATABASE_URL=file:./support-local.db npm run local:seed` is repeatable. `TURSO_DATABASE_URL=file:./support-local.db npm run local:reset` only clears the selected fixture scope and refuses if it contains durable refund/idempotency effects. Both commands reject non-`file:` database URLs and leave Mastra tables and unrelated tenant/account data untouched.
- **Recovery lifecycle**: Use `npm run dev` for Studio or `npm run start` for the built server. Both load `src/mastra/index.ts`, which seeds the local default fixture and runs bounded dispatch/outbox recovery. Existing `suspended`, `waiting`, and `paused` Mastra runs remain suspended; only pending work is started and active runs are restarted with their stable persisted run ID.
- **Case storage**: `src/mastra/lib/case-store.ts` owns versioned app tables for cases, messages, events, dispatch, actions, idempotency, and outbox records. Its migrations do not alter Mastra tables and refuse a downgrade that would discard durable records.
- **Approval boundary**: each displayed refund command has an immutable fingerprint. The approver must submit that exact fingerprint; the server records one authenticated durable decision, fences resume ownership, and invokes Mastra's native tool approval. A later recovery sweep can resume a committed decision without issuing another effect.
- **Retention**: DEC-015 measures raw-payload and case windows from the server acceptance time; provider event dates are retained only as untrusted occurrence metadata. After 90 days a case becomes a write-denying tombstone, terminal approval prose is minimized, and residual content from earlier deployments is repaired by later sweeps. Inbound raw payloads and inbound workflow snapshots expire after 7 days, case content and Mastra memory after 90 days, observability spans after 30 days, and financial audit content after 365 days; replay keys remain for safety. Supported workflow snapshots for expired cases include `ingest-support-case`, `resolve-support-case`, `agentic-loop`, and `durable-agentic-loop`; active recovery snapshots remain intact. Runtime sweeps are bounded and run at `SUPPORT_RETENTION_SWEEP_MS`; `npm run local:retention` runs one sweep against a `file:` database only. All retention values are observable in `.env` and may only shorten these windows.
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

Synthetic unit, contract, and temporary-SQLite integration fixtures prove local code paths only. They are not evidence of a real Intercom sandbox run. Before declaring an external integration complete, obtain explicit authorization and record redacted development-workspace receipts for signed event/follow-up/replay, reply, escalation/status/conditional ticket, optional article sync, and binding-safe rollback within the approved sandbox budget.
