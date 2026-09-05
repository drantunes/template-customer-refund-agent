# Codebase Inventory

Status: Complete — round 6 findings mapped to implementation reviews

## Baseline

- Commit observado: `df2cb0df7dc0e9b0e1774306da268c570fa933a7` (`main`, alinhado a `origin/main`).
- Repositório Git: `template-customer-refund-agent/`; o diretório pai não é repositório.
- Modo: brownfield, fork de um WIP.
- Estado antes do Discovery: apenas `codex/` não rastreado, criado por `ryo-init`; nenhum arquivo de aplicação modificado.
- Estrutura relevante: backend em `src/mastra/`, frontend independente em `web/`, documentação em `README.md`, `web/README.md` e `docs/`.
- Evidência: `SRC-002`, `SRC-003`, `SRC-004`.

## Fatos observados

### Stack e manifests

- Runtime declarado: Node.js `>=22.13.0`; gerenciador e lockfile: Bun.
- Backend: TypeScript 6, ESM/ES2022, Mastra; o lock registra `@mastra/core` 1.63.2, evals 1.9.0, libSQL 1.22.2, memory 1.28.1, observability 1.17.4 e RAG 2.6.0.
- Dados: `@libsql/client`; Zod 4 para contratos; OpenAI via Mastra model router.
- Frontend: React 19, Vite 8, React Router 7, Tailwind 4, Base UI/shadcn e oxlint.
- `node_modules` não estava presente; nenhuma verificação executável foi rodada nesta etapa.
- Licença declarada em `package.json`: Apache-2.0; não existe arquivo `LICENSE` rastreado.

### Entry points e arquitetura atual

- `src/mastra/index.ts` é o composition root. Registra três agentes, três workflows, scorers, vector store, API routes, storage libSQL, logger e observabilidade.
- `triageAgent` produz classificação estruturada; `responseAgent` produz resolução estruturada e acessa ferramentas read-only; `supportSupervisorAgent` delega aos dois especialistas e está disponível no Studio.
- O fluxo operacional não usa o supervisor: `resolve-support-case.ts` chama diretamente triage e response agents em sequência.
- `ingest-support-case` normaliza e persiste um payload, deduplica por `(source, externalId)` e inicia o workflow de resolução em background.
- `resolve-support-case` executa: classificar → recuperar política → consultar commerce → redigir → suspender para aprovação quando há refund → executar ou escalar → sincronizar com a origem.
- `index-support-knowledge` recria um índice vetorial e indexa seis políticas embutidas em módulos TypeScript.
- `server/routes.ts` expõe ingestão, lista/detalhe, approve/reject, feedback, monitoring e reindexação.

### Contratos e integrações

- `domain/support-case.ts` centraliza schemas Zod para caso, mensagens, triagem, políticas, pedidos, assinaturas, histórico de refunds, draft, aprovação, feedback e resultado financeiro.
- Existe `SupportSourceAdapter` para normalização inbound, resposta, nota interna e status.
- Implementações atuais: `MockSupportAdapter` e um WIP `ZendeskSupportAdapter`; a seleção é global via `SUPPORT_SOURCE`.
- Não existe contrato equivalente para commerce, payments/refunds ou knowledge. As tools importam diretamente arrays e funções de `mock-commerce.ts`.
- `caseSourceSchema` admite `chat`, mas não há adapter de chat.
- O adapter mock não faz outbound: reply, internal note e status são no-ops.
- O WIP Zendesk permeia dependência `node-zendesk`, env vars, rotas, source enum, active adapter, README e guia de deploy.

### Dados, estado e persistência

- Mastra, vetores e casos usam a mesma configuração libSQL: `file:./mastra.db` local ou Turso por env vars.
- `CaseStore` cria tabela e índice inline; armazena o agregado inteiro como JSON e não possui migrations versionadas nem controle de concorrência.
- Snapshots de workflow dependem do storage Mastra configurado.
- Pedidos, assinaturas e refunds mock são arrays em memória; a idempotência do refund é um `Map` em memória. Reiniciar o processo perde refunds mock e suas chaves idempotentes.
- O caso armazena os trechos de política usados, decisão, mensagens, trace ID, uso agregado de tokens e feedback.

### UI e experiência local

- `web/` é um pacote separado. Rotas: landing, portal e admin; a API é acessada por `/support/*` via proxy local.
- O portal cria casos, faz polling e coleta feedback. Ele usa email fixo, mas chama a listagem sem filtro e pode receber todos os casos.
- O admin lista casos, mostra triagem/políticas/order/draft, permite approve/reject e dispara reindexação.
- O approver ID vem de `localStorage` e é enviado pelo cliente; não há identidade verificada.
- O monitoring dashboard consome apenas métricas de funil, approvals e feedback.
- Componentes UI gerados do shadcn/Base UI foram considerados infraestrutura de apresentação e não analisados individualmente.

### Evals e observabilidade

- Há scorers registrados para groundedness, policy compliance, routing accuracy, tool-call correctness, resolution quality e multi-turn consistency, além de checks estruturais auxiliares.
- Não há datasets, casos de teste executáveis, thresholds, comando de eval ou gate de regressão.
- `SensitiveDataFilter`, storage exporter e platform exporter estão configurados.
- `computeMonitoringSummary` não lê spans e não calcula custo de tokens, latência ou falhas de tools, apesar dos comentários e README afirmarem isso.
- O uso de tokens é agregado no caso, mas não é exposto no resumo de monitoring.

### Testes, CI e entrega

- Não foram encontrados testes unitários, de integração ou E2E.
- Não foram encontrados workflows de CI, Dockerfiles ou configuração de deploy reproduzível.
- O backend oferece apenas `dev`, `build` e `start`; o frontend oferece `dev`, `build`, `lint` e `preview`.
- `CONTRIBUTING.md` ainda contém placeholder `templates/TEMPLATE_NAME` e diz que PRs neste repositório serão ignorados.

### Segurança, privacidade e operação

- Não há autenticação/autorização nas rotas de casos, aprovação, feedback, monitoring ou reindexação.
- Não há isolamento de tenant/usuário; email é usado como filtro opcional, não como autorização.
- O endpoint mock inbound aceita payload arbitrário sem autenticação; o branch Zendesk possui verificação HMAC específica.
- PII e payload bruto podem ser persistidos no JSON do caso. Não há política de retenção, redaction no storage de casos ou exclusão.
- A aprovação financeira confia em `approverId` controlado pelo navegador.
- A sincronização outbound é best-effort: falha só gera log, mas o caso pode permanecer `resolved` sem entrega confirmada.

### Alinhamento com estrutura e exemplos oficiais do Mastra

- O layout `src/mastra/index.ts` + `agents/` + `tools/` + `workflows/` segue a estrutura oficial, assim como ESM/ES2022, TypeScript strict e modelos no formato `provider/model` (`SRC-017`).
- Agents usam `Agent`, tools usam `createTool`, workflows usam `createStep`/`createWorkflow` com schemas e `.commit()`, e as custom routes usam `registerApiRoute`; esses são primitives oficiais atuais.
- O uso de workflow para um pipeline predeterminado e de agents para triagem/redação aberta segue a divisão recomendada pelo framework.
- Suspend/resume com storage LibSQL está alinhado ao padrão oficial de HITL e snapshots persistidos.
- RAG usa `MDocument`, embeddings, `LibSQLVector` e `createVectorQueryTool`; scorers usam a API moderna `createScorer`; observability usa exporters e `SensitiveDataFilter` mostrados na documentação oficial.
- O composition root não registra as tools em `Mastra({ tools: ... })`, embora `AGENTS.md` exija registro de todas as primitives e o Mastra suporte esse registry.
- Dentro do workflow, triage e response são chamados por imports diretos; a documentação recomenda obtê-los da instância Mastra para herdar storage, logging, registry e demais serviços compartilhados.
- Tools são chamadas via `.execute(..., {} as any)`, descartando o execution context. Isso reduz tipagem e pode perder request context/tracing/hooks.
- `issueRefundTool.requireApproval` não é exercitado pelo runtime de agent: o workflow chama `execute` diretamente depois de sua própria suspensão. A documentação oficial só aplica pre-execution approval quando uma tool é chamada por um agent run e retomada via `approveToolCall*`/`declineToolCall*`.
- `threadId` e `resourceId` recebem o mesmo `caseId`. No modelo oficial, thread representa a conversa e resource representa o usuário/entidade proprietária; o WIP portanto isola por caso, mas não demonstra memória multi-thread do cliente nem ownership multiusuário.
- Custom routes são válidas, porém fazem parsing/validação manual. A API oficial `createRoute()` oferece schemas tipados e OpenAPI; autenticação/request context ainda precisam ser adicionados.
- Scorers estão ligados aos agents, mas faltam datasets, experiments/gates e execução em CI; logo há live scoring conceitual, não uma avaliação reproduzível de template.
- A configuração de observability está alinhada, mas o endpoint de monitoring não consulta spans: seu parâmetro Mastra é ignorado e custo/latência/falhas não são calculados.
- Agents code-registered continuam oficialmente suportados; file-based agents são opcionais e não há evidência para migrar este WIP.
- Como `node_modules` não está presente, não foi possível consultar embedded docs nem executar build/typecheck contra as versões resolvidas. O `bun.lock` registra `@mastra/core` 1.63.2; a compatibilidade exata ainda precisa ser provada após instalação frozen.

## Inferências e implicações a validar

- O shape normalizado de `SupportCase` e o adapter de origem são uma boa base para contratos portáveis, mas precisam deixar de depender de um provider global para suportar múltiplas origens simultâneas.
- A suspensão do workflow é hoje a única barreira efetiva. O `requireApproval` na tool é apenas declarativo porque a execução direta não passa pelo ciclo de aprovação do agent; o projeto precisa escolher um único mecanismo autoritativo ou integrar os dois sem dupla aprovação.
- Memória por `caseId` demonstra o primitive, mas não constitui conversa multi-turn: eventos duplicados são ignorados em vez de anexados, e não há identidade/tenant real.
- Policies em TypeScript são adequadas ao demo empacotado, mas não resolvem governança, atualização ou autoria de knowledge externo.
- O JSON agregado acelera o template, porém exigirá estratégia de concorrência/auditoria antes de múltiplos workers ou approvals reais.

## Funcionalidades a preservar

- Composition root único e registro explícito das primitives Mastra.
- Separação entre supervisor, triage e response specialists.
- Schemas Zod e outputs estruturados.
- Workflow explícito e suspensível para human-in-the-loop.
- RAG com trechos e fontes armazenados no caso.
- Fixtures determinísticas e experiência Studio-first sem contas externas.
- Contrato `SupportSourceAdapter` como ponto de partida.
- Deduplicação inbound e intenção de idempotência financeira.
- UI de portal/admin, explicabilidade do caso, feedback e métricas básicas.
- LibSQL local/Turso, logger, observability exporters e sensitive-data processor.
- Cobertura conceitual dos seis eixos de eval solicitados.

## Lacunas do estado atual para o estado-alvo

| Gap | Impacto | Requisitos relacionados |
|---|---|---|
| Zendesk WIP acoplado ao core e documentação | Conflita com decisão explícita e dificulta nova seleção | REQ-P0-010 |
| Commerce/payment sem interfaces; mocks voláteis | Impede adapters reais e idempotência confiável | REQ-P0-003, REQ-P0-004, REQ-P0-011 |
| Inbound deduplica, mas não anexa follow-ups | Multi-turn e chat real não funcionam | REQ-P0-005 |
| Sem auth, RBAC ou tenant boundary | Aprovação financeira e dados de clientes estão inseguros | REQ-P0-002, REQ-P0-009 |
| Provider ativo global, não por caso | Casos de origens diferentes podem sincronizar pelo adapter errado | REQ-P0-003, REQ-P1-001 |
| Outbound best-effort sem outbox/retry | Caso pode fechar sem resposta entregue | REQ-P0-011 |
| Monitoring parcial | Não atende custo, tools lentas/falhando | REQ-P0-008 |
| Scorers sem dataset/threshold/gate | Não prova qualidade nem regressão | REQ-P0-007 |
| Sem testes e CI | Alto risco ao remover Zendesk e refatorar contratos | REQ-P0-012 |
| Knowledge estático, sem lifecycle/proveniência externa | Limita CRM/KB e freshness | REQ-P0-006 |
| Supervisor não participa do fluxo operacional | Primitive existe, mas papel arquitetural não está demonstrado end-to-end | REQ-P0-001 |
| Portal lista casos sem isolamento | Vazamento cruzado no cenário multiusuário | REQ-P0-005, REQ-P0-009 |
| Agents importados e tools executadas sem runtime context | Serviços compartilhados, tracing, hooks e approval do Mastra podem ser contornados | REQ-P0-002, REQ-P0-008, REQ-P0-012 |
| Tools não registradas no composition root | Viola instrução local e reduz descoberta/reuso no Studio e em workflows dinâmicos | REQ-P0-012 |
| Thread e resource colapsados no caseId | Não representa ownership do cliente nem memória entre casos | REQ-P0-005, REQ-P0-009 |

### Disposição dos achados

Nenhum achado acima foi aceito como dívida implícita. O registro normativo em `development-plan.md` transforma todos em revisões verificáveis: baseline/versionamento (`REV-001`), remoção Zendesk (`REV-002`), registry/runtime context (`REV-003`–`REV-004`), approval e supervisor (`REV-005`–`REV-006`), memory/multi-turn/auth (`REV-007`–`REV-008`), persistência/finanças/durabilidade (`REV-009`–`REV-011`), RAG/evals/monitoring (`REV-012`–`REV-014`), routes/types (`REV-015`), adapters externos (`REV-016`) e security/privacy/release (`REV-017`). As decisões que fecham o desenho Mastra estão aceitas em `DEC-009`–`DEC-011`, com proveniência em `SRC-018`.

## Limitações e dívida técnica observadas

- Tipos frontend duplicam schemas backend manualmente.
- Vários casts `as any` atravessam tools/workflow, reduzindo garantias dos contratos.
- Valores financeiros usam `number`, sem unidade mínima/decimal seguro.
- `refundAmount` ausente vira zero no payload de suspensão e pode falhar apenas na execução.
- Reindexação destrutiva do índice não oferece swap atômico nem fallback se embedding falhar.
- Modelos e pacotes são declarados como `latest`, embora o lockfile atual fixe resoluções.
- A documentação apresenta monitoring de spans ainda inexistente e Zendesk que deve ser removido.

## Restrições de compatibilidade brownfield

- Preservar os endpoints e shapes necessários à UI local durante a evolução, ou versioná-los com migração explícita.
- Preservar casos e snapshots existentes ao alterar storage/schema; qualquer migração deve ser reversível e testada.
- Não substituir o fluxo HITL nem permitir refund/credit sem identidade, policy check, decisão auditada e idempotency key durável.
- Não redesenhar componentes UI gerados sem necessidade funcional.
- Seguir `AGENTS.md`: skill Mastra atual, composition root e scripts do projeto.
