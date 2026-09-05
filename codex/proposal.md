# Proposal

Status: Discovery approved; Spec Readiness decisions approved, executable gates pending

## Problema e usuários

Times de suporte precisam resolver casos reais com contexto suficiente para responder bem, mas não podem delegar movimentação financeira irrestrita a um agente. O template deve demonstrar uma arquitetura Mastra completa, fácil de executar localmente e capaz de evoluir para integrações reais sem reescrever o core.

Usuários primários:

- cliente final que envia email/chat e acompanha a resolução;
- agente ou líder de suporte que revisa contexto e aprova/rejeita refunds ou credits;
- desenvolvedor que explora agents, workflows, tools, RAG, memory, evals e traces no Mastra Studio;
- operador que monitora qualidade, contenção, escalonamento, custo e confiabilidade.

Fontes: `SRC-001`, `SRC-003`, `SRC-004`.

## Resultados desejados

- Um fluxo local Studio-first, determinístico e demonstrável sem contas externas.
- A mesma lógica de domínio executável sobre providers mock e adapters reais por contratos estáveis.
- Toda ação financeira protegida por policy, aprovação humana verificável, auditoria e idempotência durável.
- Conversas multi-turn e multiusuário isoladas, com continuidade de contexto.
- Qualidade e segurança mensuráveis por evals executáveis e monitoring operacional.
- Intercom e Stripe sandbox como os dois providers externos reais, mantendo o domínio desacoplado de ambos.

## Escopo e prioridades

### P0 — obrigatório

- `REQ-P0-001` — Executar o fluxo completo: ingestão de email/chat, triagem, recuperação de knowledge, consulta de order/subscription, draft fundamentado, aprovação quando houver refund/credit, execução ou escalonamento e resposta ao canal. Fonte: `SRC-001`.
- `REQ-P0-002` — Impedir refund/credit sem aprovação humana autenticada e autorizada; exercer native agent tool approval dentro do workflow e persistir ator, decisão, motivo, timestamp, tool call/argument fingerprint, command imutável aprovado e resultado. Fontes: `SRC-001`, `SRC-016`, `SRC-017`, `SRC-018`.
- `REQ-P0-003` — Definir contratos provider-neutral para support channel, commerce/subscription, transactional action e knowledge; selecionar o adapter por caso/tenant. Fontes: `SRC-001`, `SRC-003`.
- `REQ-P0-004` — Oferecer modo local Studio-first com mocks determinísticos em SQLite in-process e uma façade HTTP opcional para conformance/failure tests, usando os mesmos contratos dos providers externos. Fontes: `SRC-001`, `SRC-011`.
- `REQ-P0-005` — Suportar follow-ups multi-turn, threads e resources Mastra com isolamento por tenant/usuário/caso, sem expor casos de terceiros. Fontes: `SRC-001`, `SRC-003`.
- `REQ-P0-006` — Recuperar policies e product knowledge com proveniência, versão/freshness e trechos citáveis; falhar para revisão humana quando o contexto for insuficiente. Fonte: `SRC-001`.
- `REQ-P0-007` — Tornar executáveis os seis evals pedidos: groundedness, policy compliance, routing accuracy, tool-call correctness, resolution quality e multi-turn consistency, com datasets, thresholds e evidência de regressão. Fonte: `SRC-001`.
- `REQ-P0-008` — Medir containment, escalation, approvals, feedback, token cost e tools lentas/falhando, correlacionados por case/workflow/trace/provider. Fonte: `SRC-001`.
- `REQ-P0-009` — Aplicar autenticação, autorização, tenant isolation, validação de webhook, minimização/redaction de PII, gestão de secrets e política de retenção adequadas ao demo e aos adapters reais. Fontes: `SRC-001`, `SRC-003`.
- `REQ-P0-010` — Remover o WIP Zendesk do código, dependências, configuração e documentação sem remover a abstração genérica de support source. Fonte: `SRC-001`.
- `REQ-P0-011` — Garantir deduplicação inbound, idempotência transacional durável, controle de concorrência e entrega outbound recuperável com retry/outbox ou estado equivalente. Fontes: `SRC-001`, `SRC-003`.
- `REQ-P0-012` — Criar uma rede de segurança automatizada antes das refatorações: static analysis, unit, integration e E2E do happy path, approval, rejection, escalation, replay e provider failure; provar as APIs contra versões Mastra exatas e registrar todas as primitives exigidas no composition root. Fontes: `SRC-002`, `SRC-003`, `SRC-016`, `SRC-017`, `SRC-018`.

### P1 — importante para completar o template

- `REQ-P1-001` — Integrar Intercom em development workspace com Conversation canônica, Ticket opcional, inbound webhook, follow-up, reply, note, status e identidade de contato. Fontes: `SRC-001`, `SRC-005`, `SRC-014`, `SRC-015`.
- `REQ-P1-002` — Integrar Stripe sandbox para compra avulsa e assinatura, incluindo lookup, refund history e refund aprovado. Fontes: `SRC-001`, `SRC-009`, `SRC-013`, `SRC-014`, `SRC-015`.
- `REQ-P1-003` — Preservar e adaptar o portal/admin para demonstrar caso, evidências, aprovação, escalonamento, feedback e monitoring. Fontes: `SRC-001`, `SRC-003`.
- `REQ-P1-004` — Permitir sincronização de knowledge de uma fonte externa sem torná-la requisito para o quickstart local. Fontes: `SRC-001`, `SRC-005`, `SRC-007`.

## Não objetivos

- Executar ações financeiras autonomamente ou eliminar human-in-the-loop.
- Manter ou concluir a integração Zendesk existente.
- Entregar support providers além de Intercom ou commerce/payment providers além de Stripe nesta versão.
- Transformar o template em um CRM, helpdesk ou ecommerce próprio completo.
- Fazer deploy de produção, migrar dados de cliente real ou configurar serviços remotos durante Discovery.
- Substituir Mastra, o Studio ou o frontend existente sem evidência de necessidade.

## Medidas de sucesso

- O quickstart local percorre casos de resolução, aprovação, rejeição, escalonamento e retry sem conta externa e persiste estado após restart.
- Nenhum teste prova que um refund/credit pode ocorrer sem decisão humana autorizada; replays preservam exatamente-once no efeito financeiro.
- Follow-up do mesmo ticket é anexado à thread correta e outro usuário/tenant não consegue ler nem decidir o caso.
- Cada resposta com policy claim referencia evidência recuperada e cada decisão financeira referencia order/refund state observado.
- Os seis evals rodam de forma reproduzível segundo `DEC-014`: 100% nos casos críticos de segurança/finanças; pelo menos 90% em groundedness, policy compliance, routing, tool-call correctness e multi-turn consistency; pelo menos 85% em resolution quality; regressão não crítica limitada a 2 pontos percentuais.
- Monitoring expõe todos os indicadores de `REQ-P0-008` e diferencia falha de decisão, execução e entrega.
- Evals em CI e validações de sandbox respeitam os budgets de USD 5 e USD 10; degradação acima dos thresholds de `DEC-016` e qualquer refund failure ficam visíveis.
- Intercom development workspace e Stripe sandbox passam as mesmas suites de contrato aplicáveis ao provider local.

## Restrições e assumptions

- Decisões aceitas: remover Zendesk (`DEC-001`), entregar em duas frentes (`DEC-002`), usar Intercom (`DEC-003`), usar Stripe (`DEC-004`), adotar SQLite in-process com façade HTTP opcional (`DEC-005`), Conversation canônica com Ticket opcional (`DEC-006`), cobrir compra avulsa e assinatura no Stripe (`DEC-007`), usar auth port com identidades locais seedadas (`DEC-008`), integrar native agent tool approval ao workflow (`DEC-009`), manter o supervisor assistivo/read-only (`DEC-010`), fixar versões Mastra exatas (`DEC-011`), padronizar Node.js/npm (`DEC-012`), adotar Prettier/Oxlint/Vitest/Playwright (`DEC-013`), fixar thresholds de qualidade (`DEC-014`), defaults de retenção/PII (`DEC-015`), limites operacionais/custos (`DEC-016`) e OpenAI como provider de modelos (`DEC-017`).
- O baseline é WIP e não tem testes; preservar comportamento exige primeiro capturá-lo em testes.
- O template alvo usa npm workspaces, Node.js `24.20.0` e npm `11.19.0`; Bun pertence somente ao baseline WIP e será removido em `PHASE-001`.
- OpenAI é o provider padrão de geração, avaliação e embeddings; disponibilidade dos IDs exatos precisa ser confirmada após o install frozen, sem fallback silencioso.
- O modo local não deve exigir credenciais externas além da chave do modelo usada pelo Mastra.
- Sistemas externos podem impor plano pago, scopes, rate limits, versionamento e HTTPS público; essas condições precisam ser documentadas por adapter.
- `Q-001` a `Q-009` estão fechadas. Não há pergunta P0/P1 aberta; falta somente a aprovação explícita do Discovery antes de Spec Readiness ou implementação.
