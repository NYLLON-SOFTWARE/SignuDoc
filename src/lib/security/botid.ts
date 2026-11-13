import { checkBotId } from "botid/server";

import { isBotProtectedRoute } from "./botid-routes.ts";
import { logSecurityEvent } from "./logging.ts";
import { getClientIpAddress, getRequestPathname } from "./request.ts";

// Vercel BotID: an invisible check that the request comes from a real
// browser. https://vercel.com/docs/botid
//
// It is off unless the deployment is on Vercel and sets BOTID=1. Whether it
// is on is fixed when the app is built (next.config.ts turns that into
// NEXT_PUBLIC_BOTID), so the browser code that adds the proof and this code
// that checks it always agree. If they disagreed, every sign-in would be
// refused.

type BotVerdict = { isBot: boolean };

type RejectBotsOptions = {
  check?: () => Promise<BotVerdict>;
  enabled?: boolean;
  timeoutMs?: number;
};

const CHECK_TIMEOUT_MS = 3000;

export const BOT_REJECTION_MESSAGE =
  "We could not confirm this request came from your browser. Reload the page and try again.";

export function isBotProtectionEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BOTID === "1";
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`No answer within ${String(timeoutMs)} ms.`));
    }, timeoutMs);
  });

  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Returns the 403 to send when BotID says this request is a bot, or null
 * when the request may go ahead.
 *
 * If the check itself cannot be made (BotID unreachable, or the project is
 * not set up for it) the request goes ahead: the rate limits still apply,
 * and a bot check that is down must not lock every person out of signing
 * in.
 */
export async function rejectBots(
  request: Request,
  {
    check = checkBotId,
    enabled = isBotProtectionEnabled(),
    timeoutMs = CHECK_TIMEOUT_MS,
  }: RejectBotsOptions = {},
): Promise<Response | null> {
  if (!enabled) {
    return null;
  }

  const path = getRequestPathname(request);

  if (!isBotProtectedRoute(request.method, path)) {
    return null;
  }

  let verdict: BotVerdict;

  try {
    verdict = await withTimeout(check(), timeoutMs);
  } catch (error) {
    logSecurityEvent("error", {
      category: "bot_check_unavailable",
      ipAddress: getClientIpAddress(request.headers),
      message: "The bot check could not be made, so the request was let in.",
      metadata: {
        reason: error instanceof Error ? error.message : String(error),
      },
      path,
    });

    return null;
  }

  if (!verdict.isBot) {
    return null;
  }

  logSecurityEvent("warn", {
    category: "bot_blocked",
    ipAddress: getClientIpAddress(request.headers),
    message: "A request was refused as automated.",
    path,
  });

  // "message" and "code" are what the sign-in and sign-up forms read;
  // "error" is what the app's own routes use.
  return Response.json(
    {
      code: "BOT_DETECTED",
      error: BOT_REJECTION_MESSAGE,
      message: BOT_REJECTION_MESSAGE,
    },
    { status: 403 },
  );
}
