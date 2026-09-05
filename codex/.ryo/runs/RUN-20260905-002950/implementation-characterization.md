# PHASE-001 implementation characterization

Recorded before removing the Zendesk WIP adapter on 2026-09-04 with Node.js 24.20.0 and npm 11.19.0 from `/private/tmp/ryo-phase001-runtime/bin`.

- `npm ci --no-audit --no-fund`: passed; 783 packages installed from the root `package-lock.json`.
- `npm ci --dry-run --ignore-scripts --no-audit --no-fund`: passed.
- `npm run test:unit`: 3 files and 4 tests passed. The suite covers support-case schema rejection, mock inbound normalization/rejection, and the pre-removal Zendesk selection/signature behavior.
- `npm run test:integration`: 2 files and 7 tests passed. The suite covers malformed inbound API JSON, the case-list response envelope, real registered workflow suspension/approval, rejection escalation, non-refund escalation, injected workflow failure, and actual ingest duplicate-event behavior.

The workflow tests use only deterministic triage, response, and embedding doubles. They preserve the normal Mastra workflow runtime, temporary libSQL storage, registered workflows, mock adapter, and real read-only/refund tool calls; no OpenAI credential or external provider is used. The injected failure intentionally logs `Synthetic triage failure` while asserting the workflow returns `failed`.

Observed baseline limitations retained for later phases: direct programmatic `issue_refund` execution does not enforce native `requireApproval`; the current workflow checkpoint is retained but the native approval/immutable-command redesign is explicitly PHASE-003 work. The current mock storage/idempotency model is also characterized only and remains PHASE-002 work.
