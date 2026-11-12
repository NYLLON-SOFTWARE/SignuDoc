import { hasEnv, type EnvSource } from "../utils/env.ts";

export class ServiceConfigurationError extends Error {
  constructor(serviceName: string, variableNames: readonly string[]) {
    super(
      `${serviceName} service requires environment variables: ${variableNames.join(", ")}`,
    );
    this.name = "ServiceConfigurationError";
  }
}

function listMissingEnvVariables(
  variableNames: readonly string[],
  env: EnvSource = process.env,
): string[] {
  return variableNames.filter((variableName) => {
    if (!hasEnv(variableName, env)) {
      return true;
    }

    const value = env[variableName]?.trim().toLowerCase() ?? "";

    return value.startsWith("replace-with-");
  });
}

export function assertServiceConfig(
  serviceName: string,
  variableNames: readonly string[],
  env: EnvSource = process.env,
): void {
  const missingVariables = listMissingEnvVariables(variableNames, env);

  if (missingVariables.length > 0) {
    throw new ServiceConfigurationError(serviceName, missingVariables);
  }
}

/** Returns a resolved setting, or fails naming the variable that would set it. */
export function requireConfigValue<T>(
  serviceName: string,
  variableName: string,
  value: T | undefined,
): T {
  if (value === undefined) {
    throw new ServiceConfigurationError(serviceName, [variableName]);
  }

  return value;
}
