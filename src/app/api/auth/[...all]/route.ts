import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth/server";
import { rejectBots } from "@/lib/security/botid";

type AuthHandlers = ReturnType<typeof toNextJsHandler>;

let cachedHandlers: AuthHandlers | null = null;

// Built on the first request rather than at import time, so that `next build`
// does not need a database or auth secret to collect page data.
function getHandlers(): AuthHandlers {
  cachedHandlers ??= toNextJsHandler(getAuth());

  return cachedHandlers;
}

export function DELETE(request: Request) {
  return getHandlers().DELETE(request);
}

export function GET(request: Request) {
  return getHandlers().GET(request);
}

export function PATCH(request: Request) {
  return getHandlers().PATCH(request);
}

export async function POST(request: Request) {
  // Sign-in, sign-up and the routes that send email are checked by BotID
  // first, where that is turned on.
  return (await rejectBots(request)) ?? getHandlers().POST(request);
}

export function PUT(request: Request) {
  return getHandlers().PUT(request);
}
