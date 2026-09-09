# Customer support and refund review

Turn a customer's support message into an answer backed by policy and order records, or a refund proposal for a person to review. Customers can follow their case in a portal, while staff investigate the evidence and approve or reject the proposed refund. Built with [Mastra](https://mastra.ai), with synthetic local orders and policies to try the complete flow.

## Why we built this

A duplicate-charge complaint looks simple until someone has to connect the customer's message, payment history, refund policy, and final response. Support teams need that context in one place, with a clear decision when money is involved.

This template gathers the evidence and prepares the next step. A person reviews each refund before it is executed, and uncertain cases go to a support specialist.

## Features

- Answers support questions using published policies and the customer's order records.
- Lets staff investigate a sample order in Mastra Studio.
- Keeps customer messages and follow-ups together in a support case.
- Presents proposed refunds for authenticated approval or rejection.
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

Set `OPENAI_API_KEY` in `.env`. Put the generated value in `LOCAL_AUTH_SIGNING_KEY` to sign local demo sessions. Keep `SUPPORT_SOURCE=mock` and `COMMERCE_SOURCE=mock` for the included data, then run `npm run check:env -- --profile=local`.

### 3. Start the dev server

```bash
npm run local:seed
npm run dev
```

Open [Mastra Studio](http://localhost:4111), sign in as `agent@local.test` with password `local-support-agent`, select **Support Supervisor**, and send: `Check ORD-1001 and summarize the evidence.` The supervisor reads Alex's sample order and reports recorded evidence without changing the case or issuing a refund.

## Try a refund review

Keep the server running and start the portal in another terminal:

```bash
npm run --workspace support-refund-agent-web dev
```

Open [the portal](http://localhost:5173/portal) and sign in as `alex@example.com` / `local-customer-alex`. Under **Or choose a template**, choose **I was charged twice** and click **Send message**. That selected sample names `ORD-1001` and two $49 charges.

Use **Admin dashboard**, then **Switch account**, to sign in as `approver@local.test` / `local-approver`. Review the policy and order evidence, then approve or reject the proposed refund. Approval records a local mock refund; the customer sees the outcome in the same case. Interactive model decisions can vary; the automated checks use deterministic models and synthetic data.

## Making it yours

- Change the policies and review limits to match your support process.
- Connect the optional [Intercom development or Stripe sandbox adapter](docs/external-adapters.md) to try the same flow with a representative integration.

See [local troubleshooting](docs/troubleshooting.md) for setup help, [synthetic examples](docs/examples.md) for the local flow, and [CONTRIBUTING.md](CONTRIBUTING.md) for verification commands.

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build with Mastra. Clone one, try it in Studio, and adapt it to your use case.

Want to contribute? See [CONTRIBUTING.md](CONTRIBUTING.md).
