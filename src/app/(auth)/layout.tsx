import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { BrandingProvider } from "@/components/layout/branding-provider";
import { getInstallMetadata, redirectToSetupIfNeeded } from "@/lib/install";
import { getBranding } from "@/lib/settings";

export async function generateMetadata(): Promise<Metadata> {
  await connection();

  return getInstallMetadata();
}

export default async function UnauthenticatedLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  await connection();
  await redirectToSetupIfNeeded();

  return (
    <BrandingProvider branding={await getBranding()}>
      <AuthShell>{children}</AuthShell>
    </BrandingProvider>
  );
}
