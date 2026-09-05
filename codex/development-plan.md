# Development Plan

Status: Discovery approved; Spec Readiness decisions approved, executable gates pending

## Phase index

| Phase | Objetivo | Dependências |
|---|---|---|
| `PHASE-001` | Capturar baseline, validar Mastra e remover Zendesk com segurança | Discovery aprovado, DEC-011–DEC-013, DEC-017, DEC-018 |
| `PHASE-002` | Estabilizar contracts e modo local persistente | PHASE-001, DEC-005 |
| `PHASE-003` | Completar multi-turn, identidade e approval safety | PHASE-002, DEC-006, DEC-008, DEC-009 |
| `PHASE-004` | Tornar evals, supervisor e monitoring executáveis | PHASE-002–003, DEC-010 |
| `PHASE-005` | Integrar Intercom | PHASE-002–004, DEC-003, DEC-006 |
| `PHASE-006` | Integrar Stripe sandbox | PHASE-002–004, DEC-004, DEC-007 |
| `PHASE-007` | Hardening, documentação e release do template | PHASE-005–006 |

## Registro das revisões obrigatórias

Todos os achados da revisão brownfield/Mastra estão vinculados a uma fase. O fechamento exige a evidência indicada; marcar somente o código como concluído não basta.

| Review | Revisão necessária | Requisito | Fonte/decisão | Fase | Evidência de aceitação |
|---|---|---|---|---|---|
| `REV-001` | Migrar o WIP de Bun para npm workspaces, fixar Node.js/npm, substituir `latest` por versões Mastra exatas compatíveis com o novo lock e validar as APIs e IDs OpenAI realmente resolvidos antes de refatorar. | `REQ-P0-012` | `SRC-002`, `SRC-016`, `SRC-017`, `SRC-019`, `SRC-021`, `DEC-011`–`DEC-013`, `DEC-017` | `PHASE-001` | `npm ci`, registry audit, build, typecheck e registro das versões validadas sob Node.js 24.20.0/npm 11.19.0. |
| `REV-002` | Remover adapter, routes, env, dependency e documentação Zendesk sem perder o contrato provider-neutral. | `REQ-P0-010`, `REQ-P0-012` | `SRC-001`, `SRC-003`, `DEC-001` | `PHASE-001` | Caracterização verde e busca revisada sem referência funcional Zendesk. |
| `REV-003` | Registrar tools além de agents/workflows/scorers no composition root; acessar primitives pelo registry quando dependerem dos serviços compartilhados. | `REQ-P0-012` | `SRC-003`, `SRC-016`, `SRC-017` | `PHASE-001` | Registry audit e testes de instância única com storage/logging/tracing. |
| `REV-004` | Eliminar `{} as any` e chamadas programáticas que fabricam execution context; preservar request context, tracing e hooks. | `REQ-P0-008`, `REQ-P0-012` | `SRC-003`, `SRC-016`, `SRC-017` | `PHASE-001` | Typecheck estrito e teste de propagação de context/correlation IDs. |
| `REV-005` | Integrar `requireApproval` a um agent run dentro do workflow, com uma única decisão humana sobre tool call/command imutável e recovery durável. | `REQ-P0-002`, `REQ-P0-011`, `REQ-P0-012` | `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`, `DEC-009` | `PHASE-003` | E2E approve/reject/tamper/replay/restart sem bypass nem dupla aprovação. |
| `REV-006` | Manter o supervisor assistivo/read-only e demonstrar seu uso no Studio sem torná-lo controlador do pipeline transacional. | `REQ-P0-001`, `REQ-P0-007`, `REQ-P1-003` | `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`, `DEC-010` | `PHASE-004` | Acceptance experiment e trace comprovando somente tools não destrutivas. |
| `REV-007` | Corrigir semântica de memory: thread identifica a conversa/case e resource o owner/customer, ambos tenant-qualified; follow-ups anexados não podem ser descartados. | `REQ-P0-005`, `REQ-P0-009` | `SRC-003`, `SRC-015`, `SRC-016` | `PHASE-003` | Multi-turn E2E, separação entre clientes/tenants e replay de follow-up. |
| `REV-008` | Substituir identidade vinda de body/email/localStorage por principal server-side, auth port, RBAC e tenant scope. | `REQ-P0-002`, `REQ-P0-005`, `REQ-P0-009` | `SRC-003`, `SRC-015`, `DEC-008` | `PHASE-003` | Testes negativos de customer/agent/approver e acesso cross-tenant. |
| `REV-009` | Evoluir o case store JSON para schema/migrations/versionamento e controle de concorrência; persistir messages, approvals, actions, outbox e idempotency. | `REQ-P0-004`, `REQ-P0-005`, `REQ-P0-011` | `SRC-003`, `SRC-015` | `PHASE-002`, `PHASE-003` | Migration, restart, compare-and-set e decisão concorrente testados. |
| `REV-010` | Trocar dinheiro em `number` e idempotência em `Map` por minor units/decimal exato e registros duráveis; reconciliar status financeiro assíncrono. | `REQ-P0-002`, `REQ-P0-011`, `REQ-P1-002` | `SRC-003`, `SRC-015`, `DEC-007`, `DEC-009` | `PHASE-002`, `PHASE-006` | Over-refund, currency, replay, restart e pending/succeeded/failed testados. |
| `REV-011` | Substituir processamento fire-and-forget e outbound best-effort por retomada de workflow, outbox, retry/backoff e receipts persistidos. | `REQ-P0-001`, `REQ-P0-011` | `SRC-003` | `PHASE-002`, `PHASE-005`, `PHASE-006` | Crash/restart e falhas 429/5xx/timeout recuperam sem duplicar efeitos. |
| `REV-012` | Tornar reindexação RAG segura, com proveniência/freshness e índice versionado/blue-green em vez de apagar o índice válido primeiro. | `REQ-P0-006` | `SRC-003`, `SRC-017` | `PHASE-004` | Failure injection preserva busca anterior e permite rollback verificável. |
| `REV-013` | Transformar scorers isolados em datasets/experiments/gates para os seis eixos, incluindo consistência multi-turn e critérios do supervisor. | `REQ-P0-007` | `SRC-001`, `SRC-003`, `SRC-017`, `DEC-010` | `PHASE-004` | Relatório versionado, thresholds aprovados e execução reproduzível em CI. |
| `REV-014` | Medir tokens/custo, duração, latency/error de tools/providers via spans reais e correlacionar com métricas de domínio e feedback. | `REQ-P0-008` | `SRC-001`, `SRC-003`, `SRC-017` | `PHASE-004` | Fixtures + integration tests provam todos os indicadores e falhas lentas. |
| `REV-015` | Tipar/validar boundaries externas e gerar ou compartilhar contratos do frontend; documentar OpenAPI sem depender de tipos duplicados manualmente. | `REQ-P0-012`, `REQ-P1-003` | `SRC-003`, `SRC-017` | `PHASE-001`, `PHASE-007` | Schemas rejeitam payload inválido, OpenAPI é verificável e contract drift falha no CI. |
| `REV-016` | Completar adapters Intercom/Stripe sob os mesmos ports, com webhook verification, rate-limit/retry, mapping por case e conformance contra o local/HTTP. | `REQ-P0-003`, `REQ-P0-011`, `REQ-P1-001`, `REQ-P1-002` | `SRC-001`, `SRC-014`, `SRC-015`, `DEC-003`–`DEC-007` | `PHASE-005`, `PHASE-006` | Suites de contrato e E2E redigidos nos dois sandboxes. |
| `REV-017` | Definir minimização/retenção/redaction de PII, scopes/secrets, licença, CI, quickstarts e documentação que corresponda apenas ao comportamento provado. | `REQ-P0-009`, `REQ-P0-012` | `SRC-002`, `SRC-003` | `PHASE-003`, `PHASE-007` | Security/privacy tests, LICENSE, docs audit e smoke test em clone limpo. |

## Fases

### PHASE-001 — Baseline verificável e remoção do WIP Zendesk

- Objective: Criar rede de segurança sobre o comportamento útil atual e executar `DEC-001` sem regressão do modo mock.
- Included: migração para um npm workspace único; remoção de Bun; Node.js 24.20.0/npm 11.19.0 fixados; install frozen e verificação das APIs Mastra e IDs OpenAI resolvidos; Prettier, Oxlint, Vitest e Playwright; scripts de format/typecheck/lint/unit/integration/contract/E2E/eval/build; registro das tools no composition root; acesso a agents pelo registry Mastra; remoção de execution contexts fabricados; testes de caracterização de schemas, ingest, workflow, approval/rejection, RAG e API; remoção de adapter/dependency/env/docs/routes Zendesk; correção da documentação que afirma capacidades inexistentes.
- Excluded: novo provider real, redesenho de domínio, auth de produção.
- Dependencies: Discovery aprovado; `DEC-011`, `DEC-012`, `DEC-013`, `DEC-017`, `DEC-018`; documentação embedded da versão resolvida; baseline `df2cb0d`.
- Requirements: `REQ-P0-010`, `REQ-P0-012`.
- Acceptance criteria: nenhuma referência funcional Zendesk ou Bun permanece; modo mock preserva os fluxos caracterizados; agents/tools/workflows/scorers exigidos estão registrados; chamadas preservam o runtime context aplicável; `npm ci`, format check, lint, typecheck, tests e build provam as versões declaradas.
- Verification evidence: comandos de typecheck, lint, unit/integration e build; busca por referências Zendesk revisada; golden cases do WIP.
- Completion conditions: gates npm completos verdes, sem exceções temporárias, e diff revisado sem mudança externa não planejada.
- Rollback/recovery: commits separados entre testes, remoção e docs; reverter apenas a remoção mantém a caracterização.

### PHASE-002 — Provider contracts e runtime local persistente

- Objective: Fazer o core depender de contracts estáveis e substituir mocks voláteis por implementações persistentes Studio-first.
- Included: ports de support/commerce/transaction/knowledge; provider registry por tenant/case; repositories e migrations SQLite/libSQL; durable idempotency; fixtures/seed/reset; SQLite in-process default com façade HTTP opcional conforme `DEC-005`; contract tests.
- Excluded: qualquer SDK externo e autenticação de produção.
- Dependencies: PHASE-001; `DEC-005` Accepted.
- Requirements: `REQ-P0-003`, `REQ-P0-004`, `REQ-P0-011`, `REQ-P0-012`.
- Acceptance criteria: workflow e tools não importam arrays mock; restart preserva order/refund/idempotency; suite de contrato passa no provider local; Studio inicia em um quickstart documentado.
- Verification evidence: integration test com restart, duplicate event/refund replay, timeout/failure injection e migration up/down.
- Completion conditions: mock local é referência de conformidade para adapters externos.
- Rollback/recovery: manter adapter de compatibilidade temporário; migrations reversíveis e banco fixture regenerável.

### PHASE-003 — Conversas multi-turn, isolamento e approval safety

- Objective: Tornar case/thread/approval corretos para múltiplos usuários e follow-ups.
- Included: append de inbound events; Conversation canônica e Ticket opcional; thread como conversa e resource como owner, ambos tenant-qualified; auth port com identidades/roles/tenants seedados; tenant/customer scope; RBAC admin/approver; mecanismo de approval definido em `DEC-009`; immutable approved command; concurrency control; UI scoped; audit trail.
- Excluded: SSO enterprise e política final de IAM para todos os deploys.
- Dependencies: PHASE-002; `DEC-006`, `DEC-008` e `DEC-009` Accepted.
- Requirements: `REQ-P0-002`, `REQ-P0-005`, `REQ-P0-009`, `REQ-P0-011`, `REQ-P1-003`.
- Acceptance criteria: follow-up continua a thread correta; acesso cross-tenant é negado; approver ID não vem do cliente; alteração do command após approval impede execução; decisões simultâneas produzem um único resultado.
- Verification evidence: auth/RBAC tests, multi-turn E2E, concurrency/replay tests e audit snapshot.
- Completion conditions: nenhum caminho transacional bypassa identity + approval + idempotency.
- Rollback/recovery: feature flag mantém demo single-tenant somente em ambiente local explícito; dados de approval são append-only.

### PHASE-004 — Knowledge lifecycle, evals e observabilidade

- Objective: Provar grounding/qualidade e operar o pipeline com sinais completos.
- Included: provenance/version/freshness de knowledge; index swap seguro; datasets dos seis evals; deterministic checks; acceptance cases do supervisor conforme `DEC-010`; trace correlation; custo de tokens; latency/error de tools; dashboard/API atualizados; feedback correlacionado.
- Excluded: auto-tuning em produção e alerting de uma plataforma específica.
- Dependencies: PHASE-002, PHASE-003 e `DEC-010` Accepted.
- Requirements: `REQ-P0-006`, `REQ-P0-007`, `REQ-P0-008`, `REQ-P1-003`, `REQ-P1-004`.
- Acceptance criteria: cada eval roda sobre dataset versionado; monitoring inclui todos os indicadores do brief; reindex failure preserva índice anterior; feedback liga case e trace.
- Verification evidence: eval report, metric fixtures, span/tool failure integration tests e knowledge rollback test.
- Completion conditions: thresholds e tolerâncias definidos em `DEC-014` passam localmente.
- Operational limits: evals e sandboxes respeitam `DEC-016`; falhas financeiras e violações de budget/latency/error rate permanecem bloqueantes e observáveis.
- Rollback/recovery: índices versionados permitem troca reversa; dashboard tolera métricas indisponíveis sem mascará-las.

### PHASE-005 — Intercom development workspace

- Objective: Provar ingest/reply/escalation no Intercom sem contaminar o domínio.
- Included: Intercom conforme `DEC-003`; development workspace; webhook verification; Conversation canônica e Ticket opcional conforme `DEC-006`; follow-ups; notes/status; contact mapping; retry/rate limit; optional knowledge sync.
- Excluded: Zendesk e adapters adicionais.
- Dependencies: PHASE-002–004; `DEC-003` e `DEC-006` Accepted; acesso humano ao workspace e credenciais de desenvolvimento.
- Requirements: `REQ-P0-003`, `REQ-P0-005`, `REQ-P0-009`, `REQ-P0-011`, `REQ-P1-001`, `REQ-P1-004`.
- Acceptance criteria: evento real cria/anexa case; resposta e escalonamento retornam ao ticket correto; replay não duplica; falha é recuperável; scopes mínimos documentados.
- Verification evidence: contract suite, redacted webhook fixture, provider sandbox run e delivery receipt.
- Completion conditions: adapter opt-in passa os mesmos cenários do mock e pode ser removido sem alterar o core.
- Rollback/recovery: config retorna ao mock; outbox preserva itens do provider e impede envio pelo adapter errado.

### PHASE-006 — Stripe sandbox

- Objective: Provar lookup e refund aprovado no Stripe sandbox.
- Included: Stripe conforme `DEC-004`; compra avulsa e assinatura conforme `DEC-007`; Customer/Checkout/PaymentIntent/Invoice/Subscription mapping; refund history; quote; approved execution; async reconciliation; currency/minor units; least-privilege scopes.
- Excluded: dinheiro real, produção e segundo provider não aprovado.
- Dependencies: PHASE-002–004; `DEC-004` e `DEC-007` Accepted; acesso humano ao Stripe sandbox.
- Requirements: `REQ-P0-002`, `REQ-P0-003`, `REQ-P0-009`, `REQ-P0-011`, `REQ-P1-002`.
- Acceptance criteria: sandbox lookup fundamenta o draft; nenhum refund sem approval válida; replay não duplica; pending/succeeded/failed são reconciliados; over-refund é negado.
- Verification evidence: contract suite, sandbox transaction IDs redigidos, webhook/reconciliation tests e approval audit.
- Completion conditions: provider demonstra happy path e falhas sem transação real.
- Rollback/recovery: execução externa é opt-in; commands pendentes permanecem presos ao provider original; compensação é manual/auditada quando irreversível.

### PHASE-007 — Hardening e release do template

- Objective: Transformar a implementação validada em template reproduzível e honesto.
- Included: CI, quickstarts local/external, env validation, seed/reset, troubleshooting, license/contributing cleanup, security/privacy notes, screenshots/example cases e smoke test from clean clone.
- Excluded: deploy de produção e suporte a providers adicionais.
- Dependencies: PHASE-005 e PHASE-006.
- Requirements: todos os P0; `REQ-P1-001`, `REQ-P1-002`, `REQ-P1-003`.
- Acceptance criteria: clone limpo executa localmente; external adapters têm setup isolado; docs não prometem capacidade não testada; CI cobre gates definidos.
- Verification evidence: clean-room run log, CI run, docs link check e final traceability audit.
- Completion conditions: todos os requisitos têm evidência e nenhuma pergunta blocking/P0/P1 permanece aberta.
- Rollback/recovery: release tags e migrations documentadas; provider adapters continuam opcionais.
