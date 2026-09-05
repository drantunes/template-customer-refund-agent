import type { SupportSourceAdapter } from "./support-source";
import { mockSupportAdapter } from "./mock-support";

export type SupportSourceKind = "mock";

const adaptersByKind: Record<SupportSourceKind, SupportSourceAdapter> = {
  mock: mockSupportAdapter,
};

/**
 * Picks the adapter this deployment talks to. Phase 001 intentionally supports only the built-in
 * mock. An explicit diagnostic avoids silently treating an unsupported external provider as mock.
 */
export function getActiveSupportAdapter(): SupportSourceAdapter {
  const configured = process.env.SUPPORT_SOURCE?.trim().toLowerCase() || "mock";
  if (configured !== "mock") {
    throw new Error(
      `Unsupported SUPPORT_SOURCE "${configured}". This baseline provides only "mock"; external support adapters are not included.`,
    );
  }
  const adapter = adaptersByKind[configured];
  if (!adapter) {
    throw new Error(
      `Unsupported SUPPORT_SOURCE "${configured}". Expected one of: ${Object.keys(adaptersByKind).join(", ")}.`,
    );
  }
  return adapter;
}
