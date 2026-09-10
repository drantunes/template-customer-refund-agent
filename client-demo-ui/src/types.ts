export interface DemoCustomer {
  id: string;
  name: string;
  email: string;
  tenantId: string;
  stripeCustomerId: string;
  intercomContactId: string;
  checkoutSessionId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  paymentIntentId?: string;
  purchasePaid?: boolean;
}

export interface DemoSession {
  id: string;
  customer: DemoCustomer;
  csrfToken: string;
  expiresAt: string;
}
