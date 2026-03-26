import { NextResponse } from "next/server";

import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import { AccountMutationError, requestAccountClosure } from "@/lib/account";
import { getDb } from "@/lib/db/connection";

export async function POST(request: Request) {
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    const result = await requestAccountClosure(
      session.user.id,
      {
        confirmation: String(payload?.confirmation ?? ""),
      },
      {
        database: getDb(),
      },
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof AccountMutationError) {
      return NextResponse.json(
        {
          error: error.message,
          fieldErrors: error.fieldErrors,
        },
        { status: error.statusCode },
      );
    }

    return NextResponse.json(
      {
        error: "Unable to submit the closure request.",
      },
      { status: 500 },
    );
  }
}
