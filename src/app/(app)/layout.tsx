import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { BrandingProvider } from "@/components/layout/branding-provider";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { buildBranding } from "@/lib/branding";
import { emailNeedsAttention } from "@/lib/email-status";
import { getInstallMetadata } from "@/lib/install";
import { getSettings } from "@/lib/settings";

export function generateMetadata(): Promise<Metadata> {
  return getInstallMetadata();
}

export default async function AuthenticatedAppLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  const [settings, isAdmin] = await Promise.all([
    getSettings(),
    isAdminUser(session.user.id),
  ]);

  return (
    <BrandingProvider branding={buildBranding(settings)}>
      <AppShell
        // Only the administrator can do anything about email, so only the
        // administrator is told when it still needs setting up.
        showEmailSetupNotice={isAdmin && emailNeedsAttention(settings)}
        user={{
          email: session.user.email,
          name: session.user.name,
        }}
      >
        {children}
      </AppShell>
    </BrandingProvider>
  );
}
