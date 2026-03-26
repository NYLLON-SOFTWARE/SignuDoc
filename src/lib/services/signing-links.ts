import { SIGNING_LINK_TTL_SECONDS } from "../types/domain.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { assertServiceConfig } from "./service-config.ts";
import { issueOpaqueToken } from "./opaque-tokens.ts";

const SIGNING_LINK_ENV_KEYS = ["APP_URL"] as const;

export type IssuedSigningLink = {
  exp: number;
  iat: number;
  token: string;
  tokenHash: string;
  url: string;
};

type SigningLinkOptions = {
  env?: EnvSource;
};

type SigningLinkConfig = {
  appUrl: string;
  defaultTtlSeconds: number;
};

function getSigningLinkConfig({
  env = process.env,
}: SigningLinkOptions = {}): SigningLinkConfig {
  assertServiceConfig("signing links", SIGNING_LINK_ENV_KEYS, env);

  const appEnv = getEnv(env);

  return {
    appUrl: appEnv.appUrl!,
    defaultTtlSeconds: SIGNING_LINK_TTL_SECONDS,
  };
}

export async function issueSigningLink(
  {
    expiresInSeconds,
    issuedAt,
  }: {
    expiresInSeconds?: number;
    issuedAt?: number;
  } = {},
  options: SigningLinkOptions = {},
): Promise<IssuedSigningLink> {
  const config = getSigningLinkConfig(options);
  const issuedToken = issueOpaqueToken({
    expiresInSeconds: expiresInSeconds ?? config.defaultTtlSeconds,
    issuedAt,
  });

  return {
    ...issuedToken,
    url: new URL(`/sign/${issuedToken.token}`, config.appUrl).toString(),
  };
}
