import type { Metadata } from "next";

import { PublicDocumentShell } from "@/components/layout/public-document-shell";
import { VerifyForm } from "@/components/verify/verify-form";

export const metadata: Metadata = {
  description:
    "Check that a signed PDF or audit certificate is exactly the file this site produced.",
  title: "Verify a document",
};

export default function VerifyPage() {
  return (
    <PublicDocumentShell
      description="Check that a signed PDF or audit certificate is exactly the file this site produced when signing finished. Any change to the file, however small, gives a different fingerprint."
      title="Verify a document"
    >
      <div className="mx-auto w-full max-w-[52rem] space-y-8">
        <VerifyForm />
        <section className="space-y-3">
          <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
            Checking the seal in a PDF reader
          </h2>
          <p>
            Finished documents and certificates also carry a digital seal. Open
            the file in Adobe Acrobat Reader or another PDF reader and look at
            its signature panel. The reader says whether the document has been
            changed since it was sealed. Unless the organization has installed a
            certificate from a certificate authority, the reader will also say
            the signer&apos;s identity is unknown; that is expected and does not
            affect the check for changes.
          </p>
        </section>
      </div>
    </PublicDocumentShell>
  );
}
