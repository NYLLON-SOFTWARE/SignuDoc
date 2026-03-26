import { redirect } from "next/navigation";

import { SignupShell } from "@/components/auth/signup-shell";
import { getAuthSession } from "@/lib/auth/server";

export default async function SignupPage() {
  const session = await getAuthSession();

  if (session) {
    redirect("/dashboard");
  }

  return <SignupShell />;
}
