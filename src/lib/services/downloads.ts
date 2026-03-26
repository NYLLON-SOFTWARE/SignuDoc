import {
  RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS,
  type DownloadFileType,
} from "../types/domain.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { assertServiceConfig } from "./service-config.ts";
import { issueOpaqueToken } from "./opaque-tokens.ts";

const DOWNLOAD_ENV_KEYS = ["APP_URL"] as const;

export type IssuedDownloadLink = {
  exp: number;
  fileType: DownloadFileType;
  iat: number;
  token: string;
  tokenHash: string;
  url: string;
};

type DownloadTokenOptions = {
  env?: EnvSource;
};

type DownloadTokenConfig = {
  appUrl: string;
  defaultTtlSeconds: number;
};

function getDownloadTokenConfig({
  env = process.env,
}: DownloadTokenOptions = {}): DownloadTokenConfig {
  assertServiceConfig("downloads", DOWNLOAD_ENV_KEYS, env);

  const appEnv = getEnv(env);

  return {
    appUrl: appEnv.appUrl!,
    defaultTtlSeconds: RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS,
  };
}

export async function issueRecipientDownloadLink(
  {
    expiresInSeconds,
    fileType,
    issuedAt,
  }: {
    expiresInSeconds?: number;
    fileType: DownloadFileType;
    issuedAt?: number;
  },
  options: DownloadTokenOptions = {},
): Promise<IssuedDownloadLink> {
  const config = getDownloadTokenConfig(options);
  const issuedToken = issueOpaqueToken({
    expiresInSeconds: expiresInSeconds ?? config.defaultTtlSeconds,
    issuedAt,
  });

  return {
    fileType,
    ...issuedToken,
    url: new URL(
      `/api/download/${issuedToken.token}`,
      config.appUrl,
    ).toString(),
  };
}
