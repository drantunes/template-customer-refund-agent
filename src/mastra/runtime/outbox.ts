import type { Mastra } from "@mastra/core/mastra";
import type { TracingContext } from "@mastra/core/observability";
import { caseStore, type CaseStore } from "../lib/case-store";
import type { ProviderRegistry } from "../providers/contracts";
import { traceOperationalPort } from "../lib/operational-spans";
import { IntercomHttpError } from "../providers/intercom/client";
import { bindingsForPersistedCase } from "./provider-bindings";

/** Delivers accepted domain outcomes separately from workflow completion. */
export async function deliverOutbox(
  registry?: ProviderRegistry,
  limit = 10,
  store: CaseStore = caseStore,
  observability?: { mastra?: Mastra; tracingContext?: TracingContext },
) {
  const attempted = new Set<string>();
  let claimed = 0;
  while (claimed < limit) {
    // Claim only execution capacity. A retry becomes pending again, so omit
    // it from this bounded sweep rather than spending all attempts at once.
    const [item] = await store.claimOutbox(1, [...attempted]);
    if (!item) break;
    attempted.add(item.id);
    claimed += 1;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lostOwnership = false;
    let intercomEffectMayHaveOccurred = false;
    const renew = async () => {
      try {
        if (!(await store.renewOutboxLease(item.id, item.leaseToken!)))
          lostOwnership = true;
      } catch {
        lostOwnership = true;
      }
    };
    try {
      // Outbox processing is global, but every attempt belongs to the durable
      // case that enqueued it. Never attach an arbitrary queue item to the
      // workflow that happened to trigger this sweep.
      const ownerCase = await store.get(item.caseId);
      if (
        ownerCase &&
        ((item.id.startsWith("manual_") &&
          item.originatingTurnId &&
          ownerCase.metadata.activeTurnId !== item.originatingTurnId) ||
          // A provider-originated close has already converged this local case.
          // Do not let an older escalation finalization reopen it later.
          (ownerCase.status === "resolved" && item.status === "escalated"))
      ) {
        // A later customer follow-up reopened this conversation. Neither the
        // staff note nor its close may be delivered against the newer turn.
        await store.supersedeOutbox(
          item.id,
          item.leaseToken!,
          "A newer customer turn superseded this manual resolution.",
        );
        continue;
      }
      const ownerBinding = ownerCase
        ? bindingsForPersistedCase(ownerCase).support
        : undefined;
      if (
        ownerBinding &&
        (ownerBinding.tenantId !== item.binding.tenantId ||
          ownerBinding.providerAccountId !== item.binding.providerAccountId)
      )
        throw new Error("Outbox item binding does not match its durable case.");
      const selected =
        registry ??
        (await import("../providers/registry")).providerRegistry(item.binding);
      // A claim only establishes a time-bounded reservation. Revalidate it
      // immediately before the provider effect; a lost renewal never starts
      // another delivery from this worker.
      await renew();
      if (lostOwnership) break;
      heartbeat = setInterval(() => void renew(), 10_000);
      heartbeat.unref();
      // Intercom has no documented idempotency key for these mutations. Record
      // intent-before-effect so a process loss can become durable uncertainty.
      if (item.binding.providerKind === "intercom") {
        if (!(await store.markOutboxStarted(item.id, item.leaseToken!))) {
          lostOwnership = true;
          break;
        }
      }
      const receipt = await traceOperationalPort({
        mastra: observability?.mastra,
        // Do not use the caller's context or the mutable case projection: a
        // later follow-up can replace both. The outbox owns its response turn.
        traceId:
          item.correlationState === "known"
            ? item.originatingTraceId
            : undefined,
        kind: "provider",
        operation: "support.deliver",
        run: () => {
          const support = selected.support(item.binding);
          // Once the POST boundary is entered, a caught local persistence or
          // adapter error cannot prove that Intercom did not apply it.
          const enterIntercomPostBoundary = () => {
            intercomEffectMayHaveOccurred =
              item.binding.providerKind === "intercom";
          };
          switch (item.operation ?? "reply") {
            case "note":
              enterIntercomPostBoundary();
              return support.addInternalNote(item.binding, item.body, item.id);
            case "status":
              enterIntercomPostBoundary();
              return support.updateStatus(item.binding, item.status, item.id);
            case "ticket":
              if (!support.convertToTicket)
                throw new Error(
                  "Permanent: configured support provider does not support ticket conversion.",
                );
              enterIntercomPostBoundary();
              return support.convertToTicket(
                item.binding,
                { title: item.status, description: item.body },
                item.id,
              );
            default:
              enterIntercomPostBoundary();
              return support.deliver(
                item.binding,
                item.body,
                item.status,
                item.id,
              );
          }
        },
      });
      if (lostOwnership) break;
      await store.completeOutbox(item.id, receipt, item.leaseToken);
    } catch (error) {
      if (lostOwnership) break;
      const safeIntercomNegativeResponse =
        error instanceof IntercomHttpError &&
        !error.ambiguous &&
        error.status >= 400 &&
        error.status < 500;
      // IntercomClient records the request method on its errors. A failed
      // Conversation GET has not entered a mutation boundary, even though the
      // durable intent marker was written before invoking the support adapter.
      const knownPreMutationIntercomReadFailure =
        error instanceof IntercomHttpError && error.requestMethod === "GET";
      if (
        item.binding.providerKind === "intercom" &&
        intercomEffectMayHaveOccurred &&
        !safeIntercomNegativeResponse &&
        !knownPreMutationIntercomReadFailure
      ) {
        // Includes receipt-persistence failures after a successful POST and
        // malformed/missing receipt correlation. If this durable quarantine
        // itself fails, let that failure propagate with the row still started;
        // it must never fall through to a pending replay.
        const quarantined = await store.markOutboxUncertain(
          item.id,
          error,
          item.leaseToken,
          "started",
        );
        if (!quarantined)
          throw new Error(
            "Unable to durably quarantine a possibly-applied Intercom effect.",
          );
        continue;
      }
      if (error instanceof IntercomHttpError && error.ambiguous) {
        await store.markOutboxUncertain(item.id, error, item.leaseToken);
        continue;
      }
      const message = String(error);
      const status = Number(message.match(/\b([1-5]\d\d)\b/)?.[1]);
      const terminal =
        /permanent/i.test(message) ||
        (status >= 400 && status < 500 && status !== 408 && status !== 429);
      await store.retryOutbox(
        item.id,
        error,
        terminal || item.attempts >= 3,
        item.leaseToken,
        error instanceof IntercomHttpError ? error.retryAfterMs : undefined,
        error instanceof IntercomHttpError && error.status === 429,
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    if (lostOwnership) break;
  }
  return claimed;
}
