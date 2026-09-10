import type { Child } from "hono/jsx";
import type { DemoCustomer } from "./types.js";

export function Layout(props: {
  title: string;
  children: Child;
  customer?: DemoCustomer;
  csrfToken?: string;
  widget?: string;
  requestsRefresh?: boolean;
}) {
  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · Northstar</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <div class="shell">
          <nav class="nav">
            <a class="brand" href="/">
              <span class="mark">✦</span> Northstar
            </a>
            <div class="nav-links">
              {props.customer ? (
                <>
                  <span class="muted">{props.customer.name}</span>
                  <form method="post" action="/sair">
                    <input
                      type="hidden"
                      name="csrf"
                      value={props.csrfToken ?? ""}
                    />
                    <button class="button">Sair</button>
                  </form>
                </>
              ) : (
                <a class="button" href="/entrar">
                  Entrar
                </a>
              )}
            </div>
          </nav>
          {props.children}
        </div>
        {props.widget ? (
          <script dangerouslySetInnerHTML={{ __html: props.widget }} />
        ) : null}
        {props.requestsRefresh ? (
          <script
            dangerouslySetInnerHTML={{
              __html:
                "(function(){var target=document.getElementById('financial-requests');if(!target)return;var refresh=function(){fetch('/solicitacoes',{credentials:'same-origin',cache:'no-store',headers:{'Cache-Control':'no-store'}}).then(function(response){if(!response.ok)return;return response.text()}).then(function(html){if(html)target.innerHTML=html}).catch(function(){})};window.setInterval(refresh,30000)})();",
            }}
          />
        ) : null}
      </body>
    </html>
  );
}
export function Landing() {
  return (
    <Layout title="Suporte que acompanha você">
      <main class="hero">
        <div class="eyebrow">Northstar support</div>
        <h1>Seu trabalho continua. A gente resolve o resto.</h1>
        <p class="lead">
          Acompanhe suas solicitações e fale com o suporte em um único lugar,
          com contexto da sua conta.
        </p>
        <div class="actions">
          <a class="button primary" href="/entrar">
            Acessar minha conta
          </a>
          <a class="button" href="/atendimento">
            Falar com atendimento
          </a>
        </div>
      </main>
      <section class="grid">
        <article class="card">
          <h2>Pedidos claros</h2>
          <p class="muted">
            Veja o que já foi registrado e o andamento real de cada solicitação.
          </p>
        </article>
        <article class="card">
          <h2>Suporte com contexto</h2>
          <p class="muted">
            O atendimento começa pela sua conta autenticada, sem repetir
            informações.
          </p>
        </article>
        <article class="card">
          <h2>Próxima fatura</h2>
          <p class="muted">
            Quando um crédito for aprovado, ele fica disponível para a próxima
            fatura.
          </p>
        </article>
      </section>
    </Layout>
  );
}
export function Login(props: { error?: string; next?: string }) {
  return (
    <Layout title="Entrar">
      <main class="auth">
        <div class="eyebrow">Conta Northstar</div>
        <h1>Entre para acompanhar seu suporte.</h1>
        {props.error ? <p class="error">{props.error}</p> : null}
        <form method="post" action="/entrar">
          <input type="hidden" name="next" value={props.next ?? "/conta"} />
          <label class="field">
            E-mail
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label class="field">
            Senha
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button class="button primary" type="submit">
            Entrar na conta
          </button>
        </form>
      </main>
    </Layout>
  );
}
type SupportCase = {
  caseId: string;
  turnId: string;
  type: "refund" | "subscription_credit";
  amount: number;
  currency: string;
  status: string;
};
const labels: Record<string, string> = {
  pending_approval: "Aguardando aprovação",
  rejected: "Não aprovada",
  processing: "Em processamento",
  executed: "Concluída",
  failed: "Precisa de atenção",
  unknown: "Em verificação",
};
export function Account(props: {
  customer: DemoCustomer;
  csrfToken: string;
  requests: SupportCase[];
  requestsAvailable: boolean;
  widget?: string;
  chatUnavailable: boolean;
}) {
  const purchases = [
    props.customer.purchasePaid
      ? {
          title: "Northstar Toolkit",
          detail: "Compra única · US$ 5",
          state: "Pagamento confirmado",
        }
      : undefined,
    props.customer.subscriptionId
      ? {
          title: "Northstar Workspace",
          detail: "US$ 5 por mês",
          state: "Assinatura ativa",
        }
      : undefined,
  ].filter(Boolean) as Array<{ title: string; detail: string; state: string }>;
  return (
    <Layout
      title="Minha conta"
      customer={props.customer}
      csrfToken={props.csrfToken}
      widget={props.widget}
      requestsRefresh
    >
      <main class="account">
        <div class="account-header">
          <div>
            <div class="eyebrow">Minha conta</div>
            <h1>Olá, {props.customer.name}.</h1>
            <p class="muted">
              Acompanhe seus produtos e solicitações de suporte.
            </p>
          </div>
          <a class="button primary" href="/atendimento">
            Falar com suporte
          </a>
        </div>
        {props.chatUnavailable ? (
          <p class="notice">
            O chat autenticado ainda não está configurado neste ambiente. Volte
            quando o suporte estiver disponível.
          </p>
        ) : null}
        <section class="section">
          <h2>Produtos</h2>
          <div class="stack">
            {purchases.length ? (
              purchases.map((purchase) => (
                <article class="card row">
                  <div>
                    <h3>{purchase.title}</h3>
                    <p class="muted">{purchase.detail}</p>
                  </div>
                  <span class="status">{purchase.state}</span>
                </article>
              ))
            ) : (
              <div class="empty">
                Nenhum produto disponível para esta conta.
              </div>
            )}
          </div>
        </section>
        <section class="section">
          <h2>Solicitações</h2>
          <div id="financial-requests" aria-live="polite">
            <FinancialRequests
              requests={props.requests}
              requestsAvailable={props.requestsAvailable}
            />
          </div>
        </section>
        <section class="section">
          <article class="card">
            <h2>Alteração de endereço</h2>
            <p class="muted">
              Para compras futuras, peça a atualização de endereço pelo chat
              autenticado. O suporte confirma os dados antes de registrar a
              orientação.
            </p>
          </article>
        </section>
      </main>
    </Layout>
  );
}
export function FinancialRequests(props: {
  requests: SupportCase[];
  requestsAvailable: boolean;
}) {
  return (
    <div class="stack">
      {!props.requestsAvailable ? (
        <div class="empty">
          Não foi possível consultar as solicitações agora. Tente novamente em
          instantes.
        </div>
      ) : props.requests.length ? (
        props.requests.map((request) => (
          <article class="card row">
            <div>
              <h3>
                {request.type === "subscription_credit"
                  ? "Crédito para a próxima fatura"
                  : "Solicitação de reembolso"}
              </h3>
              <p class="muted">
                {request.amount.toLocaleString("pt-BR", {
                  style: "currency",
                  currency: request.currency,
                })}
                {request.type === "subscription_credit" &&
                request.status === "executed"
                  ? " · Crédito disponível para uma fatura futura."
                  : ""}
              </p>
            </div>
            <span class="status">
              {labels[request.status] ?? request.status}
            </span>
          </article>
        ))
      ) : (
        <div class="empty">
          Ainda não há solicitações registradas para esta conta.
        </div>
      )}
    </div>
  );
}
