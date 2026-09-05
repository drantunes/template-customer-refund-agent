# Support & Refund Agent Demo UI

A Vite + React + [shadcn/ui](https://ui.shadcn.com) app that shows the `mastra-customer-refund-agent` backend in action. It's a separate package from the Mastra app (the API server), so run both together.

## Pages

- **`/`**: explainer showing how a case flows through the pipeline and which Mastra primitives are used.
- **`/portal`**: customer-facing. Send a support message (or fire a canned example email), watch the case resolve in real time, and rate the resolution once it closes.
- **`/admin`**: support-admin queue. See everything the AI found (triage, retrieved policy, order/subscription data, drafted reply) and approve or reject pending refunds.
- **`/monitoring`**: containment/escalation rates, refund approvals, customer feedback, token cost, and tool latency/error stats - derived from the case store and Mastra's observability spans.

## Run it

From the project root, in one terminal:

```bash
npm run dev # starts the Mastra API on :4111
```

In another terminal:

```bash
npm run --workspace support-refund-agent-web dev # starts the UI on :5173, proxying /support/* to :4111
```

Open [http://localhost:5173](http://localhost:5173).

## Configuration

By default the dev server proxies `/support/*` requests to `http://localhost:4111` (see `vite.config.ts`), so no configuration is needed locally. If you deploy the UI separately from the Mastra app, copy `.env.example` to `.env` and set `VITE_API_BASE_URL` to wherever the Mastra app is hosted, and make sure CORS/auth on that server allow it.
