# Technical Specification

Status: Discovery approved; Spec Readiness decisions approved, executable gates pending

## Contexto do sistema

O produto é um template Mastra executável em dois modos:

1. **Local Studio-first:** support, commerce/payment e knowledge mocks reproduzíveis em SQLite in-process, com façade HTTP opcional para testes de conformance/failure e sem contas externas (`DEC-005`).
2. **External adapters:** Intercom em development workspace e Stripe em sandbox (`DEC-003`, `DEC-004`).

Fluxo alvo: inbound event → normalização/deduplicação → triage → RAG → lookup → draft estruturado → policy/risk decision → suspensão para aprovação quando transacional → execução idempotente → resposta ou escalonamento → feedback/monitoring.

O Mastra Studio continua sendo a superfície principal para explorar agents, workflows, tools, runs, snapshots, scorers e traces. Portal/admin permanecem uma demonstração complementar.

OpenAI é o provider padrão para geração, avaliação e embeddings (`DEC-017`). Os IDs de modelo presentes no WIP são candidatos de compatibilidade, não uma autorização para substituição silenciosa: `PHASE-001` deve validá-los no provider registry da versão Mastra instalada.

## Arquitetura e component boundaries

### Camadas propostas

- **Domain:** schemas e invariantes de Case, Conversation, Evidence, Approval, Transaction e ProviderRef; não importa SDK de fornecedor.
- **Application workflows:** orquestram passos determinísticos, state transitions, retries e compensações. Somente esta camada pode solicitar execução transacional.
- **Agents:** triage e response specialists geram structured output; o supervisor coordena exploração/assistência e nunca recebe tool financeira.
- **Provider ports:** `SupportChannelProvider`, `CommerceProvider`, `TransactionalActionProvider` e `KnowledgeProvider`.
- **Provider adapters:** mock local, Intercom e Stripe conforme `DEC-003`/`DEC-004`.
- **Persistence:** repositories libSQL/SQLite com migrations para cases, messages, approvals, actions, outbox e idempotency records; storage Mastra para memory/workflow snapshots/observability.
- **Delivery:** custom API routes para UI e webhooks, protegidas conforme o ator; frontend React mantém portal/admin.

### Regra de orchestration

Workflows controlam o fluxo transacional e o supervisor permanece assistivo/read-only para Studio e investigação (`DEC-010`). Workflows usam specialists registrados no pipeline; o supervisor não controla state transitions nem transações.

Para refunds, um execution agent restrito propõe `issue_refund` dentro do workflow e ativa o native tool approval (`DEC-009`). O workflow persiste agent run, tool call, argumentos/fingerprint e command financeiro imutável, então suspende a jornada. A UI autenticada aprova ou rejeita exatamente esse command; na retomada, a tool revalida policy, amount, currency, versão e idempotency antes de chamar o provider. Essa é uma única decisão humana compartilhada entre os lifecycles de agent e workflow, não duas aprovações independentes.

### Conformidade com o runtime Mastra

- Manter agents code-registered; file-based agents são opcionais e não oferecem ganho necessário para este template.
- Registrar agents, tools, workflows e scorers no composition root, conforme `AGENTS.md` e o registry suportado pelo Mastra.
- Dentro de workflows/routes, obter agents e demais primitives da instância Mastra quando o acesso aos serviços compartilhados for necessário; evitar imports diretos que contornem storage/logging/registry.
- Não invocar tools com execution context fabricado por `as any`; chamadas programáticas devem preservar tracing, request context, hooks e invariantes equivalentes.
- Usar thread como conversa/case tenant-qualified e resource como customer/owner tenant-qualified; authorization continua no domínio, nunca na memória.
- Manter `registerApiRoute` onde adequado, migrando boundaries externas para schemas tipados/OpenAPI com `createRoute()` ou validação Zod equivalente.
- Fixar no manifest as versões Mastra exatas compatíveis com o lock e provar build, tests e evals antes de qualquer refatoração ou upgrade (`DEC-011`).

### Toolchain e workspace

- O template usa Node.js `24.20.0` LTS e npm `11.19.0`, ambos fixados em arquivos de versão, `engines` e `packageManager` aplicáveis (`DEC-012`).
- A raiz e `web/` formam um único npm workspace e compartilham um `package-lock.json`; `npm ci` é a instalação normativa. Bun, `bun.lock` e comandos Bun pertencem somente ao baseline WIP e são removidos em `PHASE-001`.
- Prettier executa format check; Oxlint executa lint; TypeScript executa typecheck; Vitest executa unit, integration e contract tests; Playwright executa E2E (`DEC-013`).
- Gates chamam scripts npm check-only e nunca executam autofix. Instalação/lock usa `npm ci --dry-run --ignore-scripts --no-audit --no-fund` como verificação não mutável.
- Para iniciar `PHASE-001`, `DEC-018` permite exceções temporárias de format, style, unit-test e integration-test em backend e frontend; `git diff --check` é o único gate ativo no bootstrap. As exceções expiram antes de `PR_READY`, quando os scripts npm completos devem existir, os gates devem ser regenerados e todos executados.

### Provider selection

Cada case persiste `{tenantId, providerKind, providerAccountId, externalConversationId}`. A resolução recupera o adapter a partir dessa referência; não usa uma variável global mutável. Múltiplos providers podem coexistir sem misturar outbound.

- Intercom é o único support adapter real desta entrega; Conversation é a identidade canônica do case e Ticket é criado ou associado somente quando houver escalonamento ou trabalho estruturado (`DEC-006`).
- Stripe é o único commerce/payment adapter real; a suite externa cobre compra avulsa e assinatura (`DEC-007`).
- Support logístico (shipping, fulfillment, damaged item) permanece coberto pelo provider local mock.

## Interfaces e contratos

Os nomes são conceituais durante Discovery; schemas finais serão definidos e versionados na implementação.

### `SupportChannelProvider`

- `verifyInbound(request): VerifiedEvent` — autentica assinatura/secret e limita replay.
- `normalizeInbound(event): NormalizedConversationEvent` — inclui tenant, event ID, conversation ID, actor, body, attachments e timestamp.
- `sendReply(ref, message, idempotencyKey): DeliveryResult`.
- `addInternalNote(ref, note, idempotencyKey): DeliveryResult`.
- `updateStatus(ref, status, idempotencyKey): DeliveryResult`.
- Eventos repetidos retornam o mesmo efeito; follow-ups anexados não são descartados.

### `CommerceProvider`

- `findCustomer(identity)`; `findOrder(query)`; `findSubscription(query)`; `listRefunds(orderRef)`.
- Resultados carregam provider IDs, currency, timestamps, status, source version e freshness.
- Lookup por email isolado não basta quando houver ambiguidade; order/subscription ID e tenant têm precedência.

### `TransactionalActionProvider`

- `quoteRefund(input)` valida amount disponível, currency, policy e estado corrente sem movimentar dinheiro.
- `executeRefund(approvedCommand, idempotencyKey)` aceita apenas command ligado a uma approval persistida e retorna `pending | succeeded | failed`.
- O payload aprovado é imutável ou protegido por hash/version; mudança de amount/order/reason invalida a approval.
- Valores financeiros usam minor units inteiras ou decimal exato; `number` binário não será contrato financeiro final.

### `KnowledgeProvider`

- `listChanged(since)` e `fetchDocument(ref)` normalizam policy, product knowledge e metadata.
- Cada chunk registra source URI, provider ID, document version/hash, effective date, indexedAt e tenant.
- Reindexação usa índice versionado/blue-green ou rollback equivalente; falha não apaga o índice válido anterior.

### API interna do demo

- Manter compatibilidade funcional de ingest/list/detail/approve/reject/feedback/monitoring/reindex durante a migração.
- Separar endpoint de demo autenticado do endpoint webhook de provider.
- Approve/reject obtém `approverId` do principal autenticado, não do body.
- List/detail sempre aplicam tenant e role scope.
- Respostas assíncronas expõem status de workflow, transaction e outbound separadamente.

## Dados e estado

### Agregados mínimos

- **Case:** identidade, tenant, provider ref, subject, status público, triage, resolution e version.
- **Message:** append-only, provider event ID, author, content, createdAt.
- **Evidence:** policy/product/order snapshot com provenance e freshness.
- **Approval:** approver principal, role, approved command hash, decision, reason e timestamps.
- **TransactionalAction:** amount/currency em representação exata, provider ref, idempotency key, attempt e final status.
- **OutboxDelivery:** reply/note/status, attempts, next retry, last error e provider receipt.
- **Feedback:** actor, rating/comment, trace link e timestamps.

### State transitions

- Estados públicos atuais (`new`, `processing`, `waiting_approval`, `resolved`, `escalated`, `failed`) devem ser preservados ou migrados de forma compatível.
- Estados internos distinguem workflow, approval, transaction e delivery; `resolved` só significa conclusão do caso quando o contrato de produto definir o tratamento de delivery pendente.
- Escritas concorrentes usam version/compare-and-set ou transação para impedir lost updates e double approval.
- Migrations são versionadas e testadas sobre uma cópia do schema WIP; nenhuma transformação destrutiva silenciosa.

## Segurança e privacidade

- Rotas de portal/admin usam um auth port provider-neutral; o modo local oferece identidades, roles e tenants determinísticos seedados. Admin e approver exigem role explícita (`DEC-008`).
- Tenant/customer scope é aplicado server-side. Email/query/body nunca representa autorização.
- Cada webhook adapter valida assinatura, timestamp/replay window e tamanho/content type antes de parsear.
- Secrets ficam apenas no ambiente/secret manager e nunca são persistidos no case ou enviados ao frontend.
- Raw payload é minimizado; PII recebe redaction em logs/traces. Defaults aprovados: raw payload por no máximo 7 dias, casos por 90 dias, logs/traces por 30 dias e audit financeiro por 365 dias; fixtures e datasets usam somente dados sintéticos sem PII real (`DEC-015`).
- Refund/credit exige least-privilege scopes, allowlist de operação, amount/currency/order checks, durable idempotency e audit trail.
- Knowledge externo deve respeitar ACL/tenant e não misturar documentos entre contas.
- Development/sandbox credentials nunca apontam para produção por default.

## Failure handling e recovery

- Inbound responde rapidamente após persistir event/case; processamento assíncrono pode ser retomado.
- Eventos são deduplicados por provider account + event ID; mensagens são deduplicadas separadamente do case.
- Timeouts, 429 e 5xx de provider usam retry limitado com backoff/jitter e classificação retryable/non-retryable.
- Outbound usa outbox durável; falha de reply não é escondida apenas em log.
- Refund pending/failure é reconciliado por webhook ou polling; não se presume sucesso pela criação do objeto.
- Idempotency record sobrevive a restart e workers concorrentes.
- Knowledge indexing mantém último índice íntegro disponível.
- Caso sem evidence suficiente, lookup ambíguo, policy conflict ou tool failure crítico termina em escalonamento com motivo observável.

## Observabilidade e operações

- Correlation IDs: `tenantId`, `caseId`, `threadId`, `workflowRunId`, `traceId`, `providerEventId`, `transactionId`.
- Métricas obrigatórias: containment, escalation, refund recommended/approved/rejected/executed/failed, feedback, input/output tokens, custo estimado por modelo, duração por etapa e latency/error rate por tool/provider.
- Diferenciar decisão recusada, erro do workflow, erro financeiro e erro de delivery.
- Dashboards não dependem somente do JSON do case; combinam domain events e observability spans de forma testável.
- Logs estruturados passam por redaction e nunca registram secrets ou payload financeiro completo.
- Operações live são proibidas. Uma execução completa de eval em CI tem budget máximo de USD 5 e uma validação manual de sandbox, USD 10; atingir o limite interrompe a validação explicitamente (`DEC-016`).
- Toda falha injetada de provider/tool deve ser classificada e resultar em retry ou escalation. Alertar quando error rate superar 2% em 15 minutos, p95 de provider/tool superar 5 segundos ou ocorrer qualquer refund failure (`DEC-016`).

## Verification strategy

- **Static:** TypeScript strict para backend/frontend, lint frontend e validação de schemas/migrations.
- **Unit:** invariantes financeiras, mapping de status, dedup, state machine, policy decision, monitoring math e adapters normalizers.
- **Contract:** mesma suite contra mocks in-process, façade HTTP e cada provider sandbox.
- **Integration:** libSQL real temporário, workflow suspend/resume, durable idempotency, outbox/retry, knowledge index swap e auth/RBAC.
- **E2E:** portal → resolution; approval → refund; rejection → escalation; follow-up multi-turn; cross-tenant denial; restart durante approval/refund/delivery.
- **Evals:** dataset versionado com positive/negative/adversarial cases para os seis scorers. Casos críticos de segurança, autorização, approval, replay e finanças exigem 100%; groundedness, policy compliance, routing accuracy, tool-call correctness e multi-turn consistency exigem pelo menos 90%; resolution quality exige pelo menos 85%. Nenhuma regressão crítica é aceita; nos demais eixos, a queda máxima é 2 pontos percentuais contra o baseline aprovado (`DEC-014`).
- **External sandbox:** gravações/evidências redigidas provam webhook, lookup, refund e reply sem dinheiro real.

Não há comandos suficientes de verificação no baseline. `PHASE-001` deve implementar os scripts npm aprovados antes de remover ou refatorar o WIP; os gates permanecem bloqueados até que todos os comandos existam e sejam check-only.

## Rollout e rollback

- Evoluir em fases pequenas mantendo modo mock funcional.
- Caracterizar o WIP antes de remover Zendesk.
- Introduzir contracts atrás do wiring atual, migrar mocks, depois eliminar imports diretos.
- Migrations de dados possuem backup/rollback e compatibilidade mínima com casos em andamento.
- External adapters ficam opt-in por config validada; ausência de credencial retorna diagnóstico e nunca cai silenciosamente em provider diferente.
- Feature flags/config selecionam provider por tenant/case; rollback volta ao mock sem reinterpretar casos externos existentes.

## Open technical questions

- `Q-001` a `Q-015` estão fechadas em `DEC-003` a `DEC-017`; não permanece pergunta P0/P1 aberta.
- OpenAI é o provider aprovado, mas IDs de modelo indisponíveis no registry instalado exigem HITL; não há fallback implícito.
- A implementação só começa após aprovação explícita do Discovery.
