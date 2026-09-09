/**
 * Process composition for concrete provider adapters. The registry itself is
 * intentionally only a binding-to-port map, so runtime workers and adapters
 * can use it without creating an ESM initialization cycle.
 */
import { defaultLocalBinding, localRuntime } from "../runtime/local-provider";
import { intercomDevelopmentConfig, intercomBinding } from "./intercom/config";
import { IntercomProviderRegistry } from "./intercom/registry";
import { registerProviderRegistry } from "./registry";
import { stripeBinding, stripeSandboxConfig } from "./stripe/config";
import { StripeProviderRegistry } from "./stripe/registry";

export function composeConfiguredProviders() {
  registerProviderRegistry(localRuntime, [defaultLocalBinding()]);

  const intercom = intercomDevelopmentConfig();
  if (intercom)
    registerProviderRegistry(new IntercomProviderRegistry(intercom), [
      intercomBinding(intercom, "configured"),
    ]);

  const stripe = stripeSandboxConfig();
  if (stripe)
    registerProviderRegistry(new StripeProviderRegistry(stripe), [
      stripeBinding(stripe, "configured"),
    ]);
}
