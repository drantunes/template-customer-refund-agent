# Traceability

| Requirement | Source | Decision | Phase | Acceptance evidence | Status |
|---|---|---|---|---|---|
| REQ-P0-001 | SRC-001, SRC-003, SRC-014, SRC-015, SRC-016, SRC-018 | DEC-002, DEC-003, DEC-004, DEC-006, DEC-007, DEC-010 | PHASE-002, PHASE-003, PHASE-005, PHASE-006 | E2E do fluxo completo + Studio run/trace | Confirmed |
| REQ-P0-002 | SRC-001, SRC-003, SRC-015, SRC-016, SRC-017, SRC-018 | DEC-002, DEC-007, DEC-008, DEC-009 | PHASE-003, PHASE-006 | Approval/RBAC/audit tests + native tool-approval sandbox evidence | Confirmed |
| REQ-P0-003 | SRC-001, SRC-003, SRC-014, SRC-015 | DEC-002, DEC-003, DEC-004, DEC-005, DEC-006, DEC-007 | PHASE-002, PHASE-005, PHASE-006 | Contract suite contra local, Intercom e Stripe | Confirmed |
| REQ-P0-004 | SRC-001, SRC-003, SRC-011 | DEC-002, DEC-005 | PHASE-002 | Clean local run + restart/idempotency evidence | Confirmed; Q-003 closed |
| REQ-P0-005 | SRC-001, SRC-003, SRC-014, SRC-015 | DEC-002, DEC-003, DEC-006, DEC-008 | PHASE-003, PHASE-005 | Multi-turn E2E + cross-tenant denial | Confirmed |
| REQ-P0-006 | SRC-001, SRC-003, SRC-021 | DEC-002, DEC-017 | PHASE-004, PHASE-005 | Provenance/freshness assertions + safe reindex test + embedding model registry audit | Confirmed |
| REQ-P0-007 | SRC-001, SRC-003, SRC-016, SRC-017, SRC-018, SRC-019, SRC-021 | DEC-002, DEC-010, DEC-014, DEC-017 | PHASE-004 | Versioned OpenAI eval report para seis eixos + thresholds/regression policy + supervisor acceptance experiment | Confirmed |
| REQ-P0-008 | SRC-001, SRC-003, SRC-004, SRC-021 | DEC-002, DEC-016, DEC-017 | PHASE-004 | Metric fixtures + budget/alert assertions + dashboard/API integration tests | Confirmed |
| REQ-P0-009 | SRC-001, SRC-003, SRC-015, SRC-019 | DEC-002, DEC-008, DEC-015 | PHASE-003, PHASE-005, PHASE-006 | Auth/RBAC/webhook/PII negative tests + retention cleanup evidence | Confirmed |
| REQ-P0-010 | SRC-001, SRC-003, SRC-004, SRC-023 | DEC-001, DEC-018 | PHASE-001 | Characterization suite + zero functional Zendesk refs + no temporary gate exceptions before PR | Confirmed |
| REQ-P0-011 | SRC-001, SRC-003, SRC-015 | DEC-002, DEC-004, DEC-005, DEC-006, DEC-007 | PHASE-002, PHASE-003, PHASE-005, PHASE-006 | Duplicate/replay/restart/outbox/reconciliation tests | Confirmed |
| REQ-P0-012 | SRC-002, SRC-003, SRC-016, SRC-017, SRC-018, SRC-019, SRC-021, SRC-023 | DEC-001, DEC-002, DEC-009–DEC-018 | PHASE-001–PHASE-007 | npm frozen-install + format/lint/typecheck/test/build + Mastra/OpenAI registry audit + CI/gate logs por fase | Confirmed |
| REQ-P1-001 | SRC-001, SRC-005, SRC-012, SRC-014, SRC-015 | DEC-003, DEC-006 | PHASE-005 | Intercom development-workspace contract/E2E | Confirmed |
| REQ-P1-002 | SRC-001, SRC-009, SRC-013, SRC-014, SRC-015 | DEC-004, DEC-007 | PHASE-006 | Stripe sandbox contract/E2E | Confirmed |
| REQ-P1-003 | SRC-001, SRC-003, SRC-015, SRC-016, SRC-018 | DEC-002, DEC-008, DEC-010 | PHASE-003, PHASE-004, PHASE-007 | Portal/admin + supervisor Studio E2E + clean-room demo | Confirmed |
| REQ-P1-004 | SRC-001, SRC-005, SRC-014, SRC-015 | DEC-003, DEC-006 | PHASE-004, PHASE-005 | Intercom knowledge sync/reindex evidence | Confirmed |
