# Local demo

`npm run demo:local` requires `APP_MODE=local` and sends real responses through OpenAI using synthetic local commerce and support data. Every identity, message, order, and result in this guide is synthetic.

Set `OPENAI_API_KEY` in `.env`, then run `npm run demo:local`. Open the customer demo at `http://127.0.0.1:3000`, support at `http://127.0.0.1:5173`, and Studio at `http://127.0.0.1:4111`.

Sign in as Alex with `alex@example.com` / `local-customer-alex`. Support staff can use `admin@local.test` / `local-admin`; an approver can use `approver@local.test` / `local-approver`. Ask Alex's chat about the USD 5 API Credits purchase on `ORD-1001`, made five days before the seed time and with no subscription.

Each launcher run resets only the configured `LOCAL_DEMO_DATABASE_URL` and `LOCAL_DEMO_CLIENT_DATABASE_URL`, plus their `-wal`, `-shm`, and `-journal` sidecars, before seeding. When signing keys are blank, it generates and stores them in ignored `.data/local-demo.env`. It preserves `.env`, external databases, and all other files. Choose distinct local ports with `LOCAL_DEMO_BACKEND_PORT`, `LOCAL_DEMO_CLIENT_PORT`, and `LOCAL_DEMO_SUPPORT_PORT` when the defaults 4111, 3000, and 5173 are occupied.

For verification, run `npm test`, `npm run test:e2e`, `npm run build`, `npm run build:demo`, and `npm run build:web` as needed. The local profile uses the separate backend and client SQLite keys from `.env.example`; it does not use the external database settings.
