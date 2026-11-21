import { SigningDoneShell } from "@/components/signing/signing-done-shell";

// Where an embedded signer lands after signing. The page that frames it was
// told already (signudoc:signed); this is what the signer sees meanwhile.

type EmbedSignDonePageProps = {
  searchParams?: Promise<{
    approved?: string | string[];
    title?: string | string[];
  }>;
};

export default async function EmbedSignDonePage({
  searchParams,
}: EmbedSignDonePageProps) {
  const resolved = searchParams ? await searchParams : undefined;
  const envelopeTitle = Array.isArray(resolved?.title)
    ? resolved.title[0]
    : resolved?.title;

  return (
    <SigningDoneShell
      approved={resolved?.approved === "1"}
      embedded
      envelopeTitle={envelopeTitle}
    />
  );
}
