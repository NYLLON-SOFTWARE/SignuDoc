import { LoginShell } from "@/components/auth/login-shell";
import { redirectIfSignedIn } from "@/lib/auth/server";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    token?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  // A link from a password reset email is for this page whoever is signed
  // in, so it is shown as it is.
  if (!resolvedSearchParams?.token && !resolvedSearchParams?.error) {
    await redirectIfSignedIn();
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
