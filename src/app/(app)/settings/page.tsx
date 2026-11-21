import { NotificationPreferencesPanel } from "@/components/settings/notification-preferences-panel";
import { NotificationsAdminPanel } from "@/components/settings/notifications-panel";
import { OrganizationSettings } from "@/components/settings/organization-settings";
import { SettingsShell } from "@/components/settings/settings-shell";
import { UpdatesPanel } from "@/components/settings/updates-panel";
import { isAdminUser } from "@/lib/auth/admin";
import { accountClosureBlock } from "@/lib/account";
import { getAuthSession } from "@/lib/auth/server";
import {
  getNotificationPreferencesView,
  getNotificationsAdminView,
} from "@/lib/notifications/settings";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import {
  getSettings,
  isMissingSchemaError,
  readStoredSettings,
  resolveSettings,
} from "@/lib/settings";
import { usesTwoFactor } from "@/lib/sign-in-security";
import { getUpdateStatus } from "@/lib/software-update";

// A database that does not have this version's notification tables yet (a
// preview sharing production's, say) shows the page without them.
function unlessUnmigrated(error: unknown): null {
  if (isMissingSchemaError(error)) {
    return null;
  }

  throw error;
}

export default async function SettingsPage() {
  const session = await getAuthSession();
  const isAdmin = session ? await isAdminUser(session.user.id) : false;
  const settings = await getSettings();
  const closureBlockedReason = session
    ? await accountClosureBlock(session.user).catch(() => null)
    : null;
  const [notificationPreferences, notificationsAdmin] = await Promise.all([
    session
      ? getNotificationPreferencesView(session.user.id).catch(unlessUnmigrated)
      : null,
    isAdmin ? getNotificationsAdminView().catch(unlessUnmigrated) : null,
  ]);

  return (
    <div className="space-y-8">
      <SettingsShell
        closureBlockedReason={closureBlockedReason}
        initialProfile={{
          email: session?.user.email ?? "",
          fullName: session?.user.name ?? "",
        }}
        twoFactor={{
          enabled: session ? usesTwoFactor(session.user) : false,
          required: settings.requireTwoFactor,
        }}
      />
      {notificationPreferences ? (
        <NotificationPreferencesPanel
          initialView={notificationPreferences}
          // Starts over when an administrator connects Slack or turns direct
          // messages on or off further down this page.
          key={notificationPreferences.channels
            .map((channel) => `${channel.id}:${channel.available}`)
            .join(",")}
        />
      ) : null}
      {isAdmin ? (
        <OrganizationSettings
          // Read fresh, not from the short-lived cache, so the form never
          // shows a value that was just replaced.
          initialSettings={toOrganizationSettingsView(
            resolveSettings(await readStoredSettings()),
          )}
        />
      ) : null}
      {notificationsAdmin ? (
        <NotificationsAdminPanel initialView={notificationsAdmin} />
      ) : null}
      {isAdmin ? <UpdatesPanel initialStatus={getUpdateStatus(null)} /> : null}
    </div>
  );
}
