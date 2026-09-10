# Northstar Demo

Northstar is an optional demo that is separate from the main template. It uses Hono, JSX, CSS, and SQLite to present an authenticated account, the Intercom Messenger, and refund or credit requests that remain subject to human approval in the Mastra backend.

Configure `LOCAL_AUTH_SIGNING_KEY`, `DEMO_AUTH_BRIDGE_SIGNING_KEY`, `DEMO_DATABASE_URL`, and `SUPPORT_BACKEND_URL` in the local `.env` file. For authenticated Messenger, also configure `INTERCOM_APP_ID` and `INTERCOM_MESSENGER_JWT_SECRET`. Without the Messenger key, the account correctly states that chat is unavailable.

Demo accounts come from a private file outside Git. Each array object must contain `id`, `name`, `email`, `password`, `tenantId`, `stripeCustomerId`, `intercomContactId`, and `scenario`; optional purchase or subscription fields must match the sandbox resources prepared for the account. Use the local path where the file was saved:

```bash
npm run --workspace support-customer-demo seed -- --input /private/path/customers.json
```

Then, in separate terminals:

```bash
npm run dev
npm run dev:demo
```

The demo serves at `http://127.0.0.1:3000`. It forwards only Intercom and Stripe webhooks to the loopback backend, preserving signed bytes and headers within the 256 KiB limit; it does not provide a generic proxy.
