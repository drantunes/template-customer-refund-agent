import type { ProviderBinding, ProviderRegistry } from "./contracts";
import { defaultLocalBinding, localRuntime } from "../runtime/local-runtime";

const registryKey = (binding: ProviderBinding) =>
  `${binding.tenantId}\u0000${binding.providerKind}\u0000${binding.providerAccountId}`;
const registrations = new Map<
  string,
  { binding: ProviderBinding; registry: ProviderRegistry }
>([
  [
    registryKey(defaultLocalBinding()),
    { binding: defaultLocalBinding(), registry: localRuntime },
  ],
]);

/**
 * Composition root registration. A tenant/account route cannot be replaced in
 * a live process: persisted cases always resolve their original registration.
 */
export function registerProviderRegistry(
  registry: ProviderRegistry,
  bindings: ProviderBinding[] = [defaultLocalBinding()],
) {
  if (bindings.length === 0)
    throw new Error(
      "Provider registry requires at least one configured binding.",
    );
  for (const binding of bindings) {
    const key = registryKey(binding);
    if (registrations.has(key))
      throw new Error(
        `Provider registry route is already registered for ${binding.tenantId}/${binding.providerAccountId}.`,
      );
    registrations.set(key, { binding: { ...binding }, registry });
  }
}

/** Isolated tests may reset composition before accepting any case. */
export function resetProviderRegistryForTests() {
  registrations.clear();
  registrations.set(registryKey(defaultLocalBinding()), {
    binding: defaultLocalBinding(),
    registry: localRuntime,
  });
}

/** Reject typoed/redirected accounts before a port can perform an effect. */
export function resolveConfiguredBinding(
  binding: ProviderBinding,
): ProviderBinding {
  const configured = registrations.get(registryKey(binding));
  if (!configured)
    throw new Error(
      `Unknown or mismatched provider binding for ${binding.tenantId}/${binding.providerAccountId}.`,
    );
  // Conversations are case-owned and vary under one configured account.
  return binding;
}

export function providerRegistry(binding: ProviderBinding): ProviderRegistry {
  const configured = registrations.get(registryKey(binding));
  if (!configured)
    throw new Error(
      `Unknown or mismatched provider binding for ${binding.tenantId}/${binding.providerAccountId}.`,
    );
  return configured.registry;
}

/** Local fixture seeding is allowed only for explicit file-backed development data. */
export async function ensureProviderFixtures(binding: ProviderBinding) {
  const url = process.env.TURSO_DATABASE_URL || "file:./mastra.db";
  if (!url.startsWith("file:"))
    throw new Error(
      "Refusing local fixture seed: TURSO_DATABASE_URL must use a file: URL.",
    );
  const registry = providerRegistry(binding) as ProviderRegistry & {
    seed?: (binding: ProviderBinding) => Promise<void>;
  };
  await registry.seed?.(binding);
}
