import { AsyncLocalStorage } from "node:async_hooks";

/** Provider reads receive authority only from a verified workflow turn. */
export interface TrustedCommerceScope {
  caseId: string;
  ownerId: string;
  tenantId: string;
}

const commerceScope = new AsyncLocalStorage<TrustedCommerceScope>();

export function withTrustedCommerceScope<T>(
  scope: TrustedCommerceScope,
  operation: () => Promise<T>,
) {
  return commerceScope.run(Object.freeze({ ...scope }), operation);
}

export function requireTrustedCommerceScope(): TrustedCommerceScope {
  const scope = commerceScope.getStore();
  if (!scope)
    throw new Error(
      "Commerce lookup requires a verified workflow turn scope; model-authored calls are not authorized.",
    );
  return scope;
}
