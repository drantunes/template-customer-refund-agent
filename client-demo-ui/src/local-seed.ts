import { pathToFileURL } from "node:url";
import { initializeDatabase, openDatabase, passwordRecord } from "./db.js";
import { isLocalMode } from "../../config/app-mode.mjs";

/** The local account deliberately matches the backend's synthetic owner. It
 * has local-only identifiers: no vendor customer/contact is required. */
export async function seedLocalCustomers() {
  if (!isLocalMode())
    throw new Error("Local customer seed requires APP_MODE=local.");
  const client = openDatabase();
  try {
    await initializeDatabase(client);
    const password = await passwordRecord("local-customer-alex");
    await client.execute({
      sql: "INSERT OR IGNORE INTO demo_customers (id,name,email,password_salt,password_hash,tenant_id,stripe_customer_id,intercom_contact_id,subscription_id,purchase_paid) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [
        "customer-alex",
        "Alex Morgan",
        "alex@example.com",
        password.salt,
        password.hash,
        "local-demo",
        "local-customer-alex",
        "local-contact-alex",
        "SUB-1001",
        1,
      ],
    });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await seedLocalCustomers();
  console.log(
    "Seeded local customer account without replacing existing records.",
  );
}
