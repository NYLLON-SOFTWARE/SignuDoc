import { SettingsShell } from "@/components/settings/settings-shell";
import { getAuthSession } from "@/lib/auth/server";

export default async function SettingsPage() {
  const session = await getAuthSession();

  return (
    <SettingsShell
      initialProfile={{
        email: session?.user.email ?? "",
        fullName: session?.user.name ?? "",
      }}
    />
  );
}
