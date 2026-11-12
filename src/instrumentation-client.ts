import { initBotId } from "botid/client/core";

import { BOT_PROTECTED_ROUTES } from "@/lib/security/botid-routes";

// Runs in the browser before the app starts.
//
// With Vercel BotID turned on (BOTID=1 on a Vercel deployment, fixed at
// build time), this makes the browser attach a proof to the requests listed
// in BOT_PROTECTED_ROUTES. The server checks that proof in
// src/lib/security/botid.ts. Everywhere else it does nothing.
// https://vercel.com/docs/botid/get-started
if (process.env.NEXT_PUBLIC_BOTID === "1") {
  initBotId({ protect: BOT_PROTECTED_ROUTES });
}
