import { initializeDatabase, openDatabase, passwordRecord } from "./db.js";

const client = openDatabase();
await initializeDatabase(client);
await client.batch(["DELETE FROM demo_sessions", "DELETE FROM demo_customers"]);
const password = await passwordRecord("test-password");
await client.execute({
  sql: "INSERT INTO demo_customers (id,name,email,password_salt,password_hash,tenant_id,stripe_customer_id,intercom_contact_id,purchase_paid) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET password_salt=excluded.password_salt,password_hash=excluded.password_hash",
  args: [
    "customer-e2e",
    "Cliente E2E",
    "customer@example.test",
    password.salt,
    password.hash,
    "local-demo",
    "cus_e2e",
    "contact_e2e",
    1,
  ],
});
const otherPassword = await passwordRecord("other-test-password");
await client.execute({
  sql: "INSERT INTO demo_customers (id,name,email,password_salt,password_hash,tenant_id,stripe_customer_id,intercom_contact_id,purchase_paid) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,password_salt=excluded.password_salt,password_hash=excluded.password_hash",
  args: [
    "customer-other-e2e",
    "Cliente Alternativo",
    "other@example.test",
    otherPassword.salt,
    otherPassword.hash,
    "local-demo",
    "cus_other_e2e",
    "contact_other_e2e",
    1,
  ],
});
