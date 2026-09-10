import type { Child } from "hono/jsx";
import type { DemoCustomer } from "./types.js";

const css = `:root{color-scheme:dark;--bg:#111315;--panel:#191c1f;--line:#30363d;--muted:#a2a9b2;--text:#f5f7f8;--green:#56c596}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}a{color:inherit;text-decoration:none}.shell{max-width:1100px;margin:auto;padding:0 24px}.nav{display:flex;align-items:center;justify-content:space-between;padding:22px 0;border-bottom:1px solid var(--line)}.brand{font-weight:750;letter-spacing:-.03em}.mark{color:var(--green)}.nav-links{display:flex;gap:18px;align-items:center}.button{border:1px solid var(--line);background:#23282c;color:var(--text);padding:10px 15px;border-radius:8px;font:inherit;cursor:pointer}.button.primary{background:var(--green);color:#092117;border-color:var(--green);font-weight:700}.hero{padding:96px 0 74px;max-width:750px}.eyebrow{color:var(--green);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em}.hero h1{font-size:clamp(42px,7vw,76px);line-height:1.02;letter-spacing:-.055em;margin:14px 0 24px}.lead{font-size:20px;color:var(--muted);max-width:610px}.actions{display:flex;gap:12px;margin-top:30px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:0 0 70px}.card{border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:22px}.card h2,.card h3{margin-top:0;letter-spacing:-.025em}.muted{color:var(--muted)}.auth{max-width:420px;margin:80px auto}.auth h1{letter-spacing:-.04em}.field{display:grid;gap:7px;margin:17px 0}.field input{border:1px solid var(--line);background:#121416;border-radius:8px;padding:12px;color:var(--text);font:inherit}.error{border-left:3px solid #dd6b6b;padding:9px 12px;background:#302021}.account{padding:42px 0 72px}.account-header{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;margin-bottom:28px}.account h1{margin:0;letter-spacing:-.04em}.section{margin-top:28px}.stack{display:grid;gap:12px}.status{font-size:13px;border:1px solid var(--line);padding:4px 8px;border-radius:99px;color:var(--muted);white-space:nowrap}.row{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.notice{border:1px solid #34634e;background:#14271e;padding:15px;border-radius:10px}.empty{border:1px dashed var(--line);border-radius:10px;padding:24px;color:var(--muted)}@media(max-width:700px){.grid{grid-template-columns:1fr}.hero{padding:64px 0 44px}.account-header{align-items:flex-start;flex-direction:column}.shell{padding:0 18px}.nav-links{gap:12px}}`;

export function Layout(props: {
  title: string;
  children: Child;
  customer?: DemoCustomer;
  csrfToken?: string;
  widget?: string;
}) {
  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · Northstar</title>
        <style>{css}</style>
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
  id: string;
  subject: string;
  status: string;
  updatedAt: string;
  messages?: Array<{ author: string; body: string }>;
};
const labels: Record<string, string> = {
  new: "Nova",
  processing: "Em análise",
  waiting_approval: "Aguardando revisão",
  resolved: "Resolvida",
  escalated: "Encaminhada",
  failed: "Precisa de atenção",
};
export function Account(props: {
  customer: DemoCustomer;
  csrfToken: string;
  cases: SupportCase[];
  casesAvailable: boolean;
  widget?: string;
  chatUnavailable: boolean;
}) {
  const purchases = [
    props.customer.purchasePaid
      ? {
          title: "Starter Toolkit",
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
          <div class="stack">
            {!props.casesAvailable ? (
              <div class="empty">
                Não foi possível consultar as solicitações agora. Tente
                novamente em instantes.
              </div>
            ) : props.cases.length ? (
              props.cases.map((supportCase) => (
                <article class="card row">
                  <div>
                    <h3>{supportCase.subject}</h3>
                    <p class="muted">
                      {supportCase.messages?.find(
                        (message) => message.author === "agent",
                      )?.body ?? "Acompanhamento disponível no atendimento."}
                    </p>
                  </div>
                  <span class="status">
                    {labels[supportCase.status] ?? supportCase.status}
                  </span>
                </article>
              ))
            ) : (
              <div class="empty">
                Ainda não há solicitações registradas para esta conta.
              </div>
            )}
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
