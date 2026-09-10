import { serve } from "@hono/node-server";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { Landing, Login, Account } from "./views.js";
import {
  createSession,
  deleteSession,
  initializeDatabase,
  openDatabase,
  sessionById,
  verifyCustomer,
} from "./db.js";
import { issueBackendBridge, issueMessengerJwt } from "./bridge.js";

const cookieName = "northstar_session";
const app = new Hono();
const client = openDatabase();
const backend = () =>
  (process.env.SUPPORT_BACKEND_URL ?? "http://127.0.0.1:4111").replace(
    /\/$/,
    "",
  );
const safeNext = (value: string | undefined) =>
  value?.startsWith("/") && !value.startsWith("//") ? value : "/conta";
function expiredPage() {
  return "window.Intercom&&window.Intercom('shutdown');window.location.assign('/entrar');";
}
async function current(c: { req: { raw: Request } }) {
  return sessionById(client, getCookie(c as never, cookieName));
}
function originAllowed(request: Request) {
  const origin = request.headers.get("origin");
  const configured = process.env.DEMO_PUBLIC_ORIGIN;
  const expected = configured
    ? new URL(configured).origin
    : new URL(request.url).origin;
  return !origin || origin === expected;
}
function secureCookies(request: Request) {
  return (process.env.DEMO_PUBLIC_ORIGIN ?? request.url).startsWith("https:");
}
function sameToken(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function widget(
  customer: Parameters<typeof issueMessengerJwt>[0],
  expiresAt: string,
) {
  const appId = process.env.INTERCOM_APP_ID;
  const jwt = issueMessengerJwt(customer, expiresAt);
  if (!appId || !jwt) return undefined;
  const settings = JSON.stringify({
    app_id: appId,
    user_id: customer.id,
    intercom_user_jwt: jwt,
  });
  return `window.intercomSettings=${settings};(function(){var w=window;if(typeof w.Intercom==='function'){w.Intercom('update',w.intercomSettings)}else{var d=document,i=function(){i.c(arguments)};i.q=[];i.c=function(a){i.q.push(a)};w.Intercom=i;var l=function(){var s=d.createElement('script');s.async=true;s.src='https://widget.intercom.io/widget/${appId}';d.head.appendChild(s)};if(d.readyState==='complete')l();else w.addEventListener('load',l)}})();var northstarSessionCheck=function(){fetch('/sessao',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(!r.ok){window.Intercom&&window.Intercom('shutdown');location.assign('/entrar')}}).catch(function(){})};window.addEventListener('visibilitychange',function(){if(!document.hidden)northstarSessionCheck()});window.setInterval(northstarSessionCheck,60000);`;
}
async function casesFor(
  customer: Parameters<typeof issueBackendBridge>[0],
  expiresAt: string,
): Promise<{
  available: boolean;
  cases: Array<{
    id: string;
    subject: string;
    status: string;
    updatedAt: string;
    messages?: Array<{ author: string; body: string }>;
  }>;
}> {
  const token = issueBackendBridge(customer, expiresAt);
  if (!token) return { available: false, cases: [] };
  try {
    const response = await fetch(`${backend()}/support/cases`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { available: false, cases: [] };
    const data = (await response.json()) as { cases?: unknown };
    return {
      available: Array.isArray(data.cases),
      cases: Array.isArray(data.cases)
        ? (data.cases as Array<{
            id: string;
            subject: string;
            status: string;
            updatedAt: string;
            messages?: Array<{ author: string; body: string }>;
          }>)
        : [],
    };
  } catch {
    return { available: false, cases: [] };
  }
}
app.get("/", (c) => c.html(<Landing />));
app.get("/atendimento", (c) => c.redirect("/entrar?next=/conta"));
app.get("/entrar", (c) =>
  c.html(<Login next={safeNext(c.req.query("next"))} />),
);
app.post("/entrar", async (c) => {
  if (!originAllowed(c.req.raw)) return c.text("Origem não permitida.", 403);
  const form = await c.req.parseBody();
  const customer = await verifyCustomer(
    client,
    String(form.email ?? ""),
    String(form.password ?? ""),
  );
  const next = safeNext(typeof form.next === "string" ? form.next : undefined);
  if (!customer)
    return c.html(
      <Login error="E-mail ou senha inválidos." next={next} />,
      401,
    );
  const session = await createSession(client, customer);
  setCookie(c, cookieName, session.id, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secureCookies(c.req.raw),
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return c.redirect(next, 303);
});
app.get("/sessao", async (c) => {
  const session = await current(c);
  return session
    ? c.json({ expiresAt: session.expiresAt })
    : c.text("Sessão expirada.", 401);
});
app.post("/sair", async (c) => {
  if (!originAllowed(c.req.raw)) return c.text("Origem não permitida.", 403);
  const id = getCookie(c, cookieName);
  const session = await sessionById(client, id);
  const form = await c.req.parseBody();
  if (
    !session ||
    typeof form.csrf !== "string" ||
    !sameToken(form.csrf, session.csrfToken)
  )
    return c.text("Sessão ou proteção CSRF inválida.", 403);
  await deleteSession(client, id);
  setCookie(c, cookieName, "", {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 0,
  });
  return c.html(
    <html>
      <body>
        <script dangerouslySetInnerHTML={{ __html: expiredPage() }} />
      </body>
    </html>,
  );
});
app.get("/conta", async (c) => {
  const session = await current(c);
  if (!session) return c.redirect("/entrar?next=/conta");
  const chat = widget(session.customer, session.expiresAt);
  const projection = await casesFor(session.customer, session.expiresAt);
  return c.html(
    <Account
      customer={session.customer}
      csrfToken={session.csrfToken}
      cases={projection.cases}
      casesAvailable={projection.available}
      widget={chat}
      chatUnavailable={!chat}
    />,
  );
});
async function forwardWebhook(c: Context) {
  const url = new URL(c.req.url);
  const destination = `${backend()}${url.pathname}`;
  const body = await c.req.raw.arrayBuffer();
  const headers = new Headers();
  for (const name of [
    "content-type",
    "intercom-signature",
    "x-hub-signature",
    "stripe-signature",
    "user-agent",
  ]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const response = await fetch(destination, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return new Response(response.body, {
    status: response.status,
    headers: new Headers(response.headers),
  });
}
app.post("/support/webhooks/intercom", forwardWebhook);
app.post("/support/webhooks/stripe", forwardWebhook);
export { app, client };
if (process.env.VITEST !== "true") {
  await initializeDatabase(client);
  serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: Number(process.env.DEMO_PORT ?? "3000"),
  });
}
