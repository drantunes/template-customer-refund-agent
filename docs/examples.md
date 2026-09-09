# Synthetic local demo examples

Every identity, message, order, and result below is synthetic. The screenshots are produced by the deterministic Playwright mock-flow test and do not represent an external provider, a paid-model response, or a production transaction.

![Synthetic signed-in customer portal](assets/local-demo-portal.png)

A synthetic customer signs in as `alex@example.com`, opens **Or choose a template**, selects **I was charged twice**, and sends the provided sample. Its message identifies `ORD-1001` and two $49 charges, so the resulting case is eligible for human refund review.

![Synthetic support approval queue](assets/local-demo-admin.png)

A synthetic approver opens **Admin dashboard**, chooses **Switch account**, signs in as `approver@local.test`, and accepts or rejects the exact pending command. The browser test exercises this flow with mock providers and a temporary database. These screenshot assets remain at `docs/assets/local-demo-portal.png` and `docs/assets/local-demo-admin.png` until the dedicated refresh run.
