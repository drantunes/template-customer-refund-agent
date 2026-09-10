# Customer support and refund review

Turn a support message into a policy-grounded answer or a refund proposal for human review. The template accepts synthetic local support and order data, keeps a case history, and returns an auditable response in Mastra Studio.

## Why we built this

A duplicate-charge complaint looks simple until someone has to connect the customer's message, payment history, refund policy, and final response. Support teams need that context in one place, with a clear decision when money is involved.

This template gathers the evidence and prepares the next step. A person reviews each refund before it is executed, and uncertain cases go to a support specialist.

## Features

- Answers support questions using published policies and the customer's order records.
- Lets staff investigate a sample order in Mastra Studio.
- Keeps customer messages and follow-ups together in a support case.
- Presents proposed refunds and subscription credits for authenticated approval or rejection.
- Includes synthetic local data and optional Intercom development and Stripe sandbox adapters.

## Quick start

Use Node.js 24.20.0 and npm 11.19.0, as pinned in the repository. Interactive responses require an OpenAI API key.

### 1. Clone the template

```bash
git clone https://github.com/drantunes/template-customer-refund-agent.git
cd template-customer-refund-agent
npm ci
```

### 2. Add your API keys

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set `OPENAI_API_KEY` in `.env`. Put the generated value in `LOCAL_AUTH_SIGNING_KEY` to sign local sessions. Keep `SUPPORT_SOURCE=mock` and `COMMERCE_SOURCE=mock` for the included data, then run `npm run check:env -- --profile=local`.

### 3. Start the dev server

```bash
npm run local:seed
npm run dev
```

Open [Mastra Studio](http://localhost:4111), sign in as `agent@local.test` with `local-support-agent`, select **Support Supervisor**, and send: `Check ORD-1001 and summarize the evidence.` The supervisor reads the synthetic order and reports recorded evidence without changing a case or issuing a refund.

## Making it yours

- Change the policies and review limits to match your support process.
- Connect the optional [Intercom development or Stripe sandbox adapter](docs/external-adapters.md) to try the same flow with a representative integration.

The separate [Northstar demo](demo/README.md) needs its own synthetic accounts and external Intercom credentials. It is not required for the Studio-first quick start.

See [local troubleshooting](docs/troubleshooting.md) for setup help, [synthetic examples](docs/examples.md) for the local flow, and [CONTRIBUTING.md](CONTRIBUTING.md) for verification commands.

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build with Mastra. Clone one, try it in Studio, and adapt it to your use case.

Want to contribute? See [CONTRIBUTING.md](CONTRIBUTING.md).
