# Northstar Demo

Northstar is an optional demo that is separate from the main template. It uses Hono, JSX, CSS, and SQLite to present an authenticated account, the Intercom Messenger, and refund or credit requests that remain subject to human approval in the Mastra backend.

Configure `LOCAL_AUTH_SIGNING_KEY`, `DEMO_AUTH_BRIDGE_SIGNING_KEY`, `DEMO_DATABASE_URL`, and `SUPPORT_BACKEND_URL` in the local `.env` file. For authenticated Messenger, also configure `INTERCOM_APP_ID` and `INTERCOM_MESSENGER_JWT_SECRET`. Without the Messenger key, the account correctly states that chat is unavailable.

With the configured Stripe test sandbox and Intercom development account, create a new private round with:

```bash
npm run demo:setup
```

The command saves passwords and provider mappings in the sibling `../demo-private` directory, outside Git, and prints only that private file path. Set `DEMO_PRIVATE_DIR` to an absolute path outside the repository if needed. Resume an interrupted recent round with `npm run demo:setup -- --run <round-id>`; otherwise each invocation creates a new round. It requires the test-only Stripe fixture permissions and Intercom `/me` plus Contacts write permissions described in `.env.example`. Demo accounts can also be imported from a private file outside Git. Each array object must contain `id`, `name`, `email`, `password`, `tenantId`, `stripeCustomerId`, `intercomContactId`, and `scenario`; optional purchase or subscription fields must match the sandbox resources prepared for the account:

```bash
npm run --workspace client-demo-ui seed -- --input /private/path/customers.json
```

Then, in separate terminals:

```bash
npm run dev
npm run dev:client-demo
npm run dev:support-demo
```

The demo serves at `http://127.0.0.1:3000`. It forwards only Intercom and Stripe webhooks to the loopback backend, preserving signed bytes and headers within the 256 KiB limit; it does not provide a generic proxy.
