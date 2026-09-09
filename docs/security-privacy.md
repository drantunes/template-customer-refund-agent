# Security and privacy

The local demo has fixed synthetic identities. Server-side signed sessions determine the tenant and role for each request; email, query parameters, browser storage, and request bodies do not grant authority. Customers can access their own tenant-scoped cases, while the operational queue requires staff roles.

Each refund approval is authenticated and binds to the exact immutable command fingerprint. The application records the decision and uses durable idempotency before a local or configured transaction effect. A customer or browser cannot approve a command by changing displayed values.

Keep `.env` and provider credentials out of version control. `npm run check:env` reads `.env` only to validate configuration; it does not start the application, open a database, or contact a provider. `local:seed` and `local:retention` do open the explicitly selected local `file:` database. The normal test suite clears inherited remote-provider selection and uses synthetic data.

The documented local retention defaults are seven days for raw payloads, 90 days for cases and memory, 30 days for observability data, and 365 days for financial audit data. Local cleanup refuses remote database URLs. Logs and stored observability data redact customer prose, credentials, payloads, and error text where the application has an operational record.
