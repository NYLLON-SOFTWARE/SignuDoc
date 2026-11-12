import { ServiceConfigurationError } from "./services/service-config.ts";
import { getSettings } from "./settings.ts";
import { type EnvSource } from "./utils/env.ts";

/**
 * The address people are told to write to. SUPPORT_EMAIL when it is set,
 * otherwise the support address saved in the install's settings.
 */
export async function resolvePublicSupportAddress(
  env: EnvSource = process.env,
): Promise<string> {
  const { supportAddress } = await getSettings(env);

  if (supportAddress) {
    return supportAddress;
  }

  throw new ServiceConfigurationError("email", ["SUPPORT_EMAIL"]);
}
