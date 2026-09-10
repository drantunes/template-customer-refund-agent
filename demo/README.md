# Demo Northstar

O Northstar é uma demonstração opcional e separada do template principal. Ela usa Hono, JSX, CSS e SQLite para apresentar uma conta autenticada, o Messenger Intercom e solicitações de reembolso ou crédito que continuam dependentes de aprovação humana no backend Mastra.

Configure `LOCAL_AUTH_SIGNING_KEY`, `DEMO_AUTH_BRIDGE_SIGNING_KEY`, `DEMO_DATABASE_URL` e `SUPPORT_BACKEND_URL` no `.env` local. Para o Messenger autenticado, configure também `INTERCOM_APP_ID` e `INTERCOM_MESSENGER_JWT_SECRET`. Sem a chave do Messenger, a conta informa corretamente que o chat não está disponível.

As contas da demonstração vêm de um arquivo privado, fora do Git. Cada objeto do array precisa conter `id`, `name`, `email`, `password`, `tenantId`, `stripeCustomerId`, `intercomContactId` e `scenario`; os campos opcionais de compra ou assinatura devem corresponder aos recursos sandbox preparados para a conta. Use o caminho local onde esse arquivo foi guardado:

```bash
npm run --workspace support-customer-demo seed -- --input /caminho/privado/clientes.json
```

Depois, em terminais separados:

```bash
npm run dev
npm run dev:demo
```

O demo atende em `http://127.0.0.1:3000`. Ele encaminha somente os webhooks Intercom e Stripe para o backend de loopback, preservando os bytes e headers assinados dentro do limite de 256 KiB; não fornece proxy genérico.
