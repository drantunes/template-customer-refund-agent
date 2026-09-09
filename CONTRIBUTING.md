# Contributing

This is the standalone repository for the Customer support resolution and refund agent template. Please open issues and pull requests in this repository.

Before opening a pull request, use Node.js 24.20.0 and npm 11.19.0, install with `npm ci`, and run the checks listed in the [README](README.md#local-verification). Do not commit `.env`, provider credentials, real customer data, or sandbox receipts containing identifiers that have not been redacted.

Changes to provider adapters must remain opt-in and must not make remote provider calls in the ordinary test suite. Keep fixture cases synthetic, preserve the authenticated approval boundary, and document any user-visible operational change.
