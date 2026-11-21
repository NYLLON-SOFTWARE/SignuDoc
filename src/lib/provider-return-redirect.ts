import { resolveAppUrl, type EnvSource } from "./utils/env.ts";

export function resolveProviderReturnUrl(
  location: string,
  requestUrl: string,
  env: EnvSource = process.env,
): URL {
  return (
    URL.parse(location) ?? new URL(location, resolveAppUrl(env) ?? requestUrl)
  );
}
