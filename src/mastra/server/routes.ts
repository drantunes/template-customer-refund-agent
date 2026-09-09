import { supportLoginRoute } from "./authentication-routes";
import { supportInboundRoute } from "./inbound-routes";
import {
  supportCaseApproveRoute,
  supportCaseRejectRoute,
} from "./approval-routes";
import {
  supportCaseFeedbackRoute,
  supportCaseFollowUpRoute,
  supportCaseDetailRoute,
  supportCasesListRoute,
} from "./casework-routes";
import {
  supportKnowledgeReindexRoute,
  supportMonitoringSummaryRoute,
  supportOpenApiRoute,
} from "./operations-routes";
import { supportCaseSupervisorRoute } from "./supervisor-routes";
import {
  intercomWebhookRoute,
  readWebhookBody,
  stripeWebhookRoute,
} from "./webhook-routes";

export {
  intercomWebhookRoute,
  readWebhookBody,
  stripeWebhookRoute,
  supportCaseApproveRoute,
  supportCaseDetailRoute,
  supportCaseFeedbackRoute,
  supportCaseFollowUpRoute,
  supportCaseRejectRoute,
  supportCaseSupervisorRoute,
  supportCasesListRoute,
  supportInboundRoute,
  supportKnowledgeReindexRoute,
  supportLoginRoute,
  supportMonitoringSummaryRoute,
  supportOpenApiRoute,
};

export const supportRoutes = [
  supportLoginRoute,
  supportInboundRoute,
  intercomWebhookRoute,
  stripeWebhookRoute,
  supportCasesListRoute,
  supportCaseDetailRoute,
  supportCaseSupervisorRoute,
  supportCaseApproveRoute,
  supportCaseRejectRoute,
  supportCaseFollowUpRoute,
  supportCaseFeedbackRoute,
  supportMonitoringSummaryRoute,
  supportKnowledgeReindexRoute,
  supportOpenApiRoute,
];
