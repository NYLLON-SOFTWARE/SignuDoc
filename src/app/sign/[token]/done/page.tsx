import { SigningDoneShell } from "@/components/signing/signing-done-shell";

type SignDonePageProps = {
  searchParams?: Promise<{
    approved?: string | string[];
    title?: string | string[];
  }>;
};

export default async function SignDonePage({
  searchParams,
}: SignDonePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const envelopeTitle = Array.isArray(resolvedSearchParams?.title)
    ? resolvedSearchParams.title[0]
    : resolvedSearchParams?.title;

  return (
    <SigningDoneShell
      approved={resolvedSearchParams?.approved === "1"}
      envelopeTitle={envelopeTitle}
    />
  );
}
