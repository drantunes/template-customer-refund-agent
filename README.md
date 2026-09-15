# Customer Support and Refund Agent

Turn customer support messages into answers grounded in your internal policies or refund proposals for human review. The agent checks purchase records, finds relevant policies, and prepares a response or proposed action with supporting evidence. Try the included customer chat and support dashboard, or connect an Intercom development workspace and Stripe sandbox to work with conversations, purchases, and billing through those services.

## Why we built this

Support teams handle multiple chats at once, check different purchase and refund policies, and move between applications such as Intercom, Stripe, and internal tools to understand each request. Gathering the right context takes time and makes consistent answers harder to deliver.

We built this template to bring that work into one flow: turn customer messages into answers guided by internal policies, or automatically prepare refund proposals with the evidence a person needs to review and approve them.

## Features

- Answers support questions with published policies and order records.
- Creates refund or next-invoice credit proposals for authenticated human approval.
- Includes a local customer chat, support queue, and persisted data.

## Quick start

Use Node.js `^22.22.0 || >=24.15.0` and npm `>=10.9.0`.

### 1. Clone the template

```bash
git clone https://github.com/mastra-ai/mastra.git
cd mastra/templates/template-customer-refund-agent
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

Open [customer demo](http://127.0.0.1:3000), sign in as Alex with `alex@example.com` / `local-customer-alex`, and ask: “I bought API Credits for USD 5 on order DEMO-API-CREDITS-001 five days ago. I have no subscription. Can I get a refund?” Review any proposal at [support](http://127.0.0.1:5173) as `approver@local.test` / `local-approver`; [Studio](http://127.0.0.1:4111) is also available locally.

Each run resets the local demo data. OpenAI generates the responses, and API usage is billed to your OpenAI account.

## Making it yours

Add local policies or use published Intercom Articles with [the policy guide](https://github.com/mastra-ai/mastra/blob/main/templates/template-customer-refund-agent/docs/policies-and-actions.md), learn the [local demo details](https://github.com/mastra-ai/mastra/blob/main/templates/template-customer-refund-agent/docs/local-demo.md), or connect development Intercom and Stripe sandboxes with [the provider guide](https://github.com/mastra-ai/mastra/blob/main/templates/template-customer-refund-agent/docs/external-adapters.md). See [environment variables](https://github.com/mastra-ai/mastra/blob/main/templates/template-customer-refund-agent/docs/env-variables.md) for additional configuration.

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build with Mastra. Clone one, try it in Studio, and adapt it to your use case.

Want to contribute? Read the [contribution guide](https://github.com/mastra-ai/mastra/blob/main/templates/template-customer-refund-agent/CONTRIBUTING.md). When this template is available from the Mastra catalog, use the catalog's current creation command; until then, clone the monorepo as shown above.
