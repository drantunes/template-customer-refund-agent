import { describe, expect, it } from "vitest";
import {
  issueBackendBridge,
  issueMessengerJwt,
  verifyBridgeForTest,
} from "../../src/bridge.js";

const customer = {
  id: "customer-example",
  name: "Cliente Exemplo",
  email: "customer@example.test",
  tenantId: "local-demo",
  stripeCustomerId: "cus_example",
  intercomContactId: "contact_example",
};

describe("demo identity tokens", () => {
  it("does not issue a backend assertion when the bridge secret is unavailable", () => {
    delete process.env.DEMO_AUTH_BRIDGE_SIGNING_KEY;
    expect(
      issueBackendBridge(customer, new Date(Date.now() + 1_000).toISOString()),
    ).toBeUndefined();
  });
  it("binds the backend assertion to the stable demo customer", () => {
    process.env.DEMO_AUTH_BRIDGE_SIGNING_KEY =
      "test-demo-bridge-signing-key-with-at-least-32-chars";
    const token = issueBackendBridge(
      customer,
      new Date(Date.now() + 1_000).toISOString(),
    )!;
    expect(
      verifyBridgeForTest(token, process.env.DEMO_AUTH_BRIDGE_SIGNING_KEY),
    ).toBe(true);
    expect(Buffer.from(token.split(".")[0]!, "base64url").toString()).toContain(
      "contact_example",
    );
  });
  it("creates a short-lived Messenger JWT scoped to the trusted Intercom contact", () => {
    process.env.INTERCOM_MESSENGER_JWT_SECRET = "messenger-secret";
    const jwt = issueMessengerJwt(customer, "2030-01-01T00:00:00.000Z")!;
    const claims = JSON.parse(
      Buffer.from(jwt.split(".")[1]!, "base64url").toString(),
    );
    expect(claims).toMatchObject({
      sub: "customer-example",
      user_id: "customer-example",
      external_id: "customer-example",
      contact_id: "contact_example",
    });
    expect(jwt.split(".")).toHaveLength(3);
    expect(claims.exp).toBe(
      Math.floor(Date.parse("2030-01-01T00:00:00.000Z") / 1_000),
    );
  });
});
