import type { Metadata } from "next";
import Link from "next/link";

import { PublicDocumentShell } from "@/components/layout/public-document-shell";
import { requireHostedMode } from "@/lib/hosted-pages";
import { resolvePublicSupportAddress } from "@/lib/public-contact";

export const metadata: Metadata = {
  description:
    "Review the terms that govern use of the SignuDoc public e-signature service.",
  title: "Terms of Service | SignuDoc",
};

export default async function TermsPage() {
  await requireHostedMode();

  const supportAddress = await resolvePublicSupportAddress();

  return (
    <PublicDocumentShell
      description="These Terms of Service govern your access to and use of SignuDoc. They are written for a launch-stage U.S. e-signature product intended for ordinary business agreements and commercial workflows."
      lastUpdated="March 21, 2026"
      title="Terms of Service"
    >
      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          1. Overview
        </h2>
        <p>
          By creating an account, uploading a document, sending an envelope, or
          signing through SignuDoc, you agree to these Terms. If you use
          SignuDoc on behalf of a company or other organization, you represent
          that you are authorized to bind that organization to these Terms.
        </p>
        <p>
          SignuDoc provides software for preparing, sending, signing, and
          storing electronic records. SignuDoc is not a law firm, is not your
          lawyer, does not give legal advice, and does not determine whether a
          particular document is legally suitable for electronic signing in any
          jurisdiction.
        </p>
        <p>
          SignuDoc is currently offered for use by U.S.-based businesses and
          organizations.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          2. Eligibility and authority
        </h2>
        <p>
          You may use SignuDoc only if you can form a binding contract under
          applicable law and only for lawful business or organizational
          purposes. You are responsible for making sure that each sender,
          signer, and recipient has authority to act for the party they
          represent.
        </p>
        <p>
          You are also responsible for determining whether your transaction
          requires witnesses, notarization, paper delivery, special retention
          rules, or a signature form that SignuDoc does not provide.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          3. Permitted use and excluded documents
        </h2>
        <p>
          SignuDoc is intended for ordinary business agreements and comparable
          commercial records, such as NDAs, statements of work, vendor
          agreements, service agreements, procurement approvals, and similar
          business documents.
        </p>
        <p>
          You must not use SignuDoc for documents or notices that are excluded
          from SignuDoc&apos;s permitted scope, including:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>wills, codicils, and testamentary trusts;</li>
          <li>adoption, divorce, or other matters of family law;</li>
          <li>
            court orders, court notices, pleadings, or other official court
            documents;
          </li>
          <li>
            notices of utility cancellation or termination, including water,
            heat, or power;
          </li>
          <li>
            notices of default, acceleration, repossession, foreclosure,
            eviction, or the right to cure involving a primary residence;
          </li>
          <li>
            cancellation or termination of health insurance benefits or life
            insurance benefits;
          </li>
          <li>
            product recall notices or notices of material product failure that
            risk endangering health or safety;
          </li>
          <li>
            documents required to accompany the transportation or handling of
            hazardous materials, pesticides, or other toxic or dangerous
            materials; and
          </li>
          <li>
            legally required consumer disclosures or other workflows that
            require a separate E-SIGN consumer-consent process before the record
            may be delivered electronically.
          </li>
        </ul>
        <p>
          If a document falls into a regulated, safety-sensitive, consumer
          disclosure, estate-planning, court, or family-law category, do not use
          SignuDoc for that workflow. By sending an envelope, you confirm that
          the document is an ordinary business agreement within SignuDoc&apos;s
          permitted use.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          4. Sender responsibilities
        </h2>
        <p>
          Senders are responsible for the content they upload, the routing order
          they configure, the fields they place, the recipients they invite, and
          the legal sufficiency of the resulting process. You must have the
          rights and permissions needed to upload the document and request
          signatures from each recipient.
        </p>
        <p>
          You are responsible for maintaining accurate signer contact
          information, avoiding misleading or deceptive envelopes, and making
          sure that any required notices, disclosures, or offline procedures are
          handled outside SignuDoc when needed.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          5. Electronic signatures and records
        </h2>
        <p>
          For documents within SignuDoc&apos;s permitted scope, SignuDoc is
          designed to support standard electronic signatures and records used in
          the United States under laws such as the Electronic Signatures in
          Global and National Commerce Act (E-SIGN) and state electronic
          transactions laws such as UETA, where applicable.
        </p>
        <p>
          SignuDoc does not provide qualified electronic signatures under eIDAS
          and does not promise that a SignuDoc workflow will satisfy any
          country-specific trust-service, certificate, identity-proofing, or
          notarization regime outside the ordinary U.S. electronic-signature
          context.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          6. Account security and acceptable use
        </h2>
        <p>
          You are responsible for safeguarding your credentials, restricting
          access to your account, and promptly notifying SignuDoc if you suspect
          unauthorized use. You may not use SignuDoc to break the law, infringe
          rights, transmit malware, harass recipients, scrape data, interfere
          with service operation, or attempt to bypass access controls or rate
          limits.
        </p>
        <p>
          You may not use SignuDoc to impersonate another person, to collect
          signatures through deception, or to send spam or bulk messages that do
          not relate to an actual signing workflow.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          7. Service changes, availability, and records
        </h2>
        <p>
          SignuDoc may change, improve, suspend, or discontinue features at any
          time. We may introduce limits on document size, signer count, storage,
          or retention as the service evolves. We may also remove content or
          suspend accounts that appear to violate these Terms or create legal,
          operational, or security risk.
        </p>
        <p>
          You should download and retain your own copies of important completed
          documents. SignuDoc&apos;s hosted document storage is a convenience
          feature and is subject to the retention and deletion practices
          described in the Privacy Policy.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          8. Intellectual property and your content
        </h2>
        <p>
          As between you and SignuDoc, you retain ownership of the documents and
          data you upload, subject to the rights needed for SignuDoc and its
          service providers to host, process, transmit, display, secure, and
          store that content to operate the service.
        </p>
        <p>
          SignuDoc and its branding, software, interface, and related materials
          are protected by applicable intellectual-property laws. Except as
          expressly allowed by law, you may not copy, resell, reverse engineer,
          or create derivative works from the service.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          9. Suspension, termination, and account closure
        </h2>
        <p>
          You may stop using the service at any time. SignuDoc may suspend or
          terminate access if we reasonably believe that you violated these
          Terms, used the service outside its permitted scope, or created
          security, fraud, or legal risk.
        </p>
        <p>
          Account-closure requests may be submitted through the settings page or
          by contacting{" "}
          <Link
            className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
            href={`mailto:${supportAddress}`}
          >
            {supportAddress}
          </Link>
          . Before closing your account, download any documents you want to
          keep. After closure, SignuDoc may provide a limited export window and
          then delete stored document files and related envelope records, except
          limited information kept for security, fraud prevention, legal
          compliance, or dispute resolution.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          10. Disclaimers
        </h2>
        <p>
          SignuDoc is provided on an &quot;as is&quot; and &quot;as
          available&quot; basis to the maximum extent permitted by law. SignuDoc
          disclaims all warranties, whether express, implied, statutory, or
          otherwise, including implied warranties of merchantability, fitness
          for a particular purpose, title, noninfringement, accuracy,
          uninterrupted availability, and legal sufficiency for any specific
          transaction.
        </p>
        <p>
          SignuDoc does not warrant that a particular workflow will be valid in
          court, accepted by a regulator, or appropriate for a regulated or
          excluded document type. You should obtain legal advice for questions
          about document enforceability, retention, consumer disclosures,
          notarization, or jurisdiction-specific requirements.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          11. Limitation of liability
        </h2>
        <p>
          To the maximum extent permitted by law, SignuDoc and its affiliates,
          service providers, licensors, and personnel will not be liable for any
          indirect, incidental, special, consequential, exemplary, or punitive
          damages, or for any loss of profits, revenue, goodwill, data, or use,
          arising out of or relating to the service or these Terms.
        </p>
        <p>
          To the maximum extent permitted by law, the aggregate liability of
          SignuDoc for all claims arising out of or relating to the service or
          these Terms will not exceed the greater of the amount you paid
          SignuDoc for the service during the 12 months before the event giving
          rise to the claim or one hundred U.S. dollars (US$100).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          12. Indemnification
        </h2>
        <p>
          You will defend, indemnify, and hold harmless SignuDoc and its
          affiliates, service providers, licensors, and personnel from and
          against claims, losses, damages, liabilities, costs, and expenses
          (including reasonable attorneys&apos; fees) arising out of or relating
          to your documents, your use of the service, your breach of these
          Terms, or your violation of law or the rights of another person.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          13. Governing law and changes
        </h2>
        <p>
          Except where applicable law requires otherwise, these Terms are
          governed by applicable U.S. federal law and the law of the state in
          which the SignuDoc operator is organized, without regard to
          conflict-of-law rules. You and SignuDoc agree to the exclusive venue
          of the state or federal courts serving that location for disputes that
          may be brought in court.
        </p>
        <p>
          SignuDoc may update these Terms from time to time by posting a revised
          version on this page. The updated Terms will apply when posted unless
          a later effective date is stated.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          14. Contact
        </h2>
        <p>
          Questions about these Terms may be sent to{" "}
          <Link
            className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
            href={`mailto:${supportAddress}`}
          >
            {supportAddress}
          </Link>{" "}
          or through the{" "}
          <Link
            className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
            href="/contact"
          >
            Contact
          </Link>{" "}
          page.
        </p>
      </section>
    </PublicDocumentShell>
  );
}
