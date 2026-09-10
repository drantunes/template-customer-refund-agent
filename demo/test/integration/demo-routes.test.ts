import { beforeAll, describe, expect, it } from "vitest";

process.env.VITEST = "true";
process.env.DEMO_DATABASE_URL = "file::memory:?cache=shared";
const server = await import("../../src/server.js");
const db = await import("../../src/db.js");

beforeAll(async () => {
  process.env.INTERCOM_APP_ID = "app_example";
  process.env.INTERCOM_MESSENGER_JWT_SECRET = "widget-test-secret";
  await db.initializeDatabase(server.client);
  const password = await db.passwordRecord("test-password");
  await server.client.execute({
    sql: "INSERT INTO demo_customers (id,name,email,password_salt,password_hash,tenant_id,stripe_customer_id,intercom_contact_id,purchase_paid) VALUES (?,?,?,?,?,?,?,?,?)",
    args: [
      "customer-example",
      "Cliente Exemplo",
      "customer@example.test",
      password.salt,
      password.hash,
      "local-demo",
      "cus_example",
      "contact_example",
      1,
    ],
  });
});

describe("Northstar demo routes", () => {
  it("sends a public support launcher to login and denies invalid credentials", async () => {
    const launcher = await server.app.request("http://demo.test/atendimento");
    expect(launcher.status).toBe(302);
    expect(launcher.headers.get("location")).toContain("/entrar?next=/conta");
    const invalid = await server.app.request("http://demo.test/entrar", {
      method: "POST",
      headers: {
        origin: "http://demo.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "email=customer%40example.test&password=wrong",
    });
    expect(invalid.status).toBe(401);
  });
  it("creates an opaque session, renders only authenticated account data, and expires it server-side", async () => {
    const login = await server.app.request("http://demo.test/entrar", {
      method: "POST",
      headers: {
        origin: "http://demo.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "email=customer%40example.test&password=test-password",
    });
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const account = await server.app.request("http://demo.test/conta", {
      headers: { cookie },
    });
    expect(account.status).toBe(200);
    const page = await account.text();
    expect(page).toContain("Starter Toolkit");
    expect(page).toContain("intercom_user_jwt");
    expect(page).toContain('user_id":"customer-example"');
    await server.client.execute(
      "UPDATE demo_sessions SET expires_at = '2000-01-01T00:00:00.000Z'",
    );
    const expired = await server.app.request("http://demo.test/sessao", {
      headers: { cookie },
    });
    expect(expired.status).toBe(401);
  });
  it("rejects foreign-origin logout and does not expose a generic proxy", async () => {
    const csrf = await server.app.request("http://demo.test/sair", {
      method: "POST",
      headers: { origin: "http://foreign.test" },
    });
    expect(csrf.status).toBe(403);
    const missingToken = await server.app.request("http://demo.test/sair", {
      method: "POST",
      headers: { origin: "http://demo.test" },
    });
    expect(missingToken.status).toBe(403);
    expect(
      (await server.app.request("http://demo.test/proxy/http://foreign.test"))
        .status,
    ).toBe(404);
  });
});
