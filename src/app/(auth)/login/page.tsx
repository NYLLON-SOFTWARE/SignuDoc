import { redirect } from "next/navigation";

import { LoginShell } from "@/components/auth/login-shell";
import { getAuthSession } from "@/lib/auth/server";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    token?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const hasLiveAuthState =
    resolvedSearchParams?.token !== undefined ||
    resolvedSearchParams?.error !== undefined;

  if (!hasLiveAuthState) {
    const session = await getAuthSession();

    if (session) {
      redirect("/dashboard");
    }
  }

  return (
    <LoginShell
      resetError={
        resolvedSearchParams?.error === "INVALID_TOKEN"
          ? resolvedSearchParams.error
          : null
      }
      resetToken={resolvedSearchParams?.token ?? null}
    />
  );
}
