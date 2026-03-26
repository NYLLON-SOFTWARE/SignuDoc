import { getEnv, type EnvSource } from "./utils/env";
import { ServiceConfigurationError } from "./services/service-config.ts";

export function resolvePublicSupportAddress(env: EnvSource = process.env) {
  const supportAddress = getEnv(env).email.supportAddress;

  if (supportAddress) {
    return supportAddress;
  }

  throw new ServiceConfigurationError("email", ["SUPPORT_EMAIL"]);
}
