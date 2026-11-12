// The requests that Vercel BotID vouches for. The browser adds a proof to
// each of these (src/instrumentation-client.ts) and the server checks it
// (src/lib/security/botid.ts), so both sides read this one list. A request
// the browser does not mark is treated as a bot by the server, which is why
// the two must never drift apart.
//
// These are the doors a script would knock on: making accounts, guessing
// passwords, causing email to be sent, and claiming a new install.

export type BotProtectedRoute = {
  method: string;
  path: string;
};

export const BOT_PROTECTED_ROUTES: BotProtectedRoute[] = [
  { method: "POST", path: "/api/auth/sign-up/email" },
  { method: "POST", path: "/api/auth/sign-in/email" },
  { method: "POST", path: "/api/auth/request-password-reset" },
  { method: "POST", path: "/api/auth/send-verification-email" },
  { method: "POST", path: "/api/contact" },
  { method: "POST", path: "/api/setup" },
];

export function isBotProtectedRoute(method: string, pathname: string): boolean {
  const normalizedPath =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  return BOT_PROTECTED_ROUTES.some(
    (route) =>
      route.path === normalizedPath &&
      route.method.toUpperCase() === method.toUpperCase(),
  );
}
