import type { ReactNode } from "react";

import { AuthShell } from "@/components/layout/auth-shell";

export default function UnauthenticatedLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return <AuthShell>{children}</AuthShell>;
}
