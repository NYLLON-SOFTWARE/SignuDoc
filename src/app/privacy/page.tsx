import type { Metadata } from "next";
import Link from "next/link";

import { PublicDocumentShell } from "@/components/layout/public-document-shell";
import { requireHostedMode } from "@/lib/hosted-pages";
import { resolvePublicSupportAddress } from "@/lib/public-contact";

export const metadata: Metadata = {
  description:
    "Read how SignuDoc collects, uses, shares, retains, and protects information for its public U.S. e-signature service.",
  title: "Privacy Policy | SignuDoc",
};

export default async function PrivacyPage() {
  await requireHostedMode();

  const privacyAddress = await resolvePublicSupportAddress();

  return (
    <PublicDocumentShell
      description="This Privacy Policy describes the categories of information SignuDoc collects, how we use and share that information, the rights available to users, and how to contact us with privacy requests."
      lastUpdated="March 25, 2026"
      title="Privacy Policy"
    >
      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          1. Scope and service design
        </h2>
        <p>
          SignuDoc is a U.S.-focused electronic-signature service designed for
          ordinary business agreements and similar commercial workflows. This
          Privacy Policy applies to account holders, signers, website visitors,
          and support contacts who interact with SignuDoc.
        </p>
        <p>
          SignuDoc is not intended for legally required consumer disclosure
          workflows that need a separate E-SIGN consumer-consent process. If a
          sender uses SignuDoc outside that scope, the sender remains
          responsible for making sure the workflow is legally appropriate.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          2. Information we collect
        </h2>
        <p>We may collect the following categories of information:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Account information</strong>, such as name, email address,
            password credentials, email-verification status, session data, and
            profile updates.
          </li>
          <li>
            <strong>Document and workflow data</strong>, such as uploaded PDFs,
            document titles, page counts, placed fields, signer routing order,
            envelope status, and related metadata.
          </li>
          <li>
            <strong>Signer and signature data</strong>, such as signer names and
            email addresses, typed signature values, drawn signature images,
            dates, text entries, checkbox selections, and decline reasons.
          </li>
          <li>
            <strong>Audit and security data</strong>, such as IP address,
            browser or device information, timestamps, token identifiers, record
            access events, sending events, reminder events, signing events, and
            system-generated audit trails.
          </li>
          <li>
            <strong>Support and communications data</strong>, such as emails you
            send to SignuDoc, account-closure requests, privacy requests, and
            feedback about accessibility or product issues.
          </li>
          <li>
            <strong>Cookies and local state</strong>, such as authentication
            cookies, session information, and limited browser-side data needed
            to operate the application securely.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          3. Where the information comes from
        </h2>
        <p>We collect information directly from you when you:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>create or use an account;</li>
          <li>upload or send a document;</li>
          <li>complete, decline, or download a signing package;</li>
          <li>communicate with us by email or through support channels; or</li>
          <li>browse or interact with the website.</li>
        </ul>
        <p>
          We also generate information automatically when SignuDoc records audit
          events, sends transactional emails, secures sessions, enforces rate
          limits, or stores completed records.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          4. How we use information
        </h2>
        <p>We may use information to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>create and manage accounts;</li>
          <li>deliver signing workflows and completed document packages;</li>
          <li>verify email addresses and send transactional messages;</li>
          <li>maintain envelope history, audit trails, and security logs;</li>
          <li>prevent fraud, abuse, and unauthorized access;</li>
          <li>respond to support, privacy, and accessibility requests;</li>
          <li>
            comply with legal obligations, enforce agreements, and resolve
            disputes; and
          </li>
          <li>
            improve the reliability, security, and usability of the service.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          5. How we share information
        </h2>
        <p>
          We may share information with service providers that help us operate
          SignuDoc, such as providers for authentication, cloud storage, email
          delivery, hosting, infrastructure, logging, security, and customer
          support.
        </p>
        <p>
          We may also disclose information when reasonably necessary to comply
          with law, respond to legal process, protect the rights or safety of
          SignuDoc, users, or the public, or in connection with a merger,
          acquisition, financing, or asset sale.
        </p>
        <p>
          SignuDoc is not built as an advertising-supported service. If that
          changes, we will update this Privacy Policy before using personal
          information in a materially different way.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          6. Retention
        </h2>
        <p>
          Unsent draft envelopes and their uploaded source documents may be
          deleted after a period of inactivity, such as 30 days without sender
          activity.
        </p>
        <p>
          Completed, declined, and voided envelopes remain available while your
          account is active so you can access signed documents and audit
          history. We also keep related audit and security records for as long
          as reasonably necessary to operate the service, prevent abuse, comply
          with legal obligations, resolve disputes, and enforce agreements.
        </p>
        <p>
          If you close your account, we may provide a limited export window and
          then delete stored document files and related envelope records, except
          limited information we need for security, fraud prevention, legal
          compliance, or dispute resolution.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          7. Security
        </h2>
        <p>
          SignuDoc uses administrative, technical, and physical safeguards that
          are designed to protect personal information, including authenticated
          access controls, audit logging, rate limiting, security headers, and
          cloud-storage controls. No system is perfectly secure, and we cannot
          guarantee absolute security.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          8. Your privacy rights
        </h2>
        <p>
          Depending on where you live and the nature of your relationship with
          SignuDoc, you may have rights to:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>know or access the personal information we hold about you;</li>
          <li>request correction of inaccurate information;</li>
          <li>request deletion of information, subject to legal exceptions;</li>
          <li>
            receive a copy of certain information we can provide manually;
          </li>
          <li>
            withdraw consent where a processing activity depends on consent; and
          </li>
          <li>
            be free from discrimination for exercising applicable privacy
            rights.
          </li>
        </ul>
        <p>
          California residents may also have rights to request the categories
          and specific pieces of personal information we collected about them,
          request correction of inaccurate personal information, and request
          deletion, subject to applicable exemptions.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          9. How to exercise your rights
        </h2>
        <p>
          To request access, correction, deletion, or account closure, email{" "}
          <Link
            className="font-semibold text-(--accent-ink) underline decoration-[rgba(83,64,214,0.35)] underline-offset-4"
            href={`mailto:${privacyAddress}`}
          >
            {privacyAddress}
          </Link>{" "}
          or use the in-app account-closure request flow when available.
        </p>
        <p>
          We may ask you to verify your identity before we act on a request. For
          example, we may ask you to confirm control of the relevant email
          address, identify recent account activity, or provide envelope details
          sufficient to locate the records you want us to review.
        </p>
        <p>
          Where California law applies, we aim to respond within 45 calendar
          days of a verifiable request and may extend once by another 45 days
          where permitted by law. Where GDPR or similar laws apply, we aim to
          respond within one month, subject to lawful extensions for complex or
          numerous requests.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          10. Cookies and local storage
        </h2>
        <p>
          SignuDoc uses cookies and similar technologies primarily for
          authentication, session continuity, security, and basic application
          state. We may also store limited local settings needed to make the app
          usable, such as interface preferences and page state for active
          workflows. For sender workflows, draft PDF previews may be cached
          locally in the browser (IndexedDB) for up to 24 hours to improve
          document preparation performance.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          11. Children and international use
        </h2>
        <p>
          SignuDoc is not directed to children under 13, and we do not knowingly
          collect personal information from children through the service. If you
          believe a child provided personal information to us, contact us so we
          can review and address the issue.
        </p>
        <p>
          SignuDoc is operated for U.S.-focused business use. If you access the
          service from outside the United States, you understand that
          information may be processed and stored in the United States or other
          locations where our service providers operate.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          12. Changes and contact
        </h2>
        <p>
          We may update this Privacy Policy from time to time by posting a
          revised version on this page. Material changes will apply when posted
          unless a later date is stated.
        </p>
        <p>
          Privacy questions, requests, and complaints may be sent to{" "}
          <Link
            className="font-semibold text-(--accent-ink) underline decoration-[rgba(83,64,214,0.35)] underline-offset-4"
            href={`mailto:${privacyAddress}`}
          >
            {privacyAddress}
          </Link>{" "}
          or through the{" "}
          <Link
            className="font-semibold text-(--accent-ink) underline decoration-[rgba(83,64,214,0.35)] underline-offset-4"
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
