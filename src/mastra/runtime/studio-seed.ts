import { caseStore } from "../lib/case-store";
import { defaultLocalBinding, localRuntime } from "./local-runtime";

/** The first native Studio investigation is safe, persisted, and synthetic. */
export const studioSupervisorDemoCaseId = "studio-demo-order-status";

export async function ensureStudioSupervisorDemoCase() {
  const existing = await caseStore.get(studioSupervisorDemoCaseId);
  if (existing) return existing;

  const binding = defaultLocalBinding(studioSupervisorDemoCaseId);
  await localRuntime.seed(binding);
  const createdAt = "2026-09-01T12:00:00.000Z";
  const supportCase = {
    id: studioSupervisorDemoCaseId,
    externalId: "studio-demo-order-status-event",
    source: "mock-email" as const,
    customer: { email: "alex@example.com", name: "Alex Rivera" },
    subject: "Where is order ORD-1001?",
    messages: [
      {
        id: "studio-demo-order-status-message",
        author: "customer" as const,
        authorName: "Alex Rivera",
        body: "Can you check the status of order ORD-1001?",
        createdAt,
      },
    ],
    status: "new" as const,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      ownerId: "customer-alex",
      providerBinding: binding,
    },
  };
  try {
    return await caseStore.create(supportCase);
  } catch (error) {
    // Concurrent Studio requests may both observe the absent fixture.  The
    // unique durable case is the authority, so return the winner if present.
    const concurrent = await caseStore.get(studioSupervisorDemoCaseId);
    if (concurrent) return concurrent;
    throw error;
  }
}
