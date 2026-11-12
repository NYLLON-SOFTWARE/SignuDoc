import { SIGNING_LINK_TTL_SECONDS } from "../types/domain.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { requireConfigValue } from "./service-config.ts";
import { issueOpaqueToken } from "./opaque-tokens.ts";

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
  return {
    appUrl: requireConfigValue("signing links", "APP_URL", getEnv(env).appUrl),
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
