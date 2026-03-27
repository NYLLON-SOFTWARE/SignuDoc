import { LoginShell } from "@/components/auth/login-shell";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    token?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

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
