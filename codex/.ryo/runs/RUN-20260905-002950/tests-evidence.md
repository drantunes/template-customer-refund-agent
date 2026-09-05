# PHASE-001 test evidence

Executed with `/private/tmp/ryo-phase001-runtime/bin` first on `PATH`.

- `npm run check:runtime` verified Node.js `v24.20.0` and npm `11.19.0`; unit coverage also proves a mismatched npm user agent fails.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm run typecheck:web` passed. Frontend strict mode is enabled in `web/tsconfig.app.json`.
- `npm run test:unit` passed: 3 files, 5 tests.
- `npm run test:integration` passed: 3 files, 9 tests. The workflow characterization passes the same nonempty `RequestContext` object and correlation ID through the registered workflow, both registered agents, and the registered RAG tool, with a real tracing context. A separate deterministic test indexes policy chunks and queries an isolated libSQL vector store. It retains the intentional deterministic triage-failure assertion, which logs an expected error while the test verifies the failed result.
- `npm run test:contract` passed: 1 file, 4 tests. It checks all public support OpenAPI paths and success response definitions, path parameters, invalid inbound DTO rejection, and unsupported provider behavior.
- `npm run build:web` passed. Vite reported its existing 531 kB minified chunk warning.
- `npm run test:e2e` passed after allowing local listeners: 2 Playwright tests. The journey serves actual registered handlers over loopback Hono, through Vite's proxy, with isolated libSQL and only generation/embedding doubles. It covers UI submission, approval/refund, rejection/escalation, a no-refund resolution, and a malformed inbound 400 with no new case.

The API negative-path characterization now verifies malformed approval JSON produces a 400 before it can resume a workflow or mutate case state. Monitoring has a Zod response schema shared with the frontend type and is present in OpenAPI.

Remaining phase limitations: current direct `Tool.execute` behavior does not prove agent hooks/native tool approval. Native approval/auth/idempotency redesign remains explicitly deferred to PHASE-002/003.
