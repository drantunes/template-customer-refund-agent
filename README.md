# Customer support and refund review

Turn a customer support message into a policy-grounded answer or a refund proposal for human review. The local demo accepts synthetic support and order data, keeps an auditable case history, and runs the workflow with Mastra.

## Why we built this

Refund requests need the customer message, purchase evidence, policy, and a clear human decision in one place. This template prepares that evidence so support staff can respond consistently without automating financial approval.

## Features

- Answers support questions with published policies and order records.
- Creates refund or next-invoice credit proposals for authenticated human approval.
- Includes a local customer chat, support queue, and persisted synthetic data.

## Quick start

Use Node.js 24.20.0 and npm 11.19.0.

### 1. Clone the template

```bash
git clone https://github.com/drantunes/template-customer-refund-agent.git
cd template-customer-refund-agent
npm ci
```

### 2. Add your API keys

```bash
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`.

### 3. Start the dev server

```bash
npm run demo:local
```

Open [customer demo](http://127.0.0.1:3000), sign in as Alex with `alex@example.com` / `local-customer-alex`, and ask: “I bought API Credits for USD 5 on order ORD-1001 five days ago. I have no subscription. Can I get a refund?” Review any proposal at [support](http://127.0.0.1:5173) as `approver@local.test` / `local-approver`; [Studio](http://127.0.0.1:4111) is also available locally.

The launcher resets only the selected local backend and client SQLite files, including their SQLite sidecars, before each run.

## Making it yours

Configure your policies in [the policy guide](https://github.com/drantunes/template-customer-refund-agent/blob/main/docs/policies-and-actions.md), learn the [local demo details](https://github.com/drantunes/template-customer-refund-agent/blob/main/docs/local-demo.md), or connect development Intercom and Stripe sandboxes with [the provider guide](https://github.com/drantunes/template-customer-refund-agent/blob/main/docs/external-adapters.md).

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build with Mastra. Clone one, try it in Studio, and adapt it to your use case.

Want to contribute? Visit [the repository](https://github.com/drantunes/template-customer-refund-agent).
