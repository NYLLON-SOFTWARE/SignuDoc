import { NextResponse } from "next/server";

import {
  readCookie,
  verifiedMethodsFromCookies,
  type SignerCheckMethod,
} from "./signer-checks.ts";
import type { SigningVerificationRequiredError } from "./signing.ts";

/** The extra signer checks this request's browser has passed for the link. */
export function verifiedMethodsForRequest(
  token: string,
  request: Request,
): SignerCheckMethod[] {
  const cookieHeader = request.headers.get("cookie");

  return verifiedMethodsFromCookies(token, (name) =>
    readCookie(cookieHeader, name),
  );
}

export function verificationRequiredResponse(
  error: SigningVerificationRequiredError,
) {
  return NextResponse.json(
    {
      ...error.details,
      error: error.message,
      state: "verification-required",
    },
    {
      headers: { "cache-control": "private, no-store" },
      status: error.statusCode,
    },
  );
}
