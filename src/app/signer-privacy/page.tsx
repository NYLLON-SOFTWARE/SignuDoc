import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { PublicDocumentShell } from "@/components/layout/public-document-shell";
import { getSettings } from "@/lib/settings";
import { STALE_DRAFT_RETENTION_DAYS } from "@/lib/retention";

export const metadata: Metadata = {
  description: "How your information is used when you sign a document here.",
  title: "Privacy notice for signers",
};

// A GDPR Article 13 notice for signers, built from the install's settings.
// Shown in the footer when the organization has not linked its own privacy
// policy. The organization remains the controller and should check it.
export default async function SignerPrivacyPage() {
  await connection();

  const settings = await getSettings();

  if (settings.hosted) {
    redirect("/privacy");
  }

  if (settings.privacyUrl) {
    redirect(settings.privacyUrl);
  }

  const organization =
    settings.organizationName?.trim() || "The organization that runs this site";
  const contact = settings.supportAddress;
  const retention = settings.retentionDays
    ? `Finished documents and their audit trails are deleted ${String(settings.retentionDays)} days after they are finished.`
    : "Finished documents and their audit trails are kept until the organization deletes them, because they are evidence of an agreement and many must be kept for years by law.";

  return (
    <PublicDocumentShell
      description={`${organization} uses this site to send documents for electronic signature. This notice says what is collected about you when you sign, why, and what you can do about it.`}
      lastUpdated="2026-11-13"
      title="Privacy notice for signers"
    >
      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-(--fg)">
          Who is responsible
        </h2>
        <p>
          {organization} is responsible for your information (the
          &ldquo;controller&rdquo;).{" "}
          {contact ? (
            <>
              Contact them at{" "}
              <a className="underline" href={`mailto:${contact}`}>
                {contact}
              </a>
              .
            </>
          ) : (
            "Contact them through the person who sent you the document."
          )}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-(--fg)">
          What is collected
        </h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>Your name and email address, given by the sender.</li>
          <li>
            What you enter: your signature or initials (typed or drawn), dates,
            text and checkboxes, or your reason for declining.
          </li>
          <li>
            Evidence of signing: when you opened, agreed and signed, your IP
            address, your browser&apos;s description of itself, and the checks
            you passed (such as an emailed code).
          </li>
          <li>Records of the emails sent to you about the document.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-(--fg)">
          Why, and on what basis
        </h2>
        <p>
          To let you review and sign the document, to deliver copies, and to
          keep evidence of who signed what and when. The basis is taking steps
          for or performing a contract you are part of (GDPR Article 6(1)(b)),
          the organization&apos;s legitimate interest in being able to prove the
          agreement (Article 6(1)(f)), and any legal duty to keep records
          (Article 6(1)(c)).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-(--fg)">
          Who else handles it
        </h2>
        <p>
          The other parties to the document see your name, email and signature.
          The services that run this site process it for {organization}: the
          hosting provider (Vercel), the database provider (such as Neon), file
          storage (Vercel Blob) and the email provider (Resend). Some are based
          in the United States; where information leaves the European Economic
          Area, it is protected by the EU-US Data Privacy Framework or by
          standard contractual clauses.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-(--fg)">
          How long it is kept
        </h2>
        <p>
          {retention} Unsent drafts are deleted after{" "}
          {String(STALE_DRAFT_RETENTION_DAYS)} days without changes.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-(--fg)">
          Your rights
        </h2>
        <p>
          You can ask {organization} for a copy of your information, to correct
          it, to restrict or object to its use, or to erase it. A signed record
          may be kept despite a request to erase it while it is needed as
          evidence or by law (GDPR Article 17(3)). You can also complain to the
          data protection authority where you live or work.
        </p>
      </section>
    </PublicDocumentShell>
  );
}
