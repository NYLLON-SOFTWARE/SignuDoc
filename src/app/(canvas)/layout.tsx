import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { getAuthSession } from "@/lib/auth/server";

export default async function CanvasLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  return children;
}
