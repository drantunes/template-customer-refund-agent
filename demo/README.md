# Demo Northstar

Aplicação de demonstração separada, renderizada no servidor com Hono e JSX. Ela mantém usuários, hashes de senha, sessões e os vínculos estáveis de cliente, Stripe e Intercom em SQLite. A aplicação principal continua sendo o backend e o Studio de suporte.

Configure `LOCAL_AUTH_SIGNING_KEY`, `DEMO_AUTH_BRIDGE_SIGNING_KEY` (o mesmo valor para backend e demo), `DEMO_DATABASE_URL` e `SUPPORT_BACKEND_URL` no `.env` local. Para usar o Messenger, acrescente `INTERCOM_APP_ID` e `INTERCOM_MESSENGER_JWT_SECRET`. Sem a chave JWT, a conta informa que o chat autenticado não está disponível.

Com as fixtures privadas preparadas fora do Git, crie as contas com:

```bash
npm run --workspace support-customer-demo seed -- --input /private/tmp/phase008-demo-fixtures/customers.json
```

Depois, em terminais separados:

```bash
npm run dev
npm run dev:demo
```

O demo atende em `http://127.0.0.1:3000`. Ele só encaminha os dois endpoints de webhook exigidos para o backend de loopback; não fornece proxy genérico.
