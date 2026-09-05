# Decisions

Registros são cronológicos; decisões superseded não devem ser apagadas.

## DEC-001 — Remover o WIP Zendesk

- Status: Accepted
- Date: 2026-09-04
- Context: O fork herdou adapter, OAuth, webhook HMAC, dependency, env vars e documentação Zendesk, mas o líder do projeto decidiu não continuar essa integração.
- Options: concluir Zendesk; mantê-lo desativado; removê-lo preservando apenas contratos genéricos.
- Decision: Remover código e documentação específicos de Zendesk, preservando e melhorando a abstração provider-neutral.
- Rationale: Decisão explícita do projeto; evita consolidar um provider não escolhido.
- Consequences: A remoção só deve ocorrer após testes de caracterização; enum, routes, env, dependency e docs precisarão ser limpos de forma coordenada.
- Sources: `SRC-001`, `SRC-003`, `SRC-004`.
- Supersedes: none.

## DEC-002 — Entrega contract-first em duas frentes

- Status: Accepted
- Date: 2026-09-04
- Context: O template precisa ser útil no Studio local e demonstrar caminho real de integração.
- Options: external-first; mock-only; local contract-first seguido de external adapters.
- Decision: Primeiro estabilizar contratos e o fluxo local com mocks; depois adicionar providers externos sob os mesmos contratos.
- Rationale: Mantém quickstart simples, reduz risco e torna comportamento comparável entre mock e real.
- Consequences: Testes de contrato e fixtures persistentes viram parte do core; nenhum adapter externo pode vazar tipos específicos para o domínio.
- Sources: `SRC-001`.
- Supersedes: none.

## DEC-003 — Support provider inicial

- Status: Accepted
- Date: 2026-09-04
- Context: É necessário escolher o primeiro sistema real de tickets/conversations.
- Options: Intercom; Freshdesk; HubSpot Service Hub.
- Decision: Implementar Intercom como primeiro e único support provider real desta entrega.
- Rationale: Escolha explícita do líder do projeto; Intercom combina conversations, tickets, contacts, knowledge e webhooks e oferece workspace de desenvolvimento gratuito adequado ao template.
- Consequences: O adapter exigirá versionamento, webhook verification, retry/rate limit e documentação de scopes/limites. Não haverá Freshdesk, HubSpot ou Zendesk nesta entrega.
- Sources: `SRC-005`, `SRC-006`, `SRC-007`, `SRC-012`, `SRC-014`.
- Supersedes: none.

## DEC-004 — Commerce/payment provider inicial

- Status: Accepted
- Date: 2026-09-04
- Context: O sistema deve consultar pedido e histórico e executar refund somente após aprovação.
- Options: Shopify dev store; Stripe sandbox; Shopify + Stripe.
- Decision: Implementar Stripe sandbox como primeiro e único commerce/payment provider real desta entrega.
- Rationale: Escolha explícita do líder do projeto; o sandbox cobre billing, subscriptions, Checkout, invoices, refunds, webhooks e simulações temporais sem dinheiro real.
- Consequences: Casos reais cobrirão cobrança, assinatura, cancelamento e refund. Shipping, fulfillment, damaged-item e physical returns permanecem demonstrados pelo provider local mock; Shopify fica fora desta entrega.
- Sources: `SRC-008`, `SRC-009`, `SRC-013`, `SRC-014`.
- Supersedes: none.

## DEC-005 — Topologia do mock local

- Status: Accepted
- Date: 2026-09-04
- Context: Arrays in-memory atuais não persistem, não simulam falhas de rede e não provam portability dos contratos.
- Options: repositories in-process com SQLite e façade HTTP opcional; serviço HTTP+SQLite sempre separado; manter arrays in-memory.
- Decision: Usar repositories in-process com SQLite por padrão e façade HTTP opcional para conformance/failure tests.
- Rationale: Escolha explícita do líder do projeto em `Q-003`; preserva o quickstart Studio-first e permite testar o mesmo contrato em fronteira de rede sem exigir dois processos em toda execução.
- Consequences: Requer contrato compartilhado e duas formas de wiring, mas evita que o mock domine a experiência local.
- Sources: `SRC-001`, `SRC-003`, `SRC-011`.
- Supersedes: none.

## DEC-006 — Mapping canônico do Intercom

- Status: Accepted
- Date: 2026-09-04
- Context: Intercom oferece conversations e tickets, mas o domínio precisa de uma representação canônica única para ingest, follow-up, resolução e escalonamento.
- Options: conversation canônica com ticket opcional; ticket canônico; espelhar ambos sempre.
- Decision: Usar Conversation como unidade canônica e criar/associar Ticket somente quando o fluxo ou estado estruturado exigir.
- Rationale: Minimiza duplicação e preserva o fluxo natural de email/chat, sem perder o modelo estruturado de ticket.
- Consequences: O adapter precisa manter referências e transições entre conversation e ticket e provar idempotência em eventos de ambos.
- Sources: `SRC-001`, `SRC-005`, `SRC-014`, `SRC-015`.
- Supersedes: none.

## DEC-007 — Cobertura inicial do Stripe

- Status: Accepted
- Date: 2026-09-04
- Context: Stripe foi escolhido, mas ainda é necessário delimitar quais jornadas reais entram no primeiro adapter.
- Options: compra avulsa e assinatura; apenas assinatura; apenas compra avulsa.
- Decision: Cobrir compra avulsa e assinatura, incluindo consulta, cancelamento quando aplicável, refund parcial/total e reconciliação assíncrona.
- Rationale: Demonstra os dois ramos centrais do requisito “orders or subscriptions” sem adicionar outro provider.
- Consequences: A suite sandbox e as fixtures ficam maiores, mas validam melhor roteamento, política e consistência multi-turn.
- Sources: `SRC-001`, `SRC-009`, `SRC-013`, `SRC-014`, `SRC-015`.
- Supersedes: none.

## DEC-008 — Identidade e RBAC no modo local

- Status: Accepted
- Date: 2026-09-04
- Context: O WIP confia em email, body e localStorage para identidade/aprovação e não isola tenants no servidor.
- Options: auth port com identidades/roles/tenants locais seedados; IdP externo já na primeira entrega; manter o WIP sem autenticação.
- Decision: Criar uma fronteira de autenticação provider-neutral com identidades, roles e tenants seedados no modo local; deixar IdP externo fora desta entrega.
- Rationale: Permite provar autorização server-side e isolamento sem tornar uma conta externa pré-requisito do quickstart.
- Consequences: Todo endpoint e ação financeira devem consumir um principal autenticado; testes negativos e de cross-tenant tornam-se obrigatórios.
- Sources: `SRC-001`, `SRC-003`, `SRC-015`.
- Supersedes: none.

## DEC-009 — Primitive autoritativa de aprovação financeira

- Status: Accepted
- Date: 2026-09-04
- Context: O WIP combina workflow suspend/resume com uma tool marcada `requireApproval`, mas executa a tool diretamente e portanto não ativa o approval lifecycle do agent.
- Options: native agent tool approval integrado ao workflow; somente workflow approval; duas aprovações humanas.
- Decision: Usar native agent tool approval dentro do workflow, vinculando a aprovação autenticada ao fingerprint dos argumentos e a um command financeiro imutável e persistido.
- Rationale: Demonstra o primitive pedido e segue a recomendação oficial de aprovar exatamente a tool/args apresentados sem ceder invariantes financeiras ao modelo.
- Consequences: Requer coordenação persistente entre agent run, workflow run, tool call e UI, além de recovery após restart.
- Sources: `SRC-001`, `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`.
- Supersedes: none.

## DEC-010 — Papel do supervisor

- Status: Accepted
- Date: 2026-09-04
- Context: O supervisor existe e funciona como agent oficial com subagents, mas não participa do fluxo operacional do WIP.
- Options: assistivo/read-only; orquestrador do pipeline; remover.
- Decision: Manter o supervisor assistivo e read-only para Studio/investigação, enquanto workflows determinísticos usam os specialists registrados no pipeline.
- Rationale: Preserva o primitive e respeita a divisão oficial entre agents para tarefas abertas e workflows para processos predefinidos.
- Consequences: A documentação e os acceptance cases devem demonstrar claramente os dois caminhos sem alegar que o supervisor controla transações.
- Sources: `SRC-001`, `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`.
- Supersedes: none.

## DEC-011 — Política de versões Mastra

- Status: Accepted
- Date: 2026-09-04
- Context: O manifest declara todos os pacotes Mastra como `latest`, enquanto o lock atual resolve versões específicas e compatíveis.
- Options: versões exatas + lock; faixas compatíveis + lock; `latest` + lock.
- Decision: Fixar no manifest as versões exatas validadas e atualizar Mastra por mudanças deliberadas com build, tests e evals.
- Rationale: Evita que regenerar o lock altere APIs rapidamente evolutivas sem revisão.
- Consequences: Exige manutenção explícita e um procedimento de upgrade, mas torna clone e CI reproduzíveis.
- Sources: `SRC-002`, `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`.
- Supersedes: none.

## DEC-012 — Toolchain Node.js/npm do template

- Status: Accepted
- Date: 2026-09-04
- Context: O WIP usa Bun, mas o líder definiu que os templates são focados em Node.js e npm e aprovou a recomendação de um workspace único e versões fixadas.
- Options: npm workspace único; dois projetos npm independentes; monorepo com orquestrador adicional.
- Decision: Usar um npm workspace único para raiz e `web/`, um `package-lock.json`, Node.js `24.20.0` LTS e npm `11.19.0`; remover Bun do template alvo.
- Rationale: Reduz instalações e lockfiles, preserva o foco Node/npm e torna os gates reproduzíveis sobre uma versão LTS oficial.
- Consequences: `PHASE-001` migra manifests/lockfiles e quickstart; Node/npm e versões Mastra passam a ser atualizados deliberadamente com todos os gates.
- Sources: `SRC-019`, `SRC-020`.
- Supersedes: none.

## DEC-013 — Toolchain de verificação

- Status: Accepted
- Date: 2026-09-04
- Context: Os dois escopos TypeScript precisam de format, style, unit e integration gates check-only, além de contract, E2E, eval e build conforme a estratégia de verificação.
- Options: Prettier/Oxlint/Vitest/Playwright; Biome/Vitest/Playwright; Prettier/ESLint/Vitest/Playwright.
- Decision: Usar Prettier para format check, Oxlint para lint, TypeScript para typecheck, Vitest para unit/integration/contract e Playwright para E2E.
- Rationale: Reaproveita Oxlint já presente no frontend, mantém ferramentas especializadas e oferece uma suite TypeScript uniforme.
- Consequences: Todos os comandos são scripts npm check-only; autofix permanece fora dos gates.
- Sources: `SRC-003`, `SRC-019`.
- Supersedes: none.

## DEC-014 — Thresholds de qualidade e regressão

- Status: Accepted
- Date: 2026-09-04
- Context: `REQ-P0-007` exige seis evals executáveis, mas Discovery deixou thresholds para Spec Readiness.
- Options: 100% em todos os eixos; política balanceada com tolerância zero em casos críticos; baseline-first sem thresholds iniciais.
- Decision: Exigir 100% nos casos críticos de segurança, autorização, approval, replay e finanças; pelo menos 90% em groundedness, policy compliance, routing accuracy, tool-call correctness e multi-turn consistency; pelo menos 85% em resolution quality. Não aceitar regressão crítica e limitar regressão não crítica a 2 pontos percentuais.
- Rationale: Mantém invariantes críticas absolutas sem tornar os eixos qualitativos impraticavelmente frágeis.
- Consequences: Datasets precisam classificar casos críticos explicitamente e relatórios comparam o resultado ao baseline aprovado.
- Sources: `SRC-001`, `SRC-019`.
- Supersedes: none.

## DEC-015 — Defaults de retenção e PII

- Status: Accepted
- Date: 2026-09-04
- Context: `REQ-P0-009` exige minimização, redaction, retenção e exclusão com defaults seguros para o template.
- Options: privacidade máxima; retenção balanceada; configuração sem defaults.
- Decision: Reter raw payload por no máximo 7 dias, casos por 90 dias, logs/traces por 30 dias e audit financeiro por 365 dias; fixtures e datasets não contêm PII real.
- Rationale: Oferece janela operacional útil ao demo sem retenção indefinida e preserva auditoria financeira por período maior.
- Consequences: Migrations, cleanup jobs, testes e documentação devem tornar esses defaults observáveis e configuráveis sem permitir retenção silenciosamente ilimitada.
- Sources: `SRC-001`, `SRC-019`.
- Supersedes: none.

## DEC-016 — Limites operacionais, alertas e budgets

- Status: Accepted
- Date: 2026-09-04
- Context: `REQ-P0-008` exige sinais operacionais e custos observáveis; Spec Readiness precisa de defaults humanos antes do baseline.
- Options: defaults conservadores; validação paga somente manual; thresholds derivados posteriormente.
- Decision: Proibir operações live; limitar uma execução completa de eval em CI a USD 5 e uma validação manual de sandbox a USD 10; exigir que 100% das falhas injetadas de provider/tool sejam classificadas e resultem em retry ou escalation; alertar quando error rate superar 2% em 15 minutos ou p95 de provider/tool superar 5 segundos; alertar em qualquer refund failure.
- Rationale: Mantém custos pequenos e explícitos, permite validação automatizada e não esconde falhas financeiras.
- Consequences: Atingir budget interrompe a validação de forma explícita; ultrapassar thresholds gera evidência e alerta, não fallback silencioso.
- Sources: `SRC-021`.
- Supersedes: none.

## DEC-017 — Provider de modelos

- Status: Accepted
- Date: 2026-09-04
- Context: O WIP já referencia modelos e embeddings pelo provider `openai`, e o líder confirmou que usará OpenAI.
- Options: OpenAI; outro provider; provider configurável sem default.
- Decision: Usar OpenAI como provider padrão de geração, avaliação e embeddings. `PHASE-001` deve validar os identificadores atuais pelo provider registry da versão Mastra instalada; IDs indisponíveis exigem decisão explícita e nunca substituição silenciosa.
- Rationale: Preserva o wiring atual e torna custo, credenciais e comportamento do template previsíveis.
- Consequences: O quickstart exige uma chave OpenAI quando exercita recursos de modelo; mocks e testes determinísticos que não dependem de modelo continuam sem credenciais externas.
- Sources: `SRC-003`, `SRC-021`, `SRC-022`.
- Supersedes: none.

## DEC-018 — Exceção temporária de gates para bootstrap da PHASE-001

- Status: Accepted
- Date: 2026-09-04
- Context: O baseline não possui scripts npm de format, lint, unit e integration; esses próprios scripts são entregáveis obrigatórios da `PHASE-001`, mas a máquina Ryo exige gates aprovados para iniciar a fase.
- Options: bloquear a fase até criar scripts fora do fluxo; aprovar uma exceção temporária limitada ao bootstrap; dispensar gates até o fim da fase.
- Decision: Aprovar exceções temporárias para as capacidades `format`, `style`, `unit-test` e `integration-test` nos escopos backend e frontend, mantendo `git diff --check` como único gate executável durante o bootstrap.
- Rationale: Resolve o ciclo de inicialização sem declarar a ausência de testes como aceitável para entrega.
- Consequences: A exceção expira obrigatoriamente antes de `PR_READY`; o agente deve implementar os scripts npm, regenerar `gates.json`, remover todas as exceções e executar todos os gates completos antes de revisão, PR ou merge.
- Sources: `SRC-023`.
- Supersedes: none.
