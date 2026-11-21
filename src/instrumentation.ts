// Runs once when a server instance starts, before it handles any request.
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Notifications go out soon after the audit event they are about, not
  // only on the scheduled run. See notifications/kick.ts.
  const { registerNotificationDelivery } =
    await import("@/lib/notifications/kick");

  registerNotificationDelivery();
}
