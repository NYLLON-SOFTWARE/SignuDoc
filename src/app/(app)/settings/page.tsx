import { OrganizationSettings } from "@/components/settings/organization-settings";
import { SettingsShell } from "@/components/settings/settings-shell";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import { readStoredSettings, resolveSettings } from "@/lib/settings";

export default async function SettingsPage() {
  const session = await getAuthSession();
  const isAdmin = session ? await isAdminUser(session.user.id) : false;

  return (
    <div className="space-y-8">
      <SettingsShell
        initialProfile={{
          email: session?.user.email ?? "",
          fullName: session?.user.name ?? "",
        }}
      />
      {isAdmin ? (
        <OrganizationSettings
          // Read fresh, not from the short-lived cache, so the form never
          // shows a value that was just replaced.
          initialSettings={toOrganizationSettingsView(
            resolveSettings(await readStoredSettings()),
          )}
        />
      ) : null}
    </div>
  );
}
