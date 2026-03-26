import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { getAuthSession } from "@/lib/auth/server";

export default async function AuthenticatedAppLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  return (
    <AppShell
      user={{
        email: session.user.email,
        name: session.user.name,
      }}
    >
      {children}
    </AppShell>
  );
}
