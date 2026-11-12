import type { Metadata } from "next";
import Link from "next/link";

import { PublicDocumentShell } from "@/components/layout/public-document-shell";
import { requireHostedMode } from "@/lib/hosted-pages";
import { resolvePublicSupportAddress } from "@/lib/public-contact";

export const metadata: Metadata = {
  description:
    "Read SignuDoc's accessibility statement, current accessibility features, known limitations, and how to request assistance.",
  title: "Accessibility Statement | SignuDoc",
};

export default async function AccessibilityPage() {
  await requireHostedMode();

  const supportAddress = await resolvePublicSupportAddress();

  return (
    <PublicDocumentShell
      description="SignuDoc is committed to improving accessibility for people with disabilities. This statement describes what is currently supported, the known limitations in our launch-stage product, and how to request assistance or accommodation."
      lastUpdated="March 25, 2026"
      title="Accessibility Statement"
    >
      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Commitment
        </h2>
        <p>
          We want SignuDoc to be usable by as many people as possible, including
          people who rely on keyboard navigation, screen readers, zoom, or other
          assistive technologies. We use accessibility best practices and treat
          accessibility feedback as a product priority.
        </p>
        <p>
          SignuDoc is still a launch-stage product, and some parts of the
          experience are more accessible than others. This statement is intended
          to be candid about the current state of the product and the help that
          is available right now.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          What currently works best
        </h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Account creation, log in, dashboard, settings, and most non-canvas
            forms use semantic controls and are intended to be keyboard
            navigable.
          </li>
          <li>
            The signing experience uses keyboard-focusable HTML inputs and
            buttons layered over the PDF preview, and includes a sidebar summary
            of assigned fields.
          </li>
          <li>
            Status messages, buttons, and form labels are designed to expose
            meaningful text to assistive technology.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Known limitations
        </h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            The PDF preview is rendered on a canvas and is therefore not a fully
            semantic representation of the source document for screen readers.
          </li>
          <li>
            Sender-side document preparation currently relies heavily on
            drag-and-drop and pointer-based field placement, which is not yet a
            fully accessible workflow for blind users or some keyboard-only
            users.
          </li>
          <li>
            Some uploaded PDFs may contain scanned images, complex layouts, or
            third-party accessibility issues that SignuDoc cannot fully correct
            at display time.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Alternative assistance
        </h2>
        <p>
          If you need help creating, sending, reviewing, or signing a document,
          email{" "}
          <Link
            className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
            href={`mailto:${supportAddress}`}
          >
            {supportAddress}
          </Link>
          . Tell us what part of the workflow you are trying to complete, what
          assistive technology you use if you are comfortable sharing it, and
          what kind of accommodation would help.
        </p>
        <p>
          Depending on the situation, we may be able to provide manual
          assistance, an alternative communication path, or another supported
          way to complete the workflow.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Standards and ongoing work
        </h2>
        <p>
          We use WCAG 2.2 Level AA as a practical reference point when planning
          improvements, but we do not claim that every part of SignuDoc fully
          conforms today.
        </p>
        <p>
          Our near-term focus includes improving the accessibility of the
          canvas-based PDF experience, strengthening modal focus behavior,
          reducing pointer-only interactions, and continuing to expand
          keyboard-friendly alternatives.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Feedback
        </h2>
        <p>
          Accessibility feedback helps us prioritize the right fixes. If you
          find a barrier, email{" "}
          <Link
            className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
            href={`mailto:${supportAddress}`}
          >
            {supportAddress}
          </Link>{" "}
          or use the{" "}
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
