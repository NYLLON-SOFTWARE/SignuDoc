import { createHash, randomBytes } from "node:crypto";

export type IssuedOpaqueToken = {
  exp: number;
  iat: number;
  token: string;
  tokenHash: string;
};

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueOpaqueToken({
  expiresInSeconds,
  issuedAt = Math.floor(Date.now() / 1000),
}: {
  expiresInSeconds: number;
  issuedAt?: number;
}): IssuedOpaqueToken {
  const token = randomBytes(32).toString("base64url");

  return {
    exp: issuedAt + expiresInSeconds,
    iat: issuedAt,
    token,
    tokenHash: hashOpaqueToken(token),
  };
}
