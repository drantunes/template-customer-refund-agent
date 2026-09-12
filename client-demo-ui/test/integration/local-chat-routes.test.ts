import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.VITEST = "true";
process.env.APP_MODE = "local";
process.env.LOCAL_DEMO_CLIENT_DATABASE_URL = "file::memory:?cache=shared";
process.env.DEMO_AUTH_BRIDGE_SIGNING_KEY =
  "local-chat-bridge-signing-key-with-at-least-32-chars";

const server = await import("../../src/server.js");
const db = await import("../../src/db.js");

beforeAll(async () => {
  await db.initializeDatabase(server.client);
  const password = await db.passwordRecord("test-password");
  await server.client.execute({
    sql: "INSERT INTO demo_customers (id,name,email,password_salt,password_hash,tenant_id,stripe_customer_id,intercom_contact_id,purchase_paid) VALUES (?,?,?,?,?,?,?,?,?)",
    args: [
      "customer-alex",
      "Alex Morgan",
      "alex@example.com",
      password.salt,
      password.hash,
      "local-demo",
      "local-customer-alex",
      "local-contact-alex",
      1,
    ],
  });
});
afterEach(() => vi.unstubAllGlobals());

async function login() {
  return server.app.request("http://demo.test/entrar", {
    method: "POST",
    headers: {
      origin: "http://demo.test",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "email=alex%40example.com&password=test-password",
  });
}

describe("local authenticated chat routes", () => {
  it("uses a separate local session cookie without clearing the external session", async () => {
    const signedIn = await login();
    const cookie = signedIn.headers.get("set-cookie")!;
    expect(cookie).toContain("northstar_local_session=");
    expect(cookie).not.toContain("northstar_session=");

    const account = await server.app.request("http://demo.test/conta", {
      headers: { cookie: `northstar_session=external-session; ${cookie}` },
    });
    const csrf = /name="csrf" value="([^"]+)"/.exec(await account.text())![1]!;
    const signedOut = await server.app.request("http://demo.test/sair", {
      method: "POST",
      headers: {
        cookie: `northstar_session=external-session; ${cookie}`,
        origin: "http://demo.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${encodeURIComponent(csrf)}`,
    });

    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toContain(
      "northstar_local_session=;",
    );
    expect(signedOut.headers.get("set-cookie")).not.toContain(
      "northstar_session=;",
    );
  });

  it("uses a CSRF-protected stable event identity and the existing inbound endpoint", async () => {
    const signedIn = await login();
    const cookie = signedIn.headers.get("set-cookie")!;
    const account = await server.app.request("http://demo.test/conta", {
      headers: { cookie },
    });
    const csrf = /name="csrf" value="([^"]+)"/.exec(await account.text())![1]!;
    const missing = await server.app.request("http://demo.test/chat/messages", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        body: "I was charged twice",
        eventId: "event-123456789012",
      }),
    });
    expect(missing.status).toBe(403);
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(
        JSON.stringify({ caseId: "case-1", status: "processing" }),
        { status: 200 },
      );
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await server.app.request(
        "http://demo.test/chat/messages",
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({
            body: "I was charged twice",
            eventId: "event-123456789012",
          }),
        },
      );
      expect(response.status).toBe(200);
    }
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => String(call.body))).toEqual([
      expect.stringContaining("chat:customer-alex:event-123456789012"),
      expect.stringContaining("chat:customer-alex:event-123456789012"),
    ]);
    expect(String(calls[0]!.body)).toContain(
      '"conversationId":"chat:customer-alex"',
    );
  });

  it("returns only the current chat conversation and omits internal notes", async () => {
    const signedIn = await login();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            cases: [
              {
                externalId: "chat:customer-alex:event-1",
                status: "waiting_approval",
                updatedAt: "2026-01-02T00:00:00.000Z",
                messages: [
                  {
                    author: "customer",
                    body: "Safe text <img onerror=1>",
                    createdAt: "2026-01-01T00:00:00.000Z",
                  },
                  {
                    author: "internal",
                    body: "never public",
                    createdAt: "2026-01-01T00:00:01.000Z",
                  },
                  {
                    author: "agent",
                    body: "Awaiting approval",
                    createdAt: "2026-01-01T00:00:02.000Z",
                  },
                ],
              },
              {
                externalId: "chat:other:event-2",
                status: "resolved",
                updatedAt: "2026-01-03T00:00:00.000Z",
                messages: [
                  {
                    author: "agent",
                    body: "other customer",
                    createdAt: "2026-01-03T00:00:00.000Z",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const response = await server.app.request("http://demo.test/chat/history", {
      headers: { cookie: signedIn.headers.get("set-cookie")! },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      customerId: "customer-alex",
      status: "waiting_approval",
      messages: [
        {
          author: "customer",
          body: "Safe text <img onerror=1>",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          author: "agent",
          body: "Awaiting approval",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    });
  });
});
