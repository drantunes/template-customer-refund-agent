# Open Questions

## Q-001 — Qual será o primeiro support provider real?

- Status: Closed — answered Intercom on 2026-09-04
- Category: Product / architecture / cost
- Severity: P1
- Question: Qual provider deve ser o adapter real de tickets/conversations do template?
- Options:
  - **A — Intercom (recommended para template/dev):** API coerente de conversations, tickets, replies/notes, contacts, articles e webhooks; development workspace gratuito. Não há plano gratuito de produção e o plano Essential é pago após trial.
  - **B — Freshdesk:** API REST/API-key é a mais simples e direta para ticket/reply/note/status. O plano Free atual tem limite de API igual a zero; somente trial/planos pagos permitem chamadas.
  - **C — HubSpot Service Hub (recommended para uso gratuito contínuo):** Free sem expiração para até dois usuários, ticketing/live chat/CRM e limites de API para apps privados. A API é mais complexa (objects, associations, versioning), e knowledge base/custom channels não fazem parte do Free.
- Answer: A — Intercom.
- Decision: `DEC-003` Accepted.
- Consequences: Intercom será o único support provider real desta entrega; outros providers ficam fora de escopo sem alterar os contracts provider-neutral.
- Affected requirements: `REQ-P0-003`, `REQ-P0-005`, `REQ-P1-001`, `REQ-P1-004`.
- Affected phases/documents: `PHASE-005`; proposal, tech spec, development plan, decision matrix, decisions.
- Evidence: `SRC-005`, `SRC-006`, `SRC-007`, `SRC-012`.
- Can work continue safely without answer: Resolved.

## Q-002 — Qual será o primeiro commerce/payment provider real?

- Status: Closed — answered Stripe on 2026-09-04
- Category: Product / architecture / financial safety
- Severity: P1
- Question: Qual ambiente real deve provar lookup e refund aprovado?
- Options:
  - **A — Shopify dev store:** orders, products, fulfillment, refund history/refund e webhooks em um ambiente sem transações reais. Subscriptions continuam mock inicialmente.
  - **B — Stripe sandbox (recommended):** cobre Customer, Product/Price, Checkout Session/line items, PaymentIntent, Invoice, Subscription, refunds e webhooks; test clocks simulam renewals, trials, prorations e falhas. Product fulfillment, shipping e physical returns continuam mock.
  - **C — Shopify + Stripe:** maior cobertura, mas cria três integrações externas quando combinado ao helpdesk e expande mapping/reconciliação.
- Answer: B — Stripe sandbox.
- Decision: `DEC-004` Accepted.
- Consequences: Stripe será o único commerce/payment provider real; casos logísticos continuam no mock e Shopify fica fora da entrega.
- Affected requirements: `REQ-P0-002`, `REQ-P0-003`, `REQ-P0-011`, `REQ-P1-002`.
- Affected phases/documents: `PHASE-006`; proposal, tech spec, development plan, decision matrix, decisions.
- Evidence: `SRC-008`, `SRC-009`, `SRC-013`.
- Can work continue safely without answer: Resolved.

## Q-003 — Qual topologia local deve ser normativa?

- Status: Closed — answered A on 2026-09-04
- Category: Architecture / developer experience
- Severity: P1
- Question: Como o quickstart deve exercitar mocks persistentes sem comprometer a experiência Studio-first?
- Options:
  - **A — SQLite in-process + façade HTTP opcional (recommended):** um processo no quickstart; testes de conformance podem ligar a fronteira HTTP e injetar timeout/erro.
  - **B — Mock API HTTP+SQLite sempre separada:** máxima fidelidade de rede, mas exige dois serviços backend além do frontend e aumenta onboarding.
  - **C — Arrays in-memory:** menor esforço, porém perde estado, idempotência durável e simulação realista de failure/retry.
- Answer: A — SQLite in-process + façade HTTP opcional.
- Decision: `DEC-005` Accepted.
- Consequences: Haverá contracts comuns, SQLite como default no mesmo processo do Mastra e transport HTTP opcional para conformance, timeout e failure injection.
- Affected requirements: `REQ-P0-003`, `REQ-P0-004`, `REQ-P0-011`, `REQ-P0-012`.
- Affected phases/documents: `PHASE-002`; tech spec, development plan, decision matrix, decisions.
- Evidence: `SRC-001`, `SRC-003`, `SRC-011`.
- Can work continue safely without answer: Resolved.

## Q-004 — Como mapear cases no modelo Intercom?

- Status: Closed — answered A on 2026-09-04
- Category: Provider architecture / product behavior
- Severity: P1
- Question: Qual objeto Intercom deve ser a identidade canônica de um support case?
- Options:
  - **A — Conversation canônica + Ticket opcional (recommended):** cada conversa inbound vira/continua um case; criar ou vincular Ticket somente para escalonamento ou trabalho estruturado complexo.
  - **B — Ticket canônico:** todo case é um Ticket e as conversations são apenas mensagens associadas; facilita fila estruturada, mas adiciona ceremony para chats simples.
  - **C — Conversation e Ticket espelhados sempre:** cobertura máxima, com risco de sincronização duplicada, estados divergentes e maior custo de API.
- Recommendation: A — acompanha o modelo do Intercom, onde Conversations são o canal primário de atendimento e Tickets representam demandas complexas, mantendo chat/email simples e escalonamento explícito.
- Answer: A — Conversation canônica + Ticket opcional.
- Decision: `DEC-006` Accepted.
- Consequences: A reduz chamadas e mapping; B privilegia reporting/fila; C amplia complexidade e exige reconciliação bidirecional.
- Affected requirements: `REQ-P0-001`, `REQ-P0-003`, `REQ-P0-005`, `REQ-P1-001`.
- Affected phases/documents: `PHASE-003`, `PHASE-005`; proposal, tech spec, development plan, decisions.
- Evidence: `SRC-001`, `SRC-005`, `SRC-014`, `SRC-015`.
- Can work continue safely without answer: Resolved.

## Q-005 — Quais cenários Stripe serão reais nesta entrega?

- Status: Closed — answered A on 2026-09-04
- Category: Product scope / financial integration
- Severity: P1
- Question: Qual recorte deve passar end-to-end contra Stripe sandbox?
- Options:
  - **A — Compra única e assinatura (recommended):** duplicate-charge/refund via Checkout/PaymentIntent e cancellation/proration/refund via Subscription/Invoice; shipping/damaged-item continuam mock.
  - **B — Somente assinatura:** cancellation, renewal, proration e refund; menor escopo, mas não prova compra avulsa.
  - **C — Somente compra única:** Checkout/payment/refund; menor escopo, mas não demonstra subscription memory e test clocks.
- Recommendation: A — são dois cenários pequenos, reutilizam o mesmo provider e demonstram melhor o contrato `orders or subscriptions` sem adicionar Shopify.
- Answer: A — compra única e assinatura.
- Decision: `DEC-007` Accepted.
- Consequences: A aumenta fixtures/webhooks e reconciliation; B aprofunda billing recorrente; C oferece o caminho transacional mais curto.
- Affected requirements: `REQ-P0-001`, `REQ-P0-002`, `REQ-P0-011`, `REQ-P1-002`.
- Affected phases/documents: `PHASE-004`, `PHASE-006`; proposal, tech spec, development plan, decisions.
- Evidence: `SRC-001`, `SRC-009`, `SRC-013`, `SRC-014`, `SRC-015`.
- Can work continue safely without answer: Resolved.

## Q-006 — Qual identidade e RBAC o template deve demonstrar?

- Status: Closed — answered A on 2026-09-04
- Category: Security / privacy / architecture
- Severity: P0 blocking
- Question: Como autenticar customers, agents e approvers sem introduzir outra integração externa obrigatória?
- Options:
  - **A — Auth port + identidades locais seeded (recommended):** sessões locais determinísticas com tenant e roles `customer`, `support_agent`, `support_lead`; principal vem do servidor e o port permite IdP futuro.
  - **B — IdP externo agora:** integrar Auth0, Clerk ou equivalente; mais realista, mas adiciona um terceiro sistema, credenciais e possível custo ao quickstart.
  - **C — Sem autenticação no demo:** manter IDs enviados pelo browser e documentar que não é production-ready; não satisfaz isolamento multiusuário nem approval confiável.
- Recommendation: A — mantém zero-config/Studio-first, permite testes reais de isolamento e evita transformar o template em tutorial de um IdP específico.
- Answer: A — auth port + identidades locais seeded.
- Decision: `DEC-008` Accepted.
- Consequences: A exige session middleware e seeded users; B amplia setup e vendor surface; C deixa uma vulnerabilidade P0 conhecida e bloqueia readiness.
- Affected requirements: `REQ-P0-002`, `REQ-P0-005`, `REQ-P0-009`, `REQ-P0-012`, `REQ-P1-003`.
- Affected phases/documents: `PHASE-003`; proposal, tech spec, development plan, project instructions, decisions.
- Evidence: `SRC-001`, `SRC-003`, `SRC-015`.
- Can work continue safely without answer: Resolved.

## Q-007 — Qual primitive será a aprovação financeira autoritativa?

- Status: Closed — answered A on 2026-09-04
- Category: Mastra architecture / financial safety
- Severity: P0 blocking
- Question: Como satisfazer o requisito de agent approval sem permitir que o modelo altere ou execute um refund fora do command aprovado?
- Options:
  - **A — Native agent tool approval dentro do workflow (recommended):** um execution agent restrito propõe a chamada de `issue_refund`; o workflow persiste run/tool-call/args, suspende a jornada e a UI autenticada aprova exatamente o fingerprint mostrado. A tool resolve um command imutável e revalida policy, amount, currency e idempotency antes de executar.
  - **B — Somente workflow suspend/resume:** o workflow é a aprovação única e chama diretamente o `TransactionalActionProvider`; é mais simples e seguro, mas não demonstra de forma real o primitive Mastra `requireApproval` pedido no brief.
  - **C — Duas aprovações humanas:** workflow approval e depois tool approval; oferece defesa adicional, mas cria dois cliques, dois estados concorrentes e pior experiência.
- Recommendation: A — atende literalmente o primitive solicitado e preserva controle determinístico se a tool aceitar apenas referência/hash de command persistido e consumir a aprovação uma vez.
- Answer: A — native agent tool approval integrado ao workflow.
- Decision: `DEC-009` Accepted.
- Consequences: A exige integrar agent run suspension ao workflow e à UI; B exige corrigir o brief/documentação; C aumenta bastante state/recovery e não é recomendado.
- Affected requirements: `REQ-P0-001`, `REQ-P0-002`, `REQ-P0-011`, `REQ-P0-012`.
- Affected phases/documents: `PHASE-002`, `PHASE-003`, `PHASE-006`; proposal, tech spec, development plan, decisions.
- Evidence: `SRC-001`, `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`.
- Can work continue safely without answer: Resolved.

## Q-008 — Qual papel operacional terá o supervisor?

- Status: Closed — answered A on 2026-09-04
- Category: Mastra architecture / product behavior
- Severity: P1
- Question: O supervisor deve participar do pipeline real ou permanecer uma superfície assistiva no Studio?
- Options:
  - **A — Supervisor assistivo e read-only (recommended):** disponível no Studio e para investigação interativa; workflows chamam specialists registrados e controlam o pipeline/transações.
  - **B — Supervisor orquestra triage e response no pipeline:** demonstra delegation end-to-end, porém torna ordem, retries e handoffs menos determinísticos.
  - **C — Remover o supervisor:** simplifica o sistema, mas deixa de atender um primitive explícito do brief.
- Recommendation: A — segue a orientação Mastra de usar workflows em processos predefinidos e agents em tarefas abertas, mantendo o supervisor útil sem autoridade financeira.
- Answer: A — supervisor assistivo e read-only.
- Decision: `DEC-010` Accepted.
- Consequences: A requer deixar esse papel explícito e testá-lo no Studio; B exige critérios de completion/loop e evals próprios; C altera o escopo aceito.
- Affected requirements: `REQ-P0-001`, `REQ-P0-007`, `REQ-P0-012`, `REQ-P1-003`.
- Affected phases/documents: `PHASE-001`, `PHASE-003`, `PHASE-004`; proposal, tech spec, development plan, decisions.
- Evidence: `SRC-001`, `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`.
- Can work continue safely without answer: Resolved.

## Q-009 — Como versionar o stack Mastra do template?

- Status: Closed — answered A on 2026-09-04
- Category: Developer experience / maintenance
- Severity: P1
- Question: O `package.json` deve continuar declarando pacotes Mastra como `latest`?
- Options:
  - **A — Versões exatas + lockfile (recommended):** fixar no manifest as versões compatíveis provadas e atualizar deliberadamente com build, tests e evals.
  - **B — Faixas compatíveis + lockfile:** permitir updates não-breaking dentro da faixa, aceitando alguma variação quando o lock for regenerado.
  - **C — `latest` + lockfile:** acompanha o framework mais rápido, mas uma regeneração pode introduzir breaking changes silenciosas entre pacotes.
- Recommendation: A — Mastra evolui rapidamente e o template precisa ser reproduzível; upgrades continuam possíveis em mudanças isoladas e verificadas.
- Answer: A — versões Mastra exatas no manifest e lockfile.
- Decision: `DEC-011` Accepted.
- Consequences: A exige rotina de atualização; B equilibra manutenção e drift; C reduz manutenção explícita mas aumenta risco de clone/build diferente.
- Affected requirements: `REQ-P0-012`.
- Affected phases/documents: `PHASE-001`, `PHASE-007`; project instructions, development plan, decisions.
- Evidence: `SRC-002`, `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`.
- Can work continue safely without answer: Resolved.

## Q-010 — Qual toolchain de runtime e package management será normativa?

- Status: Closed — recommendation approved on 2026-09-04
- Category: Developer experience / reproducibility
- Severity: P1
- Question: Como alinhar o template ao foco Node.js/npm com instalação e gates reproduzíveis?
- Answer: npm workspace único para raiz e `web/`, um `package-lock.json`, Node.js `24.20.0` LTS e npm `11.19.0`; Bun será removido do template alvo.
- Decision: `DEC-012` Accepted.
- Affected requirements: `REQ-P0-012`.
- Affected phases/documents: `PHASE-001`, `PHASE-007`; proposal, tech spec, development plan, project instructions, decisions.
- Evidence: `SRC-019`, `SRC-020`.
- Can work continue safely without answer: Resolved.

## Q-011 — Qual toolchain executará os gates TypeScript?

- Status: Closed — recommendation approved on 2026-09-04
- Category: Verification / developer experience
- Severity: P1
- Question: Quais ferramentas cobrem format, style, typecheck, unit, integration e E2E de forma check-only?
- Answer: Prettier, Oxlint, TypeScript, Vitest e Playwright.
- Decision: `DEC-013` Accepted.
- Affected requirements: `REQ-P0-012`.
- Affected phases/documents: `PHASE-001`, `PHASE-007`; tech spec, development plan, project instructions, decisions.
- Evidence: `SRC-003`, `SRC-019`.
- Can work continue safely without answer: Resolved; os scripts ainda precisam ser implementados antes da geração dos gates.

## Q-012 — Quais thresholds de qualidade serão normativos?

- Status: Closed — recommendation approved on 2026-09-04
- Category: Quality / evals
- Severity: P1
- Question: Quais pisos e tolerância de regressão devem bloquear a entrega?
- Answer: 100% nos casos críticos de segurança, autorização, approval, replay e finanças; pelo menos 90% em groundedness, policy compliance, routing accuracy, tool-call correctness e multi-turn consistency; pelo menos 85% em resolution quality; regressão crítica zero e não crítica limitada a 2 pontos percentuais.
- Decision: `DEC-014` Accepted.
- Affected requirements: `REQ-P0-007`, `REQ-P0-012`.
- Affected phases/documents: `PHASE-004`, `PHASE-007`; proposal, tech spec, development plan, project instructions, decisions.
- Evidence: `SRC-001`, `SRC-019`.
- Can work continue safely without answer: Resolved.

## Q-013 — Quais defaults de retenção e PII serão normativos?

- Status: Closed — recommendation approved on 2026-09-04
- Category: Security / privacy
- Severity: P1
- Question: Por quanto tempo o template retém cada classe de dados?
- Answer: raw payload por no máximo 7 dias, casos por 90 dias, logs/traces por 30 dias e audit financeiro por 365 dias; fixtures e datasets usam apenas dados sintéticos.
- Decision: `DEC-015` Accepted.
- Affected requirements: `REQ-P0-009`, `REQ-P0-012`.
- Affected phases/documents: `PHASE-003`, `PHASE-007`; proposal, tech spec, development plan, project instructions, decisions.
- Evidence: `SRC-001`, `SRC-019`.
- Can work continue safely without answer: Resolved.

## Q-014 — Quais limites operacionais, alertas e budgets de custo serão normativos?

- Status: Closed — recommendation approved on 2026-09-04
- Category: Operations / cost
- Severity: P1 blocking
- Question: Quais SLOs locais/sandbox, thresholds de alerta e limites monetários devem bloquear validação e exigir nova autorização?
- Options:
  - **A — Conservative template defaults (recommended):** nenhuma operação live; budget máximo de USD 5 por execução completa de eval em CI e USD 10 por validação manual de sandbox; 100% das falhas injetadas de provider/tool precisam ser classificadas e resultar em retry ou escalation; alertar quando error rate superar 2% em 15 minutos ou p95 de provider/tool superar 5 segundos; qualquer refund failure gera alerta.
  - **B — Cost-minimal:** nenhuma validação paga em CI; evals e sandboxes somente manuais, com autorização por execução; mesmos thresholds técnicos da opção A.
  - **C — Baseline-derived:** medir em `PHASE-004` e pedir nova aprovação antes de ativar gates; bloqueia readiness até os valores serem aprovados.
- Recommendation: A — mantém limites pequenos e explícitos para o template e permite gates/alertas verificáveis sem autorizar produção.
- Answer: A — conservative template defaults.
- Decision: `DEC-016` Accepted.
- Affected requirements: `REQ-P0-008`, `REQ-P0-009`, `REQ-P0-012`.
- Affected phases/documents: `PHASE-004`, `PHASE-005`, `PHASE-006`, `PHASE-007`; tech spec, project instructions, development plan, decisions.
- Evidence: `SRC-001`, `SRC-003`, `SRC-019`, `SRC-021`.
- Can work continue safely without answer: Resolved.

## Q-015 — Qual provider de modelos será o default do template?

- Status: Closed — answered OpenAI on 2026-09-04
- Category: Model provider / cost / developer experience
- Severity: P1
- Question: Qual provider sustenta geração, avaliação e embeddings no template?
- Options: OpenAI; outro provider; provider configurável sem default.
- Answer: OpenAI.
- Decision: `DEC-017` Accepted.
- Consequences: Os identificadores atuais `openai/...` só podem ser preservados após validação pelo provider registry da versão Mastra instalada; ausência de um ID exige decisão, nunca substituição silenciosa.
- Affected requirements: `REQ-P0-006`, `REQ-P0-007`, `REQ-P0-008`, `REQ-P0-012`.
- Affected phases/documents: `PHASE-001`, `PHASE-004`, `PHASE-007`; proposal, tech spec, development plan, project instructions, decisions.
- Evidence: `SRC-003`, `SRC-021`, `SRC-022`.
- Can work continue safely without answer: Resolved; exact model availability remains an executable verification in `PHASE-001`.

## Q-016 — Como iniciar PHASE-001 sem scripts de gate existentes?

- Status: Closed — temporary exception approved on 2026-09-04
- Category: Delivery process / verification
- Severity: P1
- Question: Como evitar o ciclo em que `PHASE-001` precisa criar seus próprios scripts npm de gate, mas Ryo exige gates aprovados para iniciar a fase?
- Options: bloquear até mudança fora do fluxo; exceção temporária limitada ao bootstrap; dispensar gates até o fim da fase.
- Answer: Exceção temporária limitada ao bootstrap.
- Decision: `DEC-018` Accepted.
- Consequences: Format, style, unit-test e integration-test ficam excepcionados somente até os scripts npm serem implementados. `git diff --check` é o único gate ativo no bootstrap; todas as exceções devem desaparecer antes de `PR_READY`.
- Affected requirements: `REQ-P0-010`, `REQ-P0-012`.
- Affected phases/documents: `PHASE-001`; tech spec, development plan, project instructions, decisions, gates.
- Evidence: `SRC-023`.
- Can work continue safely without answer: Resolved.
