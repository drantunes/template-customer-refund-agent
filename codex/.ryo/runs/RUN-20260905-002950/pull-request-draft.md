# PHASE-001: establish verified npm baseline and remove Zendesk

This completes PHASE-001: establish a reproducible Node.js 24.20.0/npm 11.19.0 workspace and remove the WIP Zendesk integration while preserving the characterized local mock journeys. Mastra packages are pinned to validated versions, all required tools are registered, and request context is preserved through HTTP entrypoints, workflow handoff, specialists and tools. Existing API boundaries use Zod and shared frontend contracts with an OpenAPI description.

Characterization was committed before removal. Deterministic coverage exercises registered workflows with temporary libSQL, approval/rejection, duplicate ingestion, injected failures, actual RAG indexing/query and browser journeys through real loopback HTTP handlers. The current workflow approval checkpoint is retained; native agent approval, authentication/tenant isolation and durable financial idempotency remain in their approved later phases.

Validation: all 20 required Ryo local gates pass, covering exact runtime, frozen install, backend/frontend format, lint, strict typecheck, unit, integration, contracts, phase-scoped deterministic eval, builds, Playwright E2E and diff integrity. DEC-018 bootstrap exceptions have been removed. Independent review findings are fixed and reverified; final human merge authorization remains required.

Ryo execution: RUN-20260905-002950. Scope: PHASE-001 only (REQ-P0-010 / REQ-P0-012; REV-001/002/003/004/015).

Proposed destination: https://github.com/drantunes/template-customer-refund-agent

Head branch: `ryo/phase-001-baseline`

Base branch: `main`

Reviewed source commit: `d7a56dd`; intended publication SHA including review evidence: `c68e911441338c3180b52b3658ec7933e2f3554d`.

Publication was explicitly authorized by Diego Antunes and PR #1 was opened. Its first published-SHA review identified PR-001, subsequently fixed in f71b2cf and independently reviewed with all 20 gates passing. Synchronization, final published-SHA review, human merge approval and post-merge validation are tracked in the run state.
