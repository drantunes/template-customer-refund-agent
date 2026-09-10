import { initializeDatabase, openDatabase, passwordRecord } from "./db.js";

const client = openDatabase();
await initializeDatabase(client);
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
