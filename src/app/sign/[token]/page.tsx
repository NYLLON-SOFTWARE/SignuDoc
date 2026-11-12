import { cookies, headers } from "next/headers";

import { SigningShell } from "@/components/signing/signing-shell";
import { getDb } from "@/lib/db/connection";
import { getClientIpAddress } from "@/lib/security/request";
import type { SigningVerificationState } from "@/lib/schemas/signing";
import { verifiedMethodsFromCookies } from "@/lib/signer-checks";
import {
  SigningAccessError,
  SigningVerificationRequiredError,
  getSigningPayloadForToken,
} from "@/lib/signing";

type SignPageProps = {
  params: Promise<{
    token: string;
  }>;
};

export default async function SignPage({ params }: SignPageProps) {
  const { token } = await params;
  let initialState:
    "already-signed" | "declined" | "error" | "expired" | "voided" | undefined;
  let record: Awaited<ReturnType<typeof getSigningPayloadForToken>> | null =
    null;
  let verification: SigningVerificationState | null = null;

  try {
    const requestHeaders = await headers();
    const cookieStore = await cookies();

    record = await getSigningPayloadForToken(token, {
      database: getDb(),
      requestMeta: {
        ipAddress: getClientIpAddress(requestHeaders),
        userAgent: requestHeaders.get("user-agent")?.trim() ?? null,
      },
      verifiedMethods: verifiedMethodsFromCookies(
        token,
        (name) => cookieStore.get(name)?.value,
      ),
    });
  } catch (error) {
    if (error instanceof SigningVerificationRequiredError) {
      verification = error.details;
    } else if (error instanceof SigningAccessError) {
      initialState = error.state;
    } else {
      initialState = "error";
    }
  }

  return (
    <SigningShell
      initialState={initialState}
      key={token}
      record={record ?? undefined}
      token={token}
      verification={verification ?? undefined}
    />
  );
}
