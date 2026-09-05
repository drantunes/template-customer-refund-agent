Implements PHASE-002: provider contracts and a persistent local runtime. Accepted cases retain their provider bindings, financial effects and pending work across restarts. A crash after a refund reuses the persisted approval and refund receipt, then completes the original workflow and delivery.

- Adds support, commerce, transaction and knowledge ports with a per-account registry, SQLite migrations, versioned case writes and exact monetary values.
- Persists inbound deduplication, immutable refund commands, idempotency, dispatch leases, an outbox and delivery receipts. Local seed/reset preserves durable history.
- Adds an optional validated loopback HTTP facade, shared provider conformance tests and a documented local quickstart.

Validation: all 20 configured gates pass, including 56 integration tests, contract tests, E2E and both builds. Independent review reproductions cover approved/rejected crash recovery, real-time lease renewal, stale workers, account isolation and malformed HTTP payloads. Built startup and graceful shutdown pass with a fresh local database.

Scope remains PHASE-002. Production identity/RBAC and native approval belong to PHASE-003; external providers remain later phases.
