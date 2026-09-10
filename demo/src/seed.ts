import { readFile } from "node:fs/promises";
import { initializeDatabase, openDatabase, passwordRecord } from "./db.js";

type Seed = {
  id: string;
  name: string;
  email: string;
  password: string;
  scenario: "refund" | "credit" | "knowledge";
  tenantId: string;
  stripeCustomerId: string;
  intercomContactId: string;
  checkoutSessionId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  paymentIntentId?: string;
  purchasePaid?: boolean;
};
const input = process.argv.indexOf("--input");
if (input === -1 || !process.argv[input + 1])
  throw new Error("Use --input <private-customers.json>.");
const records = JSON.parse(
  await readFile(process.argv[input + 1]!, "utf8"),
) as Seed[];
const client = openDatabase();
await initializeDatabase(client);
for (const item of records) {
  const password = await passwordRecord(item.password);
  await client.execute({
    sql: "INSERT INTO demo_customers (id,name,email,password_salt,password_hash,tenant_id,stripe_customer_id,intercom_contact_id,checkout_session_id,subscription_id,invoice_id,payment_intent_id,purchase_paid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,password_salt=excluded.password_salt,password_hash=excluded.password_hash,tenant_id=excluded.tenant_id,stripe_customer_id=excluded.stripe_customer_id,intercom_contact_id=excluded.intercom_contact_id,checkout_session_id=excluded.checkout_session_id,subscription_id=excluded.subscription_id,invoice_id=excluded.invoice_id,payment_intent_id=excluded.payment_intent_id,purchase_paid=excluded.purchase_paid",
    args: [
      item.id,
      item.name,
      item.email,
      password.salt,
      password.hash,
      item.tenantId,
      item.stripeCustomerId,
      item.intercomContactId,
      item.checkoutSessionId ?? null,
      item.subscriptionId ?? null,
      item.invoiceId ?? null,
      item.paymentIntentId ?? null,
      item.purchasePaid ? 1 : 0,
    ],
  });
}
console.log(JSON.stringify({ seeded: records.length }));
