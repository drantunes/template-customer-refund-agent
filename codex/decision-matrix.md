# Decision Matrix

Status: Discovery approved; Spec Readiness decisions approved, executable gates pending

Scores são heurísticas de Discovery de 1 (fraco) a 5 (forte), baseadas nas APIs públicas observadas em 2026-09-04. Não representam benchmark comercial. Preço, plano e disponibilidade na conta do projeto ainda precisam ser confirmados.

## Q-001 — Support provider — Accepted: Intercom

### Critérios e pesos

| Critério | Peso |
|---|---:|
| Inbound webhook e event coverage | 15% |
| Conversation/ticket/reply/note/status | 20% |
| Knowledge e customer context | 15% |
| Ambiente de desenvolvimento/onboarding | 15% |
| Uso operacional gratuito | 20% |
| Simplicidade da API e autenticação | 15% |

### Evidência e scoring

| Alternativa | Webhook | Ticket flow | Knowledge/context | Dev UX | Free operacional | Simplicidade | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| Intercom | 5 | 5 | 5 | 5 | 1 | 4 | **4.1** |
| Freshdesk | 4 | 5 | 4 | 4 | 1 | 5 | **3.8** |
| HubSpot Service Hub | 5 | 4 | 2 | 5 | 5 | 3 | **4.1** |

- **Intercom (`SRC-005`, `SRC-012`):** webhooks incluem conversation/ticket lifecycle e a API cobre contacts e knowledge. Development workspaces são gratuitos, mas produção não possui free plan; há trial e depois seat pago.
- **Freshdesk (`SRC-006`, `SRC-012`):** é o contrato REST mais direto: `/tickets`, `/reply`, `/notes` e update de status com API key. O plano Free atual tem limite de zero API calls; trial recebe 50 calls/min e planos pagos liberam API.
- **HubSpot (`SRC-007`, `SRC-012`):** Free contínuo para até dois usuários oferece ticketing, live chat e CRM; private apps no Free têm limites publicados de API. O custo é maior complexidade de objects/associations/versioning; knowledge base e Custom Channels API não estão no Free.

### Recomendação

Não existe vencedor simultâneo em simplicidade e free operacional:

- **Mais simples:** Freshdesk, mas requer trial/plano pago para usar a API.
- **Melhor para desenvolver o template gratuitamente:** Intercom development workspace; o mapping é mais natural para conversations/tickets/knowledge.
- **Melhor para operar continuamente sem assinatura:** HubSpot Free; exige adapter mais elaborado e mantém knowledge/custom channel fora do tier gratuito.

O líder do projeto escolheu **Intercom**. O workspace gratuito de desenvolvimento atende à finalidade desta entrega; operação contínua gratuita em produção não é requisito. Freshdesk e HubSpot ficam fora do escopo.

### Riscos e sensibilidade

- “Free” significa development/test nesta entrega; operação contínua sem assinatura não é requisito.
- Freshdesk só reduz onboarding técnico se houver disposição para usar trial/plano pago.
- Se CRM for a fonte mestra de customer/account data, o peso de contexto CRM sobe e HubSpot pode vencer.
- Webhook versioning e payload shapes precisam ser fixados por adapter; Intercom documenta diferenças entre versões.
- `Q-001` está fechada e `DEC-003` foi aceita.

## Q-002 — Commerce/payment provider — Accepted: Stripe

### Critérios e pesos

| Critério | Peso |
|---|---:|
| Orders/refunds e histórico | 30% |
| Sandbox/dev isolation | 20% |
| Product/fulfillment context | 15% |
| Subscription/payment lifecycle | 15% |
| Webhooks e async reconciliation | 10% |
| Complexidade de integração | 10% |

### Evidência e scoring

| Alternativa | Order/refund | Sandbox | Product/fulfillment | Subscription | Webhooks | Simplicidade | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| Shopify dev store | 5 | 5 | 5 | 2 | 5 | 3 | **4.4** |
| Stripe sandbox | 4 | 5 | 1 | 5 | 5 | 5 | **4.1** |
| Shopify + Stripe | 5 | 5 | 5 | 5 | 5 | 2 | **4.7** |

- **Shopify (`SRC-008`):** Admin GraphQL conecta order, customer, line items, fulfillment, returns, transactions e refunds; dev stores aceitam test orders sem dinheiro real; refund creation suporta idempotency.
- **Stripe (`SRC-009`, `SRC-013`):** Customer, Product/Price, Checkout Session com line items, PaymentIntent, Invoice e Subscription cobrem compra/cobrança. Refunds parciais/totais e sandbox simulam pending/succeeded/failed; test clocks cobrem trials, renewals, prorations e payment failures. Fulfillment/shipping/physical returns não são domínio do Stripe.

### Recomendação

O líder do projeto escolheu **Stripe sandbox** como integração real. Compras serão normalizadas de Checkout Session, line items e PaymentIntent; subscriptions, invoices e refunds usam recursos nativos. A entrega cobrirá compra avulsa e assinatura conforme `DEC-007`. Tracking de entrega, fulfillment e devolução física permanecem no provider local mock.

### Riscos e sensibilidade

- Shopify restringe histórico antigo de orders sem scope adicional; testes devem usar dados recentes do dev store.
- Um Refund object não basta para provar liquidação; o adapter precisa reconciliar transaction status.
- Stripe simplifica falhas financeiras assíncronas, mas exigiria mock/segundo provider para product e shipping.
- `Q-002` está fechada e `DEC-004` foi aceita; `Q-005` também está fechada em `DEC-007`.

## Q-003 — Mock local e ingest — Accepted

### Alternativas

| Alternativa | Quickstart | Persistência/idempotência | Fidelidade de rede | Failure injection | Contract testing | Total qualitativo |
|---|---:|---:|---:|---:|---:|---:|
| SQLite in-process + façade HTTP opcional | 5 | 5 | 4 | 5 | 5 | **Recommended** |
| Serviço HTTP+SQLite sempre separado | 3 | 5 | 5 | 5 | 5 | Strong, heavier |
| Arrays in-memory | 5 | 1 | 1 | 2 | 2 | Insufficient |

### Decisão

Contracts compartilhados, repositories SQLite in-process no quickstart e uma façade HTTP opcional para contract/failure tests. O endpoint `/support/inbound` continua sendo o ingest de portal/mock; adapters reais recebem webhooks próprios e normalizam para o mesmo `NormalizedConversationEvent`. Chat pode entrar pelo widget/SDK do helpdesk escolhido ou por um webhook genérico autenticado, sem colocar lógica de provider no workflow.

### Riscos e sensibilidade

- Dois transports exigem suite de conformance para evitar divergência.
- Serviço sempre separado é preferível se o template quiser ensinar explicitamente distributed systems, mas prejudica o foco Studio-first.
- `Q-003` foi respondida com A; `DEC-005` está Accepted.

## Q-004 a Q-006 — Detailed design — Accepted

| Questão | Decisão aceita | Principal consequência |
|---|---|---|
| `Q-004` | Conversation canônica + Ticket opcional (`DEC-006`) | Chat/email simples não cria objetos duplicados; escalonamento estruturado mantém referência ao Ticket. |
| `Q-005` | Compra avulsa + assinatura no Stripe (`DEC-007`) | A suite externa cobre Checkout/PaymentIntent e Subscription/Invoice, incluindo refund e reconciliação. |
| `Q-006` | Auth port + identidades/roles/tenants locais seedados (`DEC-008`) | Quickstart permanece sem IdP externo e passa a provar autorização e isolamento server-side. |

As três escolhas foram confirmadas pelo líder do projeto em `SRC-015`. Não há alternativa P0/P1 pendente nesta matriz.

## Q-007 a Q-009 — Mastra alignment — Accepted

| Questão | Decisão aceita | Motivo | Trade-off principal |
|---|---|---|---|
| `Q-007` | Native agent tool approval integrado ao workflow (`DEC-009`) | Exercita `requireApproval` de verdade e vincula a decisão aos argumentos exibidos | Coordenação mais complexa entre agent run, workflow e UI |
| `Q-008` | Supervisor assistivo/read-only (`DEC-010`) | Workflows mantêm o processo previsível; supervisor atende tarefas abertas no Studio | Supervisor não é o orquestrador do caminho operacional |
| `Q-009` | Versões Mastra exatas + lock (`DEC-011`) | Clone e CI reproduzem a combinação validada | Upgrades exigem rotina deliberada |

As três escolhas A foram confirmadas pelo líder do projeto em `SRC-018`. As alternativas completas, consequências e requirements afetados estão em `.ryo/open-questions.md`; não há alternativa P0/P1 pendente nesta matriz.

## Q-010 a Q-013 — Spec Readiness — Accepted

| Questão | Decisão aceita | Principal consequência |
|---|---|---|
| `Q-010` | npm workspace único, Node.js 24.20.0 e npm 11.19.0 (`DEC-012`) | Bun é removido em `PHASE-001`; raiz e `web/` compartilham instalação e lockfile. |
| `Q-011` | Prettier + Oxlint + Vitest + Playwright (`DEC-013`) | Gates check-only cobrem format, lint, typecheck, unit, integration, contract, E2E, eval e build. |
| `Q-012` | Thresholds balanceados com tolerância zero em casos críticos (`DEC-014`) | Segurança/finanças exigem 100%; demais eixos têm pisos e regressão máxima explícitos. |
| `Q-013` | Retenção balanceada e fixtures sintéticas (`DEC-015`) | Raw payload, casos, logs/traces e audit financeiro recebem defaults verificáveis. |

As quatro recomendações foram aprovadas pelo líder do projeto em `SRC-019`.

## Q-014 e Q-015 — Operação e provider de modelos — Accepted

| Questão | Decisão aceita | Principal consequência |
|---|---|---|
| `Q-014` | Defaults conservadores de operação/custo (`DEC-016`) | Evals e sandbox recebem budgets explícitos; degradação e qualquer refund failure geram alertas; live permanece proibido. |
| `Q-015` | OpenAI como provider padrão (`DEC-017`) | IDs `openai/...` precisam ser validados pelo registry Mastra instalado antes de uso. |

As duas decisões foram aprovadas pelo líder do projeto em `SRC-021`. Não permanece pergunta P0/P1 aberta na especificação.

## Q-016 — Bootstrap de gates — Accepted

| Questão | Decisão aceita | Principal consequência |
|---|---|---|
| `Q-016` | Exceção temporária limitada (`DEC-018`) | `PHASE-001` pode criar seus scripts npm, mas não chega a `PR_READY` sem remover exceções e executar os gates completos. |

## Knowledge e CRM

- O core deve tratar policies/product knowledge como documentos versionados via `KnowledgeProvider`, não como campos livres do CRM.
- No local, policies versionadas no repositório continuam seed autoritativo e reprodutível.
- Com Intercom, Articles/Internal Articles podem alimentar o índice (`SRC-005`); com HubSpot, CMS site search inclui knowledge content (`SRC-007`).
- Product/order truth deve vir do commerce provider; customer/account context pode vir do support/CRM provider.
- Adicionar um CRM separado só se existir uma necessidade de account/company lifecycle que o support provider escolhido não cubra. Caso contrário, aumenta PII, sincronização e conflito de fontes sem melhorar o fluxo principal.

## Portfólio aceito

- **Support:** Intercom development workspace (`DEC-003`).
- **Commerce/payment:** Stripe sandbox (`DEC-004`).
- **Studio-first local:** provider SQLite in-process com façade HTTP opcional (`DEC-005`).
- **Logística física:** somente no mock nesta entrega; Shopify, HubSpot, Freshdesk e Zendesk ficam fora do escopo.
