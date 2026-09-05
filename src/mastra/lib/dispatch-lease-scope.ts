import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A workflow may project a mutable case only while it holds the durable
 * dispatch lease that started or resumed that exact turn. The scope is local
 * to the asynchronous workflow execution, so concurrent workers cannot lend
 * each other a token through request context or model input.
 */
export interface DispatchLeaseScope {
  dispatchId: string;
  caseId: string;
  turnId: string;
  leaseToken: string;
}

const dispatchLeaseScope = new AsyncLocalStorage<DispatchLeaseScope>();

export function withDispatchLeaseScope<T>(
  scope: DispatchLeaseScope,
  operation: () => Promise<T>,
) {
  return dispatchLeaseScope.run(Object.freeze({ ...scope }), operation);
}

export function activeDispatchLeaseScope() {
  return dispatchLeaseScope.getStore();
}
