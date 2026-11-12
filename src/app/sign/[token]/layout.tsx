import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";

import { BrandingProvider } from "@/components/layout/branding-provider";
import { getInstallMetadata } from "@/lib/install";
import { getBranding } from "@/lib/settings";

export async function generateMetadata(): Promise<Metadata> {
  await connection();

  return getInstallMetadata();
}

// Signing pages carry the name of the organization that sent the document.
export default async function SigningLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  await connection();

  return (
    <BrandingProvider branding={await getBranding()}>
      {children}
    </BrandingProvider>
  );
}
