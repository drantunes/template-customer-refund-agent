# Project Instructions

Status: Discovery approved; Spec Readiness decisions approved, executable gates pending

## Repository boundaries

- A raiz Git é `template-customer-refund-agent/`.
- Backend Mastra: `src/mastra/`; frontend independente: `web/`; especificações Ryo: `codex/`.
- Ignorar em análise e commits: `node_modules/`, `.mastra/`, `dist/`, bancos locais, caches e outros artefatos gerados conforme `.gitignore`.
- Durante Discovery, alterar somente `codex/`; não implementar nem editar código-fonte, manifests ou documentação do produto.
- Preservar mudanças do usuário e nunca sobrescrever documentos canônicos existentes sem revisão semântica.

## Engineering conventions

- Carregar a skill local `mastra` antes de trabalho Mastra e verificar APIs contra a documentação da versão instalada/resolvida.
- Registrar todos os agents, tools, workflows e scorers no composition root `src/mastra/index.ts`.
- Obter primitives registradas pela instância Mastra quando o fluxo depender de storage, logging, tracing, hooks ou runtime context compartilhados.
- Não tratar `requireApproval` como ativo em chamadas diretas a `tool.execute`; approval nativo precisa ocorrer em um agent run e ser retomado pelas APIs oficiais.
- Implementar a decisão humana de refund como uma única approval autenticada sobre o fingerprint da tool call e de um command imutável; coordenar as suspensões de agent/workflow sem solicitar dois cliques.
- Manter o supervisor assistivo/read-only; o pipeline operacional pertence aos workflows e specialists registrados.
- Declarar versões Mastra exatas no manifest, manter o lockfile e executar build, tests e evals em upgrades deliberados.
- Usar thread para a conversa e resource para o owner/cliente, ambos qualificados por tenant; memory não substitui autorização.
- Manter TypeScript strict, ESM e contratos Zod nas boundaries.
- Domínio e workflows não devem importar SDKs de vendor nem implementações mock concretas.
- Provider-specific IDs, payloads e statuses são normalizados nos adapters e preservados em `ProviderRef`/metadata auditável.
- Ações financeiras usam representação monetária exata, approval vinculada ao command e idempotency persistente.
- Mensagens, approvals e financial actions são auditáveis; alterações aceitas em decisions são superseded, não apagadas.
- Comentários e docs não podem afirmar capacidade que não possua evidência executável.

## Commands e environments

O baseline WIP usa Bun, mas o template alvo é normativamente Node.js/npm (`DEC-012`). `PHASE-001` migra os manifests e lockfiles para um npm workspace único, fixa Node.js `24.20.0` e npm `11.19.0`, e remove Bun do quickstart e dos gates.

Backend, sempre pelos scripts npm do projeto:

```bash
npm run dev
npm run build
npm run start
```

Frontend:

```bash
cd web
npm run dev
npm run build
npm run lint
```

- Backend local esperado em `http://localhost:4111`; frontend em `http://localhost:5173` com proxy `/support`.
- Prettier, Oxlint, Vitest e Playwright formam a toolchain normativa de verificação (`DEC-013`).
- Não existem scripts de format/typecheck/test/eval dedicados suficientes no baseline; `PHASE-001` deve defini-los antes de refatorações.
- `DEC-018` permite somente o bootstrap controlado da `PHASE-001` com exceções temporárias; antes de `PR_READY`, não pode restar exceção de format, style, unit-test ou integration-test.
- O modo mock local não deve exigir contas externas. External adapters são opt-in e usam apenas dev workspace/dev store/sandbox.
- OpenAI é o provider padrão de geração, eval e embeddings; validar cada ID `openai/...` no provider registry Mastra instalado antes de uso e nunca substituir modelo silenciosamente (`DEC-017`).
- Não rodar CLI Mastra diretamente quando um script equivalente existir.

## Test and evidence requirements

- Toda fase deve produzir static analysis, unit/integration e build evidence para o escopo alterado.
- Mudanças de contratos exigem contract tests contra o provider local e adapters externos aplicáveis.
- Mudanças de workflow exigem E2E para success, approval, rejection, escalation, retry, restart e duplicate event.
- Ações financeiras exigem negative tests para bypass de approval, tampered command, over-refund, replay e concurrency.
- Auth/tenant changes exigem testes server-side de acesso negado; UI hiding não conta como controle.
- Evals exigem dataset versionado, expected behavior, thresholds aprovados e relatório reprodutível. Casos críticos de segurança, autorização, approval, replay e finanças exigem 100%; groundedness, policy compliance, routing, tool-call correctness e multi-turn consistency exigem pelo menos 90%; resolution quality exige pelo menos 85%; não há tolerância para regressão crítica e a tolerância máxima para os demais eixos é 2 pontos percentuais (`DEC-014`).
- Integração externa exige evidência redigida do sandbox e nunca dados/segredos reais no repositório.
- Spec Readiness, não Discovery, transforma estas expectativas em gates determinísticos.

## Security, privacy, secrets e licenses

- Nunca confiar em email, query param, localStorage ou body como identidade/role.
- Validar assinatura, timestamp, replay e tamanho em webhooks antes de processar payload.
- Minimizar raw payload e PII persistida; redigir logs, traces, fixtures e evidências. Defaults: raw payload por no máximo 7 dias, casos por 90 dias, logs/traces por 30 dias e audit financeiro por 365 dias; fixtures são exclusivamente sintéticas e sem PII real (`DEC-015`).
- Nunca colocar tokens, API keys, webhook secrets ou tenant data em código/commit.
- External providers recebem scopes mínimos; operações production/live são desabilitadas por default.
- Budgets máximos: USD 5 por execução completa de eval em CI e USD 10 por validação manual de sandbox. Atingir o budget falha explicitamente; nenhuma operação live é autorizada (`DEC-016`).
- Alertar quando error rate de provider/tool superar 2% em 15 minutos, p95 superar 5 segundos ou ocorrer qualquer refund failure. Falhas injetadas devem sempre resultar em retry ou escalation (`DEC-016`).
- Manter licença Apache-2.0 coerente e adicionar/revisar o arquivo `LICENSE` antes do release.

## Pull request and merge policy

- Configuração Ryo atual exige execução sequencial, bloqueia P0/P1, requer deferral registrado para P2 e human merge approval.
- Estratégia configurada: merge commit.
- Separar mudanças de caracterização, arquitetura/contracts, migrations, providers e documentação para revisão/rollback claros.
- Não configurar GitHub, CI remoto ou integrações durante Discovery sem autorização específica.

## Definition of Done

- Requisito e decisão vinculados na traceability.
- Acceptance criteria satisfeitos com evidência reproduzível.
- Gates aplicáveis verdes; nenhum P0/P1 aberto; P2 explicitamente deferido.
- Dados/migrations/retries/rollback verificados quando aplicável.
- Segurança e isolamento revisados para qualquer boundary de rede, usuário ou finanças.
- Documentação e `.env.example` representam o comportamento real e um clone limpo funciona.
- Novo primitive Mastra está registrado em `src/mastra/index.ts`.

## Human-only decisions

- Aprovar o Discovery e qualquer drift posterior.
- As escolhas de Intercom (`Q-001`/`DEC-003`), Stripe (`Q-002`/`DEC-004`) e topologia local (`Q-003`/`DEC-005`) já estão decididas.
- As escolhas de mapping Intercom (`Q-004`/`DEC-006`), cobertura Stripe (`Q-005`/`DEC-007`) e identidade/RBAC (`Q-006`/`DEC-008`) já estão decididas.
- As escolhas de native agent tool approval (`Q-007`/`DEC-009`), supervisor assistivo/read-only (`Q-008`/`DEC-010`) e versões Mastra exatas (`Q-009`/`DEC-011`) já estão decididas.
- As escolhas de npm workspace + Node/npm fixados (`Q-010`/`DEC-012`), toolchain de verificação (`Q-011`/`DEC-013`), thresholds de qualidade (`Q-012`/`DEC-014`) e retenção/PII (`Q-013`/`DEC-015`) já estão decididas.
- Os defaults operacionais/custos (`Q-014`/`DEC-016`) e OpenAI como provider padrão (`Q-015`/`DEC-017`) já estão decididos.
- Autorizar credenciais/contas externas, testes em sandbox e qualquer operação remota mutável.
- Aprovar qualquer aumento dos budgets ou relaxamento dos thresholds definidos em `DEC-016`.
- Aprovar merge; nenhum agente executa ações financeiras live.
